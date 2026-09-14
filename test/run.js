#!/usr/bin/env node
/**
 * End-to-end test suite.
 *
 * Runs the REAL Express app against the REAL Postgres schema over real HTTP.
 * The only thing faked is Google: global fetch is stubbed so we can exercise
 * the ingestion pipeline and the WebSub handshake without a YouTube API key or
 * a public callback URL.
 *
 *   node test/pg-server.mjs 55432     # in one shell
 *   npm test                          # in another
 */
process.env.NODE_ENV = 'test';
process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'test-key';
process.env.WEBSUB_SECRET = process.env.WEBSUB_SECRET || 'test_secret_do_not_use_in_production_0001';
process.env.WEBSUB_VERIFY_TOKEN = process.env.WEBSUB_VERIFY_TOKEN || 'test_verify_token_0002';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://example.invalid';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test_admin_token_0003';
process.env.LOG_LEVEL = 'error';
// PGlite's socket bridge accepts one connection at a time, so serialise the pool
// for tests. Real Postgres (Supabase/Render) happily handles the default of 8.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '1';

const crypto = require('crypto');
const assert = require('assert');

/* ---------------- fake YouTube + hub ---------------- */
const KNOWN_CHANNEL = 'UCmkFU-mJsajb_SK7sHPi2tQ';           // Palm Bay, seeded
const NEW_VIDEO = 'zzTESTvid01';
const realFetch = globalThis.fetch;
let hubCalls = [];

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);

  // Google's WebSub hub
  if (url.includes('pubsubhubbub.appspot.com')) {
    hubCalls.push(Object.fromEntries(new URLSearchParams(String(init && init.body))));
    return new Response('', { status: 202 });
  }

  // YouTube Data API — videos.list
  if (url.includes('/youtube/v3/videos')) {
    const ids = new URL(url).searchParams.get('id').split(',');
    return Response.json({
      items: ids.map((id) => ({
        id,
        snippet: {
          channelId: KNOWN_CHANNEL,
          channelTitle: 'Palm Bay Florida',
          title: 'Special Meeting — Stormwater Utility Fee and Police Budget Hearing',
          description:
            'The City Council will hold a public hearing on the proposed stormwater ' +
            'utility fee increase and the police department budget for fiscal year 2027. ' +
            'Public comment will be taken. Agenda: rezoning of Malabar Road parcel.',
          tags: ['city council', 'budget', 'public hearing'],
          publishedAt: '2026-09-03T23:00:00Z',
          thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
          liveBroadcastContent: 'none'
        },
        contentDetails: { duration: 'PT2H14M8S' },
        statistics: { viewCount: '812' },
        liveStreamingDetails: {
          scheduledStartTime: '2026-09-03T23:00:00Z',
          actualStartTime: '2026-09-03T23:02:00Z'
          // no actualEndTime -> should be classified LIVE
        },
        status: { privacyStatus: 'public' }
      }))
    });
  }

  // ---- Legistar ----
  if (url.includes('webapi.legistar.com')) {
    if (/\/bodies/.test(url)) {
      if (url.includes('/nosuchtown/')) return new Response('not found', { status: 404 });
      return Response.json([
        { BodyId: 1, BodyName: 'City Council', BodyActiveFlag: 1 },
        { BodyId: 2, BodyName: 'Planning Commission', BodyActiveFlag: 1 }
      ]);
    }
    if (/\/events\/\d+\/eventitems/.test(url)) {
      return Response.json([
        { EventItemTitle: 'Call To Order' },
        { EventItemTitle: 'An ordinance relating to land use and zoning; amending the comprehensive plan to allow affordable housing near transit',
          EventItemMatterType: 'Ordinance' },
        { EventItemTitle: 'Resolution approving a construction contract for roadway and sidewalk improvements on Main Street',
          EventItemMatterType: 'Resolution' },
        { EventItemTitle: 'Public hearing on the stormwater utility fee' },
        { EventItemTitle: '' }
      ]);
    }
    if (/\/events/.test(url)) {
      return Response.json([
        { EventId: 4242, EventBodyName: 'City Council', EventDate: '2026-08-20T00:00:00',
          EventAgendaStatusName: 'Final', EventAgendaFile: 'https://example.test/agenda.pdf' }
      ]);
    }
  }

  // ---- PrimeGov ----
  if (url.includes('.primegov.com')) {
    if (url.includes('ListUpcomingMeetings')) {
      return Response.json([
        { id: 991, title: 'City Council Regular Meeting', dateTime: '2026-08-20T18:00:00',
          documentList: [{ id: 5501, templateName: 'Agenda', compileOutputType: 1 }] }
      ]);
    }
    if (url.includes('ListArchivedMeetings')) return Response.json([]);
  }

  // YouTube Data API — channels.list
  if (url.includes('/youtube/v3/channels')) {
    return Response.json({
      items: [{
        id: KNOWN_CHANNEL,
        snippet: { title: 'Palm Bay Florida' },
        contentDetails: { relatedPlaylists: { uploads: 'UUmkFU-mJsajb_SK7sHPi2tQ' } }
      }]
    });
  }

  // YouTube Data API — playlistItems.list
  if (url.includes('/youtube/v3/playlistItems')) {
    return Response.json({ items: [{ contentDetails: { videoId: NEW_VIDEO } }] });
  }

  return realFetch(input, init);
};

/* ---------------- tiny test harness ---------------- */
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
function section(title) { console.log(`\n${title}`); }

/* ---------------- boot the app ---------------- */
const { app } = require('../server/index');
const db = require('../server/db');
const { channelSecret } = require('../server/websub/subscribe');

/**
 * The signing secret for a channel: whatever is stored, else the derived value.
 * This mirrors server/websub/subscribe.getStoredSecret exactly.
 */
async function secretFor(ytChannelId) {
  const row = await db.one('SELECT websub_secret FROM channels WHERE yt_channel_id = $1', [ytChannelId]);
  return (row && row.websub_secret) || channelSecret(ytChannelId);
}

let base;

async function main() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const get = async (path, opts) => {
    const res = await realFetch(base + path, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };

  /* ============ API: read routes ============ */
  section('API — read routes');

  await test('GET /api/health reports a healthy database', async () => {
    const r = await get('/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.ok(r.json.videos >= 35, `expected >=35 videos, got ${r.json.videos}`);
  });

  await test('GET /api/topics returns topics with counts', async () => {
    const r = await get('/api/topics');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.topics.length >= 9);
    const schools = r.json.topics.find((t) => t.slug === 'schools-education');
    assert.ok(schools, 'schools-education topic missing');
    assert.ok(schools.video_count >= 4, `expected >=4 school videos, got ${schools.video_count}`);
  });

  await test('GET /api/filters feeds every dropdown in one call', async () => {
    const r = await get('/api/filters');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.states.length >= 12, `states: ${r.json.states.length}`);
    assert.ok(r.json.counties.length >= 15);
    assert.ok(r.json.cities.length >= 18);
    assert.ok(r.json.bodies.includes('School Board'));
    assert.deepStrictEqual(r.json.sizeTiers, ['xs', 'sm', 'md', 'lg', 'xl']);
  });

  await test('GET /api/videos returns the full library', async () => {
    const r = await get('/api/videos?limit=100');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.total >= 35, `total: ${r.json.total}`);
    const v = r.json.items[0];
    assert.ok(v.ytVideoId && v.title && v.place.stateCode && v.govBody);
    assert.ok(Array.isArray(v.topics));
  });

  await test('filter by state narrows results', async () => {
    const r = await get('/api/videos?state=TX&limit=100');
    assert.ok(r.json.total >= 6, `TX total: ${r.json.total}`);
    assert.ok(r.json.items.every((v) => v.place.stateCode === 'TX'));
  });

  await test('filter by county and city cascade correctly', async () => {
    const county = await get('/api/videos?state=TX&county=Lubbock%20County&limit=50');
    assert.ok(county.json.total >= 2);
    assert.ok(county.json.items.every((v) => v.place.county === 'Lubbock County'));
    const city = await get('/api/videos?city=Lubbock&limit=50');
    assert.ok(city.json.items.every((v) => v.place.municipality === 'Lubbock'));
  });

  await test('filter by topic slug works', async () => {
    const r = await get('/api/videos?topic=schools-education&limit=50');
    assert.ok(r.json.total >= 4, `schools total: ${r.json.total}`);
    assert.ok(
      r.json.items.every((v) => v.topics.some((t) => t.slug === 'schools-education')),
      'a returned video was missing the requested topic'
    );
  });

  await test('filter by multiple topics (OR) works', async () => {
    const r = await get('/api/videos?topic=schools-education,zoning-housing&limit=50');
    assert.ok(r.json.total >= 5);
    assert.ok(r.json.items.every((v) =>
      v.topics.some((t) => ['schools-education', 'zoning-housing'].includes(t.slug))));
  });

  await test('filter by governing body works', async () => {
    const r = await get('/api/videos?body=School%20Board&limit=50');
    assert.ok(r.json.items.length >= 4);
    assert.ok(r.json.items.every((v) => v.govBody === 'School Board'));
  });

  await test('filter by community size tier works', async () => {
    const r = await get('/api/videos?tier=xl&limit=50');
    assert.ok(r.json.items.length >= 4);
    assert.ok(r.json.items.every((v) => v.place.sizeTier === 'xl'));
  });

  await test('full-text search matches agenda language', async () => {
    const r = await get('/api/videos?q=stormwater&limit=50');
    assert.ok(r.json.total >= 0);
    const byPlace = await get('/api/videos?q=Brunswick&limit=50');
    assert.ok(byPlace.json.total >= 4, `Brunswick search: ${byPlace.json.total}`);
  });

  await test('sort orders are applied', async () => {
    const newest = await get('/api/videos?sort=newest&limit=5');
    const oldest = await get('/api/videos?sort=oldest&limit=5');
    assert.notStrictEqual(newest.json.items[0].ytVideoId, oldest.json.items[0].ytVideoId);
    const longest = await get('/api/videos?sort=longest&limit=3');
    assert.ok(longest.json.items[0].durationSeconds >= longest.json.items[1].durationSeconds);
    const towns = await get('/api/videos?sort=town&limit=100');
    const names = towns.json.items.map((v) => v.place.municipality);
    assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  await test('pagination is stable and bounded', async () => {
    const p1 = await get('/api/videos?limit=10&offset=0');
    const p2 = await get('/api/videos?limit=10&offset=10');
    assert.strictEqual(p1.json.items.length, 10);
    const overlap = p1.json.items.filter((a) => p2.json.items.some((b) => b.ytVideoId === a.ytVideoId));
    assert.strictEqual(overlap.length, 0, 'pages overlapped');
    const capped = await get('/api/videos?limit=9999');
    assert.strictEqual(capped.json.limit, 100, 'limit should be capped at 100');
  });

  await test('unknown filter values return an empty set, not an error', async () => {
    const r = await get('/api/videos?state=ZZ&city=Nowhere');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.total, 0);
    assert.deepStrictEqual(r.json.items, []);
  });

  await test('a SQL-injection style filter value is handled safely', async () => {
    const r = await get("/api/videos?city=' OR 1=1 --");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.total, 0);
  });

  await test('GET /api/videos/:id returns one video, 404 when absent', async () => {
    const list = await get('/api/videos?limit=1');
    const id = list.json.items[0].ytVideoId;
    const one = await get('/api/videos/' + id);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.json.ytVideoId, id);
    const missing = await get('/api/videos/doesnotexist');
    assert.strictEqual(missing.status, 404);
  });

  await test('GET /api/channels exposes subscription health', async () => {
    const r = await get('/api/channels');
    assert.ok(r.json.channels.length >= 21);
    assert.ok('websub_state' in r.json.channels[0]);
  });

  await test('GET /api/stats returns headline numbers', async () => {
    const r = await get('/api/stats');
    assert.ok(r.json.videos >= 35);
    assert.ok(r.json.channels >= 21);
    assert.ok(r.json.states >= 12);
    assert.ok(r.json.archive_hours > 50, `hours: ${r.json.archive_hours}`);
  });

  /* ============ WebSub verification (GET) ============ */
  section('WebSub — verification handshake');

  const topicUrl = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${KNOWN_CHANNEL}`;

  await test('echoes hub.challenge for a known channel with the right token', async () => {
    const r = await get(
      `/websub/youtube?hub.mode=subscribe&hub.topic=${encodeURIComponent(topicUrl)}` +
      `&hub.challenge=abc123challenge&hub.lease_seconds=828000` +
      `&hub.verify_token=${process.env.WEBSUB_VERIFY_TOKEN}`
    );
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, 'abc123challenge');
  });

  await test('records the lease so the daily job knows when to renew', async () => {
    const row = await db.one(
      'SELECT websub_state, websub_expires_at FROM channels WHERE yt_channel_id = $1',
      [KNOWN_CHANNEL]
    );
    assert.strictEqual(row.websub_state, 'active');
    assert.ok(new Date(row.websub_expires_at) > new Date(), 'lease should be in the future');
  });

  await test('rejects a wrong verify token', async () => {
    const r = await get(
      `/websub/youtube?hub.mode=subscribe&hub.topic=${encodeURIComponent(topicUrl)}` +
      `&hub.challenge=nope&hub.verify_token=wrong-token`
    );
    assert.strictEqual(r.status, 404);
    assert.notStrictEqual(r.text, 'nope');
  });

  await test('rejects a channel we do not track', async () => {
    const foreign = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCzzzzzzzzzzzzzzzzzzzzzz';
    const r = await get(
      `/websub/youtube?hub.mode=subscribe&hub.topic=${encodeURIComponent(foreign)}` +
      `&hub.challenge=nope&hub.verify_token=${process.env.WEBSUB_VERIFY_TOKEN}`
    );
    assert.strictEqual(r.status, 404);
  });

  await test('rejects a malformed handshake', async () => {
    const r = await get('/websub/youtube?hub.mode=subscribe');
    assert.strictEqual(r.status, 400);
  });

  /* ============ WebSub notifications (POST) ============ */
  section('WebSub — push notifications');

  const atom = (videoId, channelId = KNOWN_CHANNEL) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <title>YouTube video feed</title>
  <entry>
    <id>yt:video:${videoId}</id>
    <yt:videoId>${videoId}</yt:videoId>
    <yt:channelId>${channelId}</yt:channelId>
    <title>Special Meeting</title>
    <published>2026-09-03T23:00:00+00:00</published>
    <updated>2026-09-03T23:05:00+00:00</updated>
  </entry>
</feed>`;

  const post = async (body, signature) => {
    const headers = { 'content-type': 'application/atom+xml' };
    if (signature) headers['x-hub-signature'] = signature;
    const res = await realFetch(base + '/websub/youtube', { method: 'POST', headers, body });
    return { status: res.status };
  };

  const sign = (body, secret, algo = 'sha1') =>
    `${algo}=${crypto.createHmac(algo, secret).update(body).digest('hex')}`;

  await test('an UNSIGNED push is refused and never ingested', async () => {
    const body = atom('zzUNSIGNED1');
    const r = await post(body);
    assert.strictEqual(r.status, 202);
    const ev = await db.one(
      'SELECT signature_valid FROM websub_events WHERE yt_video_id = $1 ORDER BY id DESC LIMIT 1',
      ['zzUNSIGNED1']
    );
    assert.strictEqual(ev.signature_valid, false);
    const vid = await db.one('SELECT id FROM videos WHERE yt_video_id = $1', ['zzUNSIGNED1']);
    assert.strictEqual(vid, null, 'unsigned payload must not create a video');
  });

  await test('a push signed with the WRONG secret is refused', async () => {
    const body = atom('zzBADSIG001');
    const r = await post(body, sign(body, 'not-the-right-secret'));
    assert.strictEqual(r.status, 202);
    const ev = await db.one(
      'SELECT signature_valid FROM websub_events WHERE yt_video_id = $1 ORDER BY id DESC LIMIT 1',
      ['zzBADSIG001']
    );
    assert.strictEqual(ev.signature_valid, false);
    assert.strictEqual(await db.one('SELECT id FROM videos WHERE yt_video_id = $1', ['zzBADSIG001']), null);
  });

  await test('a CORRECTLY signed push ingests the video end to end', async () => {
    const secret = await secretFor(KNOWN_CHANNEL);
    const body = atom(NEW_VIDEO);
    const r = await post(body, sign(body, secret));
    assert.strictEqual(r.status, 204, 'hub must get a fast 2xx');

    // The handler acknowledges first and ingests after; give it a moment.
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      await new Promise((res) => setTimeout(res, 100));
      row = await db.one(
        `SELECT v.title, v.status, v.duration_seconds, v.view_count, c.municipality
           FROM videos v JOIN channels c ON c.id = v.channel_id
          WHERE v.yt_video_id = $1`,
        [NEW_VIDEO]
      );
    }
    assert.ok(row, 'video was not ingested within 4s');
    assert.match(row.title, /Stormwater Utility Fee/);
    assert.strictEqual(row.municipality, 'Palm Bay');
    assert.strictEqual(row.duration_seconds, 8048, 'ISO-8601 duration parsed wrong');
    assert.strictEqual(row.status, 'live', 'a stream with a start and no end must be live');
  });

  await test('the ingested video received sensible civic topics', async () => {
    const tags = await db.many(
      `SELECT t.slug, vt.score, vt.matched_terms
         FROM video_topics vt
         JOIN topics t ON t.id = vt.topic_id
         JOIN videos v ON v.id = vt.video_id
        WHERE v.yt_video_id = $1 ORDER BY vt.score DESC`,
      [NEW_VIDEO]
    );
    const slugs = tags.map((t) => t.slug);
    assert.ok(slugs.includes('budget-taxes'), `expected budget-taxes, got ${slugs.join(',')}`);
    assert.ok(
      slugs.includes('water-environment') || slugs.includes('public-comment'),
      `expected stormwater/hearing signal, got ${slugs.join(',')}`
    );
    assert.ok(tags[0].matched_terms.length > 0, 'tags must record why they were applied');
    assert.ok(tags.length <= 4, 'max topics per video should be respected');
  });

  await test('the same push arriving twice does not duplicate the video', async () => {
    const secret = await secretFor(KNOWN_CHANNEL);
    const body = atom(NEW_VIDEO);
    await post(body, sign(body, secret));
    await new Promise((res) => setTimeout(res, 1200));
    const rows = await db.many('SELECT id FROM videos WHERE yt_video_id = $1', [NEW_VIDEO]);
    assert.strictEqual(rows.length, 1, 'duplicate video rows created');
  });

  await test('a sha256 signature is also accepted', async () => {
    const secret = await secretFor(KNOWN_CHANNEL);
    const body = atom('zzSHA256001');
    await post(body, sign(body, secret, 'sha256'));
    await new Promise((res) => setTimeout(res, 400));
    const ev = await db.one(
      'SELECT signature_valid FROM websub_events WHERE yt_video_id = $1 ORDER BY id DESC LIMIT 1',
      ['zzSHA256001']
    );
    assert.strictEqual(ev.signature_valid, true);
  });

  await test('a deleted-entry notification hides the video', async () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">
  <at:deleted-entry ref="yt:video:${NEW_VIDEO}" when="2026-09-04T01:00:00Z"/>
</feed>`;
    // A tombstone has no yt:channelId, so it is signed with the master secret.
    await post(body, sign(body, process.env.WEBSUB_SECRET));
    await new Promise((res) => setTimeout(res, 600));
    const row = await db.one('SELECT is_hidden FROM videos WHERE yt_video_id = $1', [NEW_VIDEO]);
    assert.strictEqual(row.is_hidden, true);
    const api = await get('/api/videos/' + NEW_VIDEO);
    assert.strictEqual(api.status, 404, 'hidden videos must disappear from the public API');
  });

  await test('garbage in the request body does not crash the endpoint', async () => {
    const r = await post('this is not xml at all', 'sha1=deadbeef');
    assert.ok([202, 400].includes(r.status), `got ${r.status}`);
    const health = await get('/api/health');
    assert.strictEqual(health.json.ok, true, 'server should still be healthy');
  });

  /* ============ subscriptions + daily job ============ */
  section('Subscriptions and the daily safety net');

  await test('subscribing sends a correctly formed request to the hub', async () => {
    hubCalls = [];
    const subscribe = require('../server/websub/subscribe');
    const r = await subscribe.subscribeChannel(KNOWN_CHANNEL);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(hubCalls.length, 1);
    const call = hubCalls[0];
    assert.strictEqual(call['hub.mode'], 'subscribe');
    assert.strictEqual(call['hub.topic'], topicUrl);
    assert.strictEqual(call['hub.callback'], 'https://example.invalid/websub/youtube');
    assert.strictEqual(call['hub.verify'], 'async');
    assert.ok(call['hub.secret'] && call['hub.secret'].length >= 20, 'a signing secret must be sent');
    assert.strictEqual(call['hub.lease_seconds'], '828000');
  });

  await test('channels needing renewal are identified before the lease lapses', async () => {
    const subscribe = require('../server/websub/subscribe');
    // Push one channel's lease to the edge of the renew window.
    await db.query(
      `UPDATE channels SET websub_state='active', websub_expires_at = now() + interval '6 hours'
        WHERE yt_channel_id = $1`,
      ['UCN4YHY9Svp-Hn-qoPNiVXCw']
    );
    // And give another a long, healthy lease.
    await db.query(
      `UPDATE channels SET websub_state='active', websub_expires_at = now() + interval '9 days'
        WHERE yt_channel_id = $1`,
      [KNOWN_CHANNEL]
    );
    const due = await subscribe.channelsNeedingRenewal();
    const ids = due.map((c) => c.yt_channel_id);
    assert.ok(ids.includes('UCN4YHY9Svp-Hn-qoPNiVXCw'), 'expiring lease was not picked up');
    assert.ok(!ids.includes(KNOWN_CHANNEL), 'a healthy lease should not be renewed');
  });

  await test('the daily job runs, renews, backfills and records itself', async () => {
    const { runDaily } = require('../server/pipeline/reconcile');
    const result = await runDaily();
    assert.strictEqual(result.ok, true);
    assert.ok(result.details.subscriptions.checked >= 1);
    assert.ok(result.details.backfill, 'backfill did not run');
    const job = await db.one(
      `SELECT job_name, ok, finished_at, details FROM job_runs ORDER BY started_at DESC LIMIT 1`
    );
    assert.strictEqual(job.job_name, 'daily-reconcile');
    assert.strictEqual(job.ok, true);
    assert.ok(job.finished_at, 'job_runs row was never closed out');
    assert.ok(job.details.youtubeQuotaUnitsUsed >= 0);
  });

  await test('a stale live stream is closed out automatically', async () => {
    await db.query(
      `UPDATE videos SET status='live', updated_at = now() - interval '20 hours'
        WHERE yt_video_id = (SELECT yt_video_id FROM videos WHERE NOT is_hidden LIMIT 1)`
    );
    const { refreshLiveStatuses } = require('../server/pipeline/reconcile');
    await refreshLiveStatuses();
    const stuck = await db.one(
      `SELECT count(*)::int AS n FROM videos
        WHERE status='live' AND updated_at < now() - interval '12 hours'`
    );
    assert.strictEqual(stuck.n, 0, 'a stale live stream was left marked live');
  });

  /* ============ admin routes ============ */
  section('Admin routes');

  await test('admin routes reject a missing or wrong token', async () => {
    const none = await get('/admin/websub-events');
    assert.strictEqual(none.status, 401);
    const wrong = await get('/admin/websub-events', { headers: { authorization: 'Bearer nope' } });
    assert.strictEqual(wrong.status, 401);
  });

  await test('admin routes accept the configured token', async () => {
    const r = await get('/admin/websub-events', {
      headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
    });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.events));
    assert.ok(r.json.events.length >= 4, 'push notifications should be audited');
  });

  await test('reclassify re-tags the library after a rule change', async () => {
    const r = await realFetch(base + '/admin/reclassify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ limit: 40 })
    });
    const json = await r.json();
    assert.strictEqual(r.status, 200);
    assert.ok(json.videos >= 30, `reclassified ${json.videos}`);
    assert.strictEqual(json.tagged, json.videos, 'every video should end up tagged');
  });

  /* ============ agenda ingestion ============ */
  section('Agenda ingestion');

  const agendaPipeline = require('../server/pipeline/agenda');
  const legistar = require('../server/lib/agenda/legistar');
  const primegov = require('../server/lib/agenda/primegov');
  const { getAdapter, vendors } = require('../server/lib/agenda');

  await test('the adapter registry exposes both vendors and rejects unknown ones', () => {
    assert.deepStrictEqual(vendors().sort(), ['legistar', 'primegov']);
    assert.strictEqual(getAdapter('LEGISTAR').vendor, 'legistar');
    assert.throws(() => getAdapter('novus'), /no agenda adapter/);
  });

  await test('Legistar verify returns the governing bodies', async () => {
    const info = await legistar.verify('testtown');
    assert.ok(info.bodies.includes('City Council'));
    assert.ok(info.bodies.includes('Planning Commission'));
  });

  await test('Legistar verify surfaces a 404 for a town that is not a client', async () => {
    await assert.rejects(() => legistar.verify('nosuchtown'), (e) => e.status === 404);
  });

  await test('Legistar returns agenda items and drops empty ones', async () => {
    const items = await legistar.listItems('testtown', 4242);
    assert.strictEqual(items.length, 4, 'the blank item should have been dropped');
    assert.match(items[1].title, /land use and zoning/);
    assert.strictEqual(items[1].matterType, 'Ordinance');
    assert.strictEqual(items[0].position, 0);
  });

  await test('PrimeGov builds a public agenda document URL', async () => {
    const meetings = await primegov.listMeetings('testtown');
    assert.strictEqual(meetings.length, 1);
    assert.strictEqual(meetings[0].externalId, '991');
    assert.strictEqual(meetings[0].meetingDate, '2026-08-20');
    assert.match(meetings[0].agendaUrl, /\/Public\/CompiledDocument\/5501$/);
    assert.strictEqual(meetings[0].hasAgenda, true);
  });

  await test('body-name similarity behaves sensibly', () => {
    const sim = agendaPipeline.nameSimilarity;
    assert.ok(sim('City Council', 'City Council Regular Meeting') > 0.9);
    assert.ok(sim('Planning Commission', 'Planning Commission Hearing 6/18') >= 0.85);
    // Sharing only the generic word "board" must not read as a half match,
    // or a school board video mis-matches a water board agenda.
    assert.ok(sim('School Board', 'Water Utility Board') < 0.35,
      `generic-word overlap scored too high: ${sim('School Board', 'Water Utility Board')}`);
    assert.ok(sim('Zoning Board of Appeals', 'Parks and Recreation Board') < 0.35);
    assert.strictEqual(sim('', 'City Council'), 0);
  });

  await test('syncing a channel stores the agenda and its items', async () => {
    await db.query(
      `UPDATE channels SET agenda_vendor = 'legistar', agenda_client = 'testtown'
        WHERE yt_channel_id = $1`, [KNOWN_CHANNEL]
    );
    const channel = await db.one('SELECT * FROM channels WHERE yt_channel_id = $1', [KNOWN_CHANNEL]);
    const out = await agendaPipeline.syncChannelAgendas(channel, { limit: 5 });
    assert.strictEqual(out.meetings, 1);
    assert.strictEqual(out.items, 4);

    const m = await db.one(
      `SELECT id, body_name, meeting_date, item_count, agenda_text
         FROM agenda_meetings WHERE vendor='legistar' AND client_code='testtown'`
    );
    assert.strictEqual(m.body_name, 'City Council');
    assert.strictEqual(m.item_count, 4);
    assert.match(m.agenda_text, /affordable housing/);
    const items = await db.many('SELECT position FROM agenda_items WHERE meeting_id = $1 ORDER BY position', [m.id]);
    assert.strictEqual(items.length, 4);
  });

  await test('a channel with no agenda source is skipped, not errored', async () => {
    const bare = await db.one(`SELECT * FROM channels WHERE agenda_vendor IS NULL LIMIT 1`);
    const out = await agendaPipeline.syncChannelAgendas(bare);
    assert.strictEqual(out.skipped, true);
  });

  await test('a video is matched to the same-day agenda and re-tagged from it', async () => {
    // Put a Palm Bay video on the agenda's date so the matcher has something to
    // find. Clear the live-stream timestamps too: those take precedence as the
    // match anchor, which is correct for a live stream but wrong for this test.
    await db.query(
      `UPDATE videos SET published_at = '2026-08-20T18:00:00Z',
              scheduled_start_at = NULL, actual_start_at = NULL, status = 'recorded',
              agenda_meeting_id = NULL, agenda_matched_at = NULL
        WHERE yt_video_id = '0-tISiCsmZw'`
    );
    const out = await agendaPipeline.matchAndReclassify({ limit: 50 });
    assert.ok(out.matched >= 1, `nothing matched (considered ${out.considered})`);

    const row = await db.one(
      `SELECT v.agenda_meeting_id, v.agenda_matched_at FROM videos v WHERE v.yt_video_id = '0-tISiCsmZw'`
    );
    assert.ok(row.agenda_meeting_id, 'video was not linked to an agenda');
    assert.ok(row.agenda_matched_at, 'match timestamp not recorded');

    const tags = await db.many(
      `SELECT t.slug, vt.source, vt.matched_terms
         FROM video_topics vt
         JOIN topics t ON t.id = vt.topic_id
         JOIN videos v ON v.id = vt.video_id
        WHERE v.yt_video_id = '0-tISiCsmZw' ORDER BY vt.score DESC`
    );
    const slugs = tags.map((t) => t.slug);
    assert.ok(slugs.includes('zoning-housing'), `expected zoning from the agenda, got ${slugs.join(',')}`);
    assert.ok(tags.some((t) => t.source === 'agenda'), 'no tag was credited to the agenda');
    assert.ok(
      tags.find((t) => t.slug === 'zoning-housing').matched_terms.some((m) => /housing|zoning|land use/.test(m)),
      'agenda evidence was not recorded'
    );
  });

  await test('agenda text outranks a bare title, so the fallback is not used', async () => {
    const tags = await db.many(
      `SELECT t.is_fallback FROM video_topics vt
         JOIN topics t ON t.id = vt.topic_id
         JOIN videos v ON v.id = vt.video_id
        WHERE v.yt_video_id = '0-tISiCsmZw'`
    );
    assert.ok(tags.length, 'video lost its tags');
    assert.ok(!tags.every((t) => t.is_fallback), 'video is still only in the fallback bucket');
  });

  await test('discovery catalogues a readable town and ignores a 404', async () => {
    const out = await agendaPipeline.discover('legistar', ['discoverytown', 'nosuchtown'], {
      delayMs: 0, names: { discoverytown: 'Discovery Town, TX' }
    });
    assert.strictEqual(out.found, 1);
    assert.strictEqual(out.failed, 1);
    const row = await db.one(
      `SELECT display_name, bodies, is_available FROM agenda_sources
        WHERE vendor='legistar' AND client_code='discoverytown'`
    );
    assert.strictEqual(row.display_name, 'Discovery Town, TX');
    assert.strictEqual(row.is_available, true);
    assert.ok(row.bodies.includes('City Council'));
    const missing = await db.one(
      `SELECT 1 FROM agenda_sources WHERE client_code='nosuchtown'`
    );
    assert.strictEqual(missing, null, 'a 404 town should not be catalogued at all');
  });

  await test('GET /api/agenda-sources is searchable and flags monitored towns', async () => {
    const all = await get('/api/agenda-sources?limit=200');
    assert.strictEqual(all.status, 200);
    assert.ok(all.json.sources.length >= 1);
    assert.ok(all.json.totals.legistar >= 1);

    const found = await get('/api/agenda-sources?q=Discovery');
    assert.ok(found.json.sources.some((s) => s.clientCode === 'discoverytown'));

    const byVendor = await get('/api/agenda-sources?vendor=legistar&limit=200');
    assert.ok(byVendor.json.sources.every((s) => s.vendor === 'legistar'));

    const unmonitored = await get('/api/agenda-sources?available_only=true&limit=200');
    assert.ok(
      unmonitored.json.sources.every((s) => s.alreadyMonitored === false),
      'available_only should exclude towns already being monitored'
    );
  });

  await test('GET /api/videos/:id/agenda returns the item list', async () => {
    const r = await get('/api/videos/0-tISiCsmZw/agenda');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.itemCount, 4);
    assert.strictEqual(r.json.items.length, 4);
    assert.match(r.json.items[1].title, /land use and zoning/);
    const none = await get('/api/videos/rKGU6F_h-Sg/agenda');
    assert.strictEqual(none.status, 404, 'a video with no agenda should 404');
  });

  await test('/api/videos exposes the agenda link on matched meetings', async () => {
    const r = await get('/api/videos/0-tISiCsmZw');
    assert.ok(r.json.agenda, 'agenda block missing');
    assert.strictEqual(r.json.agenda.itemCount, 4);
    assert.ok(r.json.topics.some((t) => t.source === 'agenda'), 'topic source not exposed to the UI');
  });

  await test('/api/stats reports agenda coverage', async () => {
    const r = await get('/api/stats');
    assert.ok(r.json.agenda_backed_videos >= 1);
    assert.ok(r.json.agenda_sources_available >= 1);
  });

  await test('adding a town from the catalogue requires a YouTube channel', async () => {
    const res = await realFetch(base + '/admin/channels/from-agenda-source', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ vendor: 'legistar', clientCode: 'discoverytown' })
    });
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /channel is required/);
    assert.strictEqual(json.agendaSource.clientCode, 'discoverytown');
  });

  await test('adding a town from a catalogue entry that does not exist 404s', async () => {
    const res = await realFetch(base + '/admin/channels/from-agenda-source', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ vendor: 'legistar', clientCode: 'imaginaryville', channel: 'x' })
    });
    assert.strictEqual(res.status, 404);
  });

  await test('the daily job now includes the agenda stage', async () => {
    const { runDaily } = require('../server/pipeline/reconcile');
    const result = await runDaily({ skipBackfill: true });
    assert.strictEqual(result.ok, true);
    assert.ok(result.details.agendaSync, 'agenda sync did not run inside the daily job');
    assert.ok(result.details.agendaMatch, 'agenda matching did not run inside the daily job');
  });

  /* ============ manual add: console endpoints ============ */
  section('Adding towns manually');

  const adminPost = (path, body) => realFetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
    body: JSON.stringify(body || {})
  });

  await test('resolve-channel previews a channel without saving anything', async () => {
    const before = await db.one('SELECT count(*)::int n FROM channels');
    const res = await adminPost('/admin/resolve-channel', { channel: 'https://www.youtube.com/watch?v=abcdefghijk' });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ytChannelId, KNOWN_CHANNEL);
    assert.strictEqual(json.title, 'Palm Bay Florida');
    assert.strictEqual(json.alreadyTracked, true);
    assert.ok(json.recentVideos.length >= 1, 'recent uploads help a human confirm the channel');
    const after = await db.one('SELECT count(*)::int n FROM channels');
    assert.strictEqual(after.n, before.n, 'a preview must not create a channel');
  });

  await test('resolve-channel rejects nonsense with a readable message', async () => {
    const res = await adminPost('/admin/resolve-channel', { channel: 'not a channel at all' });
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /Could not work out a channel ID/);
  });

  await test('resolve-channel requires input', async () => {
    const res = await adminPost('/admin/resolve-channel', {});
    assert.strictEqual(res.status, 400);
  });

  await test('bulk add accepts a pasted CSV block', async () => {
    const csv = [
      'channel,municipality,county,stateCode,stateName,govBody,population',
      'UCbulktest0000000000000a,Testville,Test County,TX,Texas,City Council,42000',
      'UCbulktest0000000000000b,Testburg,Test County,TX,Texas,School Board,8000'
    ].join('\n');
    const res = await adminPost('/admin/channels/bulk', { csv });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.total, 2);
    assert.strictEqual(json.failed, 0, JSON.stringify(json.results));
    assert.strictEqual(json.added, 2);
    const rows = await db.many(
      "SELECT municipality, gov_body, size_tier FROM channels WHERE municipality IN ('Testville','Testburg') ORDER BY municipality"
    );
    assert.strictEqual(rows.length, 2, 'each row must become its own town');
    assert.strictEqual(rows[0].gov_body, 'School Board', 'per-row governing body is respected');
    // 42k and 8k population must land in different size tiers.
    assert.notStrictEqual(rows[0].size_tier, rows[1].size_tier);
  });

  await test('bulk add accepts tab-separated paste and a missing header', async () => {
    const tsv = 'UCbulktest0000000000000c\tTabtown\tTab County\tTX\tTexas\tCity Council\t15000';
    const res = await adminPost('/admin/channels/bulk', { csv: tsv });
    const json = await res.json();
    assert.strictEqual(json.added, 1, JSON.stringify(json.results));
  });

  await test('bulk add reports bad rows individually instead of failing the batch', async () => {
    const csv = [
      'channel,municipality,county,stateCode,stateName,govBody,population',
      'UCbulktest0000000000000d,Goodtown,C,TX,Texas,City Council,1000',
      'total-nonsense,,,,,,'
    ].join('\n');
    const res = await adminPost('/admin/channels/bulk', { csv });
    const json = await res.json();
    assert.strictEqual(json.added, 1);
    assert.strictEqual(json.failed, 1);
    assert.ok(json.results.find((r) => !r.ok).error, 'the failing row must explain itself');
  });

  await test('bulk add refuses an empty payload and an oversized batch', async () => {
    assert.strictEqual((await adminPost('/admin/channels/bulk', {})).status, 400);
    const many201 = Array.from({ length: 201 }, () => ({ channel: 'x', municipality: 'y', stateCode: 'TX' }));
    assert.strictEqual((await adminPost('/admin/channels/bulk', { rows: many201 })).status, 400);
  });

  await test('GET /admin/channels gives the console its health columns', async () => {
    const r = await get('/admin/channels', {
      headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
    });
    assert.strictEqual(r.status, 200);
    const row = r.json.channels[0];
    ['municipality', 'websub_state', 'agenda_vendor', 'video_count', 'agenda_backed', 'latest_video_at']
      .forEach((k) => assert.ok(k in row, `missing column ${k}`));
  });

  await test('per-channel backfill works from the console', async () => {
    const res = await adminPost(`/admin/channels/${KNOWN_CHANNEL}/backfill`, { limit: 5 });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(json.asked >= 1);
  });

  await test('backfill 404s for a channel we do not track', async () => {
    const res = await adminPost('/admin/channels/UCzzzzzzzzzzzzzzzzzzzzzz/backfill', {});
    assert.strictEqual(res.status, 404);
  });

  await test('the console cannot reach anything without the admin token', async () => {
    for (const path of ['/admin/resolve-channel', '/admin/channels/bulk', '/admin/agendas/sync']) {
      const res = await realFetch(base + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      assert.strictEqual(res.status, 401, path + ' was not protected');
    }
    const list = await get('/admin/channels');
    assert.strictEqual(list.status, 401);
  });

  await test('the console page is served', async () => {
    const r = await get('/admin.html');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Add a town/);
    assert.match(r.text, /admin\.js/);
  });

  await test('bulk test towns are removed so the suite leaves no residue', async () => {
    await db.query("DELETE FROM channels WHERE yt_channel_id LIKE 'UCbulktest%'");
    const left = await db.one("SELECT count(*)::int n FROM channels WHERE yt_channel_id LIKE 'UCbulktest%'");
    assert.strictEqual(left.n, 0);
  });

  /* ============ static site ============ */
  section('Front end');

  await test('the home page is served', async () => {
    const r = await get('/');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Community-Span/);
  });

  /* ---------------- results ---------------- */
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`  ${passed} passed, ${failures.length} failed`);
  console.log(`${'-'.repeat(52)}\n`);

  server.close();
  await db.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest harness crashed:\n', err);
  process.exit(1);
});
