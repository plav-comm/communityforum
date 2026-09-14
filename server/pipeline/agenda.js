/**
 * Agenda ingestion and matching.
 *
 * Three jobs:
 *   1. discover  — probe candidate client codes and record which towns we can read
 *   2. sync      — pull recent meeting agendas for channels that have a source
 *   3. match     — tie each video to its meeting agenda, then re-tag it using
 *                  the agenda text
 *
 * Matching is the delicate part. A video and an agenda are the same meeting when
 * they belong to the same town, fall on the same calendar day, and their body
 * names agree. We require the date to line up and use body-name overlap to break
 * ties, then record the link so it can be audited.
 */
const { query, one, many, tx } = require('../db');
const { getAdapter, vendors } = require('../lib/agenda');
const { classify, loadRules } = require('./classify');
const log = require('../lib/log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   1. DISCOVERY — build the catalogue of readable towns
   ============================================================ */

/**
 * Probe candidate client codes for one vendor and record what answers.
 * Deliberately polite: one request at a time with a delay. This is a
 * once-in-a-while job, not something that runs on the request path.
 */
async function discover(vendor, candidates, { delayMs = 220, names = {}, onProgress } = {}) {
  const adapter = getAdapter(vendor);
  const out = { vendor, probed: 0, found: 0, failed: 0 };

  for (const code of candidates) {
    out.probed += 1;
    try {
      const info = await adapter.verify(code);
      const meetings = await adapter.listMeetings(code, { limit: 5 }).catch(() => []);
      const latest = meetings.find((m) => m.meetingAt);

      await query(
        `INSERT INTO agenda_sources
           (vendor, client_code, display_name, bodies, meetings_seen,
            latest_meeting_at, is_available, last_verified_at, last_error)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,now(),NULL)
         ON CONFLICT (vendor, client_code) DO UPDATE SET
           display_name      = COALESCE(EXCLUDED.display_name, agenda_sources.display_name),
           bodies            = EXCLUDED.bodies,
           meetings_seen     = EXCLUDED.meetings_seen,
           latest_meeting_at = EXCLUDED.latest_meeting_at,
           is_available      = TRUE,
           last_verified_at  = now(),
           last_error        = NULL`,
        [
          vendor, code, names[code] || null,
          JSON.stringify(info.bodies || []),
          meetings.length,
          latest ? latest.meetingAt : null
        ]
      );
      out.found += 1;
      if (onProgress) onProgress({ code, ok: true, bodies: (info.bodies || []).length });
    } catch (err) {
      out.failed += 1;
      // A 404 just means "this town is not on this platform" — not worth storing.
      if (err.status && err.status !== 404) {
        await query(
          `INSERT INTO agenda_sources (vendor, client_code, display_name, is_available, last_verified_at, last_error)
           VALUES ($1,$2,$3,FALSE,now(),$4)
           ON CONFLICT (vendor, client_code) DO UPDATE SET
             is_available = FALSE, last_verified_at = now(), last_error = EXCLUDED.last_error`,
          [vendor, code, names[code] || null, String(err.message).slice(0, 300)]
        ).catch(() => {});
      }
      if (onProgress) onProgress({ code, ok: false, why: err.message });
    }
    if (delayMs) await sleep(delayMs);
  }
  return out;
}

/* ============================================================
   2. SYNC — pull agendas for a channel
   ============================================================ */

async function syncChannelAgendas(channel, { limit = 25, fetchItems = true, from, to } = {}) {
  if (!channel.agenda_vendor || !channel.agenda_client) {
    return { skipped: true, why: 'channel has no agenda source configured' };
  }
  const adapter = getAdapter(channel.agenda_vendor);
  const out = { meetings: 0, items: 0, errors: 0 };

  let meetings;
  try {
    meetings = await adapter.listMeetings(channel.agenda_client, { limit, from, to });
  } catch (err) {
    await query('UPDATE channels SET agenda_last_error = $2 WHERE id = $1', [channel.id, err.message]);
    throw err;
  }

  for (const m of meetings) {
    try {
      const items = fetchItems && m.hasAgenda
        ? await adapter.listItems(channel.agenda_client, m.externalId, m)
        : [];

      const agendaText = items.map((i) => i.title).join('\n').slice(0, 60000);

      const row = await one(
        `INSERT INTO agenda_meetings
           (vendor, client_code, external_id, channel_id, body_name, title,
            meeting_date, meeting_at, agenda_url, item_count, agenda_text, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (vendor, client_code, external_id) DO UPDATE SET
           channel_id   = EXCLUDED.channel_id,
           body_name    = EXCLUDED.body_name,
           title        = EXCLUDED.title,
           meeting_date = EXCLUDED.meeting_date,
           meeting_at   = EXCLUDED.meeting_at,
           agenda_url   = EXCLUDED.agenda_url,
           item_count   = GREATEST(EXCLUDED.item_count, agenda_meetings.item_count),
           agenda_text  = COALESCE(NULLIF(EXCLUDED.agenda_text, ''), agenda_meetings.agenda_text),
           fetched_at   = now()
         RETURNING id`,
        [
          channel.agenda_vendor, channel.agenda_client, m.externalId, channel.id,
          m.bodyName, m.title, m.meetingDate, m.meetingAt, m.agendaUrl,
          items.length, agendaText
        ]
      );

      if (items.length) {
        await tx(async (client) => {
          await client.query('DELETE FROM agenda_items WHERE meeting_id = $1', [row.id]);
          for (const it of items) {
            await client.query(
              `INSERT INTO agenda_items (meeting_id, position, title, matter_type, action)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (meeting_id, position) DO NOTHING`,
              [row.id, it.position, it.title, it.matterType, it.action]
            );
          }
        });
        out.items += items.length;
      }
      out.meetings += 1;
    } catch (err) {
      out.errors += 1;
      log.warn('agenda meeting sync failed', {
        town: channel.municipality, id: m.externalId, err: err.message
      });
    }
  }

  await query(
    'UPDATE channels SET agenda_synced_at = now(), agenda_last_error = NULL WHERE id = $1',
    [channel.id]
  );
  log.info('agenda sync', {
    town: channel.municipality, vendor: channel.agenda_vendor,
    meetings: out.meetings, items: out.items
  });
  return out;
}

async function syncAllAgendas({ limit = 25 } = {}) {
  const channels = await many(
    `SELECT * FROM channels
      WHERE is_active AND agenda_vendor IS NOT NULL AND agenda_client IS NOT NULL
      ORDER BY agenda_synced_at NULLS FIRST`
  );
  const out = { channels: channels.length, meetings: 0, items: 0, errors: 0 };
  for (const c of channels) {
    try {
      const r = await syncChannelAgendas(c, { limit });
      out.meetings += r.meetings || 0;
      out.items += r.items || 0;
      out.errors += r.errors || 0;
    } catch (err) {
      out.errors += 1;
      log.error('agenda sync failed for channel', { town: c.municipality, err: err.message });
    }
  }
  return out;
}

/* ============================================================
   3. MATCH — tie a video to its agenda, then re-tag
   ============================================================ */

/**
 * Similarity between two governing-body names, 0..1.
 *
 * The naive version (token overlap over the smaller set) rated
 * "School Board" against "Water Utility Board" at 0.5, because they share the
 * word "board" — enough to mis-match a school board video to a water board
 * agenda on a busy municipal evening. So generic governance words are scored
 * separately from distinctive ones:
 *
 *   "City Council" vs "City Council Regular Meeting"      -> 1.00
 *   "Planning Commission" vs "Planning Commission Hearing" -> 0.90
 *   "School Board" vs "Water Utility Board"                -> 0.15
 */
const FILLER = new Set(['the', 'and', 'for', 'meeting', 'meetings', 'regular', 'special', 'session']);
const GENERIC = new Set([
  'board', 'council', 'commission', 'committee', 'city', 'town', 'county',
  'district', 'village', 'borough', 'authority', 'agency', 'body', 'select',
  'general', 'public', 'joint', 'formal'
]);

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !FILLER.has(w));
}

function overlap(A, B) {
  if (!A.size || !B.size) return 0;
  let hits = 0;
  A.forEach((w) => { if (B.has(w)) hits += 1; });
  return hits / Math.min(A.size, B.size);
}

function nameSimilarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;

  const dA = new Set([...A].filter((w) => !GENERIC.has(w)));
  const dB = new Set([...B].filter((w) => !GENERIC.has(w)));

  const all = overlap(A, B);
  // When neither name carries a distinctive word (a plain "City Council"),
  // the generic overlap is all we have and it is legitimate.
  if (!dA.size || !dB.size) return all;

  // Otherwise the distinctive words dominate: sharing "board" is nearly worthless.
  return Math.round((0.7 * overlap(dA, dB) + 0.3 * all) * 100) / 100;
}

/**
 * Find the agenda meeting for one video.
 * Same channel, same calendar day (allowing one day either side for streams that
 * cross midnight or agendas dated the following morning), best body-name match.
 */
/**
 * Make sure we have agendas covering a given date for a channel. Called by the
 * matcher when the recent page does not reach back far enough — one extra
 * request rather than pulling a town's entire history up front.
 */
async function ensureAgendaCoverage(channel, dateIso) {
  const day = new Date(dateIso).toISOString().slice(0, 10);
  const from = new Date(new Date(dateIso).getTime() - 3 * 864e5).toISOString().slice(0, 10);
  const to = new Date(new Date(dateIso).getTime() + 3 * 864e5).toISOString().slice(0, 10);
  try {
    await syncChannelAgendas(channel, { limit: 25, from, to });
    return true;
  } catch (err) {
    log.warn('targeted agenda fetch failed', { town: channel.municipality, day, err: err.message });
    return false;
  }
}

async function matchVideo(video) {
  const anchor = video.scheduled_start_at || video.actual_start_at || video.published_at;
  if (!anchor) return null;

  const candidates = await many(
    `SELECT id, body_name, title, meeting_date, item_count, agenda_text
       FROM agenda_meetings
      WHERE channel_id = $1
        AND meeting_date BETWEEN ($2::timestamptz - interval '1 day')::date
                             AND ($2::timestamptz + interval '1 day')::date
      ORDER BY item_count DESC`,
    [video.channel_id, anchor]
  );
  if (!candidates.length) return null;

  const scored = candidates.map((c) => {
    const sameDay = String(c.meeting_date).slice(0, 10) === new Date(anchor).toISOString().slice(0, 10);
    const sim = Math.max(
      nameSimilarity(c.body_name, video.title),
      nameSimilarity(c.body_name, video.gov_body),
      nameSimilarity(c.title, video.title)
    );
    return { ...c, score: (sameDay ? 1 : 0) + sim + (c.item_count ? 0.25 : 0) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  // Require either a same-day match or a strong name match — never guess.
  return best.score >= 1 || best.score >= 0.6 ? best : null;
}

/**
 * Match videos to agendas and reclassify them with the agenda text included.
 * This is what actually moves topic coverage.
 */
async function matchAndReclassify({ limit = 200, onlyUnmatched = false } = {}) {
  const rows = await many(
    `SELECT v.id, v.yt_video_id, v.channel_id, v.title, v.description, v.raw,
            v.published_at, v.scheduled_start_at, v.actual_start_at,
            c.gov_body, c.municipality
       FROM videos v
       JOIN channels c ON c.id = v.channel_id
      WHERE NOT v.is_hidden
        AND c.agenda_vendor IS NOT NULL
        ${onlyUnmatched ? 'AND v.agenda_meeting_id IS NULL' : ''}
      ORDER BY v.published_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );

  const rules = await loadRules({ force: true });
  const out = { considered: rows.length, matched: 0, retagged: 0, unmatched: 0 };

  // Channels keyed by id, so a miss can trigger one targeted agenda fetch.
  const channelById = new Map(
    (await many('SELECT * FROM channels WHERE agenda_vendor IS NOT NULL')).map((c) => [c.id, c])
  );

  for (const v of rows) {
    let meeting = await matchVideo(v);

    if (!meeting) {
      // Nothing on file for that date — go and get it, then try once more.
      const channel = channelById.get(v.channel_id);
      const anchor = v.scheduled_start_at || v.actual_start_at || v.published_at;
      if (channel && anchor && await ensureAgendaCoverage(channel, anchor)) {
        meeting = await matchVideo(v);
        out.targetedFetches = (out.targetedFetches || 0) + 1;
      }
    }

    if (!meeting) {
      out.unmatched += 1;
      continue;
    }

    const raw = v.raw || {};
    const topics = await classify({
      ytVideoId: v.yt_video_id,
      title: v.title,
      description: v.description,
      tags: (raw.snippet && raw.snippet.tags) || [],
      govBody: v.gov_body,
      agendaText: meeting.agenda_text || ''
    }, { rules });

    await tx(async (client) => {
      await client.query(
        'UPDATE videos SET agenda_meeting_id = $2, agenda_matched_at = now() WHERE id = $1',
        [v.id, meeting.id]
      );
      await client.query('DELETE FROM video_topics WHERE video_id = $1', [v.id]);
      for (const t of topics) {
        await client.query(
          `INSERT INTO video_topics (video_id, topic_id, score, matched_terms, source)
           VALUES ($1,$2,$3,$4,$5)`,
          [v.id, t.topicId, t.score, t.matchedTerms, t.source]
        );
      }
      await client.query('UPDATE videos SET classified_at = now() WHERE id = $1', [v.id]);
    });

    out.matched += 1;
    if (topics.some((t) => t.source === 'agenda')) out.retagged += 1;
    log.info('agenda matched', {
      town: v.municipality, video: v.yt_video_id, items: meeting.item_count,
      topics: topics.map((t) => t.slug).join(',')
    });
  }
  return out;
}

module.exports = {
  discover,
  ensureAgendaCoverage,
  syncChannelAgendas,
  syncAllAgendas,
  matchVideo,
  matchAndReclassify,
  nameSimilarity,
  vendors
};
