#!/usr/bin/env node
/**
 * The automated safety net. Point your host's scheduler at this once a day.
 *
 *   npm run daily
 *
 * It does four things:
 *   1. renews WebSub subscriptions before their ~9.6 day lease expires
 *   2. re-checks anything marked live or upcoming so badges stay accurate
 *   3. reads each channel's uploads playlist and ingests anything the push missed
 *   4. writes the outcome to the job_runs table so you can audit pipeline health
 *
 * On Render: Settings -> Cron Jobs -> command `npm run daily`, schedule `0 8 * * *`.
 */
const db = require('../server/db');
const { assertConfig } = require('../server/config');
const { runDaily } = require('../server/pipeline/reconcile');

async function main() {
  assertConfig({ requireYouTube: true });
  const started = Date.now();
  const result = await runDaily({ skipBackfill: process.argv.includes('--skip-backfill') });

  console.log('\n  ---- daily reconcile summary ----');
  console.log(JSON.stringify(result.details, null, 2));
  console.log(`  finished in ${Math.round((Date.now() - started) / 1000)}s\n`);
  await db.close();
}

main().catch(async (e) => { console.error('\n  daily job failed: ' + e.message + '\n'); await db.close().catch(() => {}); process.exit(1); });
