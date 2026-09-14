/**
 * Civic topic classifier.
 *
 * How it works: every topic owns a list of weighted keyword terms stored in the
 * `topic_rules` table. We build one regex per term (word-boundary, case
 * insensitive), score the video's text against all of them, and attach the
 * topics that clear a threshold.
 *
 * Why rules and not an AI model, for launch:
 *   - free, instant, and no third-party dependency
 *   - completely explainable: every tag records the exact terms that produced it,
 *     which matters for a platform whose promise is "no editorial slant"
 *   - tunable by editing rows in a table, no redeploy
 *
 * The scoring text is weighted by field: a term in the TITLE counts more than
 * one buried in a long description, because municipal titles are highly
 * descriptive ("Budget Work Session", "Zoning Board Public Hearing").
 */
const { many } = require('../db');
const { config } = require('../config');
const log = require('../lib/log');
const { getTranscript } = require('../lib/transcript');

// Agenda text is the strongest signal we can get short of a transcript: it is
// the official list of what the body actually took up.
const FIELD_WEIGHTS = { title: 3.0, agenda: 2.0, tags: 1.5, transcript: 1.2, description: 1.0 };

let cache = null;
let hintCache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_SLUG = 'general-session';

/** True when this governing body has tagging hints configured. */
function hasBodyHint(govBody) {
  return !!(hintCache && hintCache.get(normBody(govBody)));
}

/** Governing-body names vary in case, spacing and "and" vs "&" between towns. */
function normBody(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Load rules from the DB and compile them once, refreshed every 5 minutes. */
async function loadRules({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
  const rows = await many(
    `SELECT t.id AS topic_id, t.slug, t.label, t.is_fallback, r.term, r.weight
       FROM topic_rules r
       JOIN topics t ON t.id = r.topic_id
      WHERE r.is_active AND t.is_active`
  );
  const byTopic = new Map();
  for (const row of rows) {
    if (!byTopic.has(row.slug)) {
      byTopic.set(row.slug, {
        topicId: row.topic_id, slug: row.slug, label: row.label,
        isFallback: row.is_fallback === true, terms: []
      });
    }
    byTopic.get(row.slug).terms.push({
      term: row.term,
      weight: Number(row.weight),
      // \b does not work before/after non-word chars, so allow either boundary or edge
      re: new RegExp(`(?:^|[^a-z0-9])${escapeRegex(row.term.toLowerCase())}(?:[^a-z0-9]|$)`, 'i')
    });
  }
  cache = [...byTopic.values()];

  // The fallback topic usually has no active rules of its own, so make sure it
  // is still available to attach when nothing else qualifies.
  const fallbackRows = await many(
    `SELECT id AS topic_id, slug, label FROM topics WHERE is_active AND is_fallback`
  ).catch(() => []);
  for (const f of fallbackRows) {
    if (!cache.some((t) => t.slug === f.slug)) {
      cache.push({ topicId: f.topic_id, slug: f.slug, label: f.label, isFallback: true, terms: [] });
    } else {
      cache.find((t) => t.slug === f.slug).isFallback = true;
    }
  }

  // Governing-body hints: what the type of meeting implies on its own.
  const hints = await many(
    `SELECT g.gov_body, t.id AS topic_id, t.slug, t.label, g.weight
       FROM gov_body_topics g JOIN topics t ON t.id = g.topic_id
      WHERE t.is_active`
  ).catch(() => []);
  hintCache = new Map();
  for (const h of hints) {
    const key = normBody(h.gov_body);
    if (!hintCache.has(key)) hintCache.set(key, []);
    hintCache.get(key).push({
      topicId: h.topic_id, slug: h.slug, label: h.label, weight: Number(h.weight)
    });
  }

  cacheLoadedAt = Date.now();
  log.debug('classifier rules loaded', {
    topics: cache.length, terms: rows.length, bodyHints: hints.length
  });
  return cache;
}

const clearCache = () => {
  cache = null;
  hintCache = null;
  cacheLoadedAt = 0;
};

/**
 * Score one video against all topics.
 * @returns {Array<{topicId, slug, label, score, matchedTerms, source}>}
 */
async function classify(video, { rules } = {}) {
  const compiled = rules || (await loadRules());

  const fields = {
    title: video.title || '',
    description: (video.description || '').slice(0, 8000),
    tags: Array.isArray(video.tags) ? video.tags.join(' ') : ''
  };

  // Agenda items, when we have them, come from the town's own agenda system.
  if (video.agendaText) fields.agenda = String(video.agendaText).slice(0, 60000);

  // Optional transcript hook — returns null unless a provider is configured.
  let usedTranscript = false;
  const transcript = await getTranscript(video.ytVideoId).catch(() => null);
  if (transcript) {
    fields.transcript = transcript.slice(0, 40000);
    usedTranscript = true;
  }

  const results = [];
  for (const topic of compiled) {
    // Fallback topics never compete for score — that is the whole point of them.
    if (topic.isFallback) continue;
    let score = 0;
    const matched = new Set();
    const hitFields = new Set();
    for (const [field, text] of Object.entries(fields)) {
      if (!text) continue;
      const fieldWeight = FIELD_WEIGHTS[field] || 1;
      for (const rule of topic.terms) {
        if (rule.re.test(text)) {
          score += rule.weight * fieldWeight;
          matched.add(rule.term);
          hitFields.add(field);
        }
      }
    }
    if (score > 0) {
      // Record the strongest evidence type, so the UI can say "agenda-backed"
      // and an operator can tell where a tag came from.
      const source = hitFields.has('agenda') ? 'agenda'
        : hitFields.has('transcript') ? 'transcript'
        : 'metadata';
      results.push({
        topicId: topic.topicId,
        slug: topic.slug,
        label: topic.label,
        score: Math.round(score * 100) / 100,
        matchedTerms: [...matched],
        source
      });
    }
  }

  // ---- add governing-body hints -------------------------------------------
  // A School Board meeting is about schools even when the title says nothing.
  // Modest weights, so real agenda text always outranks the hint.
  const hints = (video.govBody && hintCache && hintCache.get(normBody(video.govBody))) || [];
  for (const hint of hints) {
    const existing = results.find((r) => r.slug === hint.slug);
    if (existing) {
      existing.score = Math.round((existing.score + hint.weight) * 100) / 100;
      existing.matchedTerms.push(`body:${video.govBody}`);
    } else {
      results.push({
        topicId: hint.topicId,
        slug: hint.slug,
        label: hint.label,
        score: hint.weight,
        matchedTerms: [`body:${video.govBody}`],
        source: 'metadata'
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const kept = results
    .filter((r) => r.score >= config.ingest.topicThreshold)
    .slice(0, config.ingest.maxTopicsPerVideo);

  // Nothing cleared the bar. Keep the strongest real signal if it is at least
  // marginally meaningful — a weak real topic is more useful to a viewer than
  // dumping the meeting into the fallback bucket.
  if (!kept.length && results.length && results[0].score >= 1.0) kept.push(results[0]);

  // Nothing at all matched (a bare title like "8/12/26", or a description that
  // is pure boilerplate): file it under the fallback topic so it stays
  // browsable and honestly labelled rather than untagged and invisible.
  if (!kept.length) {
    const fallback = (cache || []).find((t) => t.isFallback) ||
                     (cache || []).find((t) => t.slug === FALLBACK_SLUG);
    if (fallback) {
      kept.push({
        topicId: fallback.topicId, slug: fallback.slug, label: fallback.label,
        score: 0, matchedTerms: ['fallback'], source: 'metadata'
      });
    }
  }

  return kept;
}

module.exports = { classify, loadRules, clearCache, normBody, hasBodyHint };
