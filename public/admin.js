/* ============================================================
   Town Hall Meetings — newsroom console
   Add and manage towns without touching a terminal.

   Hybrid by design: the channel and the location are always yours to confirm,
   because no catalogue can judge whether a given YouTube channel really is a
   particular town's select board. The agenda source is the optional assist,
   suggested from the discovered catalogue when one exists.
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
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const API_TOKEN = '__PORT_3000__';
  const DEFAULT_BASE = API_TOKEN.indexOf('__PORT') === 0 ? '' : API_TOKEN.replace(/\/+$/, '');

  /* Held in memory only. Sandboxed previews block localStorage, and an admin
     token does not belong in browser storage anyway. */
  const session = { token: '', base: DEFAULT_BASE, resolved: null, agenda: null };

  const STATES = [
    ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
    ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
    ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
    ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
    ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
    ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
    ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
    ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],
    ['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
    ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],
    ['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']
  ];

  /* Bodies we deliberately leave unhinted because their agendas are mixed. */
  const GENERAL_BODIES = [
    'City Council', 'Town Council', 'Select Board', 'County Commission',
    'Board of Supervisors', 'Board of Aldermen', 'City Commission', 'Village Board'
  ];

  /* ------------------------------------------------------------
     HTTP
     ------------------------------------------------------------ */
  async function call(path, { method = 'GET', body, auth = true, timeout = 45000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers = { accept: 'application/json' };
      if (body) headers['content-type'] = 'application/json';
      if (auth && session.token) headers.authorization = 'Bearer ' + session.token;
      const res = await fetch(session.base + path, {
        method, headers, signal: ctrl.signal,
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* not json */ }
      if (!res.ok) {
        const msg = (json && json.error) || text.slice(0, 200) || ('HTTP ' + res.status);
        throw Object.assign(new Error(msg), { status: res.status });
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  const busy = (node, on) => node.classList.toggle('spinner', !!on);

  function showResult(target, ok, html) {
    const box = $(target);
    box.innerHTML = '';
    box.appendChild(el('div', 'result ' + (ok ? 'result--ok' : 'result--err'), html));
  }

  /* ------------------------------------------------------------
     Sign in
     ------------------------------------------------------------ */
  async function connect() {
    const token = $('#token').value.trim();
    const base = $('#apiBase').value.trim().replace(/\/+$/, '');
    if (!token) {
      $('#authNote').className = 'note note--err';
      $('#authNote').textContent = 'Paste your admin token first.';
      return;
    }
    session.token = token;
    session.base = base || DEFAULT_BASE;

    busy($('#connectBtn'), true);
    try {
      const health = await call('/api/health', { auth: false });
      await call('/admin/channels');       // proves the token is right
      $('#authBadge').textContent = 'Connected';
      $('#authBadge').className = 'srcbadge srcbadge--live';
      $('#authNote').className = 'note note--ok';
      $('#authNote').textContent =
        'Connected. ' + health.videos + ' meetings on file.';
      ['#addPanel', '#bulkPanel', '#listPanel'].forEach((s) => { $(s).hidden = false; });
      await loadChannels();
    } catch (err) {
      $('#authBadge').textContent = 'Not connected';
      $('#authBadge').className = 'srcbadge srcbadge--sample';
      $('#authNote').className = 'note note--err';
      $('#authNote').textContent = err.status === 401
        ? 'That token was rejected. Check ADMIN_TOKEN on the server.'
        : 'Could not reach the server: ' + err.message;
    } finally {
      busy($('#connectBtn'), false);
    }
  }

  /* ------------------------------------------------------------
     Step 1 — look up the channel
     ------------------------------------------------------------ */
  async function resolveChannel() {
    const input = $('#chanInput').value.trim();
    if (!input) return;
    busy($('#resolveBtn'), true);
    $('#resolveResult').innerHTML = '';
    try {
      const r = await call('/admin/resolve-channel', { method: 'POST', body: { channel: input } });
      session.resolved = r;

      const recent = (r.recentVideos || []).map((v) =>
        '<li><b>' + esc(v.title.slice(0, 78)) + '</b><span>' +
        (v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('en-US') : '') + '</span></li>'
      ).join('');

      $('#resolveResult').innerHTML =
        '<div class="preview">' +
        '<div class="preview__top">' +
        '<span class="preview__name">' + esc(r.title || r.ytChannelId) + '</span>' +
        '<span class="preview__id">' + esc(r.ytChannelId) + '</span>' +
        (r.alreadyTracked
          ? '<span class="pill pill--warn">Already monitored as ' +
            esc((r.existing && r.existing.municipality) || '') + '</span>'
          : '<span class="pill pill--ok">New</span>') +
        '</div>' +
        (recent
          ? '<p class="step__hint" style="margin:12px 0 4px">Most recent uploads — confirm these look like meetings:</p>' +
            '<ul class="preview__list">' + recent + '</ul>'
          : '<p class="step__hint" style="margin:12px 0 0">No recent uploads found on this channel.</p>') +
        '</div>';

      // Prefill the town name from the channel title when it is obvious.
      const guess = String(r.title || '')
        .replace(/^(city of|town of|village of|county of)\s+/i, '')
        .replace(/\s*(tv|media|channel|government|gov|council|meetings?)\s*$/i, '')
        .trim();
      if (guess && !$('#fMuni').value) $('#fMuni').value = guess;

      $('#detailsStep').hidden = false;
      $('#agendaStep').hidden = false;
      $('#saveRow').hidden = false;
      updateBodyHelp();
      if ($('#fMuni').value) suggestAgenda($('#fMuni').value);
    } catch (err) {
      showResult('#resolveResult', false, 'Could not resolve that channel.<br><code>' + esc(err.message) + '</code>');
    } finally {
      busy($('#resolveBtn'), false);
    }
  }

  /* ------------------------------------------------------------
     Step 2 — governing body guidance
     ------------------------------------------------------------ */
  function updateBodyHelp() {
    const body = $('#fBody').value;
    const help = $('#bodyHelp');
    if (GENERAL_BODIES.includes(body)) {
      help.textContent = 'Mixed agenda, so no default subject is assumed — topics come from the ' +
        'title or the agenda. This is intentional.';
    } else {
      help.textContent = 'Single-purpose body: meetings inherit a sensible default topic automatically.';
    }
  }

  /* ------------------------------------------------------------
     Step 3 — optional agenda source
     ------------------------------------------------------------ */
  let suggestTimer;
  async function suggestAgenda(q) {
    const box = $('#agendaSuggest');
    if (!q || q.trim().length < 3) { box.innerHTML = ''; return; }
    try {
      const r = await call('/api/agenda-sources?available_only=true&limit=6&q=' +
        encodeURIComponent(q.trim()), { auth: false });
      if (!r.sources.length) {
        box.innerHTML = '<p class="step__hint" style="margin:8px 0 0">' +
          'No agenda system found for “' + esc(q.trim()) + '”. That is normal — most towns ' +
          'publish agendas only as PDFs on their own website. Add the town anyway.</p>';
        return;
      }
      box.innerHTML = '<div class="suggest">' + r.sources.map((s) =>
        '<button class="suggest__item" type="button" data-vendor="' + esc(s.vendor) +
        '" data-code="' + esc(s.clientCode) + '" data-name="' + esc(s.displayName) + '">' +
        '<span><span class="suggest__name">' + esc(s.displayName) + '</span><br>' +
        '<span class="suggest__meta">' + esc(s.clientCode) + ' · ' +
        (s.bodies || []).length + ' bodies published</span></span>' +
        '<span class="suggest__vendor">' + esc(s.vendor) + '</span></button>'
      ).join('') + '</div>';

      box.querySelectorAll('.suggest__item').forEach((b) => {
        b.addEventListener('click', () => {
          session.agenda = { vendor: b.dataset.vendor, clientCode: b.dataset.code, name: b.dataset.name };
          renderChosen();
        });
      });
    } catch (err) {
      box.innerHTML = '';
    }
  }

  function renderChosen() {
    const box = $('#agendaChosen');
    if (!session.agenda) { box.innerHTML = ''; return; }
    box.innerHTML =
      '<div class="chosen">Agenda source: <b>' + esc(session.agenda.name) + '</b> (' +
      esc(session.agenda.vendor) + ')' +
      '<button class="btn btn--outline btn--sm" type="button" id="dropAgenda">Remove</button></div>';
    $('#dropAgenda').addEventListener('click', () => { session.agenda = null; renderChosen(); });
    $('#agendaSuggest').innerHTML = '';
  }

  /* ------------------------------------------------------------
     Save
     ------------------------------------------------------------ */
  async function saveTown() {
    if (!session.resolved) return;
    const payload = {
      channel: session.resolved.ytChannelId,
      municipality: $('#fMuni').value.trim(),
      county: $('#fCounty').value.trim() || null,
      stateCode: $('#fStateCode').value,
      stateName: (STATES.find((s) => s[0] === $('#fStateCode').value) || [])[1],
      govBody: $('#fBody').value,
      population: $('#fPop').value ? Number($('#fPop').value) : null,
      timezone: $('#fTz').value,
      autoSubscribe: $('#fSubscribe').checked
    };
    if (!payload.municipality || !payload.stateCode) {
      showResult('#saveResult', false, 'City/town and state are required.');
      return;
    }

    busy($('#saveBtn'), true);
    try {
      let out;
      if (session.agenda) {
        out = await call('/admin/channels/from-agenda-source', {
          method: 'POST',
          body: Object.assign({}, payload, {
            vendor: session.agenda.vendor, clientCode: session.agenda.clientCode
          })
        });
      } else {
        out = await call('/admin/channels', { method: 'POST', body: payload });
      }

      let extra = '';
      if ($('#fBackfill').checked) {
        const bf = await call('/admin/channels/' + encodeURIComponent(session.resolved.ytChannelId) + '/backfill',
          { method: 'POST', body: { limit: 15 } }).catch((e) => ({ error: e.message }));
        extra = bf && bf.inserted != null
          ? '<li>Pulled ' + bf.inserted + ' meetings (' + bf.skipped + ' skipped)</li>'
          : '<li>Backfill did not run: <code>' + esc((bf && bf.error) || 'unknown') + '</code></li>';
      }

      const sub = out.subscription;
      showResult('#saveResult', true,
        '<b>' + esc(payload.municipality) + ', ' + esc(payload.stateCode) + '</b> is now monitored.' +
        '<ul>' +
        '<li>Channel: <code>' + esc(session.resolved.ytChannelId) + '</code></li>' +
        '<li>Real-time push: ' + (sub ? (sub.ok ? 'requested — the hub verifies within seconds' :
          'failed (' + esc(String(sub.error || sub.status)) + ')') : 'not requested') + '</li>' +
        (session.agenda ? '<li>Agenda source: ' + esc(session.agenda.name) + '</li>'
                        : '<li>No agenda source — topics will come from titles</li>') +
        extra +
        '</ul>');

      // Reset for the next town, keeping the state selection.
      session.resolved = null; session.agenda = null;
      $('#chanInput').value = ''; $('#fMuni').value = ''; $('#fCounty').value = ''; $('#fPop').value = '';
      $('#resolveResult').innerHTML = ''; $('#agendaChosen').innerHTML = ''; $('#agendaSuggest').innerHTML = '';
      $('#detailsStep').hidden = true; $('#agendaStep').hidden = true; $('#saveRow').hidden = true;
      await loadChannels();
    } catch (err) {
      showResult('#saveResult', false, 'Could not add that town.<br><code>' + esc(err.message) + '</code>');
    } finally {
      busy($('#saveBtn'), false);
    }
  }

  /* ------------------------------------------------------------
     Bulk
     ------------------------------------------------------------ */
  async function bulkAdd() {
    const csv = $('#bulkCsv').value.trim();
    if (!csv) return;
    busy($('#bulkBtn'), true);
    try {
      const out = await call('/admin/channels/bulk', { method: 'POST', body: { csv } });
      const lines = out.results.map((r) =>
        '<li>' + (r.ok ? '✓ ' : '✗ ') + esc(r.municipality || '?') +
        (r.ok ? '' : ' — <code>' + esc(r.error) + '</code>') + '</li>').join('');
      showResult('#bulkResult', out.failed === 0,
        '<b>' + out.added + ' added, ' + out.failed + ' failed.</b><ul>' + lines + '</ul>');
      await loadChannels();
    } catch (err) {
      showResult('#bulkResult', false, esc(err.message));
    } finally {
      busy($('#bulkBtn'), false);
    }
  }

  /* ------------------------------------------------------------
     Monitored towns
     ------------------------------------------------------------ */
  function pushPill(c) {
    if (!c.is_active) return '<span class="pill pill--none">Off</span>';
    if (c.websub_state === 'active') return '<span class="pill pill--ok">Live</span>';
    if (c.websub_state === 'pending') return '<span class="pill pill--warn">Pending</span>';
    if (c.websub_state === 'failed') return '<span class="pill pill--err">Failed</span>';
    return '<span class="pill pill--none">' + esc(c.websub_state || 'none') + '</span>';
  }

  async function loadChannels() {
    try {
      const r = await call('/admin/channels');
      const tbody = $('#chanTable tbody');
      tbody.innerHTML = '';

      const withAgenda = r.channels.filter((c) => c.agenda_vendor).length;
      const pushOn = r.channels.filter((c) => c.websub_state === 'active').length;
      $('#listSummary').textContent =
        r.channels.length + ' towns · ' + pushOn + ' with real-time push confirmed · ' +
        withAgenda + ' with an agenda source';

      r.channels.forEach((c) => {
        const tr = el('tr');
        tr.innerHTML =
          '<td><div class="table__town">' + esc(c.municipality) + ', ' + esc(c.state_code) + '</div>' +
          '<div class="table__where">' + esc(c.county || '') + (c.county ? ' · ' : '') + esc(c.name) + '</div></td>' +
          '<td>' + esc(c.gov_body) + '</td>' +
          '<td>' + pushPill(c) + '</td>' +
          '<td>' + (c.agenda_vendor
            ? '<span class="pill pill--ok">' + esc(c.agenda_vendor) + '</span>'
            : '<span class="pill pill--none">none</span>') + '</td>' +
          '<td class="num">' + c.video_count + (c.agenda_backed ? ' <span class="table__where">(' + c.agenda_backed + ' agenda)</span>' : '') + '</td>' +
          '<td class="table__where">' + (c.latest_video_at
            ? new Date(c.latest_video_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '—') + '</td>' +
          '<td><div class="rowbtns">' +
          '<button class="btn btn--outline btn--sm" data-act="backfill" data-id="' + esc(c.yt_channel_id) + '">Pull</button>' +
          '<button class="btn btn--outline btn--sm" data-act="resub" data-id="' + esc(c.yt_channel_id) + '">Re-subscribe</button>' +
          '</div></td>';
        tbody.appendChild(tr);
      });

      tbody.querySelectorAll('button[data-act]').forEach((b) => {
        b.addEventListener('click', async () => {
          busy(b, true);
          const id = b.dataset.id;
          try {
            if (b.dataset.act === 'backfill') {
              const out = await call('/admin/channels/' + encodeURIComponent(id) + '/backfill',
                { method: 'POST', body: { limit: 15 } });
              showResult('#listResult', true, 'Pulled ' + out.inserted + ' new, updated ' + out.updated + '.');
            } else {
              const out = await call('/admin/channels/' + encodeURIComponent(id) + '/subscribe', { method: 'POST' });
              showResult('#listResult', !!out.ok,
                out.ok ? 'Subscription requested — the hub verifies within seconds.'
                       : 'Hub returned ' + out.status);
            }
            await loadChannels();
          } catch (err) {
            showResult('#listResult', false, esc(err.message));
          } finally {
            busy(b, false);
          }
        });
      });
    } catch (err) {
      showResult('#listResult', false, 'Could not load towns: ' + esc(err.message));
    }
  }

  /* ------------------------------------------------------------
     Init
     ------------------------------------------------------------ */
  function init() {
    const sel = $('#fStateCode');
    sel.appendChild(new Option('Choose…', ''));
    STATES.forEach(([code, name]) => sel.appendChild(new Option(name, code)));

    $('#connectBtn').addEventListener('click', connect);
    $('#token').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
    $('#resolveBtn').addEventListener('click', resolveChannel);
    $('#chanInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') resolveChannel(); });
    $('#fBody').addEventListener('change', updateBodyHelp);
    $('#fMuni').addEventListener('input', (e) => {
      clearTimeout(suggestTimer);
      const v = e.target.value;
      suggestTimer = setTimeout(() => { if (!session.agenda) suggestAgenda(v); }, 350);
    });
    $('#agendaSearch').addEventListener('input', (e) => {
      clearTimeout(suggestTimer);
      const v = e.target.value;
      suggestTimer = setTimeout(() => suggestAgenda(v), 300);
    });
    $('#agendaClear').addEventListener('click', () => {
      session.agenda = null; renderChosen(); $('#agendaSuggest').innerHTML = '';
    });
    $('#saveBtn').addEventListener('click', saveTown);
    $('#bulkBtn').addEventListener('click', bulkAdd);
    $('#refreshBtn').addEventListener('click', loadChannels);
    $('#syncAgendasBtn').addEventListener('click', async () => {
      busy($('#syncAgendasBtn'), true);
      try {
        const out = await call('/admin/agendas/sync', { method: 'POST', body: {} });
        showResult('#listResult', true,
          'Agendas: ' + out.sync.meetings + ' meetings, ' + out.sync.items + ' items. ' +
          'Matched ' + out.match.matched + ' videos, ' + out.match.retagged + ' re-tagged from the agenda.');
        await loadChannels();
      } catch (err) {
        showResult('#listResult', false, esc(err.message));
      } finally {
        busy($('#syncAgendasBtn'), false);
      }
    });

    const root = document.documentElement;
    let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    $('#themeBtn').addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
    });
  }

  init();
})();
