/**
 * Applies every .sql file in db/migrations, in filename order, once.
 * Used by `npm run migrate` and by the web server at startup, so a deploy
 * that adds a migration applies it without anyone opening a terminal.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

/**
 * @param {object} opts
 * @param {(msg: string) => void} [opts.say]  progress output (defaults to silent)
 * @returns {Promise<{ran: string[], total: number}>}
 */
async function runMigrations({ say = () => {} } = {}) {
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
  const ran = [];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        say(`  ! ${file} has changed since it was applied. Add a NEW migration file instead of editing old ones.`);
      } else {
        say(`  · ${file} already applied`);
      }
      continue;
    }

    say(`  → applying ${file}`);
    try {
      await db.tx(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2)', [file, checksum]);
      });
      ran.push(file);
    } catch (err) {
      const e = new Error(`${file} failed: ${err.message}`);
      e.file = file;
      throw e;
    }
  }
  return { ran, total: files.length };
}

module.exports = { runMigrations };
