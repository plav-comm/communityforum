#!/usr/bin/env node
/**
 * Pull recent meeting history for every channel (or one channel).
 * Useful right after seeding, so the site is not empty on day one.
 *
 *   npm run backfill              # 10 most recent uploads per channel
 *   npm run backfill -- 25        # 25 per channel
 */
const db = require('../server/db');
const { assertConfig } = require('../server/config');
const { backfillChannels } = require('../server/pipeline/reconcile');

async function main() {
  assertConfig({ requireYouTube: true });
  const perChannel = Number(process.argv[2]) || 10;
  console.log(`\n  Backfilling up to ${perChannel} recent uploads per channel...\n`);
  const out = await backfillChannels({ perChannel });
  console.log(`\n  Channels checked: ${out.channels}`);
  console.log(`  New videos ingested: ${out.newVideos}`);
  console.log(`  Errors: ${out.errors}\n`);
  await db.close();
}

main().catch(async (e) => { console.error(e.message); await db.close().catch(() => {}); process.exit(1); });
