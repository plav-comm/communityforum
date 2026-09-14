/**
 * Test-only Postgres. Boots PGlite (real Postgres compiled to WebAssembly) and
 * exposes it on a TCP port speaking the Postgres wire protocol, so the app's
 * ordinary `pg` driver connects to it exactly as it would to Supabase.
 *
 * This means the test suite exercises the real SQL — generated columns, GIN
 * indexes, triggers, jsonb aggregation and all — not a mock.
 *
 *   node test/pg-server.mjs 55432
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2] || 55432);
const dataDir = process.env.PGLITE_DIR || './.pgdata';
const db = await PGlite.create({ dataDir });
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
console.log(`pglite listening on 127.0.0.1:${port} (data: ${dataDir})`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
