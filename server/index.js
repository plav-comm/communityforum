/**
 * Community-Span server entry point.
 *
 * Serves three things:
 *   /                the front-end site (public/)
 *   /api/*           the read API the site queries
 *   /websub/youtube  the real-time push endpoint YouTube calls
 */
const path = require('path');
const express = require('express');
const { config, assertConfig } = require('./config');
const log = require('./lib/log');
const db = require('./db');

const app = express();
app.set('trust proxy', 1);          // Render/Railway/Fly all sit behind a proxy
app.disable('x-powered-by');

/* ------------------------------------------------------------------
   WebSub must be mounted BEFORE the JSON body parser.
   Signature verification needs the exact raw bytes YouTube sent; any
   parser that re-serialises the body would break the HMAC.
   ------------------------------------------------------------------ */
const { router: websubRouter } = require('./websub/router');
app.use(
  config.websub.callbackPath,
  express.raw({ type: ['application/atom+xml', 'text/xml', 'application/xml', '*/*'], limit: '1mb' }),
  websubRouter
);

/* ---------------- normal middleware ---------------- */
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  const allowed = config.cors.origins;
  const origin = req.get('origin');
  if (allowed.includes('*')) res.set('access-control-allow-origin', '*');
  else if (origin && allowed.includes(origin)) res.set('access-control-allow-origin', origin);
  res.set('access-control-allow-headers', 'content-type, authorization');
  res.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/api/health') return;
    log.debug('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
  });
  next();
});

/* ---------------- routes ---------------- */
app.use('/api', require('./routes/api'));
app.use('/admin', require('./routes/admin'));

/* ---------------- static front end ---------------- */
// Cache assets in production, but never in development — stale CSS/JS while
// iterating is a genuinely confusing way to lose an afternoon.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: config.env === 'production' ? '1h' : 0,
  etag: true,
  extensions: ['html']
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/* ---------------- errors ---------------- */
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.use((err, req, res, next) => {
  log.error('unhandled route error', { path: req.path, err: err.message });
  res.status(err.status || 500).json({
    error: config.env === 'production' ? 'internal error' : err.message
  });
});

/* ---------------- boot ---------------- */
async function start() {
  assertConfig();

  // Prove the database is reachable before we start taking traffic.
  try {
    await db.query('SELECT 1');
    log.info('database connection ok');
  } catch (err) {
    log.error('cannot reach the database — check DATABASE_URL', { err: err.message });
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    log.info('community-span server listening', {
      port: config.port,
      env: config.env,
      websubCallback: config.websub.callbackUrl || '(PUBLIC_BASE_URL not set)',
      youtubeKey: config.youtubeApiKey ? 'set' : 'MISSING'
    });
  });

  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) start();

module.exports = { app, start };
