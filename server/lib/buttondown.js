/**
 * Buttondown (newsletter service) client.
 *
 *   createDraft({ subject, body })   a new email, saved as a DRAFT for a person to send
 *   addSubscriber({ email, ... })    a new subscriber; Buttondown emails them a
 *                                    confirmation link first (double opt-in)
 *
 * The API key lives in BUTTONDOWN_API_KEY (Buttondown -> Settings -> API).
 */
const { config } = require('../config');

const BASE = 'https://api.buttondown.com/v1';

async function call(path, body, { timeout = 20000 } = {}) {
  if (!config.buttondownApiKey) {
    const e = new Error('BUTTONDOWN_API_KEY is not set');
    e.code = 'NO_KEY';
    throw e;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        authorization: 'Token ' + config.buttondownApiKey,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    if (!res.ok) {
      const detail = (json && (json.detail || json.message || json.code ||
        (json.email_address && [].concat(json.email_address).join(' ')))) || text.slice(0, 300);
      const e = new Error(`buttondown ${path} -> ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      e.status = res.status;
      e.body = json || text;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Save an issue as a draft. Markdown body. Never sends. */
async function createDraft({ subject, body }) {
  return call('/emails', { subject, body, status: 'draft' });
}

/** Add a subscriber. Buttondown sends them a confirmation email. */
async function addSubscriber({ email, ip, referrer }) {
  const payload = { email_address: email, tags: ['website'] };
  if (ip) payload.ip_address = ip;
  if (referrer) payload.referrer_url = referrer;
  return call('/subscribers', payload);
}

const isConfigured = () => !!config.buttondownApiKey;

module.exports = { createDraft, addSubscriber, isConfigured };
