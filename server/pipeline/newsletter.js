/**
 * The weekly newsletter: built entirely from the database, no writing needed.
 *
 * A deliberately plain, ticker-style email (think Drudge, not a magazine):
 * capitalised headlines, each one a link to the meeting on the site.
 *
 *   NATIONAL ISSUES     meetings tagged data centers, housing reform ...
 *   FEATURED            hand-picked towns (admin page), when they met
 *   BY TOPIC            the week's busiest topics and the towns behind them
 *   MARATHON            the longest meeting of the week
 *   COMING UP / LIVE    scheduled streams in the next seven days
 *   NEW ON THE SITE     towns added this week
 *
 * Headlines are built from facts only (town, body, topic tags, length) — the
 * same no-commentary promise as the site.
 *
 * The daily job calls maybeDraftWeekly(); on Mondays (New York time) it saves
 * the issue to Buttondown as a DRAFT. A person reviews it and presses send.
 */
const { many, one, query } = require('../db');
const { config } = require('../config');
const buttondown = require('../lib/buttondown');
const log = require('../lib/log');

const BASE = config.websub.callbackBase || 'https://townhallmeetings.org';
const TZ = 'America/New_York';
const DAY = 864e5;

/* ---------------- small helpers ---------------- */
const nyDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const nyWeekday = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
const fmtDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric' }).format(new Date(d));
const fmtMonthDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(d));
const fmtWhen = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(d)) + ' ET';
const dur = (s) => {
  s = Number(s) || 0;
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};
/** Markdown-safe text: no stray brackets or emphasis characters from titles. */
const md = (s) => String(s == null ? '' : s).replace(/[\[\]*_`<>#|\\]/g, ' ').replace(/\s+/g, ' ').trim();
const upper = (s) => md(s).toUpperCase();
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : (many || one + 's')}`;

function link(id, campaign) {
  return `${BASE}/meeting/${id}?utm_source=newsletter&utm_medium=email&utm_campaign=${campaign}`;
}

/**
 * "AKRON, OH CITY COUNCIL: BUDGET & TAXES, PUBLIC SAFETY" — plus day and length.
 * Facts only: where, which body, what it was tagged with, how long.
 */
// Procedural tags describe how a meeting ran, not what it was about.
const NOT_HEADLINE = new Set(['public-comment']);

function headline(v, campaign, { lead } = {}) {
  // `lead` puts one topic first (the national issue a section is about).
  const tags = (v.topics || []).filter((t) => !t.fallback && !NOT_HEADLINE.has(t.slug));
  tags.sort((a, b) => (b.slug === lead) - (a.slug === lead));
  const topics = tags.map((t) => t.label);
  const what = topics.length ? ': ' + topics.slice(0, 3).join(', ') : ' MEETS';
  const text = upper(`${v.municipality}, ${v.state_code} ${v.gov_body}${what}`);
  const meta = [fmtDay(v.published_at), dur(v.duration_seconds)].filter(Boolean).join(' · ');
  return `[${text}](${link(v.yt_video_id, campaign)}) — ${meta}`;
}

/* ---------------- data ---------------- */
async function loadWeek(now) {
  const since = new Date(now.getTime() - 7 * DAY);
  const topicMeta = await many(
    `SELECT slug, label, COALESCE(to_jsonb(t)->>'topic_group', 'local') AS grp,
            COALESCE((to_jsonb(t)->>'is_fallback')::boolean, false) AS fallback, sort_order
       FROM topics t WHERE is_active`);
  const meta = new Map(topicMeta.map((t) => [t.slug, t]));

  const rows = await many(
    `SELECT yt_video_id, title, published_at, duration_seconds, status, scheduled_start_at,
            municipality, county, state_code, state_name, gov_body, topics
       FROM v_videos_public
      WHERE published_at >= $1 AND published_at <= $2 AND status = 'recorded'
      ORDER BY published_at DESC`, [since, now]);
  const decorate = (v) => ({
    ...v,
    topics: (v.topics || []).map((t) => {
      const m = meta.get(t.slug) || {};
      return { slug: t.slug, label: t.label || m.label || t.slug, national: m.grp === 'national', fallback: !!m.fallback };
    })
  });
  const week = rows.map(decorate);

  const upcoming = (await many(
    `SELECT yt_video_id, title, published_at, duration_seconds, status, scheduled_start_at,
            municipality, state_code, gov_body, topics
       FROM v_videos_public
      WHERE (status = 'upcoming' AND scheduled_start_at BETWEEN $1 AND $2) OR status = 'live'
      ORDER BY (status = 'live') DESC, scheduled_start_at ASC NULLS LAST
      LIMIT 12`, [now, new Date(now.getTime() + 7 * DAY)])).map(decorate);

  const newTowns = await many(
    `SELECT DISTINCT ON (c.state_code, c.municipality) c.municipality, c.state_code, c.gov_body,
            (SELECT v.yt_video_id FROM videos v WHERE v.channel_id = c.id AND NOT v.is_hidden
              ORDER BY v.published_at DESC NULLS LAST LIMIT 1) AS latest
       FROM channels c
      WHERE c.is_active AND c.created_at >= $1
      ORDER BY c.state_code, c.municipality`, [since]);

  const settings = await one('SELECT featured_towns FROM newsletter_settings WHERE id = 1').catch(() => null);
  const featured = ((settings && settings.featured_towns) || []).map(parseTown).filter(Boolean);

  return { since, week, upcoming, newTowns: newTowns.filter((t) => t.latest), featured, meta: topicMeta };
}

/** "Akron, OH" -> { town: 'akron', state: 'OH' } */
function parseTown(s) {
  const m = String(s || '').trim().match(/^(.+?)[,\s]+([A-Za-z]{2})$/);
  return m ? { label: `${m[1].trim()}, ${m[2].toUpperCase()}`, town: m[1].trim().toLowerCase(), state: m[2].toUpperCase() } : null;
}

/* ---------------- the issue ---------------- */
async function buildIssue({ now = new Date() } = {}) {
  const { since, week, upcoming, newTowns, featured, meta } = await loadWeek(now);
  const campaign = 'weekly-' + nyDate(now);
  const towns = new Set(week.map((v) => v.state_code + '|' + v.municipality));
  const out = [];
  const shown = new Set();   // headline sections never repeat a meeting

  out.push(`**Every local meeting, unedited.** Week of ${fmtMonthDay(since)} – ${fmtMonthDay(now)}: ` +
    `**${plural(week.length, 'meeting')}** from ${plural(towns.size, 'community', 'communities')}.`);
  out.push('');

  // ---- national issues
  const national = meta.filter((t) => t.grp === 'national').sort((a, b) => a.sort_order - b.sort_order);
  const natBlocks = [];
  for (const t of national) {
    const hits = week.filter((v) => v.topics.some((x) => x.slug === t.slug));
    if (!hits.length) continue;
    const fresh = hits.filter((v) => !shown.has(v.yt_video_id));
    if (!fresh.length) continue;
    const lines = fresh.slice(0, 6).map((v) => { shown.add(v.yt_video_id); return '- ' + headline(v, campaign, { lead: t.slug }); });
    if (fresh.length > 6) lines.push(`- …and ${fresh.length - 6} more`);
    natBlocks.push({ label: t.label, n: hits.length, towns: [...new Set(hits.map((v) => v.municipality))], text: `**${upper(t.label)}**\n\n${lines.join('\n')}` });
  }
  if (natBlocks.length) {
    out.push('---', '### ▶ NATIONAL ISSUES, LOCAL VOTES', '');
    natBlocks.forEach((b) => out.push(b.text, ''));
  }

  // ---- featured towns
  const featLines = [];
  for (const f of featured) {
    const hits = week.filter((v) => v.state_code === f.state && v.municipality.toLowerCase() === f.town);
    hits.filter((v) => !shown.has(v.yt_video_id)).slice(0, 2)
      .forEach((v) => { shown.add(v.yt_video_id); featLines.push('- ' + headline(v, campaign)); });
  }
  if (featLines.length) out.push('---', '### ▶ ON THE AGENDA', '', featLines.join('\n'), '');

  // ---- by topic: towns behind the week's busiest subjects
  const local = meta.filter((t) => t.grp !== 'national' && !t.fallback && t.slug !== 'public-comment');
  const byTopic = local.map((t) => {
    const hits = week.filter((v) => v.topics.some((x) => x.slug === t.slug));
    const perTown = new Map();
    hits.forEach((v) => { const k = v.municipality + ', ' + v.state_code; if (!perTown.has(k)) perTown.set(k, v); });
    return { t, hits, perTown };
  }).filter((x) => x.hits.length).sort((a, b) => b.hits.length - a.hits.length).slice(0, 6);
  if (byTopic.length) {
    out.push('---', '### ▶ BY TOPIC', '');
    for (const { t, hits, perTown } of byTopic) {
      const shown = [...perTown.entries()].slice(0, 8)
        .map(([name, v]) => `[${md(name)}](${link(v.yt_video_id, campaign)})`);
      const extra = perTown.size > 8 ? ` +${perTown.size - 8} more` : '';
      out.push(`**${upper(t.label)}** (${hits.length}) — ${shown.join(' · ')}${extra}`, '');
    }
  }

  // ---- marathon
  const longest = week.filter((v) => v.duration_seconds).sort((a, b) => b.duration_seconds - a.duration_seconds)[0];
  if (longest && longest.duration_seconds >= 2 * 3600) {
    out.push('---', '### ▶ MARATHON OF THE WEEK', '',
      `[${upper(`${longest.municipality}, ${longest.state_code} ${longest.gov_body}`)}](${link(longest.yt_video_id, campaign)}) — ${dur(longest.duration_seconds)}, ${fmtDay(longest.published_at)}`, '');
  }

  // ---- live / coming up
  if (upcoming.length) {
    out.push('---', '### ▶ LIVE & COMING UP', '');
    upcoming.forEach((v) => out.push(
      `- ${v.status === 'live' ? '**LIVE NOW:** ' : fmtWhen(v.scheduled_start_at) + ': '}` +
      `[${upper(`${v.municipality}, ${v.state_code} ${v.gov_body}`)}](${link(v.yt_video_id, campaign)})`));
    out.push('');
  }

  // ---- new towns
  if (newTowns.length) {
    out.push('---', '### ▶ NEW ON THE SITE', '',
      newTowns.slice(0, 20).map((t) => `[${md(t.municipality)}, ${t.state_code}](${link(t.latest, campaign)})`).join(' · ') +
      (newTowns.length > 20 ? ` +${newTowns.length - 20} more` : ''), '');
  }

  out.push('---', '',
    `**[Watch every meeting at townhallmeetings.org →](${BASE}/?utm_source=newsletter&utm_medium=email&utm_campaign=${campaign})**`, '',
    '*Headlines are built from each meeting\'s town, governing body, length and topic tags. Tags come only from what ' +
    'each government publishes. No editing, commentary or analysis.*');

  // ---- subject line: lead with the busiest national issue if there is one
  const top = natBlocks.sort((a, b) => b.n - a.n)[0];
  let subject = `This week in local government: ${plural(week.length, 'meeting')}`;
  if (top) {
    const where = top.towns.slice(0, 2).join(' & ');
    subject = `${top.label} in ${where}${top.towns.length > 2 ? ' + more' : ''} · ${plural(week.length, 'local meeting')} this week`;
  }

  return { subject: subject.slice(0, 140), body: out.join('\n'), meetings: week.length, issueKey: nyDate(now) };
}

/* ---------------- email HTML: the markdown above, with a light touch of the site ----------------
   Same plain ticker, plus three things borrowed from townhallmeetings.org: the navy
   masthead with its thin red rule, the red-dash section labels ("— BY TOPIC"), and the
   site's blue for headline links. Inline styles only, because email clients drop <style>.
   No blank lines anywhere, so Buttondown passes it through as one HTML block. */
const C = {
  navy: '#071a33', red: '#c8102e', redOnNavy: '#ff5d72', blue: '#14498f',
  text: '#101c2e', muted: '#5b6779', faint: '#8b95a5', rule: '#d6dae2', tagline: '#9fb0c8'
};
const FONT = "Arial,'Helvetica Neue',Helvetica,sans-serif";

function renderEmailHtml(markdown) {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (x) => esc(x)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      `<a href="$2" style="color:${C.blue};font-weight:700;text-decoration:none;">$1</a>`)
    .replace(/\*\*([^*]+)\*\*/g, `<strong style="color:${C.text};">$1</strong>`)
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/→/g, `<span style="color:${C.red};">&rarr;</span>`)
    .replace(/ — ([^<]*)$/, ` <span style="color:${C.muted};">— $1</span>`);   // the "— Tue 11/10 · 3h 12m" tail
  const P = `margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:1.5;color:${C.text};`;
  const html = [];
  html.push(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;">` +
    `<tr><td style="background:${C.navy};border-bottom:3px solid ${C.red};padding:14px 18px;">` +
    `<div style="font-family:${FONT};font-size:18px;font-weight:800;letter-spacing:0.04em;color:#ffffff;">` +
    `TOWN HALL <span style="color:${C.redOnNavy};">MEETINGS</span></div>` +
    `<div style="font-family:${FONT};font-size:11px;letter-spacing:0.14em;color:${C.tagline};margin-top:3px;">` +
    `THE WEEKLY RUNDOWN</div></td></tr></table>`);
  let inList = false;
  for (const line of markdown.split('\n')) {
    if (/^- /.test(line)) {
      if (!inList) { html.push(`<ul style="margin:0 0 14px;padding-left:18px;">`); inList = true; }
      html.push(`<li style="margin:0 0 8px;font-family:${FONT};font-size:14px;line-height:1.45;color:${C.text};">${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) { html.push('</ul>'); inList = false; }
    if (/^### /.test(line)) {
      const label = line.slice(4).replace(/^▶\s*/, '');
      html.push(`<p style="margin:22px 0 10px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;color:${C.blue};">` +
        `<span style="color:${C.red};">&mdash;</span>&nbsp; ${esc(label)}</p>`);
    } else if (/^---$/.test(line)) {
      html.push(`<hr style="border:0;border-top:1px solid ${C.rule};margin:18px 0 0;">`);
    } else if (/^\*\*[^*\[]+\*\*$/.test(line.trim())) {
      // a sub-head on its own line, e.g. **DATA CENTERS**
      html.push(`<p style="margin:12px 0 6px;font-family:${FONT};font-size:13px;font-weight:800;letter-spacing:0.04em;color:${C.text};">${esc(line.trim().slice(2, -2))}</p>`);
    } else if (/^\*[^*].*\*$/.test(line.trim())) {
      html.push(`<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.faint};">${esc(line.trim().slice(1, -1))}</p>`);
    } else if (line.trim()) {
      html.push(`<p style="${P}">${inline(line)}</p>`);
    }
  }
  if (inList) html.push('</ul>');
  return `<div style="max-width:640px;">${html.join('')}</div>`;
}

/** A browser page around the email, for the admin preview button. */
function toHtml(markdown) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Newsletter preview</title></head><body style="margin:24px auto;max-width:680px;padding:0 16px;background:#ffffff;">' +
    renderEmailHtml(markdown) + '</body></html>';
}

/* ---------------- drafting ---------------- */
async function createDraft({ now = new Date(), force = false } = {}) {
  const issue = await buildIssue({ now });
  if (!issue.meetings) return { skipped: true, why: 'no meetings in the past 7 days' };
  if (!force) {
    const exists = await one('SELECT id FROM newsletter_issues WHERE issue_key = $1', [issue.issueKey]);
    if (exists) return { skipped: true, why: 'already drafted ' + issue.issueKey };
  }
  try {
    const email = await buttondown.createDraft({ subject: issue.subject, body: renderEmailHtml(issue.body) });
    await query(
      `INSERT INTO newsletter_issues (issue_key, subject, meetings, buttondown_id, status)
       VALUES ($1,$2,$3,$4,'draft')
       ON CONFLICT (issue_key) DO UPDATE SET subject = EXCLUDED.subject, meetings = EXCLUDED.meetings,
         buttondown_id = EXCLUDED.buttondown_id, status = 'draft', error = NULL, created_at = now()`,
      [issue.issueKey, issue.subject, issue.meetings, email && email.id ? String(email.id) : null]);
    log.info('newsletter draft created', { key: issue.issueKey, meetings: issue.meetings });
    return { drafted: true, subject: issue.subject, meetings: issue.meetings };
  } catch (err) {
    await query(
      `INSERT INTO newsletter_issues (issue_key, subject, meetings, status, error)
       VALUES ($1,$2,$3,'failed',$4)
       ON CONFLICT (issue_key) DO UPDATE SET status = 'failed', error = EXCLUDED.error`,
      [issue.issueKey, issue.subject, issue.meetings, err.message.slice(0, 500)]).catch(() => {});
    throw err;
  }
}

/** Called by the daily job. Drafts once, on Monday (New York time). */
async function maybeDraftWeekly({ now = new Date() } = {}) {
  if (!buttondown.isConfigured()) return { skipped: true, why: 'BUTTONDOWN_API_KEY not set' };
  if (nyWeekday(now) !== 'Mon') return { skipped: true, why: 'not Monday' };
  return createDraft({ now });
}

module.exports = { buildIssue, toHtml, renderEmailHtml, createDraft, maybeDraftWeekly, parseTown, headline };
