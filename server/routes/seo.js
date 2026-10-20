/**
 * Search-engine and AI-crawler support. None of this changes the home page.
 *
 *   /robots.txt              who may crawl, and where the sitemap is
 *   /sitemap.xml             every state, town and meeting page
 *   /oh                      a state's meetings          (library pre-filtered)
 *   /oh/akron                one town's meetings         (library pre-filtered)
 *   /meeting/<youtubeId>     one meeting                 (opens in the player)
 *
 * Each page is the normal site (index.html) with its own title, description,
 * share-preview tags and schema.org data in the <head>, plus a plain-text list
 * of the same meetings inside the library grid. That list is what crawlers that
 * don't run JavaScript read; for people, the site's script replaces it with the
 * usual video cards a moment later, showing the same meetings.
 *
 * Nothing on the home page links here: visitors only arrive from search, AI
 * answers or a shared link.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { many, one } = require('../db');
const { config } = require('../config');

const router = express.Router();
const BASE = config.websub.callbackBase || 'https://townhallmeetings.org';
const SITE = 'Town Hall Meetings';
const INDEX = path.join(__dirname, '..', '..', 'public', 'index.html');

let template = null;
const getTemplate = () => {
  if (!template || config.env !== 'production') template = fs.readFileSync(INDEX, 'utf8');
  return template;
};

/* ---------------- helpers ---------------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const townPath = (code, municipality) => `/${String(code).toLowerCase()}/${slugify(municipality)}`;
const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-US',
  { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const isoDuration = (sec) => {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s || (!h && !m) ? s + 'S' : '');
};
/** JSON for a <script> tag: escape "<" so a title can never close the tag. */
const ldJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

const VIDEO_COLS = `yt_video_id, title, description, published_at, duration_seconds, thumbnail_url,
  status, scheduled_start_at, channel_name, municipality, county, state_code, state_name, gov_body, topics`;

function videoLd(v) {
  const o = {
    '@type': 'VideoObject',
    '@id': `${BASE}/meeting/${v.yt_video_id}#video`,
    name: v.title,
    description: clip(v.description, 4000) ||
      `${v.gov_body} meeting, ${v.municipality}, ${v.state_name}. Unedited recording.`,
    thumbnailUrl: v.thumbnail_url || `https://i.ytimg.com/vi/${v.yt_video_id}/hqdefault.jpg`,
    uploadDate: v.published_at ? new Date(v.published_at).toISOString() : undefined,
    embedUrl: `https://www.youtube.com/embed/${v.yt_video_id}`,
    url: `${BASE}/meeting/${v.yt_video_id}`,
    inLanguage: 'en',
    isFamilyFriendly: true,
    contentLocation: {
      '@type': 'Place',
      name: `${v.municipality}, ${v.state_name}`,
      address: { '@type': 'PostalAddress', addressLocality: v.municipality, addressRegion: v.state_code, addressCountry: 'US' }
    },
    author: { '@type': 'GovernmentOrganization', name: v.channel_name || `${v.municipality} ${v.gov_body}` },
    keywords: [v.gov_body, v.municipality, v.county, v.state_name]
      .concat((v.topics || []).map((t) => t.label)).filter(Boolean).join(', ')
  };
  if (v.duration_seconds) o.duration = isoDuration(v.duration_seconds);
  if (v.status === 'live') {
    o.publication = { '@type': 'BroadcastEvent', isLiveBroadcast: true,
      startDate: new Date(v.scheduled_start_at || v.published_at).toISOString() };
  }
  return o;
}

/** The plain list crawlers read inside the library grid. */
function listHtml(heading, intro, rows) {
  const items = rows.map((v) =>
    `<li><a href="/meeting/${esc(v.yt_video_id)}">${esc(v.title)}</a> — ` +
    `${esc(v.gov_body)}, ${esc(v.municipality)}, ${esc(v.state_code)} · ${esc(fmtDate(v.published_at))}</li>`).join('');
  return `<div class="seolist"><h2>${esc(heading)}</h2><p>${esc(intro)}</p>` +
    (items ? `<ul>${items}</ul>` : '') + '</div>';
}

function breadcrumbs(list) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: list.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: BASE + url }))
  };
}

/** Fill index.html's markers and send it. `boot` tells app.js what to open. */
function render(res, { title, description, url, image, graph, body, boot }) {
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(BASE + url)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${SITE}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(BASE + url)}" />`,
    `<meta property="og:image" content="${esc(image || BASE + '/og.png')}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<script type="application/ld+json">${ldJson({ '@context': 'https://schema.org', '@graph': graph })}</script>`,
    `<script>window.__THM_BOOT__=${ldJson(boot)};</script>`
  ].join('\n');
  const html = getTemplate()
    .replace(/<!--SEO-HEAD-->[\s\S]*?<!--\/SEO-HEAD-->/, head)
    .replace('<!--SEO-BODY-->', body);
  res.set('cache-control', 'public, max-age=300');
  res.type('html').send(html);
}

/* ---------------- robots + sitemap ---------------- */
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    '# Search engines and AI assistants are welcome to read and cite this site.',
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /admin.html',
    'Disallow: /api/',
    'Disallow: /websub/',
    '',
    `Sitemap: ${BASE}/sitemap.xml`,
    ''
  ].join('\n'));
});

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const towns = await many(
      `SELECT state_code, municipality, max(published_at) AS last
         FROM v_videos_public GROUP BY state_code, municipality`);
    const vids = await many(
      `SELECT yt_video_id, published_at FROM v_videos_public ORDER BY published_at DESC NULLS LAST LIMIT 45000`);
    const states = new Map();
    towns.forEach((t) => {
      const prev = states.get(t.state_code);
      if (!prev || (t.last && t.last > prev)) states.set(t.state_code, t.last);
    });
    const latest = vids[0] && vids[0].published_at;
    const u = (loc, last) => `<url><loc>${esc(BASE + loc)}</loc>` +
      (last ? `<lastmod>${new Date(last).toISOString().slice(0, 10)}</lastmod>` : '') + '</url>';
    const xml = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      u('/', latest), u('/privacy.html')]
      .concat([...states].map(([code, last]) => u('/' + code.toLowerCase(), last)))
      .concat(towns.map((t) => u(townPath(t.state_code, t.municipality), t.last)))
      .concat(vids.map((v) => u('/meeting/' + v.yt_video_id, v.published_at)))
      .concat('</urlset>').join('\n');
    res.set('cache-control', 'public, max-age=900');
    res.type('application/xml').send(xml);
  } catch (err) { next(err); }
});

/* ---------------- one meeting ---------------- */
router.get('/meeting/:id', async (req, res, next) => {
  try {
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(req.params.id)) return next();
    const v = await one(`SELECT ${VIDEO_COLS} FROM v_videos_public WHERE yt_video_id = $1`, [req.params.id]);
    if (!v) return next();
    const more = await many(
      `SELECT ${VIDEO_COLS} FROM v_videos_public
        WHERE state_code = $1 AND municipality = $2 AND yt_video_id <> $3
        ORDER BY published_at DESC NULLS LAST LIMIT 12`, [v.state_code, v.municipality, v.yt_video_id]);
    const where = `${v.municipality}, ${v.state_code}`;
    const date = fmtDate(v.published_at);
    const town = townPath(v.state_code, v.municipality);
    render(res, {
      title: `${clip(v.title, 70)} — ${where} | ${SITE}`,
      description: clip(`${v.gov_body} meeting in ${v.municipality}, ${v.state_name}` +
        (date ? `, ${date}` : '') + '. Full, unedited recording. ' + (v.description || ''), 158),
      url: `/meeting/${v.yt_video_id}`,
      image: v.thumbnail_url || `https://i.ytimg.com/vi/${v.yt_video_id}/hqdefault.jpg`,
      graph: [videoLd(v), breadcrumbs([[SITE, '/'], [v.state_name, '/' + v.state_code.toLowerCase()],
        [v.municipality, town], [clip(v.title, 80), `/meeting/${v.yt_video_id}`]])],
      body: `<div class="seolist"><h1>${esc(v.title)}</h1><p>${esc(v.gov_body)}, ` +
        `<a href="${esc(town)}">${esc(v.municipality)}</a>, ${esc(v.state_name)}` +
        (date ? ` · ${esc(date)}` : '') + '. Full, unedited recording published by the local government.</p>' +
        (v.description ? `<p>${esc(clip(v.description, 600))}</p>` : '') + '</div>' +
        (more.length ? listHtml(`More meetings from ${where}`, '', more) : ''),
      boot: { state: v.state_code, city: v.municipality, video: v.yt_video_id }
    });
  } catch (err) { next(err); }
});

/* ---------------- one state ---------------- */
router.get('/:state', async (req, res, next) => {
  try {
    if (!/^[a-z]{2}$/i.test(req.params.state)) return next();
    const code = req.params.state.toUpperCase();
    if (req.params.state !== code.toLowerCase()) return res.redirect(301, '/' + code.toLowerCase());
    const towns = await many(
      `SELECT municipality, state_name, array_agg(DISTINCT gov_body) AS bodies, count(*)::int AS n
         FROM v_videos_public WHERE state_code = $1 GROUP BY municipality, state_name ORDER BY municipality`, [code]);
    if (!towns.length) return next();
    const name = towns[0].state_name;
    const rows = await many(`SELECT ${VIDEO_COLS} FROM v_videos_public WHERE state_code = $1
       ORDER BY published_at DESC NULLS LAST LIMIT 30`, [code]);
    const townList = '<div class="seolist"><h2>Communities in ' + esc(name) + '</h2><ul>' +
      towns.map((t) => `<li><a href="${esc(townPath(code, t.municipality))}">${esc(t.municipality)}</a> — ` +
        `${esc(t.bodies.join(', '))} (${t.n} meeting${t.n === 1 ? '' : 's'})</li>`).join('') + '</ul></div>';
    const total = towns.reduce((a, t) => a + t.n, 0);
    render(res, {
      title: `${name} local government meetings — city council, county & school board | ${SITE}`,
      description: clip(`Watch ${total} unedited local government meetings from ${towns.length} ` +
        `${name} communities, including ${towns.slice(0, 5).map((t) => t.municipality).join(', ')}.`, 158),
      url: '/' + code.toLowerCase(),
      graph: [
        { '@type': 'CollectionPage', name: `${name} local government meetings`, url: BASE + '/' + code.toLowerCase(),
          isPartOf: { '@id': BASE + '/#site' } },
        breadcrumbs([[SITE, '/'], [name, '/' + code.toLowerCase()]])
      ],
      body: listHtml(`${name} local government meetings`,
        `Full, unedited recordings of public meetings from ${towns.length} communities in ${name}.`, rows) + townList,
      boot: { state: code }
    });
  } catch (err) { next(err); }
});

/* ---------------- one town ---------------- */
router.get('/:state/:town', async (req, res, next) => {
  try {
    if (!/^[a-z]{2}$/i.test(req.params.state)) return next();
    const code = req.params.state.toUpperCase();
    const places = await many(
      'SELECT DISTINCT municipality, county, state_name FROM v_videos_public WHERE state_code = $1', [code]);
    const place = places.find((p) => slugify(p.municipality) === req.params.town.toLowerCase());
    if (!place) return next();
    const canonical = townPath(code, place.municipality);
    if (req.path !== canonical) return res.redirect(301, canonical);
    const rows = await many(`SELECT ${VIDEO_COLS} FROM v_videos_public WHERE state_code = $1 AND municipality = $2
       ORDER BY published_at DESC NULLS LAST LIMIT 50`, [code, place.municipality]);
    const bodies = [...new Set(rows.map((r) => r.gov_body))];
    const where = `${place.municipality}, ${code}`;
    render(res, {
      title: `${where} ${bodies.slice(0, 2).join(' & ')} meetings — watch unedited | ${SITE}`,
      description: clip(`Watch full, unedited ${bodies.join(', ')} meetings from ${place.municipality}, ` +
        `${place.state_name}` + (place.county && place.county !== place.municipality ? ` (${place.county})` : '') +
        (rows[0] ? `. Latest: ${fmtDate(rows[0].published_at)}.` : '.'), 158),
      url: canonical,
      image: rows[0] && (rows[0].thumbnail_url || `https://i.ytimg.com/vi/${rows[0].yt_video_id}/hqdefault.jpg`),
      graph: [
        { '@type': 'CollectionPage', name: `${where} government meetings`, url: BASE + canonical,
          isPartOf: { '@id': BASE + '/#site' },
          about: { '@type': 'Place', name: `${place.municipality}, ${place.state_name}` },
          mainEntity: { '@type': 'ItemList', itemListElement: rows.slice(0, 20).map((v, i) =>
            ({ '@type': 'ListItem', position: i + 1, url: `${BASE}/meeting/${v.yt_video_id}` })) } },
        breadcrumbs([[SITE, '/'], [place.state_name, '/' + code.toLowerCase()], [place.municipality, canonical]])
      ],
      body: listHtml(`${place.municipality}, ${place.state_name} government meetings`,
        `Full, unedited recordings of ${bodies.join(', ')} meetings from ${place.municipality}` +
        (place.county && place.county !== place.municipality ? `, ${place.county}` : '') + '.', rows),
      boot: { state: code, city: place.municipality }
    });
  } catch (err) { next(err); }
});

router.slugify = slugify;
module.exports = router;
