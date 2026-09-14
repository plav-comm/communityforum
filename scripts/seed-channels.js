#!/usr/bin/env node
/**
 * Loads db/seed-channels.json into the channels table.
 * These are 21 REAL municipal, county and school district YouTube channels,
 * verified against their published meeting videos.
 *
 *   npm run seed
 *
 * Add your own towns by editing db/seed-channels.json and re-running, or with:
 *   npm run add-channel -- "https://www.youtube.com/@YourTownTV" "Your Town" "Your County" ST "Your State" "City Council" 42000
 */
const fs = require('fs');
const path = require('path');
const db = require('../server/db');
const { tierFor } = require('../server/routes/admin');

async function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seed-channels.json'), 'utf8'));
  let added = 0;
  let updated = 0;

  for (const c of rows) {
    const existing = await db.one('SELECT id FROM channels WHERE yt_channel_id = $1', [c.ytChannelId]);
    await db.query(
      `INSERT INTO channels
         (yt_channel_id, name, municipality, county, state_code, state_name, gov_body,
          population, size_tier, timezone, website)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (yt_channel_id) DO UPDATE SET
         name = EXCLUDED.name, municipality = EXCLUDED.municipality, county = EXCLUDED.county,
         state_code = EXCLUDED.state_code, state_name = EXCLUDED.state_name,
         gov_body = EXCLUDED.gov_body, population = EXCLUDED.population,
         size_tier = EXCLUDED.size_tier, timezone = EXCLUDED.timezone`,
      [
        c.ytChannelId, c.name, c.municipality, c.county || null,
        c.stateCode, c.stateName, c.govBody, c.population || null,
        tierFor(c.population), c.timezone || 'America/New_York', c.website || null
      ]
    );
    existing ? (updated += 1) : (added += 1);
    console.log(`  ${existing ? '·' : '+'} ${c.municipality}, ${c.stateCode} — ${c.govBody}`);
  }

  const total = await db.one('SELECT count(*)::int AS n FROM channels WHERE is_active');
  console.log(`\n  ${added} added, ${updated} updated. ${total.n} active channels being monitored.\n`);
  console.log('  Next: npm run subscribe   (turns on real-time push for every channel)\n');
  await db.close();
}

main().catch(async (e) => { console.error(e); await db.close().catch(() => {}); process.exit(1); });
