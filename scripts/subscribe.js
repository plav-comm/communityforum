#!/usr/bin/env node
/**
 * Turns on real-time push for every active channel.
 * Run once after seeding, and any time you change PUBLIC_BASE_URL.
 *
 *   npm run subscribe
 *
 * Requires PUBLIC_BASE_URL, WEBSUB_SECRET and WEBSUB_VERIFY_TOKEN, and the
 * server must already be deployed and reachable at that URL — the hub calls it
 * back within seconds to verify.
 */
const db = require('../server/db');
const { config, assertConfig } = require('../server/config');
const subscribe = require('../server/websub/subscribe');

async function main() {
  assertConfig({ requireWebSub: true });
  console.log(`\n  Callback URL the hub will use: ${config.websub.callbackUrl}`);
  console.log('  (this must be publicly reachable over HTTPS right now)\n');

  const results = await subscribe.subscribeAll();
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.town || r.channel}${r.ok ? '' : '  ' + (r.error || 'status ' + r.status)}`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n  ${ok}/${results.length} subscription requests accepted by the hub.`);
  console.log('  The hub now calls your GET endpoint to verify each one.');
  console.log('  Check it worked:  curl "$PUBLIC_BASE_URL/api/channels" | grep websub_state\n');
  await db.close();
}

main().catch(async (e) => { console.error('\n  ' + e.message + '\n'); await db.close().catch(() => {}); process.exit(1); });
