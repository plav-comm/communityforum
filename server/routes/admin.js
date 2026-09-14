/**
 * Maintenance routes. Protected by ADMIN_TOKEN — send it as
 *   Authorization: Bearer <ADMIN_TOKEN>
 *
 *   POST /admin/channels                  add a town channel
 *   POST /admin/channels/:id/subscribe    (re)subscribe one channel
 *   POST /admin/ingest                    ingest specific video IDs by hand
 *   POST /admin/reclassify                re-run tagging after editing rules
 *   POST /admin/run-daily                 trigger the safety net on demand
 *   GET  /admin/websub-events             recent push notifications
 */
const express = require('express');
const { many, one, query } = require('../db');
const { config } = require('../config');
const youtube = require('../lib/youtube');
const subscribe = require('../websub/subscribe');
const { ingestVideoIds, reclassifyAll } = require('../pipeline/ingest');
const { runDaily } = require('../pipeline/reconcile');
const { syncChannelAgendas, syncAllAgendas, matchAndReclassify } = require('../pipeline/agenda');
const { clearCache } = require('../pipeline/classify');
const log = require('../lib/log');

const router = express.Router();

router.use((req, res, next) => {
  if (!config.adminToken) {
    return res.status(503).json({ error: 'ADMIN_TOKEN is not configured on the server' });
  }
  const sent = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (sent !== config.adminToken) return res.status(401).json({ error: 'unauthorized' });
  next();
});

/**
 * Look up a channel without saving anything, so the Add-a-town screen can show
 * "is this the right channel?" before you commit.
 */
router.post('/resolve-channel', async (req, res, next) => {
  try {
    const input = (req.body && req.body.channel) || '';
    if (!input) return res.status(400).json({ error: 'channel is required' });

    const ytChannelId = await youtube.resolveChannelId(input);
    const meta = (await youtube.getChannels([ytChannelId]))[0];
    const existing = await one(
      'SELECT municipality, state_code, is_active FROM channels WHERE yt_channel_id = $1',
      [ytChannelId]
    );

    // Show the most recent uploads so a human can confirm these really are
    // meetings, not a parks department promo reel.
    let recent = [];
    if (meta && meta.uploadsPlaylistId) {
      const ids = await youtube.getPlaylistVideoIds(meta.uploadsPlaylistId, 5).catch(() => []);
      if (ids.length) {
        recent = (await youtube.getVideos(ids)).map((v) => ({
          title: v.title, publishedAt: v.publishedAt, status: v.status
        }));
      }
    }

    res.json({
      ytChannelId,
      title: (meta && meta.title) || null,
      description: meta && meta.description ? meta.description.slice(0, 300) : null,
      uploadsPlaylistId: (meta && meta.uploadsPlaylistId) || null,
      alreadyTracked: !!existing,
      existing: existing || null,
      recentVideos: recent
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Bulk add. Accepts an array of town objects, or a CSV/TSV block pasted from a
 * spreadsheet with the header:
 *   channel,municipality,county,stateCode,stateName,govBody,population
 * Every row is reported individually — one bad row never sinks the batch.
 */
router.post('/channels/bulk', async (req, res, next) => {
  try {
    let rows = (req.body && req.body.rows) || [];

    if (!rows.length && req.body && typeof req.body.csv === 'string') {
      const lines = req.body.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const split = (l) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((c) => c.trim().replace(/^"|"$/g, ''));
      let header = null;
      for (const line of lines) {
        const cells = split(line);
        if (!header) {
          const looksLikeHeader = /channel/i.test(cells[0]) || /url/i.test(cells[0]);
          header = looksLikeHeader
            ? cells.map((c) => c.replace(/\s+/g, '').toLowerCase())
            : ['channel', 'municipality', 'county', 'statecode', 'statename', 'govbody', 'population'];
          if (looksLikeHeader) continue;
        }
        const row = {};
        header.forEach((key, i) => { row[key] = cells[i] || ''; });
        rows.push({
          channel: row.channel || row.url,
          municipality: row.municipality || row.town || row.city,
          county: row.county,
          stateCode: row.statecode || row.state,
          stateName: row.statename || row.state,
          govBody: row.govbody || row.body || 'City Council',
          population: row.population ? Number(String(row.population).replace(/[^0-9]/g, '')) : null
        });
      }
    }

    if (!rows.length) return res.status(400).json({ error: 'provide rows[] or a csv string' });
    if (rows.length > 200) return res.status(400).json({ error: 'at most 200 rows per request' });

    const results = [];
    for (const r of rows) {
      try {
        if (!r.channel || !r.municipality || !r.stateCode) {
          throw new Error('channel, municipality and stateCode are required');
        }
        const ytChannelId = await youtube.resolveChannelId(r.channel);
        const meta = (await youtube.getChannels([ytChannelId]))[0];
        await query(
          `INSERT INTO channels
             (yt_channel_id, name, municipality, county, state_code, state_name, gov_body,
              population, size_tier, uploads_playlist_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (yt_channel_id) DO UPDATE SET
             municipality = EXCLUDED.municipality, county = EXCLUDED.county,
             state_code = EXCLUDED.state_code, state_name = EXCLUDED.state_name,
             gov_body = EXCLUDED.gov_body, population = EXCLUDED.population,
             size_tier = EXCLUDED.size_tier, is_active = TRUE`,
          [
            ytChannelId, (meta && meta.title) || r.municipality, r.municipality,
            r.county || null, String(r.stateCode).toUpperCase().slice(0, 2),
            r.stateName || r.stateCode, r.govBody || 'City Council',
            r.population || null, tierFor(r.population),
            (meta && meta.uploadsPlaylistId) || null
          ]
        );
        if (config.websub.callbackBase) {
          await subscribe.subscribeChannel(ytChannelId).catch(() => {});
        }
        results.push({ ok: true, municipality: r.municipality, ytChannelId });
      } catch (err) {
        results.push({ ok: false, municipality: r.municipality || r.channel, error: err.message });
      }
    }
    res.json({
      total: results.length,
      added: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results
    });
  } catch (err) { next(err); }
});

/** Add a channel. Accepts a channel URL, @handle, UC id, or any video URL. */
router.post('/channels', async (req, res, next) => {
  try {
    const {
      channel, municipality, county, stateCode, stateName,
      govBody = 'City Council', population, timezone, website, autoSubscribe = true
    } = req.body || {};

    if (!channel || !municipality || !stateCode || !stateName) {
      return res.status(400).json({
        error: 'channel, municipality, stateCode and stateName are required'
      });
    }

    const ytChannelId = await youtube.resolveChannelId(channel);
    const meta = (await youtube.getChannels([ytChannelId]))[0];

    const tier = tierFor(population);
    const row = await one(
      `INSERT INTO channels
         (yt_channel_id, name, municipality, county, state_code, state_name, gov_body,
          population, size_tier, timezone, website, uploads_playlist_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'America/New_York'),$11,$12)
       ON CONFLICT (yt_channel_id) DO UPDATE SET
         name = EXCLUDED.name, municipality = EXCLUDED.municipality, county = EXCLUDED.county,
         state_code = EXCLUDED.state_code, state_name = EXCLUDED.state_name,
         gov_body = EXCLUDED.gov_body, population = EXCLUDED.population,
         size_tier = EXCLUDED.size_tier, website = EXCLUDED.website, is_active = TRUE
       RETURNING *`,
      [
        ytChannelId, (meta && meta.title) || municipality, municipality, county || null,
        String(stateCode).toUpperCase(), stateName, govBody,
        population || null, tier, timezone || null, website || null,
        (meta && meta.uploadsPlaylistId) || null
      ]
    );

    let subscription = null;
    if (autoSubscribe && config.websub.callbackBase) {
      subscription = await subscribe.subscribeChannel(ytChannelId).catch((e) => ({ ok: false, error: e.message }));
    }
    res.status(201).json({ channel: row, subscription });
  } catch (err) { next(err); }
});

router.post('/channels/:ytChannelId/subscribe', async (req, res, next) => {
  try {
    const result = await subscribe.subscribeChannel(req.params.ytChannelId);
    res.json(result);
  } catch (err) { next(err); }
});

router.delete('/channels/:ytChannelId', async (req, res, next) => {
  try {
    await subscribe.unsubscribeChannel(req.params.ytChannelId).catch(() => {});
    await query('UPDATE channels SET is_active = FALSE WHERE yt_channel_id = $1', [req.params.ytChannelId]);
    res.json({ ok: true, deactivated: req.params.ytChannelId });
  } catch (err) { next(err); }
});

router.post('/ingest', async (req, res, next) => {
  try {
    const ids = (req.body && req.body.videoIds) || [];
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'videoIds must be a non-empty array' });
    }
    const summary = await ingestVideoIds(ids, { reason: 'admin' });
    res.json(summary);
  } catch (err) { next(err); }
});

router.post('/reclassify', async (req, res, next) => {
  try {
    clearCache();
    const limit = Math.min(Number((req.body && req.body.limit) || 500), 5000);
    res.json(await reclassifyAll({ limit }));
  } catch (err) { next(err); }
});

router.post('/run-daily', async (req, res, next) => {
  try {
    log.info('daily job triggered via admin route');
    res.json(await runDaily(req.body || {}));
  } catch (err) { next(err); }
});

/* ---------------- agenda sources ---------------- */

/**
 * Add a town by picking it out of the discovered agenda catalogue.
 * You still supply the YouTube channel and the location, because only a human
 * knows which channel belongs to which town — but the agenda source is chosen
 * from a verified list rather than typed in.
 */
router.post('/channels/from-agenda-source', async (req, res, next) => {
  try {
    const {
      vendor, clientCode, channel, municipality, county, stateCode, stateName,
      govBody = 'City Council', population, autoSubscribe = true
    } = req.body || {};

    if (!vendor || !clientCode) {
      return res.status(400).json({ error: 'vendor and clientCode are required' });
    }
    const src = await one(
      'SELECT * FROM agenda_sources WHERE vendor = $1 AND client_code = $2 AND is_available',
      [String(vendor).toLowerCase(), clientCode]
    );
    if (!src) return res.status(404).json({ error: 'that agenda source is not in the catalogue' });

    if (!channel) {
      return res.status(400).json({
        error: 'channel is required — paste the town\'s YouTube channel URL, @handle, or any video link',
        agendaSource: { vendor: src.vendor, clientCode: src.client_code, displayName: src.display_name }
      });
    }

    const ytChannelId = await youtube.resolveChannelId(channel);
    const meta = (await youtube.getChannels([ytChannelId]))[0];
    const guessedName = src.display_name || clientCode;
    const [guessCity, guessState] = String(guessedName).split(',').map((x) => (x || '').trim());

    const row = await one(
      `INSERT INTO channels
         (yt_channel_id, name, municipality, county, state_code, state_name, gov_body,
          population, size_tier, uploads_playlist_id, agenda_vendor, agenda_client)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (yt_channel_id) DO UPDATE SET
         agenda_vendor = EXCLUDED.agenda_vendor,
         agenda_client = EXCLUDED.agenda_client,
         municipality  = COALESCE(EXCLUDED.municipality, channels.municipality),
         is_active     = TRUE
       RETURNING *`,
      [
        ytChannelId, (meta && meta.title) || guessCity || clientCode,
        municipality || guessCity || clientCode, county || null,
        String(stateCode || guessState || 'ZZ').toUpperCase().slice(0, 2),
        stateName || guessState || 'Unassigned', govBody,
        population || null, tierFor(population),
        (meta && meta.uploadsPlaylistId) || null,
        src.vendor, src.client_code
      ]
    );

    let subscription = null;
    if (autoSubscribe && config.websub.callbackBase) {
      subscription = await subscribe.subscribeChannel(ytChannelId).catch((e) => ({ ok: false, error: e.message }));
    }

    // Pull the agendas straight away so the town is useful immediately.
    const agenda = await syncChannelAgendas(row, { limit: 20 }).catch((e) => ({ error: e.message }));

    res.status(201).json({ channel: row, agendaSource: { vendor: src.vendor, clientCode: src.client_code }, subscription, agenda });
  } catch (err) { next(err); }
});

/** Attach or change the agenda source on an existing channel. */
router.post('/channels/:ytChannelId/agenda-source', async (req, res, next) => {
  try {
    const { vendor, clientCode } = req.body || {};
    if (!vendor || !clientCode) return res.status(400).json({ error: 'vendor and clientCode are required' });

    const src = await one(
      'SELECT 1 FROM agenda_sources WHERE vendor = $1 AND client_code = $2 AND is_available',
      [String(vendor).toLowerCase(), clientCode]
    );
    if (!src) return res.status(404).json({ error: 'that agenda source is not in the catalogue' });

    const row = await one(
      `UPDATE channels SET agenda_vendor = $2, agenda_client = $3
        WHERE yt_channel_id = $1 RETURNING *`,
      [req.params.ytChannelId, String(vendor).toLowerCase(), clientCode]
    );
    if (!row) return res.status(404).json({ error: 'channel not found' });

    const agenda = await syncChannelAgendas(row, { limit: 25 }).catch((e) => ({ error: e.message }));
    res.json({ channel: row, agenda });
  } catch (err) { next(err); }
});

/** Sync agendas and re-tag. Safe to call any time. */
router.post('/agendas/sync', async (req, res, next) => {
  try {
    const sync = await syncAllAgendas({ limit: Number((req.body && req.body.limit) || 25) });
    const match = await matchAndReclassify({ limit: Number((req.body && req.body.reclassifyLimit) || 500) });
    res.json({ sync, match });
  } catch (err) { next(err); }
});

router.get('/websub-events', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT id, yt_channel_id, yt_video_id, action, signature_valid, processed, error, received_at
         FROM websub_events ORDER BY received_at DESC LIMIT 100`
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
});

/** Everything the admin screen needs about monitored towns. */
router.get('/channels', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT c.yt_channel_id, c.name, c.municipality, c.county, c.state_code, c.state_name,
              c.gov_body, c.population, c.size_tier, c.is_active,
              c.websub_state, c.websub_expires_at, c.websub_last_error,
              c.agenda_vendor, c.agenda_client, c.agenda_synced_at,
              count(v.id)::int AS video_count,
              count(v.id) FILTER (WHERE v.agenda_meeting_id IS NOT NULL)::int AS agenda_backed,
              max(v.published_at) AS latest_video_at
         FROM channels c
         LEFT JOIN videos v ON v.channel_id = c.id AND NOT v.is_hidden
        GROUP BY c.id
        ORDER BY c.is_active DESC, c.state_code, c.municipality`
    );
    res.json({ channels: rows });
  } catch (err) { next(err); }
});

/** Pull a channel's recent uploads on demand. */
router.post('/channels/:ytChannelId/backfill', async (req, res, next) => {
  try {
    const ch = await one('SELECT * FROM channels WHERE yt_channel_id = $1', [req.params.ytChannelId]);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    let playlist = ch.uploads_playlist_id;
    if (!playlist) {
      const meta = (await youtube.getChannels([ch.yt_channel_id]))[0];
      playlist = meta && meta.uploadsPlaylistId;
      if (playlist) {
        await query('UPDATE channels SET uploads_playlist_id = $2 WHERE id = $1', [ch.id, playlist]);
      }
    }
    if (!playlist) return res.status(400).json({ error: 'could not find an uploads playlist' });
    const ids = await youtube.getPlaylistVideoIds(playlist, Number((req.body && req.body.limit) || 15));
    res.json(await ingestVideoIds(ids, { reason: 'admin-backfill' }));
  } catch (err) { next(err); }
});

router.get('/job-runs', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT id, job_name, started_at, finished_at, ok, error, details
         FROM job_runs ORDER BY started_at DESC LIMIT 30`
    );
    res.json({ jobs: rows });
  } catch (err) { next(err); }
});

function tierFor(population) {
  const p = Number(population);
  if (!p) return null;
  if (p < 10000) return 'xs';
  if (p < 50000) return 'sm';
  if (p < 150000) return 'md';
  if (p < 500000) return 'lg';
  return 'xl';
}

module.exports = router;
module.exports.tierFor = tierFor;
