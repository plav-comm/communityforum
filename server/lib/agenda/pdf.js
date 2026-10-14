/**
 * PDF text extraction for agenda documents.
 * Used by the PrimeGov adapter, which publishes agendas as PDFs rather than JSON.
 */
const UA_DEFAULT = 'TownHallMeetings/1.0 (civic meeting aggregator; +https://townhallmeetings.org)';
const MAX_BYTES = 12 * 1024 * 1024;   // agendas are text; anything huge is a scan

async function extractPdfText(url, { timeout = 30000, userAgent = UA_DEFAULT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let buf;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'application/pdf,*/*' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`pdf fetch ${res.status}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) throw new Error(`pdf too large (${ab.byteLength} bytes)`);
    buf = Buffer.from(ab);
  } finally {
    clearTimeout(timer);
  }

  // Lazy require: nothing else in the app needs this dependency at boot.
  const pdfParse = require('pdf-parse');
  const parsed = await pdfParse(buf, { max: 40 });   // 40 pages is plenty for an agenda
  return (parsed && parsed.text) || '';
}

module.exports = { extractPdfText };
