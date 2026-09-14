/**
 * Transcript provider slot — intentionally empty for launch.
 *
 * IMPORTANT, and worth understanding before you pay anyone for this:
 * YouTube's Data API only lets you download captions for channels that YOUR
 * Google account owns (captions.download requires the channel owner's OAuth
 * token). There is no legitimate API path to pull transcripts for other towns'
 * videos. So for launch we classify from title, description and tags, which for
 * municipal meetings is unusually rich — clerks title these videos precisely.
 *
 * When you are ready to tag from what was actually SAID in the room, set
 * TRANSCRIPT_PROVIDER and implement the matching function below. Everything
 * downstream (scoring, tagging, the API, the UI) already handles transcripts:
 * classify() weights them and records source='transcript' on each tag.
 *
 * Options when that day comes:
 *   'none'      (default) metadata-only classification
 *   'supadata'  or similar third-party transcript API — per-video fee
 *   'whisper'   self-hosted speech-to-text on the audio — compute cost, slow
 *               on 6-hour meetings, so run it as a queued background job
 *   'partner'   many towns publish agendas and minutes as PDFs; parsing those
 *               is free, legal, and often better signal than a raw transcript
 */
const { config } = require('../config');
const log = require('./log');

async function getTranscript(ytVideoId) {
  const provider = (config.transcriptProvider || 'none').toLowerCase();
  if (!provider || provider === 'none') return null;

  switch (provider) {
    // ------------------------------------------------------------------
    // Example shape for a third-party provider. Uncomment, add the key to
    // .env as TRANSCRIPT_API_KEY, and this starts feeding the classifier.
    // ------------------------------------------------------------------
    // case 'supadata': {
    //   const res = await fetch(
    //     `https://api.example-transcripts.com/v1/youtube?videoId=${ytVideoId}`,
    //     { headers: { authorization: `Bearer ${process.env.TRANSCRIPT_API_KEY}` } }
    //   );
    //   if (!res.ok) return null;
    //   const data = await res.json();
    //   return typeof data.text === 'string' ? data.text : null;
    // }

    default:
      log.warn('unknown TRANSCRIPT_PROVIDER, skipping transcripts', { provider });
      return null;
  }
}

module.exports = { getTranscript };
