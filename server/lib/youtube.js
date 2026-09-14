/**
 * Thin YouTube Data API v3 client.
 *
 * Quota notes (the free daily allowance is 10,000 units):
 *   videos.list         = 1 unit per call (up to 50 video IDs per call)
 *   channels.list       = 1 unit per call (up to 50 channel IDs per call)
 *   playlistItems.list  = 1 unit per call (up to 50 items per call)
 *   search.list         = 100 units  <-- we deliberately never use this
 *
 * Because push notifications tell us exactly which video IDs are new, and the
 * daily safety net reads uploads playlists (1 unit each), a 200-channel
 * deployment costs roughly 250-400 units per day. Well inside the free tier.
 */
const { config } = require('../config');
const log = require('./log');

const API = 'https://www.googleapis.com/youtube/v3';

let unitsUsed = 0;
const quotaUsed = () => unitsUsed;

async function call(endpoint, params, { cost = 1 } = {}) {
  if (!config.youtubeApiKey) throw new Error('YOUTUBE_API_KEY is not set');
  const url = new URL(API + endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  url.searchParams.set('key', config.youtubeApiKey);

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  unitsUsed += cost;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403 && /quota/i.test(body)) {
      throw Object.assign(new Error('YouTube API quota exceeded'), { code: 'QUOTA', status: 403 });
    }
    throw Object.assign(new Error(`YouTube API ${endpoint} failed: ${res.status} ${body.slice(0, 300)}`), {
      status: res.status
    });
  }
  return res.json();
}

/** ISO-8601 duration ("PT1H32M21S") -> seconds. Live streams have no duration. */
function parseDuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => (x ? parseInt(x, 10) : 0));
  const total = d * 86400 + h * 3600 + mi * 60 + s;
  return total > 0 ? total : null;
}

/** Pick the largest thumbnail YouTube offers. */
function bestThumbnail(snippet, videoId) {
  const t = (snippet && snippet.thumbnails) || {};
  const pick = t.maxres || t.standard || t.high || t.medium || t.default;
  return (pick && pick.url) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * Decide live | upcoming | recorded from liveStreamingDetails.
 * A council livestream moves upcoming -> live -> recorded over its lifetime,
 * which is exactly what the front end needs to show a LIVE badge.
 */
function deriveStatus(item) {
  const d = item.liveStreamingDetails;
  const broadcast = item.snippet && item.snippet.liveBroadcastContent;
  if (d) {
    if (d.actualStartTime && !d.actualEndTime) return 'live';
    if (!d.actualStartTime && d.scheduledStartTime) {
      return new Date(d.scheduledStartTime) > new Date() ? 'upcoming' : 'upcoming';
    }
    return 'recorded';
  }
  if (broadcast === 'live') return 'live';
  if (broadcast === 'upcoming') return 'upcoming';
  return 'recorded';
}

/** Fetch full metadata for up to 50 video IDs at a time. */
async function getVideos(videoIds) {
  const out = [];
  const ids = [...new Set(videoIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await call('/videos', {
      part: 'snippet,contentDetails,statistics,liveStreamingDetails,status',
      id: batch.join(','),
      maxResults: 50
    });
    for (const item of data.items || []) {
      out.push({
        ytVideoId: item.id,
        ytChannelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        title: item.snippet.title,
        description: item.snippet.description || '',
        tags: item.snippet.tags || [],
        publishedAt: item.snippet.publishedAt,
        durationSeconds: parseDuration(item.contentDetails && item.contentDetails.duration),
        thumbnailUrl: bestThumbnail(item.snippet, item.id),
        viewCount: item.statistics && item.statistics.viewCount ? Number(item.statistics.viewCount) : null,
        status: deriveStatus(item),
        scheduledStartAt: (item.liveStreamingDetails || {}).scheduledStartTime || null,
        actualStartAt: (item.liveStreamingDetails || {}).actualStartTime || null,
        actualEndAt: (item.liveStreamingDetails || {}).actualEndTime || null,
        privacyStatus: (item.status || {}).privacyStatus || null,
        raw: item
      });
    }
  }
  log.debug('youtube.getVideos', { asked: ids.length, got: out.length, quota: unitsUsed });
  return out;
}

/** Channel details, including the "uploads" playlist used for backfill. */
async function getChannels(channelIds) {
  const out = [];
  const ids = [...new Set(channelIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await call('/channels', {
      part: 'snippet,contentDetails,statistics',
      id: ids.slice(i, i + 50).join(',')
    });
    for (const item of data.items || []) {
      out.push({
        ytChannelId: item.id,
        title: item.snippet.title,
        description: item.snippet.description || '',
        country: item.snippet.country || null,
        uploadsPlaylistId:
          item.contentDetails && item.contentDetails.relatedPlaylists
            ? item.contentDetails.relatedPlaylists.uploads
            : null,
        raw: item
      });
    }
  }
  return out;
}

/** Most recent uploads for a channel. Used by the daily safety net. */
async function getPlaylistVideoIds(playlistId, limit = 10) {
  const data = await call('/playlistItems', {
    part: 'contentDetails',
    playlistId,
    maxResults: Math.min(limit, 50)
  });
  return (data.items || [])
    .map((i) => i.contentDetails && i.contentDetails.videoId)
    .filter(Boolean);
}

/**
 * Resolve a channel from whatever a non-technical user pastes:
 * a full channel URL, an @handle, a /channel/UC... URL, or a video URL.
 * Returns a UC... channel ID.
 */
async function resolveChannelId(input) {
  const raw = String(input).trim();

  const direct = raw.match(/(UC[\w-]{22})/);
  if (direct) return direct[1];

  const handle = raw.match(/@([A-Za-z0-9._-]+)/);
  if (handle) {
    const data = await call('/channels', { part: 'id', forHandle: handle[1] });
    if (data.items && data.items[0]) return data.items[0].id;
  }

  const user = raw.match(/youtube\.com\/user\/([A-Za-z0-9._-]+)/);
  if (user) {
    const data = await call('/channels', { part: 'id', forUsername: user[1] });
    if (data.items && data.items[0]) return data.items[0].id;
  }

  const video = raw.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/);
  if (video) {
    const vids = await getVideos([video[1]]);
    if (vids[0]) return vids[0].ytChannelId;
  }

  throw new Error(
    `Could not work out a channel ID from "${raw}". Paste the channel's URL ` +
    `(youtube.com/@TownOfExample or youtube.com/channel/UC...) or a link to any video on it.`
  );
}

/** The Atom feed URL that WebSub subscribes to for a channel. */
const feedUrl = (ytChannelId) =>
  `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${ytChannelId}`;

module.exports = {
  getVideos,
  getChannels,
  getPlaylistVideoIds,
  resolveChannelId,
  parseDuration,
  deriveStatus,
  feedUrl,
  quotaUsed
};
