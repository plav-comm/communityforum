/**
 * Does a video look like a public meeting?
 *
 * Many towns publish through a community-access channel that also posts
 * concerts, PSAs, sports and trivia nights. The site promises meetings, so
 * only videos whose title names a meeting-type event get in.
 *
 * Deliberately title-only and generous: a missed oddly-titled meeting is a
 * smaller problem than a jazz concert in the Library.
 */
const MEETING_WORDS = new RegExp(
  '\\b(' + [
    'meetings?', 'council', 'commission\\w*', 'board', 'boc', 'bocc', 'sessions?',
    'hearings?', 'committees?', 'workshop', 'budget', 'agenda', 'caucus',
    'supervisors', 'trustees', 'selectmen', 'select ?board', 'aldermen', 'alderpersons',
    'assembly', 'planning', 'zoning', 'public comment', 'legislative', 'cow',
    'town hall', 'governing', 'school board', 'board of education', 'freeholders',
    'quorum court', 'fiscal court', 'county court', 'mayor and council', 'city commission'
  ].join('|') + ')\\b',
  'i'
);

// Things that use meeting-ish words but are not meetings.
const NOT_MEETING = /\b(trailer|promo|highlights?|recap|music video|concert|parade|ribbon cutting)\b/i;

/** Shorts and clips: anything under 3 minutes that is not live or upcoming. */
const MIN_SECONDS = 180;

function looksLikeMeeting(video) {
  const title = String((video && video.title) || '');
  if (!MEETING_WORDS.test(title)) return false;
  if (NOT_MEETING.test(title)) return false;
  const live = video.status === 'live' || video.status === 'upcoming';
  if (!live && video.durationSeconds && video.durationSeconds < MIN_SECONDS) return false;
  return true;
}

module.exports = { looksLikeMeeting };
