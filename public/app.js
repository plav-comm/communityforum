/* ============================================================
   COMMUNITY-SPAN — home page
   Reads from the live API. Falls back to the bundled sample file
   (data.js) if the API cannot be reached, so the page never breaks.
   ============================================================ */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  /* ------------------------------------------------------------
     Where is the API?
     When this bundle is deployed as a static preview, the token below is
     rewritten to a proxy URL pointing at the backend. When the Express
     server serves this page itself, the token is left alone and we simply
     use the same origin.
     ------------------------------------------------------------ */
  const API_TOKEN = '__PORT_3000__';
  const API_BASE = API_TOKEN.indexOf('__PORT') === 0 ? '' : API_TOKEN.replace(/\/+$/, '');
  const api = (path) => API_BASE + path;

  const TIER_LABELS = {
    xs: 'Under 10,000',
    sm: '10,000 – 50,000',
    md: '50,000 – 150,000',
    lg: '150,000 – 500,000',
    xl: '500,000+'
  };
  const TIER_ORDER = ['xs', 'sm', 'md', 'lg', 'xl'];

  /* ------------------------------------------------------------
     Formatting helpers
     ------------------------------------------------------------ */
  const fmtDur = (s) => {
    if (!s) return 'Live';
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
  };
  const asDate = (iso) => (iso ? new Date(iso) : null);
  const fmtDate = (iso) => {
    const d = asDate(iso);
    return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  };
  const fmtDateShort = (iso) => {
    const d = asDate(iso);
    return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  };
  const fmtTime = (iso) => {
    const d = asDate(iso);
    return d ? d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  };
  const fmtPop = (n) => (n ? '~' + Number(n).toLocaleString('en-US') : '—');
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------
     State
     ------------------------------------------------------------ */
  const state = {
    mode: 'api',                 // 'api' | 'sample'
    filters: { states: [], counties: [], cities: [], bodies: [], sizeTiers: [] },
    topics: [],
    query: {
      state: '', county: '', city: '', tier: '', body: '', topic: '', status: '', q: '', sort: 'newest'
    },
    page: 1,
    perPage: 12,
    total: 0,
    items: [],
    current: null
  };

  /* ------------------------------------------------------------
     Data access — API first, bundled sample as a safety net
     ------------------------------------------------------------ */
  async function getJson(path, { timeout = 8000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(api(path), { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(path + ' -> ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convert a row from the bundled sample file into the API's shape. */
  function sampleToApi(v) {
    const slugMap = {
      budget: ['budget-taxes', 'Budget & Taxes'],
      housing: ['zoning-housing', 'Zoning & Housing'],
      safety: ['public-safety', 'Public Safety'],
      schools: ['schools-education', 'Schools & Education'],
      infra: ['infrastructure', 'Infrastructure'],
      water: ['water-environment', 'Water & Environment'],
      parks: ['parks-recreation', 'Parks & Recreation'],
      gov: ['open-government', 'Open Government']
    };
    return {
      ytVideoId: v.yt,
      title: v.title,
      description: v.blurb,
      publishedAt: v.date + 'T18:00:00Z',
      durationSeconds: v.dur,
      thumbnailUrl: 'https://i.ytimg.com/vi/' + v.yt + '/hqdefault.jpg',
      status: 'recorded',
      channel: { name: v.org },
      place: {
        municipality: v.city, county: v.county, stateCode: v.sc,
        stateName: v.state, population: null, sizeTier: v.tier
      },
      govBody: v.body,
      topics: (v.topics || []).map((t) => ({ slug: (slugMap[t] || [t, t])[0], label: (slugMap[t] || [t, t])[1] }))
    };
  }

  const sampleLibrary = () =>
    (typeof VIDEOS !== 'undefined' ? VIDEOS : []).map(sampleToApi);

  /** Apply the current query to the sample library, client side. */
  function filterSample() {
    const q = state.query;
    let out = sampleLibrary().filter((v) => {
      if (q.state && v.place.stateName !== stateNameFor(q.state)) return false;
      if (q.county && v.place.county !== q.county) return false;
      if (q.city && v.place.municipality !== q.city) return false;
      if (q.tier && v.place.sizeTier !== q.tier) return false;
      if (q.body && v.govBody !== q.body) return false;
      if (q.topic && !v.topics.some((t) => t.slug === q.topic)) return false;
      if (q.status && q.status.split(',').indexOf(v.status) === -1) return false;
      if (q.q) {
        const hay = [v.title, v.description, v.place.municipality, v.place.county, v.place.stateName,
          v.govBody, v.channel.name].concat(v.topics.map((t) => t.label)).join(' ').toLowerCase();
        if (hay.indexOf(q.q.toLowerCase()) === -1) return false;
      }
      return true;
    });

    const byDate = (a, b) => new Date(a.publishedAt) - new Date(b.publishedAt);
    const rank = (v) => TIER_ORDER.indexOf(v.place.sizeTier);
    const sorters = {
      newest: (a, b) => byDate(b, a),
      oldest: byDate,
      longest: (a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0),
      shortest: (a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0),
      'population-desc': (a, b) => rank(b) - rank(a) || byDate(b, a),
      'population-asc': (a, b) => rank(a) - rank(b) || byDate(b, a),
      town: (a, b) => a.place.municipality.localeCompare(b.place.municipality) || byDate(b, a)
    };
    out.sort(sorters[q.sort] || sorters.newest);
    return out;
  }

  const stateNameFor = (code) => {
    const hit = state.filters.states.find((s) => s.code === code);
    return hit ? hit.name : code;
  };

  /** Fetch one page of videos from whichever source is active. */
  async function fetchVideos() {
    const q = state.query;
    if (state.mode === 'sample') {
      const all = filterSample();
      return { total: all.length, items: all.slice(0, state.page * state.perPage) };
    }
    const p = new URLSearchParams();
    ['state', 'county', 'city', 'tier', 'body', 'topic', 'status', 'q', 'sort'].forEach((k) => {
      if (q[k]) p.set(k, q[k]);
    });
    p.set('limit', String(state.page * state.perPage));
    p.set('offset', '0');
    const data = await getJson('/api/videos?' + p.toString());
    return { total: data.total, items: data.items };
  }

  /* ------------------------------------------------------------
     Dropdowns — dependent state -> county -> city
     ------------------------------------------------------------ */
  function fill(sel, allLabel, options, chosen) {
    sel.innerHTML = '';
    sel.appendChild(new Option(allLabel, ''));
    options.forEach((o) => sel.appendChild(new Option(o.label, o.value)));
    sel.value = options.some((o) => o.value === chosen) ? chosen : '';
  }

  function buildDropdowns() {
    const q = state.query;
    const f = state.filters;

    fill($('#fState'), 'All states', f.states.map((s) => ({ value: s.code, label: s.name })), q.state);

    const counties = f.counties.filter((c) => !q.state || c.state === q.state);
    fill(
      $('#fCounty'),
      q.state ? 'All counties in ' + stateNameFor(q.state) : 'All counties',
      counties.map((c) => ({ value: c.name, label: c.name })),
      q.county
    );
    if (!counties.some((c) => c.name === q.county)) q.county = '';

    const cities = f.cities.filter(
      (c) => (!q.state || c.state === q.state) && (!q.county || c.county === q.county)
    );
    fill($('#fCity'), 'All cities & towns', cities.map((c) => ({ value: c.name, label: c.name })), q.city);
    if (!cities.some((c) => c.name === q.city)) q.city = '';

    fill($('#fTier'), 'Any population',
      f.sizeTiers.map((t) => ({ value: t, label: TIER_LABELS[t] || t })), q.tier);
    fill($('#fBody'), 'All governing bodies',
      f.bodies.map((b) => ({ value: b, label: b })), q.body);

    if ($('#fTopic')) {
      fill($('#fTopic'), 'All topics',
        state.topics.filter((t) => t.video_count || t.slug === q.topic)
          .map((t) => ({ value: t.slug, label: t.label })), q.topic);
    }

    $('#fSort').value = q.sort;
    if ($('#fStatus')) $('#fStatus').value = q.status;
    markActiveFields();
  }

  /* ------------------------------------------------------------
     Cards
     ------------------------------------------------------------ */
  function makeCard(v) {
    const card = el('button', 'card');
    card.type = 'button';
    card.setAttribute('aria-label', 'Play: ' + v.title + ' — ' + v.place.municipality + ', ' + v.place.stateCode);

    const flags = [];
    if (v.status === 'live') flags.push('<span class="badge badge--live">● Live</span>');
    else if (v.status === 'upcoming') flags.push('<span class="badge badge--gold">Upcoming</span>');
    else if (isRecent(v)) flags.push('<span class="badge badge--new">New</span>');

    card.innerHTML =
      '<div class="card__thumb">' +
      '<img loading="lazy" src="' + esc(v.thumbnailUrl) + '" alt="" />' +
      '<div class="card__flag">' + flags.join('') + '</div>' +
      '<div class="card__dur">' + fmtDur(v.durationSeconds) + '</div>' +
      '<div class="card__play"><span><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg></span></div>' +
      '</div>' +
      '<div class="card__body">' +
      '<div class="card__where">' + esc(v.place.municipality) + ', ' + esc(v.place.stateCode) +
        (v.place.county ? ' · ' + esc(v.place.county) : '') + '</div>' +
      '<div class="card__title">' + esc(v.title) + '</div>' +
      '<div class="card__tags">' +
        v.topics.slice(0, 2).map((t) => '<span class="tag">' + esc(t.label) + '</span>').join('') +
      '</div>' +
      '<div class="card__meta"><span>' + esc(v.govBody) + '</span><span>' +
        (v.status === 'upcoming' ? fmtTime(v.scheduledStartAt) : fmtDate(v.publishedAt)) +
      '</span></div>' +
      '</div>';

    card.addEventListener('click', () => play(v, true));
    return card;
  }

  /** Published within 8 days of the newest thing we know about. */
  let newestKnown = null;
  function isRecent(v) {
    if (!newestKnown || !v.publishedAt) return false;
    return new Date(v.publishedAt) >= new Date(newestKnown.getTime() - 8 * 864e5);
  }

  /* ------------------------------------------------------------
     Results
     ------------------------------------------------------------ */
  let renderToken = 0;

  async function renderResults() {
    const token = ++renderToken;
    const box = $('#results');

    if (!state.items.length) box.setAttribute('aria-busy', 'true');

    let data;
    try {
      data = await fetchVideos();
    } catch (err) {
      if (state.mode === 'api') {
        // The API went away mid-session — drop to the bundled sample quietly.
        setMode('sample');
        data = await fetchVideos();
      } else {
        data = { total: 0, items: [] };
      }
    }
    if (token !== renderToken) return;   // a newer request already won

    state.total = data.total;
    state.items = data.items;

    // Work out what "this week" means before painting, so New badges are right
    // on the very first render rather than one interaction later.
    if (!newestKnown) {
      const dates = data.items.map((v) => asDate(v.publishedAt)).filter(Boolean);
      if (dates.length) newestKnown = new Date(Math.max.apply(null, dates));
    }
    box.removeAttribute('aria-busy');
    box.innerHTML = '';

    if (!data.items.length) {
      const active = activeFilters();
      const empty = el('div', 'empty',
        '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>' +
        '<h3>No meetings match all of these filters together</h3>' +
        '<p>' + (active.length > 1
          ? 'Filters combine, so a meeting has to match every one. Remove one to widen the results:'
          : 'Community-Span is still onboarding municipal feeds. Remove the filter to see everything:') +
        '</p>');
      if (active.length) {
        const chips = el('div', 'empty__chips');
        active.forEach((pair) => chips.appendChild(filterChip(pair)));
        empty.appendChild(chips);
      }
      const reset = el('button', 'btn', 'Clear all filters');
      reset.type = 'button';
      reset.addEventListener('click', resetAll);
      empty.appendChild(reset);
      box.appendChild(empty);
      $('#moreWrap').hidden = true;
    } else {
      data.items.forEach((v) => box.appendChild(makeCard(v)));
      const remaining = data.total - data.items.length;
      $('#moreWrap').hidden = remaining <= 0;
      $('#moreBtn').textContent = 'Show ' + Math.min(remaining, state.perPage) + ' more meetings';
    }

    renderChips();
  }

  /* ------------------------------------------------------------
     Chips
     ------------------------------------------------------------ */
  const STATUS_LABELS = {
    live: 'Live now',
    'live,upcoming': 'Live & upcoming',
    recorded: 'Archived only'
  };
  const topicLabel = (slug) => {
    const t = state.topics.find((x) => x.slug === slug);
    return t ? t.label : slug;
  };

  /** Every filter currently switched on, as [key, human label] pairs. */
  function activeFilters() {
    const q = state.query;
    return [
      ['state', q.state && stateNameFor(q.state)],
      ['county', q.county],
      ['city', q.city],
      ['tier', q.tier && (TIER_LABELS[q.tier] + ' residents')],
      ['body', q.body],
      ['topic', q.topic && 'Topic: ' + topicLabel(q.topic)],
      ['status', q.status && (STATUS_LABELS[q.status] || q.status)],
      ['q', q.q && 'Search: “' + q.q + '”']
    ].filter((p) => p[1]);
  }

  function removeFilter(key) {
    const q = state.query;
    q[key] = '';
    if (key === 'q') $('#search').value = '';
    if (key === 'state') { q.county = ''; q.city = ''; }
    if (key === 'county') q.city = '';
    state.page = 1;
    buildDropdowns();
    renderResults();
    renderTopics();
  }

  function filterChip(pair) {
    const chip = el('button', 'chip', esc(pair[1]) + ' <span aria-hidden="true">×</span>');
    chip.type = 'button';
    chip.setAttribute('aria-label', 'Remove filter ' + pair[1]);
    chip.addEventListener('click', () => removeFilter(pair[0]));
    return chip;
  }

  /** Highlight each dropdown that is narrowing the results. */
  function markActiveFields() {
    const q = state.query;
    [['#fState', q.state], ['#fCounty', q.county], ['#fCity', q.city], ['#fTier', q.tier],
     ['#fBody', q.body], ['#fTopic', q.topic], ['#fStatus', q.status]].forEach(([sel, val]) => {
      const node = $(sel);
      if (!node) return;
      node.parentElement.classList.toggle('is-active', !!val);
      const label = document.querySelector('label[for="' + node.id + '"]');
      if (label) label.classList.toggle('is-active', !!val);
    });
  }

  function renderChips() {
    const box = $('#chips');
    box.innerHTML = '';
    box.appendChild(el('span', 'chips__count',
      '<b>' + state.total + '</b> ' + (state.total === 1 ? 'proceeding' : 'proceedings') + ' in view'));
    activeFilters().forEach((pair) => box.appendChild(filterChip(pair)));
    markActiveFields();
  }

  /* ------------------------------------------------------------
     Player
     ------------------------------------------------------------ */
  function play(v, scroll) {
    state.current = v;
    const videoId = v.ytVideoId || v.yt || v.id;
    if (!videoId) {
      $('#playerFrame').src = '';
      $('#playerTitle').textContent = v.title || 'No video';
      $('#playerWhere').textContent = v.place ? (v.place.municipality + ', ' + v.place.stateName) : '';
      $('#playerBadges').innerHTML = '<span class="badge badge--navy">No video available</span>';
      $('#playerBlurb').textContent = '';
      $('#playerFacts').innerHTML = '';
      return;
    }
    // Normalise so rail highlighting and the rest of the UI can rely on one field.
    v.ytVideoId = videoId;
    $('#playerFrame').src = 'https://www.youtube-nocookie.com/embed/' + videoId + '?rel=0&modestbranding=1';
    $('#playerFrame').title = v.title + ' — ' + v.place.municipality + ', ' + v.place.stateName;
    $('#playerLoading').textContent = 'Loading video…';
    $('#playerLoading').style.opacity = '1';
    $('#playerFrame').removeAttribute('data-loaded');
    const frame = $('#playerFrame');
    frame.onload = () => {
      frame.setAttribute('data-loaded', '1');
      $('#playerLoading').style.opacity = '0';
    };
    frame.onerror = () => {
      frame.setAttribute('data-loaded', '1');
      $('#playerLoading').textContent = 'Video unavailable';
      $('#playerLoading').style.opacity = '1';
    };

    const badges = [];
    if (v.status === 'live') badges.push('<span class="badge badge--live">● Live now</span>');
    else if (v.status === 'upcoming') badges.push('<span class="badge badge--gold">Upcoming</span>');
    else if (isRecent(v)) badges.push('<span class="badge badge--new">New this week</span>');
    badges.push('<span class="badge badge--onDark">' + esc(v.govBody) + '</span>');
    if (v.agenda && v.agenda.itemCount) {
      badges.push('<span class="badge badge--navy" title="Topics confirmed against the ' +
        'published agenda for this meeting">Agenda-backed · ' + v.agenda.itemCount + ' items</span>');
    }
    v.topics.forEach((t) => badges.push('<span class="badge badge--onDark">' + esc(t.label) + '</span>'));
    $('#playerBadges').innerHTML = badges.join('');

    $('#playerTitle').textContent = v.title;
    $('#playerWhere').textContent =
      [v.place.municipality + ', ' + v.place.stateName, v.place.county, v.channel && v.channel.name]
        .filter(Boolean).join(' · ');
    $('#playerBlurb').textContent = v.description || '';

    $('#playerFacts').innerHTML = [
      [v.status === 'upcoming' ? 'Scheduled' : 'Recorded',
        v.status === 'upcoming' ? fmtTime(v.scheduledStartAt) : fmtDate(v.publishedAt)],
      ['Runtime', fmtDur(v.durationSeconds)],
      ['Body', v.govBody],
      ['Population', fmtPop(v.place.population)],
      ['Size tier', TIER_LABELS[v.place.sizeTier] || '—']
    ].map((f) => '<div class="fact"><span class="fact__k">' + esc(f[0]) +
      '</span><span class="fact__v">' + esc(f[1]) + '</span></div>').join('');

    document.querySelectorAll('.railitem').forEach((n) => {
      n.setAttribute('aria-current', n.dataset.yt === v.ytVideoId ? 'true' : 'false');
    });

    if (scroll) {
      const y = document.querySelector('.hero').getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top: Math.max(y, 0), behavior: 'smooth' });
    }
  }

  /* ------------------------------------------------------------
     Featured rail + upcoming schedule
     ------------------------------------------------------------ */
  async function renderRail() {
    let featured = [];
    let upcoming = [];

    if (state.mode === 'api') {
      try {
        const [feat, up] = await Promise.all([
          getJson('/api/videos?sort=newest&limit=9'),
          getJson('/api/videos?status=live,upcoming&sort=newest&limit=8')
        ]);
        featured = feat.items;
        upcoming = up.items;
      } catch (err) {
        featured = filterSample().slice(0, 9);
      }
    } else {
      featured = filterSample().slice(0, 9);
    }

    // Live items belong at the top of Featured.
    featured.sort((a, b) => (b.status === 'live') - (a.status === 'live'));

    const panel = $('#panel-featured');
    panel.innerHTML = '';
    featured.forEach((v) => {
      const item = el('button', 'railitem');
      item.type = 'button';
      item.dataset.yt = v.ytVideoId;
      item.innerHTML =
        '<div class="railitem__thumb"><img loading="lazy" src="' + esc(v.thumbnailUrl) + '" alt="" />' +
        '<span class="railitem__dur">' + fmtDur(v.durationSeconds) + '</span></div>' +
        '<div><div class="railitem__t">' + esc(v.title) + '</div>' +
        '<div class="railitem__m">' + esc(v.place.municipality) + ', ' + esc(v.place.stateCode) + ' · ' +
        (v.status === 'live' ? 'Live now' : fmtDateShort(v.publishedAt)) + '</div></div>';
      item.addEventListener('click', () => play(v, true));
      panel.appendChild(item);
    });

    const up = $('#panel-upcoming');
    up.innerHTML = '<div class="sched"></div>';
    const sched = up.firstChild;

    if (upcoming.length) {
      upcoming.forEach((v) => {
        const row = el('div', 'schedrow',
          '<div class="schedrow__time">' +
            (v.status === 'live' ? 'Now' : esc(fmtTime(v.scheduledStartAt || v.publishedAt))) + '</div>' +
          '<div><div class="schedrow__t">' + esc(v.title) +
            (v.status === 'live' ? ' <span class="badge badge--live">● Live</span>' : '') + '</div>' +
          '<div class="schedrow__p">' + esc(v.place.municipality) + ', ' + esc(v.place.stateCode) +
            ' · ' + esc(v.govBody) + '</div></div>');
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => play(v, true));
        sched.appendChild(row);
      });
      $('#railNote').textContent =
        'Live and scheduled streams, detected automatically from each municipality\u2019s feed.';
    } else if (typeof UPCOMING !== 'undefined' && UPCOMING.length) {
      UPCOMING.forEach((u) => {
        sched.appendChild(el('div', 'schedrow',
          '<div class="schedrow__time">' + esc(u.time) + '</div>' +
          '<div><div class="schedrow__t">' + esc(u.title) +
            (u.live ? ' <span class="badge badge--live">● Live</span>' : '') + '</div>' +
          '<div class="schedrow__p">' + esc(u.place) + ' · ' + esc(u.body) + '</div></div>'));
      });
      $('#railNote').textContent =
        'Sample programming grid. Live schedules appear here as soon as monitored channels announce streams.';
    } else {
      sched.appendChild(el('div', 'schedrow',
        '<div class="schedrow__time">—</div>' +
        '<div><div class="schedrow__t">Nothing scheduled right now</div>' +
        '<div class="schedrow__p">Upcoming streams appear here automatically when a monitored town announces one.</div></div>'));
      $('#railNote').textContent = 'Monitoring ' + (state.channelCount || 0) + ' municipal channels for new streams.';
    }
  }

  function switchTab(which) {
    const isFeat = which === 'featured';
    $('#tab-featured').setAttribute('aria-selected', String(isFeat));
    $('#tab-upcoming').setAttribute('aria-selected', String(!isFeat));
    $('#panel-featured').hidden = !isFeat;
    $('#panel-upcoming').hidden = isFeat;
  }

  /* ------------------------------------------------------------
     What's new this week
     ------------------------------------------------------------ */
  async function renderNew() {
    const box = $('#newScroller');
    box.innerHTML = '';
    let items = [];
    if (state.mode === 'api') {
      try {
        items = (await getJson('/api/videos?sort=newest&limit=10')).items;
      } catch (err) { /* fall through */ }
    }
    if (!items.length) items = filterSample().slice(0, 10);
    items.forEach((v) => box.appendChild(makeCard(v)));
  }

  /* ------------------------------------------------------------
     Top community topics
     ------------------------------------------------------------ */
  function renderTopics() {
    const box = $('#topicGrid');
    box.innerHTML = '';
    // Show every browsable topic, including ones with no coverage yet. Hiding
    // the empties would misrepresent how much of the agenda we can actually
    // characterise from what towns publish.
    const list = state.topics.filter((t) => t.show_in_trending !== false);
    if (!list.length) return;
    const max = Math.max.apply(null, list.map((t) => t.video_count)) || 1;

    list.forEach((t, i) => {
      const empty = !t.video_count;
      const b = el('button', 'topic' + (empty ? ' topic--empty' : ''));
      b.type = 'button';
      b.disabled = empty;
      b.setAttribute('aria-pressed', String(state.query.topic === t.slug));
      b.title = empty
        ? t.label + ' — no meetings tagged with this topic yet'
        : (t.description || t.label);
      b.innerHTML =
        '<span class="topic__rank">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="topic__name">' + esc(t.label) + '</span>' +
        '<span class="topic__n">' + (empty ? 'none yet' : t.video_count + (t.video_count === 1 ? ' video' : ' videos')) + '</span>' +
        '<span class="topic__bar" style="width:' + Math.round((t.video_count / max) * 100) + '%"></span>';
      if (!empty) {
        b.addEventListener('click', () => {
          state.query.topic = state.query.topic === t.slug ? '' : t.slug;
          state.page = 1;
          buildDropdowns();
          renderResults();
          renderTopics();
          $('#library').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      box.appendChild(b);
    });

    // Say plainly how much of the library carries a specific subject tag.
    // Counts come from /api/stats so they are distinct MEETINGS, not tag rows —
    // a meeting can carry several topics.
    const note = $('#topicNote');
    if (note && state.coverage && state.coverage.total) {
      const { tagged, total } = state.coverage;
      const backed = state.coverage.agendaBacked || 0;
      note.textContent =
        tagged + ' of ' + total + ' meetings carry a specific subject tag' +
        (backed ? ', ' + backed + ' of them confirmed against the town\u2019s published agenda' : '') +
        '. The rest are full mixed-agenda sessions filed under General Session, because the ' +
        'title and description the town published do not say what was discussed.';
    } else if (note) {
      note.textContent = '';
    }
  }

  /** Topic counts, from the API or computed from the sample. */
  async function loadTopics() {
    if (state.mode === 'api') {
      try {
        state.topics = (await getJson('/api/topics')).topics;
        return;
      } catch (err) { /* fall through */ }
    }
    const counts = {};
    sampleLibrary().forEach((v) => v.topics.forEach((t) => {
      counts[t.slug] = counts[t.slug] || { slug: t.slug, label: t.label, video_count: 0 };
      counts[t.slug].video_count += 1;
    }));
    state.topics = Object.values(counts).sort((a, b) => b.video_count - a.video_count);
  }

  /* ------------------------------------------------------------
     Stats strip
     ------------------------------------------------------------ */
  async function renderStats() {
    let s = null;
    if (state.mode === 'api') {
      try { s = await getJson('/api/stats'); } catch (err) { /* fall through */ }
    }
    if (!s) {
      const lib = sampleLibrary();
      s = {
        videos: lib.length,
        states: new Set(lib.map((v) => v.place.stateName)).size,
        municipalities: new Set(lib.map((v) => v.place.municipality)).size,
        archive_hours: Math.round(lib.reduce((a, v) => a + (v.durationSeconds || 0), 0) / 3600),
        channels: new Set(lib.map((v) => v.channel.name)).size
      };
    }
    state.channelCount = s.channels;
    state.coverage = {
      tagged: s.tagged_videos || 0,
      total: s.videos || 0,
      agendaBacked: s.agenda_backed_videos || 0
    };

    $('#stats').innerHTML = [
      [String(s.videos), 'Proceedings archived'],
      [String(s.states), 'States represented'],
      [String(s.municipalities), 'Communities covered'],
      [s.archive_hours + '+', 'Hours of unedited record']
    ].map((d) => '<div class="stat"><div class="stat__v">' + d[0] +
      '</div><div class="stat__k">' + d[1] + '</div></div>').join('');

    const liveCount = (s.live_now || 0) + (s.upcoming || 0);
    $('#liveCount').textContent = String(s.live_now || 0);
    const pill = document.querySelector('.livepill');
    if (pill) pill.hidden = !(s.live_now > 0);
    const upcomingPill = $('#upcomingCount');
    if (upcomingPill) upcomingPill.textContent = String(liveCount);
  }

  /* ------------------------------------------------------------
     Reset
     ------------------------------------------------------------ */
  function resetAll() {
    Object.assign(state.query, {
      state: '', county: '', city: '', tier: '', body: '', topic: '', status: '', q: '', sort: 'newest'
    });
    state.page = 1;
    $('#search').value = '';
    buildDropdowns();
    renderResults();
    renderTopics();
  }

  /* ------------------------------------------------------------
     Source indicator
     ------------------------------------------------------------ */
  function setMode(mode) {
    state.mode = mode;
    const badge = $('#sourceBadge');
    if (!badge) return;
    if (mode === 'api') {
      badge.textContent = 'Live data';
      badge.className = 'srcbadge srcbadge--live';
      badge.title = 'Reading from the Community-Span ingestion database';
    } else {
      badge.textContent = 'Sample data';
      badge.className = 'srcbadge srcbadge--sample';
      badge.title = 'The API is not reachable, so this page is showing the bundled sample library';
    }
  }

  /* ------------------------------------------------------------
     Wiring
     ------------------------------------------------------------ */
  function bind() {
    const rerender = () => { state.page = 1; buildDropdowns(); renderResults(); };

    $('#fState').addEventListener('change', (e) => {
      state.query.state = e.target.value; state.query.county = ''; state.query.city = ''; rerender();
    });
    $('#fCounty').addEventListener('change', (e) => {
      state.query.county = e.target.value; state.query.city = ''; rerender();
    });
    $('#fCity').addEventListener('change', (e) => { state.query.city = e.target.value; rerender(); });
    $('#fTier').addEventListener('change', (e) => { state.query.tier = e.target.value; rerender(); });
    $('#fBody').addEventListener('change', (e) => { state.query.body = e.target.value; rerender(); });
    if ($('#fTopic')) {
      $('#fTopic').addEventListener('change', (e) => {
        state.query.topic = e.target.value; rerender(); renderTopics();
      });
    }
    $('#fSort').addEventListener('change', (e) => {
      state.query.sort = e.target.value; state.page = 1; renderResults();
    });
    if ($('#fStatus')) {
      $('#fStatus').addEventListener('change', (e) => {
        state.query.status = e.target.value; state.page = 1; renderResults();
      });
    }

    let t;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(t);
      const val = e.target.value;
      t = setTimeout(() => { state.query.q = val; state.page = 1; renderResults(); }, 220);
    });

    $('#resetBtn').addEventListener('click', resetAll);
    $('#topicClear').addEventListener('click', () => {
      state.query.topic = ''; state.page = 1; renderResults(); renderTopics();
    });
    $('#moreBtn').addEventListener('click', () => { state.page += 1; renderResults(); });

    $('#tab-featured').addEventListener('click', () => switchTab('featured'));
    $('#tab-upcoming').addEventListener('click', () => switchTab('upcoming'));
    document.querySelectorAll('a[href="#upcoming"]').forEach((a) =>
      a.addEventListener('click', () => switchTab('upcoming')));

    const scroller = $('#newScroller');
    $('#newPrev').addEventListener('click', () => scroller.scrollBy({ left: -580, behavior: 'smooth' }));
    $('#newNext').addEventListener('click', () => scroller.scrollBy({ left: 580, behavior: 'smooth' }));

    const root = document.documentElement;
    let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    $('#themeBtn').addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
    });

    const nav = $('#mainnav');
    $('#navToggle').addEventListener('click', (e) => {
      const open = nav.classList.toggle('nav--open');
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') {
        nav.classList.remove('nav--open');
        $('#navToggle').setAttribute('aria-expanded', 'false');
      }
    });
    // Close the mobile menu when any hash link is followed.
    document.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener('click', () => {
        nav.classList.remove('nav--open');
        $('#navToggle').setAttribute('aria-expanded', 'false');
      });
    });

    $('#premiumBtn').addEventListener('click', () => {
      document.querySelector('.footer').scrollIntoView({ behavior: 'smooth' });
    });
  }

  /* ------------------------------------------------------------
     Boot
     ------------------------------------------------------------ */
  async function boot() {
    // Decide the data source first — everything else depends on it.
    try {
      const health = await getJson('/api/health', { timeout: 5000 });
      setMode(health && health.ok ? 'api' : 'sample');
    } catch (err) {
      setMode('sample');
    }

    if (state.mode === 'api') {
      try {
        state.filters = await getJson('/api/filters');
      } catch (err) {
        setMode('sample');
      }
    }

    if (state.mode === 'sample') {
      // Derive dropdown options from the bundled library.
      const lib = sampleLibrary();
      const uniq = (arr, key) => Array.from(new Set(arr.map(key))).filter(Boolean).sort();
      state.filters = {
        states: uniq(lib, (v) => v.place.stateName).map((name) => {
          const hit = lib.find((v) => v.place.stateName === name);
          return { code: hit.place.stateCode, name };
        }),
        counties: Array.from(new Map(lib.map((v) =>
          [v.place.county, { state: v.place.stateCode, name: v.place.county }])).values())
          .filter((c) => c.name).sort((a, b) => a.name.localeCompare(b.name)),
        cities: Array.from(new Map(lib.map((v) =>
          [v.place.municipality, { state: v.place.stateCode, county: v.place.county, name: v.place.municipality }])).values())
          .sort((a, b) => a.name.localeCompare(b.name)),
        bodies: uniq(lib, (v) => v.govBody),
        sizeTiers: TIER_ORDER.filter((t) => lib.some((v) => v.place.sizeTier === t))
      };
    }

    await loadTopics();
    buildDropdowns();
    bind();

    await renderResults();
    await Promise.all([renderRail(), renderNew(), renderStats()]);
    renderTopics();   // runs after renderStats so the coverage note has real numbers

    // Open on whatever is live, else the most recent proceeding.
    const opener = state.items.find((v) => v.status === 'live') || state.items[0];
    if (opener) play(opener, false);
  }

  boot();
})();
