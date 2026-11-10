#!/usr/bin/env node
/**
 * Find each town's agenda system (Legistar or PrimeGov) and link it.
 *
 *   npm run find-agendas              # look only: prints what it found
 *   npm run find-agendas -- --apply   # link the confident matches and pull their agendas
 *   npm run find-agendas -- --apply --include=columbus,akron
 *                                     # also link "LIKELY" accounts you checked by eye
 *   npm run find-agendas -- --town=akron   # just one town
 *
 * For every active channel (school boards skipped; they use other systems) it
 * tries the account names towns usually use on each platform, e.g. for Akron:
 * akron, akronoh, cityofakron. An account that answers is then CHECKED against
 * the channel's own videos before it is trusted:
 *
 *   1. dates line up    the platform has a meeting of the same body on the
 *                       same day (±1) as the channel's recent videos
 *   2. right state      the agenda text never names a different state
 *                       ("State of Georgia" for a Columbus, Ohio channel)
 *
 * Only accounts that pass both are linked with --apply. Everything else is
 * listed so a person can look. Nothing is linked by the plain run.
 */
const db = require('../server/db');
const { config } = require('../server/config');
const { getAdapter } = require('../server/lib/agenda');
const { nameSimilarity, syncChannelAgendas, matchAndReclassify } = require('../server/pipeline/agenda');
const { runMigrations } = require('../server/lib/migrations');

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--town=')) || '').slice(7).toLowerCase();
// Accounts a person has checked by eye: --include=akron,miamidade
const INCLUDE = ((process.argv.find((a) => a.startsWith('--include=')) || '').slice(10))
  .toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming'
};

/** Account names a town is likely to use on each platform. */
function candidates(ch) {
  const st = String(ch.state_code || '').toLowerCase();
  const clean = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 -]/g, '').trim();
  const name = clean(ch.municipality);
  const isCounty = /\bcounty\b/.test(name);
  const core = name.replace(/\bcounty\b/, '').trim();
  const flat = (s) => s.replace(/[\s-]+/g, '');
  const dash = (s) => s.replace(/\s+/g, '-');
  const c = flat(core);
  const set = new Set();
  if (isCounty) {
    [c + 'county', c + 'county' + st, c + 'co', c + 'co' + st, c, c + st, dash(core) + '-county',
      c + '-county', 'county' + c].forEach((x) => set.add(x));
  } else {
    [c, c + st, 'cityof' + c, 'cityof' + c + st, c + 'city', 'townof' + c, c + 'gov', dash(core)]
      .forEach((x) => set.add(x));
  }
  return {
    legistar: [...set].filter((x) => x.length >= 3),
    primegov: [c, 'cityof' + c, c + st, c + 'county'].filter((x, i, a) => x.length >= 3 && a.indexOf(x) === i)
  };
}

/** Does this account's agenda text name some OTHER state? */
function stateEvidence(text, code) {
  const want = STATES[code];
  const t = ' ' + String(text || '') + ' ';
  const said = (s) => new RegExp(`state of ${s}(?![a-z])`, 'i').test(t) ||
    new RegExp(`${s} (revised statutes|revised code|statutes|general statutes|compiled laws|administrative code|department of transportation|constitution)`, 'i').test(t);
  const other = Object.values(STATES).find((s) => s !== want && !(want || '').includes(s) && said(s));
  return { ok: !!(want && said(want)), other: other || null };
}

async function probe(vendor, code, ch, videos) {
  const adapter = getAdapter(vendor);
  try {
    await adapter.verify(code);
  } catch (err) {
    return null;
  }
  // Compare against the channel's recent videos.
  const dates = videos.map((v) => new Date(v.anchor));
  const from = new Date(Math.min(...dates) - 3 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Math.max(...dates) + 3 * 864e5).toISOString().slice(0, 10);
  let meetings = [];
  try {
    meetings = await adapter.listMeetings(code, { limit: 400, from, to });
  } catch (err) {
    return { vendor, code, error: err.message };
  }
  const matched = [];
  for (const v of videos) {
    const day = new Date(v.anchor).getTime();
    const hit = meetings.find((m) => {
      const d = new Date(m.meetingDate + 'T12:00:00Z').getTime();
      if (Math.abs(d - day) > 1.6 * 864e5) return false;
      return Math.max(nameSimilarity(m.bodyName, v.title), nameSimilarity(m.bodyName, ch.gov_body)) >= 0.5;
    });
    if (hit) matched.push(hit);
  }
  // Read a few matched agendas for the state check (Legistar only: PrimeGov
  // agendas are PDFs and too slow to read here).
  let text = '';
  if (vendor === 'legistar') {
    for (const m of matched.filter((x, i, a) => a.indexOf(x) === i).slice(0, 4)) {
      try {
        const items = await adapter.listItems(code, m.externalId, m);
        text += ' ' + items.map((i) => i.title).join(' ');
      } catch (err) { /* skip */ }
      await sleep(150);
    }
  }
  const ev = stateEvidence(text, ch.state_code);
  const rate = videos.length ? matched.length / videos.length : 0;
  let verdict;
  if (ev.other) verdict = `WRONG STATE? agenda mentions ${ev.other}`;
  // A same-named town elsewhere can share a meeting day, so a modest overlap
  // also needs the state confirmed in the agenda text or the account name.
  else if (matched.length >= 3 && rate >= 0.3 &&
           (ev.ok || code.endsWith(String(ch.state_code).toLowerCase()) || INCLUDE.includes(code))) verdict = 'MATCH';
  else if (matched.length >= 3 && rate >= 0.3) verdict = 'LIKELY — state not confirmed, check by eye';
  else if (matched.length) verdict = 'WEAK — few dates line up';
  else verdict = 'NO OVERLAP — dates/bodies never line up';
  return { vendor, code, matched: matched.length, of: videos.length, rate, stateConfirmed: ev.ok, verdict };
}

async function main() {
  if (!config.databaseUrl) { console.error('\n  DATABASE_URL is not set in .env\n'); process.exit(1); }
  await runMigrations();
  const channels = (await db.many(
    `SELECT * FROM channels WHERE is_active ORDER BY state_code, municipality`))
    .filter((c) => !/school|education|isd\b/i.test(c.gov_body))
    .filter((c) => !ONLY || c.municipality.toLowerCase().includes(ONLY));

  console.log(`\n  Looking for agenda systems for ${channels.length} channels (school boards skipped).`);
  console.log('  This takes roughly 10-20 minutes. Nothing is changed unless you add --apply.\n');

  const results = [];
  for (const ch of channels) {
    const label = `${ch.municipality}, ${ch.state_code} · ${ch.gov_body}`;
    if (ch.agenda_vendor && ch.agenda_client) {
      console.log(`  = ${label.padEnd(46).slice(0, 46)} already linked (${ch.agenda_vendor}/${ch.agenda_client})`);
      continue;
    }
    const videos = (await db.many(
      `SELECT title, COALESCE(scheduled_start_at, actual_start_at, published_at) AS anchor
         FROM videos WHERE channel_id = $1 AND NOT is_hidden AND published_at IS NOT NULL
        ORDER BY published_at DESC LIMIT 25`, [ch.id]));
    if (videos.length < 3) {
      console.log(`  · ${label.padEnd(46).slice(0, 46)} skipped — fewer than 3 videos to check against`);
      continue;
    }
    const cand = candidates(ch);
    const found = [];
    for (const vendor of ['legistar', 'primegov']) {
      for (const code of cand[vendor]) {
        const r = await probe(vendor, code, ch, videos);
        if (r) found.push(r);
        await sleep(200);
      }
    }
    const best = found.filter((r) => r.verdict === 'MATCH').sort((a, b) => b.matched - a.matched)[0];
    const show = best || found.sort((a, b) => (b.matched || 0) - (a.matched || 0))[0];
    results.push({ ch, best, found });
    if (!show) {
      console.log(`  ✗ ${label.padEnd(46).slice(0, 46)} no Legistar or PrimeGov account found`);
    } else {
      console.log(`  ${best ? '✓' : '?'} ${label.padEnd(46).slice(0, 46)} ${(show.vendor + '/' + show.code).padEnd(28)} ` +
        (show.error ? 'ERROR ' + show.error
          : `${show.verdict}  (${show.matched}/${show.of} videos line up${show.stateConfirmed ? ', state confirmed' : ''})`));
    }
  }

  const linkable = results.filter((r) => r.best);
  console.log(`\n  ${linkable.length} confident matches, ${results.length - linkable.length} not linked.`);

  if (!APPLY) {
    console.log('  Nothing changed. To link the ✓ rows and pull their agendas, run:');
    console.log('    npm run find-agendas -- --apply\n');
    const likely = results.filter((r) => !r.best && r.found.some((f) => /^LIKELY/.test(f.verdict)));
    if (likely.length) {
      console.log('  "?" rows marked LIKELY line up by date but the state could not be confirmed.');
      console.log('  If you check one and it is right, add its account name, e.g.  --include=' +
        likely[0].found.find((f) => /^LIKELY/.test(f.verdict)).code + '\n');
    }
    await db.close();
    return;
  }

  console.log('\n  Linking and pulling agendas...');
  const ids = [];
  for (const { ch, best } of linkable) {
    await db.query(
      `INSERT INTO agenda_sources (vendor, client_code, display_name, state_code, is_available, last_verified_at)
       VALUES ($1,$2,$3,$4,TRUE,now())
       ON CONFLICT (vendor, client_code) DO UPDATE SET
         display_name = COALESCE(agenda_sources.display_name, EXCLUDED.display_name),
         state_code = COALESCE(agenda_sources.state_code, EXCLUDED.state_code),
         is_available = TRUE, last_verified_at = now(), last_error = NULL`,
      [best.vendor, best.code, `${ch.municipality}, ${ch.state_code}`, ch.state_code]);
    const row = await db.one(
      'UPDATE channels SET agenda_vendor = $2, agenda_client = $3 WHERE id = $1 RETURNING *',
      [ch.id, best.vendor, best.code]);
    try {
      const s = await syncChannelAgendas(row, { limit: 40 });
      console.log(`  ✓ ${ch.municipality}: ${s.meetings} agendas, ${s.items} items`);
    } catch (err) {
      console.log(`  ! ${ch.municipality}: agenda pull failed (${err.message})`);
    }
    ids.push(ch.id);
  }
  if (ids.length) {
    console.log('\n  Matching meetings to their agendas and re-tagging (several minutes)...');
    const m = await matchAndReclassify({ limit: 3000, onlyUnmatched: true, channelIds: ids });
    console.log(`  checked=${m.considered} matched=${m.matched} tagged-from-agenda=${m.retagged} no-agenda=${m.unmatched}`);
    console.log('  The daily job keeps going from here, a batch each night.\n');
  }
  await db.close();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('\n  ' + err.message + '\n');
    await db.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = { candidates, stateEvidence, probe };
