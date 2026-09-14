/**
 * WebSub (formerly PubSubHubbub) subscription management.
 *
 * The handshake, in plain English:
 *   1. We POST to Google's hub: "please push me updates for this channel's feed,
 *      send them to <our callback URL>, and sign them with <this secret>".
 *   2. The hub immediately calls our callback with a GET containing a random
 *      `hub.challenge` string. We must echo that string back as plain text.
 *      That proves we actually own the callback URL.
 *   3. From then on, every new upload or livestream on that channel arrives at
 *      our callback as a signed POST, usually within seconds.
 *   4. Subscriptions EXPIRE (lease_seconds). Ours are ~9.6 days, which is why
 *      the daily job re-subscribes. Miss that and the feed silently goes quiet.
 */
const crypto = require('crypto');
const { query, one, many } = require('../db');
const { config } = require('../config');
const youtube = require('../lib/youtube');
const log = require('../lib/log');

/** Each channel gets its own signing secret, derived from the master secret. */
function channelSecret(ytChannelId) {
  return crypto
    .createHmac('sha256', config.websub.secret)
    .update(ytChannelId)
    .digest('hex')
    .slice(0, 40);
}

async function sendHubRequest(ytChannelId, mode) {
  const secret = channelSecret(ytChannelId);
  const body = new URLSearchParams({
    'hub.mode': mode,                                  // subscribe | unsubscribe
    'hub.topic': youtube.feedUrl(ytChannelId),
    'hub.callback': config.websub.callbackUrl,
    'hub.verify': 'async',
    'hub.secret': secret,
    'hub.verify_token': config.websub.verifyToken,
    'hub.lease_seconds': String(config.websub.leaseSeconds)
  });

  const res = await fetch(config.websub.hubUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await res.text().catch(() => '');

  // 202 Accepted is the success case: the hub will now call our GET endpoint.
  const ok = res.status === 202 || res.status === 204;
  return { ok, status: res.status, body: text.slice(0, 300), secret };
}

/** Subscribe (or renew) one channel. */
async function subscribeChannel(ytChannelId) {
  if (!config.websub.callbackBase) {
    throw new Error('PUBLIC_BASE_URL is not set — the hub has nowhere to push to.');
  }
  const result = await sendHubRequest(ytChannelId, 'subscribe');

  await query(
    `UPDATE channels SET
       websub_state           = $2,
       websub_secret          = $3,
       websub_last_request_at = now(),
       websub_last_error      = $4
     WHERE yt_channel_id = $1`,
    [
      ytChannelId,
      result.ok ? 'pending' : 'failed',      // becomes 'active' when the hub verifies
      result.secret,
      result.ok ? null : `hub returned ${result.status}: ${result.body}`
    ]
  );

  log[result.ok ? 'info' : 'error']('websub subscribe requested', {
    channel: ytChannelId, status: result.status, ok: result.ok
  });
  return result;
}

async function unsubscribeChannel(ytChannelId) {
  const result = await sendHubRequest(ytChannelId, 'unsubscribe');
  await query(
    `UPDATE channels SET websub_state = 'unsubscribed', websub_last_request_at = now()
      WHERE yt_channel_id = $1`,
    [ytChannelId]
  );
  return result;
}

/** Subscribe every active channel that has no live lease. */
async function subscribeAll() {
  const channels = await many(
    'SELECT yt_channel_id, municipality FROM channels WHERE is_active ORDER BY id'
  );
  const out = [];
  for (const c of channels) {
    try {
      const r = await subscribeChannel(c.yt_channel_id);
      out.push({ channel: c.yt_channel_id, town: c.municipality, ok: r.ok, status: r.status });
    } catch (err) {
      out.push({ channel: c.yt_channel_id, town: c.municipality, ok: false, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 250)); // be polite to the hub
  }
  return out;
}

/**
 * Channels whose lease expires inside the renew window, plus anything stuck in
 * pending/failed. This is what the daily job acts on.
 */
async function channelsNeedingRenewal() {
  return many(
    `SELECT yt_channel_id, municipality, websub_state, websub_expires_at
       FROM channels
      WHERE is_active
        AND (websub_expires_at IS NULL
             OR websub_expires_at < now() + ($1 || ' hours')::interval
             OR websub_state IN ('pending', 'failed'))
      ORDER BY websub_expires_at NULLS FIRST`,
    [String(config.websub.renewWindowHours)]
  );
}

/** Called by the GET verification handler once the hub confirms a lease. */
async function markVerified(ytChannelId, leaseSeconds) {
  const lease = Number(leaseSeconds) || config.websub.leaseSeconds;
  await query(
    `UPDATE channels SET
       websub_state      = 'active',
       websub_expires_at = now() + ($2 || ' seconds')::interval,
       websub_last_error = NULL
     WHERE yt_channel_id = $1`,
    [ytChannelId, String(lease)]
  );
  log.info('websub subscription verified', { channel: ytChannelId, leaseSeconds: lease });
}

async function getStoredSecret(ytChannelId) {
  const row = await one('SELECT websub_secret FROM channels WHERE yt_channel_id = $1', [ytChannelId]);
  return (row && row.websub_secret) || channelSecret(ytChannelId);
}

module.exports = {
  subscribeChannel,
  unsubscribeChannel,
  subscribeAll,
  channelsNeedingRenewal,
  markVerified,
  channelSecret,
  getStoredSecret
};
