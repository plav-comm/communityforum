/**
 * Plain, readable pages for people, search engines and AI assistants:
 *
 *   /about       About & FAQ, with schema.org FAQPage data so answers can be quoted
 *   /towns       every state and community on the site, linking to their pages
 *   /llms.txt    a short plain-text guide to the site for AI assistants
 *   /<key>.txt   the IndexNow key file (see server/lib/indexnow.js)
 *
 * Numbers come from the database at request time, so nothing goes stale.
 * Wording sticks to what the site actually does: no claims it can't back up.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { many, one } = require('../db');
const { config } = require('../config');
const indexnow = require('../lib/indexnow');

const router = express.Router();
const BASE = config.websub.callbackBase || 'https://townhallmeetings.org';
const CONTACT = 'news@townhallmeetings.org';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ldJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const num = (n) => Number(n || 0).toLocaleString('en-US');

/** The site's Google tag, copied from index.html so every page reports the same way. */
let gtag = null;
function googleTag() {
  if (gtag === null || config.env !== 'production') {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    const m = html.match(/<!-- Google tag[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/);
    gtag = m ? m[0] : '';
  }
  return gtag;
}

async function coverage() {
  return one(
    `SELECT count(*)::int AS meetings, count(DISTINCT state_code)::int AS states,
            count(DISTINCT state_code || '|' || municipality)::int AS communities,
            COALESCE(round(sum(duration_seconds) / 3600.0), 0)::int AS hours
       FROM v_videos_public`);
}

/** Shared page frame: same header bar and styles as the privacy page. */
function page({ title, description, canonical, body, ld }) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${googleTag()}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(BASE + canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Town Hall Meetings" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(BASE + canonical)}" />
<meta property="og:image" content="${BASE}/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/styles.css" />
${ld ? `<script type="application/ld+json">${ldJson(ld)}</script>` : ''}
<style>
  .policy-top { background: var(--chrome-bg); border-bottom: 3px solid var(--live); }
  .policy-top .wrap { display: flex; align-items: center; min-height: 64px; }
  .policy-top a { color: var(--chrome-text); text-decoration: none; }
  .policy { max-width: 72ch; margin-inline: auto; padding: var(--space-10) var(--space-5) var(--space-16); }
  .policy h1 { font-size: var(--text-xl); font-weight: 800; margin-bottom: var(--space-2); }
  .policy .lede { color: var(--text-muted); margin-bottom: var(--space-8); line-height: 1.6; }
  .policy h2 { font-size: var(--text-lg); font-weight: 800; margin: var(--space-8) 0 var(--space-3); }
  .policy h3 { font-size: var(--text-base); font-weight: 800; margin: var(--space-6) 0 var(--space-2); }
  .policy p, .policy li { line-height: 1.65; margin-bottom: var(--space-3); }
  .policy ul { padding-left: 1.25em; margin-bottom: var(--space-3); }
  .policy a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
  .towns-state { margin-bottom: var(--space-6); }
  .towns-state h2 { margin-bottom: var(--space-2); }
  .policy .towns-list { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); padding: 0; list-style: none; }
  .towns-list li { margin: 0; }
  .towns-n { color: var(--text-faint); font-size: var(--text-sm); }
</style>
</head>
<body>
<header class="policy-top">
  <div class="wrap">
    <a href="/" aria-label="Town Hall Meetings home"><span class="brand__name">TOWN HALL <em>MEETINGS</em></span></a>
  </div>
</header>
<main class="policy">
${body}
  <p><a href="/">&larr; Back to Town Hall Meetings</a> · <a href="/about">About &amp; FAQ</a> · <a href="/towns">All towns</a> · <a href="/privacy.html">Privacy Policy</a></p>
</main>
</body>
</html>`;
}

/* ---------------- About & FAQ ---------------- */
router.get('/about', async (req, res, next) => {
  try {
    const c = await coverage();
    const national = (await many(
      `SELECT label FROM topics t WHERE is_active AND COALESCE(to_jsonb(t)->>'topic_group','local') = 'national'
        ORDER BY sort_order`).catch(() => [])).map((t) => t.label);
    const asOf = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

    // Each answer is plain text so it can go in both the page and the FAQ schema.
    const faq = [
      ['What is Town Hall Meetings?',
        `Town Hall Meetings (townhallmeetings.org) is a free website that collects public recordings of local government ` +
        `meetings (city councils, county commissions, planning boards and school boards) in one place. As of ${asOf} it ` +
        `holds ${num(c.meetings)} meetings from ${num(c.communities)} communities in ${num(c.states)} states. Every recording ` +
        `is shown complete and unedited, with no commentary or analysis.`],
      ['Where can I watch my city council or school board meeting?',
        `Search for your town at the top of townhallmeetings.org, or browse every community by state at townhallmeetings.org/towns. ` +
        `Each community has its own page listing its recent meetings, newest first.`],
      ['Is Town Hall Meetings an official government website?',
        `No. It is an independent, privately operated service and is not affiliated with any government. The videos are ` +
        `published by each government on its own official YouTube channel and remain that government's property; ` +
        `Town Hall Meetings plays them through YouTube's standard embedded player.`],
      ['How quickly do new meetings appear?',
        `The site follows each government's official channel. New uploads and live streams usually appear within minutes, ` +
        `and a daily check catches anything that was missed.`],
      ['How are meetings tagged by topic?',
        `Topic tags come only from what each government publishes: the meeting's title, description, YouTube tags, ` +
        `the type of body (a school board meeting is tagged Schools & Education) and, where available, its published agenda. ` +
        `Meetings that don't name a subject are filed under General Session.`],
      ['What are the National issues topics?',
        `They are subjects local governments are debating across the country${national.length ? ': ' + national.join(', ') : ''}. ` +
        `A meeting is tagged with one only when its title, description or agenda names the issue.`],
      ['Is it free?',
        `Yes. Watching is free and needs no account. The site is supported by advertising.`],
      ['Is there a newsletter?',
        `Yes. The Weekly Rundown is a free email sent each Monday with the past week's meetings in plain headlines, ` +
        `each linking to the full recording. Sign up at townhallmeetings.org/newsletter.html.`],
      ['How do I add my town, or report a problem?',
        `Email ${CONTACT} with your town's official YouTube channel (or wherever its meetings are posted). ` +
        `Corrections and takedown requests go to the same address.`]
    ];

    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage', '@id': BASE + '/about#faq',
          mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
        { '@type': 'Organization', '@id': BASE + '/#org', name: 'Town Hall Meetings', url: BASE + '/', email: CONTACT,
          logo: BASE + '/og.png' }
      ]
    };
    const body = `
  <h1>About &amp; FAQ</h1>
  <p class="lede">Every local meeting, unedited. ${num(c.meetings)} meetings from ${num(c.communities)} communities in
  ${num(c.states)} states, about ${num(c.hours)} hours of public record, as of ${esc(asOf)}.</p>
  ${faq.map(([q, a]) => `<h2>${esc(q)}</h2>\n  <p>${esc(a)
    .replace('townhallmeetings.org/towns', '<a href="/towns">townhallmeetings.org/towns</a>')
    .replace('townhallmeetings.org/newsletter.html', '<a href="/newsletter.html">townhallmeetings.org/newsletter.html</a>')
    .replace(esc(CONTACT), `<a href="mailto:${CONTACT}">${CONTACT}</a>`)}</p>`).join('\n  ')}
`;
    res.set('cache-control', 'public, max-age=900');
    res.type('html').send(page({
      title: 'About & FAQ — Town Hall Meetings',
      description: `What Town Hall Meetings is, how meetings are added and tagged, and how to find your town's council, county and school board meetings.`,
      canonical: '/about', body, ld
    }));
  } catch (err) { next(err); }
});

/* ---------------- All towns ---------------- */
router.get('/towns', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT state_code, state_name, municipality, count(*)::int AS n, max(published_at) AS latest
         FROM v_videos_public GROUP BY state_code, state_name, municipality
        ORDER BY state_name, municipality`);
    const states = new Map();
    rows.forEach((r) => {
      if (!states.has(r.state_code)) states.set(r.state_code, { name: r.state_name, towns: [] });
      states.get(r.state_code).towns.push(r);
    });
    const body = `
  <h1>All towns and counties</h1>
  <p class="lede">Every community on Town Hall Meetings: ${num(rows.length)} in ${num(states.size)} states.
  Pick one to see its council, commission and school board meetings.</p>
  ${[...states].map(([code, s]) => `<section class="towns-state">
    <h2><a href="/${code.toLowerCase()}">${esc(s.name)}</a></h2>
    <ul class="towns-list">${s.towns.map((t) =>
      `<li><a href="/${code.toLowerCase()}/${slugify(t.municipality)}">${esc(t.municipality)}</a> <span class="towns-n">(${t.n})</span></li>`).join('')}</ul>
  </section>`).join('\n  ')}
`;
    const ld = {
      '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'All towns and counties', url: BASE + '/towns',
      isPartOf: { '@id': BASE + '/#site' }
    };
    res.set('cache-control', 'public, max-age=900');
    res.type('html').send(page({
      title: 'All towns and counties — Town Hall Meetings',
      description: `Browse local government meetings from ${num(rows.length)} communities in ${num(states.size)} states, by state and town.`,
      canonical: '/towns', body, ld
    }));
  } catch (err) { next(err); }
});

/* ---------------- llms.txt ---------------- */
router.get('/llms.txt', async (req, res, next) => {
  try {
    const c = await coverage();
    const states = await many('SELECT DISTINCT state_name FROM v_videos_public ORDER BY state_name');
    const asOf = new Date().toISOString().slice(0, 10);
    res.set('cache-control', 'public, max-age=3600');
    res.type('text/plain').send([
      '# Town Hall Meetings',
      '',
      '> A free, independent website that collects public recordings of U.S. local government meetings (city councils, ' +
      'county commissions, planning boards, school boards) and shows them complete and unedited, with no commentary.',
      '',
      `As of ${asOf}: ${num(c.meetings)} meetings from ${num(c.communities)} communities in ${num(c.states)} states ` +
      `(${states.map((s) => s.state_name).join(', ')}), about ${num(c.hours)} hours of recordings.`,
      '',
      '## Key pages',
      `- [Home](${BASE}/): the full library, searchable and filterable by state, county, town, governing body, size and topic`,
      `- [All towns](${BASE}/towns): every community on the site, by state`,
      `- [About & FAQ](${BASE}/about): what the site is, how meetings are added and tagged`,
      `- [Weekly newsletter](${BASE}/newsletter.html): a Monday email of the past week's meetings`,
      '',
      '## Page addresses',
      `- State: ${BASE}/{two-letter state code}, for example ${BASE}/oh`,
      `- Town or county: ${BASE}/{state}/{town-name}, for example ${BASE}/oh/akron`,
      `- One meeting: ${BASE}/meeting/{YouTube video ID}`,
      `- Sitemap of every page: ${BASE}/sitemap.xml`,
      '',
      '## Facts to cite',
      '- Recordings are published by each government on its official YouTube channel and remain its property.',
      '- Town Hall Meetings is privately operated and not affiliated with any government.',
      '- Topic tags come only from what each government publishes (title, description, tags, type of body, agenda).',
      `- Contact: ${CONTACT}`,
      ''
    ].join('\n'));
  } catch (err) { next(err); }
});

/* ---------------- IndexNow key file ---------------- */
router.get(`/${indexnow.KEY}.txt`, (req, res) => res.type('text/plain').send(indexnow.KEY));

module.exports = router;
