#!/usr/bin/env node
/**
 * Add one town's channel from the command line, then subscribe to its feed.
 *
 * Usage:
 *   npm run add-channel -- "<channel url or @handle>" "<Municipality>" "<County>" <ST> "<State Name>" "<Governing Body>" <population>
 *
 * Example:
 *   npm run add-channel -- "https://www.youtube.com/@CityofAustin" "Austin" "Travis County" TX "Texas" "City Council" 975000
 *
 * You can paste a channel URL, an @handle, a UC... id, or a link to ANY video
 * on the channel — the script works out the channel ID either way.
 */
const db = require('../server/db');
const youtube = require('../server/lib/youtube');
const subscribe = require('../server/websub/subscribe');
const { tierFor } = require('../server/routes/admin');
const { config } = require('../server/config');

async function main() {
  const [input, municipality, county, stateCode, stateName, govBody, population] = process.argv.slice(2);

  if (!input || !municipality || !stateCode || !stateName) {
    console.error(`
  Missing arguments.

  npm run add-channel -- "<channel url>" "<Municipality>" "<County>" <ST> "<State Name>" "<Governing Body>" <population>

  Example:
  npm run add-channel -- "https://www.youtube.com/@CityofAustin" "Austin" "Travis County" TX "Texas" "City Council" 975000
`);
    process.exit(1);
  }

  console.log(`\n  Resolving channel from: ${input}`);
  const ytChannelId = await youtube.resolveChannelId(input);
  const meta = (await youtube.getChannels([ytChannelId]))[0];
  console.log(`  Found: ${meta ? meta.title : ytChannelId}  (${ytChannelId})`);

  await db.query(
    `INSERT INTO channels
       (yt_channel_id, name, municipality, county, state_code, state_name, gov_body,
        population, size_tier, uploads_playlist_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (yt_channel_id) DO UPDATE SET
       name = EXCLUDED.name, municipality = EXCLUDED.municipality, county = EXCLUDED.county,
       state_code = EXCLUDED.state_code, state_name = EXCLUDED.state_name,
       gov_body = EXCLUDED.gov_body, population = EXCLUDED.population,
       size_tier = EXCLUDED.size_tier, uploads_playlist_id = EXCLUDED.uploads_playlist_id,
       is_active = TRUE`,
    [
      ytChannelId, (meta && meta.title) || municipality, municipality, county || null,
      String(stateCode).toUpperCase(), stateName, govBody || 'City Council',
      population ? Number(population) : null, tierFor(population),
      (meta && meta.uploadsPlaylistId) || null
    ]
  );
  console.log(`  Saved ${municipality}, ${String(stateCode).toUpperCase()}`);

  // Warn loudly if this body type has no tagging hints. Without this the
  // pipeline degrades silently as you add towns: meetings still ingest, they
  // just stop getting sensible subject tags.
  const { loadRules, hasBodyHint } = require('../server/pipeline/classify');
  await loadRules({ force: true });
  const body = govBody || 'City Council';
  const GENERAL = ['city council', 'town council', 'select board', 'selectboard',
    'county commission', 'board of supervisors', 'board of aldermen',
    'city commission', 'board of trustees', 'village board'];
  const { normBody } = require('../server/pipeline/classify');
  if (!hasBodyHint(body) && !GENERAL.includes(normBody(body))) {
    console.log(`
  NOTE: "${body}" has no topic hints configured, and it is not one of the
  general-purpose bodies we intentionally leave unhinted. Meetings from this
  channel will still ingest, but they will usually land in General Session.

  To give this body a default subject, run:
    INSERT INTO gov_body_topics (gov_body, topic_id, weight)
    SELECT '${body}', id, 3.0 FROM topics WHERE slug = 'schools-education';
  (swap in whichever topic slug fits), then POST /admin/reclassify.
`);
  }

  if (config.websub.callbackBase) {
    const r = await subscribe.subscribeChannel(ytChannelId);
    console.log(`  Subscription requested: ${r.ok ? 'accepted by hub' : 'FAILED (' + r.status + ')'}`);
  } else {
    console.log('  PUBLIC_BASE_URL is not set, so no push subscription was requested.');
  }

  console.log('\n  Pulling recent meetings from this channel...');
  const { ingestVideoIds } = require('../server/pipeline/ingest');
  const playlist = (meta && meta.uploadsPlaylistId) || null;
  if (playlist) {
    const ids = await youtube.getPlaylistVideoIds(playlist, 15);
    const summary = await ingestVideoIds(ids, { reason: 'add-channel' });
    console.log(`  Ingested ${summary.inserted} new, updated ${summary.updated}, skipped ${summary.skipped}.\n`);
  }

  await db.close();
}

main().catch(async (e) => { console.error('\n  ' + e.message + '\n'); await db.close().catch(() => {}); process.exit(1); });
