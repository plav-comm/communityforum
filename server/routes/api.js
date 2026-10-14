/**
 * Public read API consumed by the front end.
 *
 *   GET /api/health                 service + database status
 *   GET /api/topics                 topic list with live counts
 *   GET /api/filters                everything the dropdowns need, in one call
 *   GET /api/videos                 the main query: filter, search, sort, page
 *   GET /api/videos/:ytVideoId      one video
 *   GET /api/channels               monitored channels and subscription health
 *   GET /api/stats                  headline numbers for the site
 */
const express = require('express');
const { many, one } = require('../db');
const log = require('../lib/log');

const router = express.Router();

const clampInt = (v, dflt, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
};

const SORTS = {
  newest: 'published_at DESC NULLS LAST',
  oldest: 'published_at ASC NULLS LAST',
  longest: 'duration_seconds DESC NULLS LAST',
  shortest: 'duration_seconds ASC NULLS LAST',
  'population-desc': "array_position(ARRAY['xs','sm','md','lg','xl'], size_tier) DESC, published_at DESC",
  'population-asc': "array_position(ARRAY['xs','sm','md','lg','xl'], size_tier) ASC, published_at DESC",
  town: 'municipality ASC, published_at DESC'
};

/* ---------------- health ---------------- */
router.get('/health', async (req, res) => {
  try {
    const row = await one('SELECT now() AS db_time, count(*)::int AS videos FROM videos');
    res.json({
      ok: true,
      service: 'townhallmeetings-api',
      dbTime: row.db_time,
      videos: row.videos,
      uptimeSeconds: Math.round(process.uptime())
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database unavailable', detail: err.message });
  }
});

/* ---------------- topics ---------------- */
router.get('/topics', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT t.slug, t.label, t.description, t.sort_order, t.show_in_trending,
              count(vt.video_id)::int AS video_count
         FROM topics t
         LEFT JOIN video_topics vt ON vt.topic_id = t.id
         LEFT JOIN videos v ON v.id = vt.video_id AND NOT v.is_hidden
        WHERE t.is_active
        GROUP BY t.id, t.slug, t.label, t.description, t.sort_order, t.show_in_trending
        ORDER BY count(vt.video_id) DESC, t.sort_order`
    );
    res.json({ topics: rows });
  } catch (err) { next(err); }
});

/* ---------------- filters (one call feeds every dropdown) ----------------
   Deliberately ONE query rather than five parallel ones: the front end needs
   all of this before it can paint the filter bar, and a single round trip is
   both faster and kinder to the connection pool. Each dropdown's options come
   back as a ready-to-use JSON array.
   ------------------------------------------------------------------------ */
router.get('/filters', async (req, res, next) => {
  try {
    const row = await one(`
      WITH v AS (SELECT * FROM v_videos_public)
      SELECT
        (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'), '[]'::jsonb) FROM (
           SELECT DISTINCT jsonb_build_object('code', state_code, 'name', state_name) AS x FROM v
         ) s)                                                         AS states,
        (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'), '[]'::jsonb) FROM (
           SELECT DISTINCT jsonb_build_object('state', state_code, 'name', county) AS x
             FROM v WHERE county IS NOT NULL
         ) c)                                                         AS counties,
        (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'), '[]'::jsonb) FROM (
           SELECT DISTINCT jsonb_build_object(
             'state', state_code, 'county', county, 'name', municipality) AS x FROM v
         ) m)                                                         AS cities,
        (SELECT COALESCE(jsonb_agg(DISTINCT gov_body ORDER BY gov_body), '[]'::jsonb) FROM v) AS bodies,
        (SELECT COALESCE(jsonb_agg(t ORDER BY array_position(ARRAY['xs','sm','md','lg','xl'], t)), '[]'::jsonb)
           FROM (SELECT DISTINCT size_tier AS t FROM v WHERE size_tier IS NOT NULL) z) AS size_tiers
    `);

    res.set('cache-control', 'public, max-age=120');
    res.json({
      states: row.states,
      counties: row.counties,
      cities: row.cities,
      bodies: row.bodies,
      sizeTiers: row.size_tiers,
      sorts: Object.keys(SORTS)
    });
  } catch (err) { next(err); }
});

/* ---------------- videos ---------------- */
router.get('/videos', async (req, res, next) => {
  try {
    const {
      topic, state, county, city, body, tier, status, q, sort = 'newest'
    } = req.query;

    const limit = clampInt(req.query.limit, 24, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const orderBy = SORTS[sort] || SORTS.newest;

    const where = [];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

    // `topic` accepts a comma-separated list: ?topic=budget-taxes,public-safety
    if (topic) {
      const slugs = String(topic).split(',').map((s) => s.trim()).filter(Boolean);
      if (slugs.length) {
        params.push(slugs);
        where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(topics) e
                             WHERE e->>'slug' = ANY($${params.length}::text[]))`);
      }
    }
    if (state)  add('state_code = ?', String(state).toUpperCase());
    if (county) add('county = ?', county);
    if (city)   add('municipality = ?', city);
    if (body)   add('gov_body = ?', body);
    if (tier)   add('size_tier = ?', tier);
    if (status) {
      const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      params.push(list);
      where.push(`status = ANY($${params.length}::text[])`);
    }
    if (q && String(q).trim()) {
      params.push(String(q).trim());
      const i = params.length;
      // Full-text match on title+description, OR a plain match on place names.
      where.push(`(search_tsv @@ websearch_to_tsquery('english', $${i})
                   OR municipality ILIKE '%' || $${i} || '%'
                   OR county ILIKE '%' || $${i} || '%'
                   OR state_name ILIKE '%' || $${i} || '%'
                   OR channel_name ILIKE '%' || $${i} || '%')`);
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRow = await one(`SELECT count(*)::int AS total FROM v_videos_public ${whereSql}`, params);

    params.push(limit, offset);
    const rows = await many(
      `SELECT yt_video_id, title, description, published_at, duration_seconds, thumbnail_url,
              view_count, status, scheduled_start_at, actual_start_at,
              yt_channel_id, channel_name, municipality, county, state_code, state_name,
              gov_body, population, size_tier, topics,
              agenda_meeting_id, agenda_url, agenda_item_count
         FROM v_videos_public
         ${whereSql}
        ORDER BY ${orderBy}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.set('cache-control', 'public, max-age=30');
    res.json({
      total: countRow.total,
      limit,
      offset,
      count: rows.length,
      items: rows.map(shapeVideo)
    });
  } catch (err) { next(err); }
});

router.get('/videos/:ytVideoId', async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM v_videos_public WHERE yt_video_id = $1', [req.params.ytVideoId]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(shapeVideo(row));
  } catch (err) { next(err); }
});

/* ---------------- channels ---------------- */
router.get('/channels', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT c.yt_channel_id, c.name, c.municipality, c.county, c.state_code, c.state_name,
              c.gov_body, c.population, c.size_tier, c.is_active,
              c.websub_state, c.websub_expires_at, c.last_backfilled_at,
              count(v.id)::int AS video_count,
              max(v.published_at) AS latest_video_at
         FROM channels c
         LEFT JOIN videos v ON v.channel_id = c.id AND NOT v.is_hidden
        GROUP BY c.id
        ORDER BY c.state_code, c.municipality`
    );
    res.json({ channels: rows });
  } catch (err) { next(err); }
});

/* ---------------- agenda source directory ----------------
   The catalogue of towns whose agenda system we can read. This is what makes
   "add a town by picking it from a list" possible.
     GET /api/agenda-sources?q=austin&vendor=legistar&limit=50
   ------------------------------------------------------------------- */
router.get('/agenda-sources', async (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const params = [];
    const where = ['is_available'];
    if (req.query.vendor) {
      params.push(String(req.query.vendor).toLowerCase());
      where.push(`vendor = $${params.length}`);
    }
    if (req.query.q && String(req.query.q).trim()) {
      params.push('%' + String(req.query.q).trim() + '%');
      const i = params.length;
      where.push(`(display_name ILIKE $${i} OR client_code ILIKE $${i} OR bodies::text ILIKE $${i})`);
    }
    // Exclude towns already being monitored, so the picker only offers new ones.
    if (String(req.query.available_only || '') === 'true') {
      where.push(`NOT EXISTS (SELECT 1 FROM channels c
                               WHERE c.agenda_vendor = agenda_sources.vendor
                                 AND c.agenda_client = agenda_sources.client_code)`);
    }
    params.push(limit);

    const rows = await many(
      `SELECT vendor, client_code, display_name, state_code, bodies,
              meetings_seen, latest_meeting_at, last_verified_at,
              EXISTS (SELECT 1 FROM channels c
                       WHERE c.agenda_vendor = agenda_sources.vendor
                         AND c.agenda_client = agenda_sources.client_code) AS already_monitored
         FROM agenda_sources
        WHERE ${where.join(' AND ')}
        ORDER BY display_name NULLS LAST, client_code
        LIMIT $${params.length}`,
      params
    );
    const totals = await many(
      `SELECT vendor, count(*)::int AS n FROM agenda_sources WHERE is_available GROUP BY vendor`
    );
    res.set('cache-control', 'public, max-age=300');
    res.json({
      totals: totals.reduce((a, r) => ({ ...a, [r.vendor]: r.n }), {}),
      count: rows.length,
      sources: rows.map((r) => ({
        vendor: r.vendor,
        clientCode: r.client_code,
        displayName: r.display_name || r.client_code,
        stateCode: r.state_code,
        bodies: r.bodies || [],
        meetingsSeen: r.meetings_seen,
        latestMeetingAt: r.latest_meeting_at,
        verifiedAt: r.last_verified_at,
        alreadyMonitored: r.already_monitored
      }))
    });
  } catch (err) { next(err); }
});

/** The agenda behind one meeting — item list included. */
router.get('/videos/:ytVideoId/agenda', async (req, res, next) => {
  try {
    const row = await one(
      `SELECT am.id, am.body_name, am.title, am.meeting_date, am.agenda_url,
              am.item_count, am.vendor
         FROM videos v
         JOIN agenda_meetings am ON am.id = v.agenda_meeting_id
        WHERE v.yt_video_id = $1 AND NOT v.is_hidden`,
      [req.params.ytVideoId]
    );
    if (!row) return res.status(404).json({ error: 'no agenda matched to this meeting' });
    const items = await many(
      'SELECT position, title, matter_type, action FROM agenda_items WHERE meeting_id = $1 ORDER BY position',
      [row.id]
    );
    res.json({
      bodyName: row.body_name,
      title: row.title,
      meetingDate: row.meeting_date,
      agendaUrl: row.agenda_url,
      vendor: row.vendor,
      itemCount: row.item_count,
      items: items.map((i) => ({
        position: i.position, title: i.title, matterType: i.matter_type, action: i.action
      }))
    });
  } catch (err) { next(err); }
});

/* ---------------- stats ---------------- */
router.get('/stats', async (req, res, next) => {
  try {
    const row = await one(
      `SELECT
         (SELECT count(*)::int FROM videos v JOIN channels c ON c.id = v.channel_id
           WHERE NOT v.is_hidden AND c.is_active)                        AS videos,
         (SELECT count(*)::int FROM channels WHERE is_active)            AS channels,
         (SELECT count(DISTINCT state_code)::int FROM v_videos_public)   AS states,
         (SELECT count(DISTINCT municipality)::int FROM v_videos_public) AS municipalities,
         (SELECT count(*)::int FROM v_videos_public WHERE status = 'live')     AS live_now,
         (SELECT count(*)::int FROM v_videos_public WHERE status = 'upcoming') AS upcoming,
         (SELECT count(*)::int FROM v_videos_public
           WHERE published_at > now() - interval '7 days')               AS added_this_week,
         (SELECT COALESCE(round(sum(duration_seconds) / 3600.0), 0)::int
            FROM v_videos_public)                                        AS archive_hours,
         -- distinct meetings carrying at least one real subject tag (a
         -- fallback tag such as General Session does not count)
         (SELECT count(DISTINCT v.id)::int
            FROM videos v
            JOIN channels c ON c.id = v.channel_id
            JOIN video_topics vt ON vt.video_id = v.id
            JOIN topics t ON t.id = vt.topic_id
           WHERE NOT v.is_hidden AND c.is_active AND NOT t.is_fallback)  AS tagged_videos,
         (SELECT count(*)::int FROM videos v JOIN channels c ON c.id = v.channel_id
           WHERE NOT v.is_hidden AND c.is_active AND v.agenda_meeting_id IS NOT NULL)
                                                                         AS agenda_backed_videos,
         (SELECT count(*)::int FROM agenda_sources WHERE is_available)    AS agenda_sources_available`
    );
    const lastJob = await one(
      `SELECT job_name, started_at, finished_at, ok FROM job_runs
        ORDER BY started_at DESC LIMIT 1`
    );
    res.json({ ...row, lastJob });
  } catch (err) { next(err); }
});

/** Consistent camelCase shape so the front end never deals with SQL column names. */
function shapeVideo(r) {
  return {
    ytVideoId: r.yt_video_id,
    title: r.title,
    description: r.description ? String(r.description).slice(0, 600) : '',
    publishedAt: r.published_at,
    durationSeconds: r.duration_seconds,
    thumbnailUrl: r.thumbnail_url,
    viewCount: r.view_count,
    status: r.status,
    scheduledStartAt: r.scheduled_start_at,
    actualStartAt: r.actual_start_at,
    channel: {
      ytChannelId: r.yt_channel_id,
      name: r.channel_name
    },
    place: {
      municipality: r.municipality,
      county: r.county,
      stateCode: r.state_code,
      stateName: r.state_name,
      population: r.population,
      sizeTier: r.size_tier
    },
    govBody: r.gov_body,
    agenda: r.agenda_meeting_id
      ? { itemCount: r.agenda_item_count, url: r.agenda_url }
      : null,
    topics: r.topics || []
  };
}

module.exports = router;
