#!/usr/bin/env node
/**
 * Put the demo database back to a clean, presentable state.
 *
 * The test suite deliberately drives the real pipeline against a stubbed
 * YouTube API. That is what makes the tests meaningful, but it also means a
 * suite run leaves marks on the demo data: the reconcile stage refreshes any
 * live or upcoming video's metadata, so those rows come back wearing the stub's
 * title. Run this after `npm test` and the demo is trustworthy again.
 */
const db = require('../server/db');
const log = require('../server/lib/log');
const { seedDemoVideos } = require('./seed-demo-videos');

const LIVE = ['0-tISiCsmZw', 'GvuFLziqUmc'];
const UPCOMING = ['RYtkLLIG1LM', 'fzcBRWsAGI4'];
const PUSH_ON = ['Palm Bay', 'Phoenix', 'Corpus Christi', 'Chelmsford', 'Columbia'];
const AGENDA_LINKS = [
  ['Corpus Christi', 'legistar', 'corpuschristi'],
  ['Phoenix', 'legistar', 'phoenix']
];

(async () => {
  // 1. Remove everything the tests invented.
  await db.query("DELETE FROM videos WHERE yt_video_id LIKE 'zz%'");
  await db.query("DELETE FROM channels WHERE yt_channel_id LIKE 'UCbulktest%'");
  await db.query(
    "UPDATE videos SET agenda_meeting_id = NULL, agenda_matched_at = NULL " +
    "WHERE channel_id IN (SELECT id FROM channels WHERE agenda_client = 'testtown')"
  );
  await db.query(
    "UPDATE channels SET agenda_vendor = NULL, agenda_client = NULL, agenda_synced_at = NULL " +
    "WHERE agenda_client = 'testtown'"
  );
  await db.query("DELETE FROM agenda_meetings WHERE client_code = 'testtown'");
  await db.query("DELETE FROM agenda_sources WHERE client_code IN ('testtown','discoverytown')");
  await db.query('DELETE FROM websub_events');
  await db.query('DELETE FROM job_runs');
  await db.query('UPDATE videos SET is_hidden = FALSE');

  // 2. Re-seed the real titles and descriptions from db/seed-videos.json.
  //    In-process on purpose: the local test Postgres serves one connection at a
  //    time, so a child process with its own pool would be refused.
  await seedDemoVideos();

  // 3. Re-apply the presentation state the seed file cannot express.
  const db2 = db;
  for (const [municipality, vendor, client] of AGENDA_LINKS) {
    await db2.query(
      'UPDATE channels SET agenda_vendor = $2, agenda_client = $3 WHERE municipality = $1',
      [municipality, vendor, client]
    );
  }
  await db2.query(
    `UPDATE videos SET status = 'live', actual_start_at = now(), scheduled_start_at = now()
      WHERE yt_video_id = ANY($1)`, [LIVE]
  );
  await db2.query(
    `UPDATE videos SET status = 'upcoming', scheduled_start_at = now() + interval '6 hours',
            actual_start_at = NULL
      WHERE yt_video_id = ANY($1)`, [UPCOMING]
  );
  await db2.query(
    `UPDATE channels SET websub_state = 'active', websub_expires_at = now() + interval '9 days'
      WHERE municipality = ANY($1)`, [PUSH_ON]
  );

  // 4. Prove it: every title must be distinct and none may be the stub's.
  const dupes = await db2.many(
    'SELECT title, count(*)::int n FROM videos GROUP BY title HAVING count(*) > 1'
  );
  const stub = await db2.one(
    "SELECT count(*)::int n FROM videos WHERE title LIKE '%Stormwater Utility Fee and Police Budget%'"
  );
  const stats = await db2.one(
    `SELECT count(*)::int videos,
            count(*) FILTER (WHERE status = 'live')::int live,
            count(*) FILTER (WHERE status = 'upcoming')::int upcoming,
            count(*) FILTER (WHERE agenda_meeting_id IS NOT NULL)::int agenda_backed
       FROM videos WHERE NOT is_hidden`
  );
  await db2.close();

  if (dupes.length) {
    log.error(`restore failed: ${dupes.length} duplicated title(s), e.g. "${dupes[0].title}"`);
    process.exit(1);
  }
  if (stub.n) {
    log.error(`restore failed: ${stub.n} video(s) still carry the test stub's title`);
    process.exit(1);
  }

  console.log(
    `\n  Demo restored: ${stats.videos} videos, all titles distinct, ` +
    `${stats.live} live, ${stats.upcoming} upcoming, ${stats.agenda_backed} agenda-backed.`
  );
  console.log('  Next: npm run agendas   (re-matches agendas after a restore)\n');
})().catch((err) => { log.error(err.message); process.exit(1); });
