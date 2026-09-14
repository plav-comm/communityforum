/**
 * Postgres connection pool. Works against Supabase, Neon, Render Postgres,
 * Railway, or a plain local Postgres — it is all the same wire protocol.
 */
const { Pool } = require('pg');
const { config } = require('./config');
const log = require('./lib/log');

let pool;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DB_POOL_MAX || 8),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', (err) => log.error('idle postgres client error', { err: err.message }));
  }
  return pool;
}

/** Run a query. Logs anything slower than 500ms so you can spot problems. */
async function query(text, params) {
  const started = Date.now();
  const res = await getPool().query(text, params);
  const ms = Date.now() - started;
  if (ms > 500) log.warn('slow query', { ms, sql: text.slice(0, 90).replace(/\s+/g, ' ') });
  return res;
}

const one = async (text, params) => (await query(text, params)).rows[0] || null;
const many = async (text, params) => (await query(text, params)).rows;

/** Run several statements in a single transaction. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, query, one, many, tx, close };
