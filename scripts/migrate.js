#!/usr/bin/env node
/**
 * Applies every .sql file in db/migrations, in filename order, once.
 * Safe to run repeatedly — already-applied files are skipped.
 *
 *   npm run migrate
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../server/config');
const db = require('../server/db');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  if (!config.databaseUrl) {
    console.error('\n  DATABASE_URL is not set. Copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Map(
    (await db.many('SELECT filename, checksum FROM schema_migrations')).map((r) => [r.filename, r.checksum])
  );

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        console.warn(`  ! ${file} has changed since it was applied. Add a NEW migration file instead of editing old ones.`);
      } else {
        console.log(`  · ${file} already applied`);
      }
      continue;
    }

    process.stdout.write(`  → applying ${file} ... `);
    try {
      await db.tx(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2)', [file, checksum]);
      });
      console.log('done');
      ran += 1;
    } catch (err) {
      console.log('FAILED');
      console.error(`\n  ${file} failed:\n  ${err.message}\n`);
      process.exit(1);
    }
  }

  console.log(`\n  Migrations complete. ${ran} new, ${files.length - ran} already in place.\n`);
  await db.close();
}

main().catch(async (err) => {
  console.error(err);
  await db.close().catch(() => {});
  process.exit(1);
});
