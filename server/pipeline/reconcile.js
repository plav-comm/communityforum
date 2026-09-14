/**
 * The automated safety net. Run once a day (see scripts/daily.js).
 *
 * Push notifications are fast but not guaranteed. Four things go wrong in
 * practice, and this job fixes all of them:
 *
 *   1. LEASES EXPIRE. WebSub subscriptions last ~9.6 days. If nothing renews
 *      them, the feed goes quiet and nobody notices for a week.
 *   2. PUSHES GET MISSED. Deploys, restarts, and hub hiccups drop notifications.
 *      So we read each channel's uploads playlist and ingest anything new.
 *   3. LIVE STREAMS GO STALE. A stream flagged 'live' stays 'live' in our DB
 *      until we re-check it, so the site would show a LIVE badge on a meeting
 *      that ended last Tuesday.
 *   4. STUCK 'UPCOMING'. Scheduled streams that were cancelled never start.
 */
const { query, many, one } = require('../db');
const { config } = require('../config');
const youtube = require('../lib/youtube');
const subscribe = require('../websub/subscribe');
const { ingestVideoIds } = require('./ingest');
const log = require('../lib/log');

/* ---------- 1. renew subscriptions before they lapse ---------- */
async function renewSubscriptions() {
  const due = await subscribe.channelsNeedingRenewal();
  const out = { checked: due.length, renewed: 0, failed: 0, channels: [] };

  for (const c of due) {
    try {
      const r = await subscribe.subscribeChannel(c.yt_channel_id);
      r.ok ? (out.renewed += 1) : (out.failed += 1);
      out.channels.push({ town: c.municipality, ok: r.ok, status: r.status });
    } catch (err) {
      out.failed += 1;
      out.channels.push({ town: c.municipality, ok: false, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log.info('subscription renewal pass', { checked: out.checked, renewed: out.renewed, failed: out.failed });
  return out;
}

/* ---------- 2. catch uploads the push missed ---------- */
async function backfillChannels({ perChannel = config.ingest.backfillPerChannel } = {}) {
  const channels = await many(
    'SELECT id, yt_channel_id, municipality, uploads_playlist_id FROM channels WHERE is_active ORDER BY last_backfilled_at NULLS FIRST'
  );
  const out = { channels: channels.length, newVideos: 0, errors: 0 };

  // Fill in any missing uploads-playlist IDs in one batched call.
  const missing = channels.filter((c) => !c.uploads_playlist_id).map((c) => c.yt_channel_id);
  if (missing.length) {
    try {
      const metas = await youtube.getChannels(missing);
      for (const m of metas) {
        if (m.uploadsPlaylistId) {
          await query('UPDATE channels SET uploads_playlist_id = $2 WHERE yt_channel_id = $1', [
            m.ytChannelId, m.uploadsPlaylistId
          ]);
          const hit = channels.find((c) => c.yt_channel_id === m.ytChannelId);
          if (hit) hit.uploads_playlist_id = m.uploadsPlaylistId;
        }
      }
    } catch (err) {
      log.error('could not resolve uploads playlists', { err: err.message });
    }
  }

  for (const c of channels) {
    if (!c.uploads_playlist_id) continue;
    try {
      const ids = await youtube.getPlaylistVideoIds(c.uploads_playlist_id, perChannel);
      if (!ids.length) continue;

      const known = await many(
        'SELECT yt_video_id FROM videos WHERE yt_video_id = ANY($1::text[])',
        [ids]
      );
      const knownSet = new Set(known.map((r) => r.yt_video_id));
      const fresh = ids.filter((id) => !knownSet.has(id));

      if (fresh.length) {
        const summary = await ingestVideoIds(fresh, { reason: 'backfill' });
        out.newVideos += summary.inserted;
        log.info('backfill found missed uploads', {
          town: c.municipality, found: fresh.length, inserted: summary.inserted
        });
      }
      await query('UPDATE channels SET last_backfilled_at = now() WHERE id = $1', [c.id]);
    } catch (err) {
      out.errors += 1;
      if (err.code === 'QUOTA') {
        log.error('stopping backfill: YouTube quota exhausted');
        break;
      }
      log.error('backfill failed for channel', { town: c.municipality, err: err.message });
    }
  }
  return out;
}

/* ---------- 3 & 4. refresh anything still marked live or upcoming ---------- */
async function refreshLiveStatuses() {
  const rows = await many(
    `SELECT yt_video_id FROM videos
      WHERE status IN ('live', 'upcoming')
         OR (status = 'recorded' AND published_at > now() - interval '2 days')
      ORDER BY published_at DESC NULLS LAST
      LIMIT 200`
  );
  if (!rows.length) return { checked: 0, changed: 0 };

  const ids = rows.map((r) => r.yt_video_id);
  const summary = await ingestVideoIds(ids, { reason: 'live-refresh' });

  // Any stream still 'live' with no update in 12 hours is almost certainly over.
  const stale = await query(
    `UPDATE videos SET status = 'recorded'
      WHERE status = 'live' AND updated_at < now() - interval '12 hours'
      RETURNING yt_video_id`
  );
  if (stale.rowCount) log.warn('closed stale live streams', { count: stale.rowCount });

  return { checked: ids.length, changed: summary.updated, staleClosed: stale.rowCount };
}

/* ---------- the whole job ---------- */
async function runDaily({ skipBackfill = false } = {}) {
  const job = await one(
    `INSERT INTO job_runs (job_name) VALUES ('daily-reconcile') RETURNING id, started_at`
  );
  const details = {};
  try {
    details.subscriptions = await renewSubscriptions();
    details.liveRefresh = await refreshLiveStatuses();
    if (!skipBackfill) details.backfill = await backfillChannels();

    // Agendas: pull today's published agendas, then match and re-tag. Wrapped so
    // an agenda vendor having a bad day never fails the whole safety net.
    try {
      const { syncAllAgendas, matchAndReclassify } = require('./agenda');
      details.agendaSync = await syncAllAgendas({ limit: 25 });
      details.agendaMatch = await matchAndReclassify({ limit: 400 });
    } catch (err) {
      details.agendaError = err.message;
      log.warn('agenda stage failed but the rest of the job succeeded', { err: err.message });
    }
    details.youtubeQuotaUnitsUsed = youtube.quotaUsed();

    await query(
      `UPDATE job_runs SET finished_at = now(), ok = TRUE, details = $2 WHERE id = $1`,
      [job.id, JSON.stringify(details)]
    );
    log.info('daily reconcile complete', {
      renewed: details.subscriptions.renewed,
      newVideos: details.backfill ? details.backfill.newVideos : 0,
      quota: details.youtubeQuotaUnitsUsed
    });
    return { ok: true, jobId: job.id, details };
  } catch (err) {
    await query(
      `UPDATE job_runs SET finished_at = now(), ok = FALSE, error = $2, details = $3 WHERE id = $1`,
      [job.id, err.message, JSON.stringify(details)]
    );
    log.error('daily reconcile failed', { err: err.message });
    throw err;
  }
}

module.exports = { runDaily, renewSubscriptions, backfillChannels, refreshLiveStatuses };
