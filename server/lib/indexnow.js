/**
 * IndexNow: tell Bing (and the other engines that share IndexNow, such as Yandex,
 * Seznam and Naver) about new pages the moment they exist, instead of waiting
 * for a crawl. Bing's index also feeds ChatGPT search and Copilot.
 *
 * The key is public by design: the engines fetch /<key>.txt to confirm the
 * request came from this site. Fire-and-forget; a failure only means the
 * engines find the page on their next crawl via the sitemap.
 */
const { config } = require('../config');
const log = require('./log');

const KEY = process.env.INDEXNOW_KEY || 'c375612fc8b877e1f755a13fd4dd1c47';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function enabled() {
  return config.env === 'production' && /^https:\/\//.test(config.websub.callbackBase || '');
}

/** Notify the engines about a list of absolute URLs on this site. Never throws. */
async function notify(urls) {
  const list = [...new Set((urls || []).filter(Boolean))].slice(0, 10000);
  if (!list.length || !enabled()) return { skipped: true };
  const base = config.websub.callbackBase;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(base).host, key: KEY, keyLocation: `${base}/${KEY}.txt`, urlList: list }),
      signal: AbortSignal.timeout(15000)
    });
    log.info('indexnow notified', { urls: list.length, status: res.status });
    return { status: res.status };
  } catch (err) {
    log.warn('indexnow notify failed', { err: err.message });
    return { error: err.message };
  }
}

module.exports = { KEY, notify, enabled };
