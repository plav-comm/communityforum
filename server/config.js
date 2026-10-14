/**
 * Central configuration. Every environment variable the app reads is
 * declared here and nowhere else, so there is one place to look.
 */
require('dotenv').config();

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, dflt) => (v === undefined || v === '' ? dflt : parseInt(v, 10));

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),

  // Postgres connection string. Supabase gives you this under
  // Project Settings -> Database -> Connection string -> URI.
  databaseUrl: process.env.DATABASE_URL || '',
  // Supabase and most hosts require TLS; local Postgres usually does not.
  databaseSsl: bool(process.env.DATABASE_SSL, /supabase|neon|render|railway/i.test(process.env.DATABASE_URL || '')),

  // YouTube Data API v3 key (Google Cloud Console -> APIs & Services -> Credentials)
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',

  websub: {
    // Google's public WebSub hub for YouTube feeds. Do not change.
    hubUrl: process.env.WEBSUB_HUB_URL || 'https://pubsubhubbub.appspot.com/subscribe',
    // The public HTTPS base URL of THIS server, e.g. https://townhallmeetings.org
    callbackBase: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    callbackPath: process.env.WEBSUB_CALLBACK_PATH || '/websub/youtube',
    // Shared secret used to sign push notifications. Any long random string.
    secret: process.env.WEBSUB_SECRET || '',
    // Extra token echoed back during verification, proving the request is ours.
    verifyToken: process.env.WEBSUB_VERIFY_TOKEN || '',
    // Google's hub caps the lease at 828000 seconds (~9.6 days).
    leaseSeconds: int(process.env.WEBSUB_LEASE_SECONDS, 828000),
    // Renew when fewer than this many hours remain on the lease.
    renewWindowHours: int(process.env.WEBSUB_RENEW_WINDOW_HOURS, 48)
  },

  ingest: {
    // Minimum total score before a topic is attached to a video.
    topicThreshold: Number(process.env.TOPIC_SCORE_THRESHOLD || 2.0),
    // Never attach more than this many topics to one video.
    maxTopicsPerVideo: int(process.env.MAX_TOPICS_PER_VIDEO, 4),
    // How many recent uploads per channel the daily backfill checks.
    backfillPerChannel: int(process.env.BACKFILL_PER_CHANNEL, 10),
    // If a push arrives from a channel we do not know, add it automatically?
    autoAddChannels: bool(process.env.AUTO_ADD_CHANNELS, false),
    // Only import videos whose title looks like a public meeting. Keeps
    // concerts, PSAs and Shorts from community-access channels off the site.
    meetingsOnly: bool(process.env.MEETINGS_ONLY, true)
  },

  // Optional: a transcript provider. Left unset for launch — see server/lib/transcript.js
  transcriptProvider: process.env.TRANSCRIPT_PROVIDER || '',

  // Protects the admin/maintenance routes. Any long random string.
  adminToken: process.env.ADMIN_TOKEN || '',

  cors: {
    // Comma-separated list of allowed browser origins, or * for any.
    origins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean)
  }
};

config.websub.callbackUrl = config.websub.callbackBase + config.websub.callbackPath;

/** Fail fast with a readable message rather than a confusing crash later. */
function assertConfig({ requireYouTube = false, requireWebSub = false } = {}) {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (requireYouTube && !config.youtubeApiKey) missing.push('YOUTUBE_API_KEY');
  if (requireWebSub) {
    if (!config.websub.callbackBase) missing.push('PUBLIC_BASE_URL');
    if (!config.websub.secret) missing.push('WEBSUB_SECRET');
    if (!config.websub.verifyToken) missing.push('WEBSUB_VERIFY_TOKEN');
  }
  if (missing.length) {
    throw new Error(
      'Missing required environment variable(s): ' + missing.join(', ') +
      '\nCopy .env.example to .env and fill these in. See README.md step 3.'
    );
  }
}

module.exports = { config, assertConfig };
