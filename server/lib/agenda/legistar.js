/**
 * Legistar adapter (Granicus).
 *
 * The best of the agenda sources: fully structured JSON, no API key, no fee.
 *   https://webapi.legistar.com/v1/{client}/bodies
 *   https://webapi.legistar.com/v1/{client}/events
 *   https://webapi.legistar.com/v1/{client}/events/{id}/eventitems
 *
 * A real response looks like:
 *   "An ordinance relating to land use and zoning; amending the Seattle
 *    Comprehensive Plan ..."
 * which is exactly the text the topic classifier needs.
 *
 * Granicus documents that "some clients require use of an API Token". Those
 * clients simply fail verification and are marked unavailable — we never guess
 * at credentials.
 */
const BASE = 'https://webapi.legistar.com/v1';
const UA = 'TownHallMeetings/1.0 (civic meeting aggregator; +https://townhallmeetings.org)';

async function get(path, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: ctrl.signal
    });
    if (!res.ok) {
      const err = new Error(`legistar ${path} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap probe used by discovery: does this client code exist and answer? */
async function verify(clientCode) {
  const bodies = await get(`/${encodeURIComponent(clientCode)}/bodies?$top=25`);
  if (!Array.isArray(bodies) || !bodies.length) throw new Error('no bodies returned');
  return {
    bodies: bodies
      .filter((b) => b.BodyActiveFlag !== 0)
      .map((b) => b.BodyName)
      .filter(Boolean)
      .slice(0, 25)
  };
}

/**
 * Meetings, newest first. Pass `from`/`to` (YYYY-MM-DD) to target a specific
 * window — used when matching an older video whose agenda is not in the recent
 * page. Costs one request either way.
 */
async function listMeetings(clientCode, { limit = 40, sinceDays = 400, from, to } = {}) {
  const start = from || new Date(Date.now() - sinceDays * 864e5).toISOString().slice(0, 10);
  const clauses = [`EventDate ge datetime'${start}T00:00:00'`];
  if (to) clauses.push(`EventDate le datetime'${to}T23:59:59'`);
  const filter = encodeURIComponent(clauses.join(' and '));
  const rows = await get(
    `/${encodeURIComponent(clientCode)}/events?$top=${limit}` +
    `&$orderby=EventDate%20desc&$filter=${filter}`
  );
  return (rows || []).map((e) => ({
    externalId: String(e.EventId),
    bodyName: e.EventBodyName || null,
    title: e.EventBodyName || null,
    meetingAt: e.EventDate
      ? new Date(e.EventDate.slice(0, 10) + 'T12:00:00Z').toISOString()
      : null,
    meetingDate: e.EventDate ? e.EventDate.slice(0, 10) : null,
    agendaUrl: e.EventAgendaFile || e.EventInSiteURL || null,
    hasAgenda: (e.EventAgendaStatusName || '').toLowerCase() === 'final' || !!e.EventAgendaFile
  })).filter((m) => m.meetingDate);
}

/** The agenda items for one meeting. This is the payload that matters. */
async function listItems(clientCode, externalId) {
  const rows = await get(
    `/${encodeURIComponent(clientCode)}/events/${encodeURIComponent(externalId)}/eventitems` +
    `?AgendaNote=1&MinutesNote=1&Event=1`
  );
  const items = [];
  let position = 0;
  for (const it of rows || []) {
    const title = (it.EventItemTitle || it.EventItemMatterName || '').trim();
    if (!title) continue;
    items.push({
      position: position++,
      title: title.replace(/\s+/g, ' ').slice(0, 2000),
      matterType: it.EventItemMatterType || null,
      action: it.EventItemActionName || null
    });
  }
  return items;
}

module.exports = { vendor: 'legistar', verify, listMeetings, listItems };
