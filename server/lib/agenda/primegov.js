/**
 * PrimeGov adapter.
 *
 * Meetings come back as JSON with no key:
 *   https://{client}.primegov.com/api/v2/PublicPortal/ListUpcomingMeetings
 *   https://{client}.primegov.com/api/v2/PublicPortal/ListArchivedMeetings?year=YYYY
 *
 * The agenda itself is a PDF, served via a redirect to public blob storage:
 *   https://{client}.primegov.com/Public/CompiledDocument/{documentId}
 *
 * So unlike Legistar there is no structured item list — we extract text from the
 * PDF and split it into agenda-item-shaped lines. Less precise, still far better
 * than a YouTube description.
 */
const { extractPdfText } = require('./pdf');
const log = require('../log');

const UA = 'TownHallMeetings/1.0 (civic meeting aggregator; +https://townhallmeetings.org)';
const base = (clientCode) => `https://${encodeURIComponent(clientCode)}.primegov.com`;

async function getJson(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: ctrl.signal
    });
    if (!res.ok) {
      const err = new Error(`primegov ${url} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function agendaDocId(meeting) {
  const docs = meeting.documentList || [];
  const agenda =
    docs.find((d) => /agenda/i.test(d.templateName || '')) ||
    docs.find((d) => d.compileOutputType === 1);
  return agenda ? agenda.id : null;
}

function shape(clientCode, m) {
  const docId = agendaDocId(m);
  const iso = m.dateTime || null;
  return {
    externalId: String(m.id),
    bodyName: (m.title || '').replace(/\s*-\s*(Rescheduled|Cancelled|Canceled).*$/i, '').trim() || null,
    title: m.title || null,
    meetingAt: iso ? new Date(iso).toISOString() : null,
    meetingDate: iso ? String(iso).slice(0, 10) : null,
    agendaUrl: docId ? `${base(clientCode)}/Public/CompiledDocument/${docId}` : null,
    hasAgenda: !!docId
  };
}

async function verify(clientCode) {
  const upcoming = await getJson(`${base(clientCode)}/api/v2/PublicPortal/ListUpcomingMeetings`);
  const year = new Date().getFullYear();
  let archived = [];
  try {
    archived = await getJson(`${base(clientCode)}/api/v2/PublicPortal/ListArchivedMeetings?year=${year}`);
  } catch (err) { /* a brand new tenant may have no archive yet */ }
  const all = [].concat(upcoming || [], archived || []);
  if (!all.length) throw new Error('no meetings returned');
  const bodies = [...new Set(all.map((m) => shape(clientCode, m).bodyName).filter(Boolean))];
  return { bodies: bodies.slice(0, 25) };
}

async function listMeetings(clientCode, { limit = 40, from } = {}) {
  // PrimeGov archives by calendar year, so a targeted window means asking for
  // that year rather than a date filter.
  const year = from ? new Date(from).getFullYear() : new Date().getFullYear();
  const [upcoming, archived] = await Promise.all([
    getJson(`${base(clientCode)}/api/v2/PublicPortal/ListUpcomingMeetings`).catch(() => []),
    getJson(`${base(clientCode)}/api/v2/PublicPortal/ListArchivedMeetings?year=${year}`).catch(() => [])
  ]);
  return []
    .concat(upcoming || [], archived || [])
    .map((m) => shape(clientCode, m))
    .filter((m) => m.meetingDate)
    .sort((a, b) => (a.meetingDate < b.meetingDate ? 1 : -1))
    .slice(0, limit);
}

/**
 * Pull the agenda PDF and split it into item-shaped lines.
 * Deliberately conservative: we keep lines that look like agenda entries and
 * drop page furniture, rather than dumping raw PDF text into the classifier.
 */
async function listItems(clientCode, externalId, meeting) {
  if (!meeting || !meeting.agendaUrl) return [];
  let text;
  try {
    text = await extractPdfText(meeting.agendaUrl, { userAgent: UA });
  } catch (err) {
    log.warn('primegov agenda pdf failed', { client: clientCode, id: externalId, err: err.message });
    return [];
  }
  if (!text) return [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const items = [];
  let position = 0;
  for (const line of lines) {
    if (line.length < 14 || line.length > 600) continue;           // furniture / noise
    if (/^page \d+/i.test(line)) continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) continue;
    if (/^[\d\W]+$/.test(line)) continue;                          // numbering only
    items.push({ position: position++, title: line.slice(0, 2000), matterType: null, action: null });
    if (items.length >= 200) break;
  }
  return items;
}

module.exports = { vendor: 'primegov', verify, listMeetings, listItems };
