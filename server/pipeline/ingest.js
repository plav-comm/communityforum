/**
 * Ingestion pipeline.
 *
 *   video IDs  ->  YouTube metadata  ->  topic classification  ->  Postgres
 *
 * Called from three places:
 *   1. the WebSub webhook, when YouTube pushes a new upload or livestream
 *   2. the daily safety net, for anything the push missed
 *   3. scripts/backfill.js, when you add a channel and want its recent history
 */
const { query, one, tx } = require('../db');
const youtube = require('../lib/youtube');
const { classify, loadRules } = require('./classify');
const { config } = require('../config');
const log = require('../lib/log');

/** Look up our internal channel row from a YouTube channel ID. */
async function findChannel(ytChannelId) {
  return one('SELECT * FROM channels WHERE yt_channel_id = $1', [ytChannelId]);
}

/**
 * Create a channel row for a channel we have never seen. Only used when
 * AUTO_ADD_CHANNELS=true; the location fields are left for you to fill in via
 * the admin route or SQL, because only a human knows which town a channel serves.
 */
async function autoAddChannel(meta) {
  log.warn('auto-adding unknown channel', { ytChannelId: meta.ytChannelId, title: meta.channelTitle });
  return one(
    `INSERT INTO channels
       (yt_channel_id, name, municipality, state_code, state_name, gov_body, is_active, websub_state)
     VALUES ($1, $2, $3, 'ZZ', 'Unassigned', 'Unknown', FALSE, 'active')
     ON CONFLICT (yt_channel_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [meta.ytChannelId, meta.channelTitle || meta.ytChannelId, meta.channelTitle || 'Unassigned']
  );
}

/**
 * Ingest a list of YouTube video IDs.
 * @returns {{inserted:number, updated:number, skipped:number, results:Array}}
 */
async function ingestVideoIds(videoIds, { reason = 'manual' } = {}) {
  const ids = [...new Set((videoIds || []).filter(Boolean))];
  const summary = { asked: ids.length, inserted: 0, updated: 0, skipped: 0, results: [] };
  if (!ids.length) return summary;

  const metas = await youtube.getVideos(ids);
  const found = new Set(metas.map((m) => m.ytVideoId));
  for (const id of ids) {
    if (!found.has(id)) {
      summary.skipped += 1;
      summary.results.push({ ytVideoId: id, action: 'skipped', why: 'not returned by YouTube (private or deleted)' });
    }
  }

  // Load classifier rules once for the whole batch.
  const rules = await loadRules();

  for (const meta of metas) {
    try {
      let channel = await findChannel(meta.ytChannelId);
      if (!channel) {
        if (!config.ingest.autoAddChannels) {
          summary.skipped += 1;
          summary.results.push({
            ytVideoId: meta.ytVideoId,
            action: 'skipped',
            why: `channel ${meta.ytChannelId} is not in the channels table`
          });
          continue;
        }
        channel = await autoAddChannel(meta);
      }

      if (meta.privacyStatus && meta.privacyStatus !== 'public') {
        summary.skipped += 1;
        summary.results.push({ ytVideoId: meta.ytVideoId, action: 'skipped', why: 'not public' });
        continue;
      }

      // The governing body is part of the evidence, so hand it to the classifier.
      const topics = await classify({ ...meta, govBody: channel.gov_body }, { rules });

      const action = await tx(async (client) => {
        const existing = await client.query('SELECT id FROM videos WHERE yt_video_id = $1', [meta.ytVideoId]);
        const isNew = existing.rowCount === 0;

        const { rows } = await client.query(
          `INSERT INTO videos
             (yt_video_id, channel_id, title, description, published_at, duration_seconds,
              thumbnail_url, view_count, status, scheduled_start_at, actual_start_at,
              actual_end_at, raw, classified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
           ON CONFLICT (yt_video_id) DO UPDATE SET
             title              = EXCLUDED.title,
             description        = EXCLUDED.description,
             published_at       = EXCLUDED.published_at,
             duration_seconds   = COALESCE(EXCLUDED.duration_seconds, videos.duration_seconds),
             thumbnail_url      = EXCLUDED.thumbnail_url,
             view_count         = EXCLUDED.view_count,
             status             = EXCLUDED.status,
             scheduled_start_at = EXCLUDED.scheduled_start_at,
             actual_start_at    = EXCLUDED.actual_start_at,
             actual_end_at      = EXCLUDED.actual_end_at,
             raw                = EXCLUDED.raw,
             classified_at      = now()
           RETURNING id`,
          [
            meta.ytVideoId, channel.id, meta.title, meta.description, meta.publishedAt,
            meta.durationSeconds, meta.thumbnailUrl, meta.viewCount, meta.status,
            meta.scheduledStartAt, meta.actualStartAt, meta.actualEndAt, JSON.stringify(meta.raw)
          ]
        );
        const videoId = rows[0].id;

        // Replace tags wholesale — reclassification should never leave stale topics.
        await client.query('DELETE FROM video_topics WHERE video_id = $1', [videoId]);
        for (const t of topics) {
          await client.query(
            `INSERT INTO video_topics (video_id, topic_id, score, matched_terms, source)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (video_id, topic_id) DO UPDATE
               SET score = EXCLUDED.score, matched_terms = EXCLUDED.matched_terms`,
            [videoId, t.topicId, t.score, t.matchedTerms, t.source]
          );
        }
        return isNew ? 'inserted' : 'updated';
      });

      summary[action] += 1;
      summary.results.push({
        ytVideoId: meta.ytVideoId,
        action,
        title: meta.title,
        municipality: channel.municipality,
        status: meta.status,
        topics: topics.map((t) => t.slug)
      });
      log.info('ingested video', {
        id: meta.ytVideoId, action, reason, status: meta.status,
        town: channel.municipality, topics: topics.map((t) => t.slug).join(',') || 'none'
      });
    } catch (err) {
      summary.skipped += 1;
      summary.results.push({ ytVideoId: meta.ytVideoId, action: 'error', why: err.message });
      log.error('ingest failed', { id: meta.ytVideoId, err: err.message });
    }
  }

  return summary;
}

/** Mark a video hidden when YouTube tells us the entry was deleted. */
async function markDeleted(ytVideoId) {
  await query('UPDATE videos SET is_hidden = TRUE WHERE yt_video_id = $1', [ytVideoId]);
  log.info('video marked hidden after delete notification', { id: ytVideoId });
}

/** Re-run classification over videos already in the database (after rule edits). */
async function reclassifyAll({ limit = 500 } = {}) {
  const rows = (await query(
    `SELECT v.yt_video_id, v.title, v.description, v.raw, c.gov_body
       FROM videos v JOIN channels c ON c.id = v.channel_id
      WHERE NOT v.is_hidden ORDER BY v.published_at DESC NULLS LAST LIMIT $1`,
    [limit]
  )).rows;
  const rules = await loadRules({ force: true });
  let tagged = 0;

  for (const row of rows) {
    const raw = row.raw || {};
    const meta = {
      ytVideoId: row.yt_video_id,
      title: row.title,
      description: row.description,
      tags: (raw.snippet && raw.snippet.tags) || [],
      govBody: row.gov_body
    };
    const topics = await classify(meta, { rules });
    await tx(async (client) => {
      const { rows: v } = await client.query('SELECT id FROM videos WHERE yt_video_id = $1', [row.yt_video_id]);
      if (!v[0]) return;
      await client.query('DELETE FROM video_topics WHERE video_id = $1', [v[0].id]);
      for (const t of topics) {
        await client.query(
          `INSERT INTO video_topics (video_id, topic_id, score, matched_terms, source)
           VALUES ($1,$2,$3,$4,$5)`,
          [v[0].id, t.topicId, t.score, t.matchedTerms, t.source]
        );
      }
      await client.query('UPDATE videos SET classified_at = now() WHERE id = $1', [v[0].id]);
    });
    if (topics.length) tagged += 1;
  }
  log.info('reclassified', { videos: rows.length, tagged });
  return { videos: rows.length, tagged };
}

module.exports = { ingestVideoIds, markDeleted, reclassifyAll, findChannel };
