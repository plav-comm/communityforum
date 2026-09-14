#!/usr/bin/env node
/**
 * Pull agendas for every channel that has an agenda source, then match them to
 * videos and re-tag those videos using the agenda text.
 *
 *   npm run agendas
 */
const db = require('../server/db');
const { syncAllAgendas, matchAndReclassify } = require('../server/pipeline/agenda');

async function main() {
  console.log('\n  Syncing agendas...');
  const sync = await syncAllAgendas({ limit: Number(process.argv[2]) || 25 });
  console.log(`  channels=${sync.channels} meetings=${sync.meetings} items=${sync.items} errors=${sync.errors}`);

  console.log('\n  Matching videos to agendas and re-tagging...');
  const match = await matchAndReclassify({ limit: 500 });
  console.log(`  considered=${match.considered} matched=${match.matched} agenda-tagged=${match.retagged} unmatched=${match.unmatched}\n`);
  await db.close();
}

main().catch(async (e) => { console.error(e); await db.close().catch(() => {}); process.exit(1); });
