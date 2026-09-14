/**
 * The WebSub callback endpoint. This is the URL you give to Google's hub, and
 * the single most important route in the system.
 *
 *   GET  /websub/youtube   -> verification handshake (echo hub.challenge)
 *   POST /websub/youtube   -> signed push notification with new video(s)
 *
 * Two rules this file exists to enforce:
 *   1. Verify the HMAC signature on every POST. Without it, anyone who learns
 *      your callback URL could inject videos into your platform.
 *   2. Answer FAST. The hub expects a 2xx within seconds and will retry (then
 *      eventually drop your subscription) if we are slow. So we acknowledge
 *      first and do the YouTube API work after the response is sent.
 */
const express = require('express');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { query, one } = require('../db');
const { config } = require('../config');
const subscribe = require('./subscribe');
const { ingestVideoIds, markDeleted } = require('../pipeline/ingest');
const log = require('../lib/log');

const router = express.Router();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** Extract the channel ID out of a feed topic URL. */
function channelIdFromTopic(topic) {
  if (!topic) return null;
  const m = String(topic).match(/channel_id=(UC[\w-]{22})/);
  return m ? m[1] : null;
}

/* ============================================================
   1. VERIFICATION  (GET)
   The hub calls this right after we request a subscription.
   We must return hub.challenge as plain text with a 200.
   ============================================================ */
router.get('/', async (req, res) => {
  const mode = req.query['hub.mode'];
  const topic = req.query['hub.topic'];
  const challenge = req.query['hub.challenge'];
  const lease = req.query['hub.lease_seconds'];
  const token = req.query['hub.verify_token'];

  log.info('websub verification request', { mode, topic, lease });

  if (!mode || !challenge) {
    return res.status(400).type('text/plain').send('Missing hub.mode or hub.challenge');
  }

  // Confirm this handshake was started by us, not a stranger.
  if (config.websub.verifyToken && token !== config.websub.verifyToken) {
    log.warn('websub verification rejected: bad verify_token', { topic });
    return res.status(404).type('text/plain').send('Not found');
  }

  const ytChannelId = channelIdFromTopic(topic);
  if (!ytChannelId) {
    return res.status(400).type('text/plain').send('Unrecognised hub.topic');
  }

  // Only confirm channels we actually track.
  const channel = await one('SELECT id FROM channels WHERE yt_channel_id = $1', [ytChannelId]);
  if (!channel) {
    log.warn('websub verification for unknown channel', { ytChannelId });
    return res.status(404).type('text/plain').send('Unknown channel');
  }

  if (mode === 'subscribe') {
    await subscribe.markVerified(ytChannelId, lease);
  } else if (mode === 'unsubscribe') {
    await query(`UPDATE channels SET websub_state = 'unsubscribed' WHERE yt_channel_id = $1`, [ytChannelId]);
  }

  // Echo the challenge verbatim. This is the whole handshake.
  return res.status(200).type('text/plain').send(String(challenge));
});

/* ============================================================
   2. NOTIFICATION  (POST)
   Body is an Atom feed. Signature is in X-Hub-Signature.
   ============================================================ */
function verifySignature(header, rawBody, secret) {
  if (!header) return { valid: false, why: 'missing X-Hub-Signature header' };
  const [algo, sent] = String(header).split('=');
  if (!algo || !sent) return { valid: false, why: 'malformed signature header' };
  if (!['sha1', 'sha256', 'sha384', 'sha512'].includes(algo)) {
    return { valid: false, why: `unsupported algorithm ${algo}` };
  }
  const expected = crypto.createHmac(algo, secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sent, 'utf8');
  if (a.length !== b.length) return { valid: false, why: 'signature length mismatch' };
  return { valid: crypto.timingSafeEqual(a, b), why: 'digest mismatch' };
}

/** Pull the interesting bits out of YouTube's Atom payload. */
function parseNotification(xml) {
  const doc = parser.parse(xml);
  const feed = doc.feed || {};
  const entries = [].concat(feed.entry || []).filter(Boolean);
  const deleted = [].concat(feed['at:deleted-entry'] || []).filter(Boolean);

  const upserts = entries.map((e) => ({
    ytVideoId: e['yt:videoId'] ? String(e['yt:videoId']) : null,
    ytChannelId: e['yt:channelId'] ? String(e['yt:channelId']) : null,
    title: e.title ? String(e.title) : null,
    published: e.published || null,
    updated: e.updated || null
  })).filter((e) => e.ytVideoId);

  const deletes = deleted.map((d) => {
    const ref = d['@_ref'] || '';
    const m = String(ref).match(/video:([\w-]{11})/);
    return { ytVideoId: m ? m[1] : null };
  }).filter((d) => d.ytVideoId);

  return { upserts, deletes };
}

router.post('/', async (req, res) => {
  // req.body is a Buffer here — see the express.raw() mount in server/index.js.
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
  const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const xml = raw.toString('utf8');

  let parsed = { upserts: [], deletes: [] };
  try {
    parsed = parseNotification(xml);
  } catch (err) {
    log.error('websub payload parse failure', { err: err.message });
    return res.status(400).end();
  }

  const first = parsed.upserts[0] || {};
  const ytChannelId = first.ytChannelId || null;

  // Signature check, using the per-channel secret we handed the hub.
  const secret = ytChannelId
    ? await subscribe.getStoredSecret(ytChannelId)
    : config.websub.secret;
  const sig = verifySignature(req.get('x-hub-signature'), raw, secret);

  // Always record the event, valid or not. This is your audit trail.
  const event = await one(
    `INSERT INTO websub_events
       (yt_channel_id, yt_video_id, action, signature_valid, body_sha256)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      ytChannelId,
      first.ytVideoId || (parsed.deletes[0] || {}).ytVideoId || null,
      parsed.deletes.length && !parsed.upserts.length ? 'delete' : 'upsert',
      sig.valid,
      bodyHash
    ]
  );

  if (!sig.valid) {
    log.warn('websub signature rejected', { why: sig.why, channel: ytChannelId });
    // 202 rather than 403: we do not want the hub retrying a payload we refuse.
    return res.status(202).end();
  }

  // ---- Acknowledge immediately, then do the slow work. ----
  res.status(204).end();

  setImmediate(async () => {
    try {
      for (const d of parsed.deletes) await markDeleted(d.ytVideoId);

      const ids = parsed.upserts.map((u) => u.ytVideoId);
      if (ids.length) {
        const summary = await ingestVideoIds(ids, { reason: 'websub' });
        log.info('websub push processed', {
          channel: ytChannelId,
          inserted: summary.inserted, updated: summary.updated, skipped: summary.skipped
        });
      }
      await query('UPDATE websub_events SET processed = TRUE WHERE id = $1', [event.id]);
    } catch (err) {
      log.error('websub post-processing failed', { err: err.message });
      await query('UPDATE websub_events SET error = $2 WHERE id = $1', [event.id, err.message]).catch(() => {});
    }
  });
});

module.exports = { router, verifySignature, parseNotification };
