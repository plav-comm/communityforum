/**
 * Agenda adapter registry.
 *
 * Every adapter implements the same three functions, so the pipeline never
 * needs to know which vendor a town uses:
 *
 *   verify(clientCode)                     -> { bodies: [...] }
 *   listMeetings(clientCode, opts)         -> [ meeting ]
 *   listItems(clientCode, id, meeting)     -> [ { position, title, matterType, action } ]
 *
 * Adding CivicClerk, NovusAGENDA or eScribe later means adding one file here
 * and one row to the vendor CHECK constraint — nothing else changes.
 */
const legistar = require('./legistar');
const primegov = require('./primegov');

const ADAPTERS = { legistar, primegov };

const getAdapter = (vendor) => {
  const a = ADAPTERS[String(vendor || '').toLowerCase()];
  if (!a) throw new Error(`no agenda adapter for vendor "${vendor}"`);
  return a;
};

const vendors = () => Object.keys(ADAPTERS);

module.exports = { getAdapter, vendors, ADAPTERS };
