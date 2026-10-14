#!/usr/bin/env node
/**
 * Hide videos already on the site that are not meetings (concerts, PSAs,
 * Shorts...) — the same test new uploads now go through.
 *
 *   npm run hide-non-meetings            # list what would be hidden
 *   npm run hide-non-meetings -- --apply # hide them
 *
 * Hidden videos stay in the database (is_hidden = true) and can be restored
 * with SQL if a real meeting was caught.
 */
const db = require('../server/db');
const { looksLikeMeeting } = require('../server/lib/meetings');

async function main() {
  const apply = process.argv.includes('--apply');
  const rows = await db.many(
    `SELECT v.id, v.yt_video_id, v.title, v.duration_seconds, v.status, c.municipality
       FROM videos v JOIN channels c ON c.id = v.channel_id
      WHERE NOT v.is_hidden`
  );
  const bad = rows.filter((r) => !looksLikeMeeting({
    title: r.title, durationSeconds: r.duration_seconds, status: r.status
  }));

  console.log(`\n  ${rows.length} videos on the site, ${bad.length} do not look like meetings:\n`);
  bad.forEach((r) => console.log(`   - ${r.municipality}: ${r.title}`));

  if (!bad.length) {
    console.log('  Nothing to do.\n');
  } else if (apply) {
    await db.query('UPDATE videos SET is_hidden = TRUE WHERE id = ANY($1::bigint[])', [bad.map((r) => r.id)]);
    console.log(`\n  Hidden ${bad.length} videos.\n`);
  } else {
    console.log('\n  Nothing changed. Run again with  -- --apply  to hide these.\n');
  }
  await db.close();
}

main().catch(async (err) => {
  console.error('\n  ' + err.message + '\n');
  await db.close().catch(() => {});
  process.exit(1);
});
