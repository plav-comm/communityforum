#!/usr/bin/env node
/**
 * Builds the catalogue of towns whose agenda system we can read.
 *
 *   npm run discover                 # both vendors, full candidate list
 *   npm run discover -- legistar     # one vendor only
 *   npm run discover -- primegov 40  # one vendor, first 40 candidates
 *
 * How it works. Neither vendor publishes a customer directory, so we verify
 * candidates instead: for Legistar we probe likely client codes derived from US
 * city and county names; for PrimeGov we start from the tenant subdomains found
 * in public certificate transparency logs. Anything that answers with real
 * meeting data gets catalogued, and you can then add a town by picking it from
 * the list rather than configuring it by hand.
 *
 * It is deliberately slow (one request at a time, ~4/second). Run it
 * occasionally, not on a schedule.
 */
const fs = require('fs');
const path = require('path');
const db = require('../server/db');
const { discover } = require('../server/pipeline/agenda');

async function main() {
  const cand = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'agenda-candidates.json'), 'utf8'));
  const onlyVendor = (process.argv[2] || '').toLowerCase();
  const cap = Number(process.argv[3]) || 0;

  const plan = [
    { vendor: 'legistar', list: cand.legistarCandidates, names: cand.candidateNames || {} },
    { vendor: 'primegov', list: cand.primegovTenants,    names: {} }
  ].filter((p) => !onlyVendor || p.vendor === onlyVendor);

  for (const p of plan) {
    const list = cap ? p.list.slice(0, cap) : p.list;
    console.log(`\n  Probing ${list.length} ${p.vendor} candidates (this takes a while)...\n`);
    let n = 0;
    const res = await discover(p.vendor, list, {
      names: p.names,
      onProgress: ({ code, ok, bodies }) => {
        n += 1;
        if (ok) console.log(`  ✓ ${p.vendor.padEnd(9)} ${code.padEnd(22)} ${bodies} bodies`);
        else if (n % 50 === 0) process.stdout.write(`  ... ${n}/${list.length}\r`);
      }
    });
    console.log(`\n  ${p.vendor}: ${res.found} readable of ${res.probed} probed.\n`);
  }

  const summary = await db.many(
    `SELECT vendor, count(*)::int n FROM agenda_sources WHERE is_available GROUP BY vendor ORDER BY vendor`
  );
  console.log('  Catalogue now holds:');
  summary.forEach((r) => console.log(`    ${r.vendor}: ${r.n} towns`));
  console.log('\n  Browse it:  curl "$PUBLIC_BASE_URL/api/agenda-sources?q=austin"\n');
  await db.close();
}

main().catch(async (e) => { console.error(e); await db.close().catch(() => {}); process.exit(1); });
