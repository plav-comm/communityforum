#!/usr/bin/env node
/**
 * Loads 35 real, already-published municipal meeting videos into the database
 * WITHOUT needing a YouTube API key.
 *
 *   node scripts/seed-demo-videos.js
 *
 * Why this exists: it lets you run the whole stack, see the site populated, and
 * demo it before you have finished setting up Google Cloud. Once your API key is
 * in place, `npm run backfill` takes over and keeps everything fresh from the
 * real API. Topic tags here are produced by the SAME classifier the live
 * pipeline uses, so what you see is genuine output, not canned data.
 */
const fs = require('fs');
const path = require('path');
const db = require('../server/db');
const { classify, loadRules } = require('../server/pipeline/classify');

async function main() {
  const videos = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seed-videos.json'), 'utf8'));
  const rules = await loadRules({ force: true });

  let inserted = 0;
  let skipped = 0;
  let tagged = 0;

  for (const v of videos) {
    const channel = await db.one('SELECT id, municipality, gov_body FROM channels WHERE yt_channel_id = $1', [v.ytChannelId]);
    if (!channel) {
      console.log(`  ! no channel row for ${v.ytChannelId} — run "npm run seed" first`);
      skipped += 1;
      continue;
    }

    const topics = await classify(
      { ytVideoId: v.ytVideoId, title: v.title, description: v.description, tags: [], govBody: channel.gov_body },
      { rules }
    );

    await db.tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO videos
           (yt_video_id, channel_id, title, description, published_at, duration_seconds,
            thumbnail_url, status, classified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (yt_video_id) DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description,
           published_at = EXCLUDED.published_at, duration_seconds = EXCLUDED.duration_seconds,
           status = EXCLUDED.status, classified_at = now()
         RETURNING id`,
        [
          v.ytVideoId, channel.id, v.title, v.description, v.publishedAt,
          v.durationSeconds, `https://i.ytimg.com/vi/${v.ytVideoId}/hqdefault.jpg`,
          v.status || 'recorded'
        ]
      );
      const videoId = rows[0].id;
      await client.query('DELETE FROM video_topics WHERE video_id = $1', [videoId]);
      for (const t of topics) {
        await client.query(
          `INSERT INTO video_topics (video_id, topic_id, score, matched_terms, source)
           VALUES ($1,$2,$3,$4,'metadata')`,
          [videoId, t.topicId, t.score, t.matchedTerms]
        );
      }
    });

    inserted += 1;
    if (topics.length) tagged += 1;
    console.log(`  + ${channel.municipality}: ${v.title.slice(0, 52)}  ->  ${topics.map((t) => t.slug).join(', ') || 'untagged'}`);
  }

  console.log(`\n  ${inserted} videos loaded, ${tagged} received topic tags, ${skipped} skipped.\n`);
  return { inserted, tagged, skipped };
}

module.exports = { seedDemoVideos: main };

// Only take over the process (and the database connection) when run directly.
if (require.main === module) {
  main()
    .then(() => db.close())
    .catch(async (e) => { console.error(e); await db.close().catch(() => {}); process.exit(1); });
}
