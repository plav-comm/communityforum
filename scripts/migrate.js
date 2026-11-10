#!/usr/bin/env node
/**
 * Applies every .sql file in db/migrations, in filename order, once.
 * Safe to run repeatedly — already-applied files are skipped.
 *
 *   npm run migrate
 *
 * The web server also does this by itself at startup.
 */
const { config } = require('../server/config');
const db = require('../server/db');
const { runMigrations } = require('../server/lib/migrations');

async function main() {
  if (!config.databaseUrl) {
    console.error('\n  DATABASE_URL is not set. Copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  try {
    const { ran, total } = await runMigrations({ say: (m) => console.log(m) });
    console.log(`\n  Migrations complete. ${ran.length} new, ${total - ran.length} already in place.\n`);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    await db.close().catch(() => {});
    process.exit(1);
  }
  await db.close();
}

main().catch(async (err) => {
  console.error(err);
  await db.close().catch(() => {});
  process.exit(1);
});
