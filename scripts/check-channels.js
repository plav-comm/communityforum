#!/usr/bin/env node
/**
 * Check a list of towns BEFORE adding them to the site.
 *
 *   npm run check-channels -- db/expansion/PA.csv
 *
 * The file uses the same columns as the admin page's "Paste from a
 * spreadsheet" box:
 *   channel, municipality, county, stateCode, stateName, govBody, population
 * (an optional extra "note" column is shown in the report and then dropped).
 *
 * For every row it asks YouTube: does this channel exist, what is it really
 * called, and when did it last upload? Then it writes two files next to the
 * input:
 *   PA.ready.csv   rows that passed — paste these into /admin.html
 *   PA.review.csv  rows that need a human look, with the reason
 *
 * Nothing is added to the site by this script. Costs roughly 2-3 YouTube API
 * units per row (the free allowance is 10,000 a day).
 *
 * The admin page's bulk paste registers towns but does not pull their videos;
 * run  npm run backfill -- 50  afterwards to fill them in.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../server/config');
const youtube = require('../server/lib/youtube');
const { looksLikeMeeting } = require('../server/lib/meetings');

const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas',
  'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
  'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];

/** Words that should appear somewhere in an official channel's name or description. */
function placeWords(r) {
  const strip = (s) => String(s || '').replace(/\b(county|city|town|township|borough|of|the)\b/gi, ' ').trim();
  return [strip(r.municipality), strip(r.county)].filter((w) => w.length >= 3);
}

/** A different state named in the channel's text, if any (and not the expected one). */
function otherState(text, expected) {
  const t = ' ' + text + ' ';
  const exp = String(expected || '').toLowerCase();
  if (exp && t.toLowerCase().includes(exp)) return null;
  for (const s of STATES) {
    if (s.toLowerCase() === exp) continue;
    // "West Virginia" contains "Virginia", "Arkansas" contains "Kansas": match whole names only
    const re = new RegExp('(^|[^a-z])' + s.toLowerCase() + '([^a-z]|$)');
    if (re.test(t.toLowerCase())) return s;
  }
  return null;
}

const STALE_DAYS = Number(process.env.STALE_DAYS || 60);

function parse(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((c) => c.trim().replace(/^"|"$/g, ''));
  let header = null;
  const rows = [];
  for (const line of lines) {
    const cells = split(line);
    if (!header) {
      const looksLikeHeader = /channel|url/i.test(cells[0]);
      header = looksLikeHeader
        ? cells.map((c) => c.replace(/\s+/g, '').toLowerCase())
        : ['channel', 'municipality', 'county', 'statecode', 'statename', 'govbody', 'population', 'note'];
      if (looksLikeHeader) continue;
    }
    const r = {};
    header.forEach((k, i) => { r[k] = cells[i] || ''; });
    rows.push(r);
  }
  return rows;
}

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function existingChannelIds() {
  if (!config.databaseUrl) return new Set();
  try {
    const db = require('../server/db');
    const rows = await db.many('SELECT yt_channel_id FROM channels');
    await db.close();
    return new Set(rows.map((r) => r.yt_channel_id));
  } catch (err) {
    return new Set();
  }
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('\n  Usage: npm run check-channels -- db/expansion/PA.csv\n');
    process.exit(1);
  }
  if (!config.youtubeApiKey) {
    console.error('\n  YOUTUBE_API_KEY is not set in .env\n');
    process.exit(1);
  }

  const rows = parse(fs.readFileSync(file, 'utf8'));
  const already = await existingChannelIds();
  console.log(`\n  Checking ${rows.length} rows from ${path.basename(file)} ...\n`);

  // 1. Work out each row's channel ID.
  for (const r of rows) {
    try {
      r.id = await youtube.resolveChannelId(r.channel || r.url);
    } catch (err) {
      r.problem = 'NOT FOUND — link did not lead to a channel';
    }
  }

  // 2. Channel names and upload playlists, 50 per call.
  const channels = await youtube.getChannels(rows.filter((r) => r.id).map((r) => r.id));
  const byId = new Map(channels.map((c) => [c.ytChannelId, c]));

  // 3. Each channel's 50 most recent uploads, to see how many are meetings.
  //    Big-city channels post many short clips between meetings, so 10 is too few.
  const recentIds = new Map();
  for (const c of channels) {
    if (!c.uploadsPlaylistId) continue;
    try {
      recentIds.set(c.ytChannelId, await youtube.getPlaylistVideoIds(c.uploadsPlaylistId, 50));
    } catch (err) { /* empty or private uploads list */ }
  }
  const vids = await youtube.getVideos([].concat(...recentIds.values()));
  const vidById = new Map(vids.map((v) => [v.ytVideoId, v]));

  // 4. Verdicts.
  const seen = new Map();
  const now = Date.now();
  for (const r of rows) {
    if (r.problem) continue;
    const c = byId.get(r.id);
    if (!c) { r.problem = 'NOT FOUND — channel missing or private'; continue; }
    r.channelName = c.title;
    if (already.has(r.id)) { r.problem = 'ALREADY ON SITE'; continue; }
    if (seen.has(r.id)) {
      r.problem = `DUPLICATE — same channel as ${seen.get(r.id)}`;
      continue;
    }
    seen.set(r.id, `${r.municipality} ${r.govbody}`);

    // Is this really the right place? Same-named towns in other states are the
    // most common mistake (Lancaster PA vs Lancaster OH vs Lancaster County NE).
    const text = `${c.title} ${c.description}`;
    const wrong = otherState(text, r.statename);
    if (wrong) { r.problem = `WRONG PLACE? — channel mentions ${wrong}`; continue; }
    const words = placeWords(r);
    if (words.length && !words.some((w) => text.toLowerCase().includes(w.toLowerCase()))) {
      r.problem = `CHECK NAME — "${words.join('" / "')}" not in channel name or description`;
      continue;
    }

    const recent = (recentIds.get(r.id) || []).map((id) => vidById.get(id)).filter(Boolean)
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    if (!recent.length) { r.problem = 'NO VIDEOS'; continue; }
    const meetings = recent.filter(looksLikeMeeting);
    r.meetingShare = `${meetings.length}/${recent.length}`;
    if (!meetings.length) { r.problem = `NO MEETINGS in last ${recent.length} uploads`; continue; }
    const v = meetings[0];
    r.latestTitle = v.title;
    r.latestDate = (v.publishedAt || '').slice(0, 10);
    const days = Math.round((now - new Date(v.publishedAt).getTime()) / 864e5);
    r.days = days;
    if (days > STALE_DAYS) r.problem = `STALE — last meeting ${days} days ago`;
  }

  // 5. Report.
  const ok = rows.filter((r) => !r.problem);
  const review = rows.filter((r) => r.problem);
  const line = (r) =>
    `  ${(r.problem ? '✗' : '✓')} ${(r.municipality + ' · ' + r.govbody).padEnd(42).slice(0, 42)} ` +
    `${(r.channelName || '—').padEnd(38).slice(0, 38)} ` +
    (r.problem ? r.problem : `${r.meetingShare.padStart(5)} meetings  ${r.latestDate}  ${String(r.latestTitle).slice(0, 44)}`);
  console.log('  Town · body                                 YouTube channel name                   Recent uploads that are meetings · latest meeting');
  console.log('  ' + '-'.repeat(130));
  rows.forEach((r) => console.log(line(r)));

  const base = file.replace(/\.csv$/i, '');
  const cols = ['channel', 'municipality', 'county', 'stateCode', 'stateName', 'govBody', 'population'];
  const out = (r) => [
    r.id ? 'https://www.youtube.com/channel/' + r.id : r.channel,
    r.municipality, r.county, r.statecode, r.statename, r.govbody, r.population
  ].map(csvCell).join(',');

  fs.writeFileSync(base + '.ready.csv', [cols.join(',')].concat(ok.map(out)).join('\n') + '\n');
  fs.writeFileSync(base + '.review.csv',
    [cols.concat(['problem', 'youtubeChannelName', 'lastUpload', 'note']).join(',')]
      .concat(review.map((r) => out(r) + ',' +
        [r.problem, r.channelName, r.latestDate, r.note].map(csvCell).join(',')))
      .join('\n') + '\n');

  console.log(`\n  ${ok.length} ready, ${review.length} need a look.`);
  console.log(`  Ready to paste:  ${base}.ready.csv   (then run: npm run backfill -- 50)`);
  console.log(`  Needs review:    ${base}.review.csv`);
  console.log(`  Still glance at the channel names above: each should be the town's own channel`);
  console.log(`  or its community-access station. Only meeting videos are imported, so a mixed`);
  console.log(`  channel is fine. YouTube units used: ${youtube.quotaUsed()}\n`);
}

main().catch((err) => {
  console.error('\n  ' + err.message + '\n');
  process.exit(1);
});
