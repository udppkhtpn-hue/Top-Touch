/**
 * admin.js — Live Operations Cockpit (SPEC §4 Admin tier, DASHBOARD_PLAN §2).
 *
 * Flow: admin login (username + PIN) -> session token -> poll getLiveCases
 * every ~45s -> render. Between polls, the window countdowns tick locally each
 * second from each case's time-of-death, so the 4h / 12h / 24h bars drain and
 * re-colour (green -> amber -> red) live without hammering the backend.
 *
 * The server is the source of truth for the gate (token, validated in Auth.gs)
 * and for every view being written to AuditLog. This file only renders the
 * per-case detail the token-gated endpoint returns; it computes no gate itself.
 *
 * Sections rendered:
 *   - On-call / backup roster            (C4, top-level)
 *   - Exceptions strip                   (C3: unack-escalated, serology overdue,
 *                                          exclusion-flagged, medico-legal)
 *   - Live window countdowns / urgency   (C2, most-urgent-first)
 *   - Pipeline board by phase            (C1)
 *   - Per-case coordination readiness    (C4, read-only until updateReferral)
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'top_admin_token';
  var NAME_KEY = 'top_admin_name';
  var POLL_MS = 45000;

  // Clinical windows from time of death (minutes). Mirrors Dashboard.gs constants.
  var WINDOWS = [
    { key: 'serology',        name: 'Serologi', limitMin: 240 },   // ≤ 4 h
    { key: 'cornea',          name: 'Kornea',   limitMin: 720 },   // ≤ 12 h
    { key: 'musculoskeletal', name: 'MSK/Injap', limitMin: 1440 }  // ≤ 24 h
  ];

  // Exceptions strip (C3). severity drives the accent colour.
  var EXCEPTIONS = [
    { key: 'unackEscalated',  label: 'Belum diakui — melepasi masa eskalasi', sev: 'hot' },
    { key: 'serologyOverdue', label: 'Serologi lewat — >1j tiada keputusan',  sev: 'hot' },
    { key: 'exclAny',         label: 'Kriteria pengecualian = Ya — menunggu semakan TOP', sev: 'warn' },
    { key: 'medicoLegal',     label: 'Kes perundangan (medico-legal) belum dilepaskan',   sev: 'warn' }
  ];

  // Per-case coordination steps (C4, DCD checklist). key -> label.
  var COORD = [
    ['ophthal',  'Oftal (kornea)'],
    ['ortho',    'Ortho (tulang)'],
    ['plastic',  'Plastik (kulit)'],
    ['ijn',      'IJN (injap)'],
    ['ot',       'OT'],
    ['forensics','Forensik']
  ];

  // Canonical pipeline phases for the board (C1). key -> Bahasa Melayu label.
  var PHASES = [
    ['NEW',                   'Baharu'],
    ['ACKNOWLEDGED',          'Diakui'],
    ['SEROLOGI',              'Serologi'],
    ['PELEPASAN PERUNDANGAN', 'Pelepasan Perundangan'],
    ['PEROLEHAN',             'Perolehan'],
    ['JENAZAH DIPULANGKAN',   'Jenazah Dipulangkan']
  ];

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- State ----
  var token = '';
  var lastData = null;      // most recent getLiveCases payload
  var clockOffset = 0;      // serverTimeMs - clientNowMs, so countdowns match server
  var view = 'urgency';     // 'urgency' | 'board'
  var pollTimer = null, tickTimer = null;

  // ---- DOM refs ----
  var gate = document.getElementById('gate');
  var uName = document.getElementById('uName');
  var uPin = document.getElementById('uPin');
  var gateBtn = document.getElementById('gateBtn');
  var gateErr = document.getElementById('gateErr');
  var cockpit = document.getElementById('cockpit');
  var liveInd = document.getElementById('liveInd');
  var liveTxt = document.getElementById('liveTxt');
  var ckUser = document.getElementById('ckUser');
  var ckAsOf = document.getElementById('ckAsOf');
  var ckCount = document.getElementById('ckCount');
  var btnRefresh = document.getElementById('btnRefresh');
  var btnLogout = document.getElementById('btnLogout');
  var oncallList = document.getElementById('oncallList');
  var excStrip = document.getElementById('excStrip');
  var caseList = document.getElementById('caseList');
  var emptyUrgency = document.getElementById('emptyUrgency');
  var board = document.getElementById('board');
  var paneUrgency = document.getElementById('paneUrgency');
  var paneBoard = document.getElementById('paneBoard');
  var viewUrgencyBtn = document.getElementById('viewUrgency');
  var viewBoardBtn = document.getElementById('viewBoard');

  // =========================================================================
  // Login
  // =========================================================================
  gate.addEventListener('submit', function (e) {
    e.preventDefault();
    var username = uName.value.trim();
    var pin = uPin.value;
    if (!username || !pin) { setGateErr('Sila masukkan nama pengguna dan PIN.'); return; }
    setGateErr('');
    gateBtn.disabled = true;
    var prev = gateBtn.textContent;
    gateBtn.textContent = 'Menyemak…';

    apiPost('login', { username: username, pin: pin })
      .then(function (res) {
        if (!res || res.ok !== true) {
          throw new Error(res && res.error === 'invalid_credentials'
            ? 'Nama pengguna atau PIN tidak sah.'
            : 'Ralat pelayan. Cuba lagi.');
        }
        token = res.data.token;
        try {
          sessionStorage.setItem(TOKEN_KEY, token);
          sessionStorage.setItem(NAME_KEY, res.data.name || username);
        } catch (e2) { /* private mode: session lives in memory only */ }
        uPin.value = '';
        startSession(res.data.name || username);
      })
      .catch(function (err) { setGateErr(err.message || 'Ralat sambungan.'); })
      .then(function () { gateBtn.disabled = false; gateBtn.textContent = prev; });
  });

  function setGateErr(msg) { gateErr.textContent = msg || ''; }

  // =========================================================================
  // Session lifecycle
  // =========================================================================
  function startSession(name) {
    gate.classList.add('ck-hidden');
    cockpit.classList.remove('ck-hidden');
    ckUser.textContent = name ? ('👤 ' + name) : '';
    poll();
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = setInterval(poll, POLL_MS);
    tickTimer = setInterval(refreshAll, 1000);
  }

  function forceLogout(message) {
    token = '';
    try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(NAME_KEY); } catch (e) {}
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = tickTimer = null;
    lastData = null;
    cockpit.classList.add('ck-hidden');
    gate.classList.remove('ck-hidden');
    setGateErr(message || '');
  }

  btnLogout.addEventListener('click', function () {
    var t = token;
    forceLogout('');
    if (t) apiPost('logout', {}, { token: t }).catch(function () {}); // best-effort
  });

  btnRefresh.addEventListener('click', function () { poll(); });

  // ---- NTRC CSV export (admin-tier, token-gated, audited server-side) ----
  var btnExport = document.getElementById('btnExport');
  var expStatusMsg = document.getElementById('expStatusMsg');
  if (btnExport) btnExport.addEventListener('click', function () {
    if (!token) { forceLogout('Sila log masuk semula.'); return; }
    var from = document.getElementById('expFrom').value;
    var to = document.getElementById('expTo').value;
    var status = document.getElementById('expStatus').value;
    btnExport.disabled = true;
    expStatusMsg.textContent = 'Menyediakan eksport…';
    apiPost('exportCsv', { from: from, to: to, status: status }, { token: token })
      .then(function (res) {
        if (!res || res.ok !== true) {
          if (res && res.error === 'unauthorized') { forceLogout('Sesi tamat. Sila log masuk semula.'); return; }
          throw new Error((res && res.error) || 'export_error');
        }
        downloadCsv(res.data.filename || 'TOP-Referrals.csv', res.data.csv || '');
        expStatusMsg.textContent = (res.data.count || 0) + ' baris dieksport · ' + (res.data.filename || '');
      })
      .catch(function () { expStatusMsg.textContent = 'Ralat eksport. Cuba lagi.'; })
      .then(function () { btnExport.disabled = false; });
  });

  // Trigger a client-side download of the CSV text (BOM so Excel reads Malay + UTF-8).
  function downloadCsv(filename, csv) {
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // Pause polling while the tab is hidden (save Apps Script quota); refresh on return.
  document.addEventListener('visibilitychange', function () {
    if (!token) return;
    if (document.hidden) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } else if (!pollTimer) {
      poll();
      pollTimer = setInterval(poll, POLL_MS);
    }
  });

  // =========================================================================
  // Poll
  // =========================================================================
  function poll() {
    if (!token) return;
    liveInd.classList.add('polling');
    liveTxt.textContent = 'Mengemas kini…';
    apiPost('getLiveCases', {}, { token: token })
      .then(function (res) {
        if (!res || res.ok !== true) {
          if (res && res.error === 'unauthorized') {
            forceLogout('Sesi tamat. Sila log masuk semula.');
            return null;
          }
          throw new Error((res && res.error) || 'unknown_error');
        }
        lastData = res.data;
        var st = res.data.serverTime ? Date.parse(res.data.serverTime) : NaN;
        if (!isNaN(st)) clockOffset = st - Date.now();
        liveTxt.textContent = 'Langsung';
        ckAsOf.textContent = 'Dikemas kini ' + fmtClock(new Date());
        render();
        return null;
      })
      .catch(function () {
        liveTxt.textContent = 'Ralat sambungan';
      })
      .then(function () { liveInd.classList.remove('polling'); });
  }

  // =========================================================================
  // Render (on each poll)
  // =========================================================================
  function render() {
    if (!lastData) return;
    var cases = lastData.cases || [];
    ckCount.textContent = cases.length + (cases.length === 1 ? ' kes aktif' : ' kes aktif');

    renderOncall(lastData.oncall || []);
    renderExceptions(cases);
    if (view === 'urgency') renderUrgency(cases); else renderBoard(cases);
    refreshAll(); // populate countdowns immediately (no blank first second)
  }

  function renderOncall(list) {
    if (!list.length) {
      oncallList.className = 'oncall-empty';
      oncallList.textContent = 'Tiada maklumat bertugas (tetapkan lajur oncall dalam sheet Users).';
      return;
    }
    oncallList.className = '';
    oncallList.innerHTML = list.map(function (p) {
      return '<span class="oncall-chip">' + esc(p.name || '—') +
        (p.role ? '<span class="oc-role">' + esc(p.role) + '</span>' : '') + '</span>';
    }).join('');
  }

  function renderExceptions(cases) {
    excStrip.innerHTML = EXCEPTIONS.map(function (ex) {
      var ids = [];
      for (var i = 0; i < cases.length; i++) {
        var f = cases[i].flags || {};
        if (f[ex.key]) ids.push(cases[i].id);
      }
      var n = ids.length;
      var cls = n === 0 ? 'is-clear' : (ex.sev === 'hot' ? 'is-hot' : 'is-warn');
      var idsHtml = n ? '<div class="exc-ids">' + esc(ids.slice(0, 6).join(', ')) +
        (n > 6 ? ' +' + (n - 6) : '') + '</div>' : '';
      return '<div class="exc-card ' + cls + '">' +
        '<span class="exc-n">' + n + '</span>' +
        '<div><div class="exc-lbl">' + esc(ex.label) + '</div>' + idsHtml + '</div></div>';
    }).join('');
  }

  // ---- Urgency (countdown) view ----
  function renderUrgency(cases) {
    var effNow = Date.now() + clockOffset;
    var sorted = cases.slice().sort(function (a, b) { return urgency(a, effNow) - urgency(b, effNow); });
    if (!sorted.length) {
      caseList.innerHTML = '';
      emptyUrgency.classList.remove('ck-hidden');
      return;
    }
    emptyUrgency.classList.add('ck-hidden');
    caseList.innerHTML = sorted.map(function (c) { return caseCard(c, false); }).join('');
  }

  // ---- Pipeline board view ----
  function renderBoard(cases) {
    var buckets = {};
    PHASES.forEach(function (p) { buckets[p[0]] = []; });
    var extra = [];
    cases.forEach(function (c) {
      var key = normalizePhase(c.phase);
      if (buckets[key]) buckets[key].push(c); else extra.push(c);
    });
    var cols = PHASES.map(function (p) { return colHtml(p[1], buckets[p[0]]); });
    if (extra.length) cols.push(colHtml('Lain / Dalam proses', extra));
    board.innerHTML = cols.join('');
  }

  function colHtml(label, list) {
    var cards = list.length
      ? list.map(function (c) { return caseCard(c, true); }).join('')
      : '<div class="board-empty">—</div>';
    return '<div class="board-col"><h3>' + esc(label) +
      '<span class="col-n">' + list.length + '</span></h3>' + cards + '</div>';
  }

  // ---- Case card (shared) ----
  function caseCard(c, compact) {
    var todMs = Date.parse(c.timeOfDeath || '');
    if (isNaN(todMs)) todMs = 0;

    var windowsHtml = WINDOWS.map(function (w) {
      var srv = (c.windows && c.windows[w.key]) || {};
      var resolved = !!srv.resolved;
      return '<div class="win-row" data-limit="' + w.limitMin + '" data-resolved="' + (resolved ? 1 : 0) + '">' +
        '<span class="win-name">' + esc(w.name) + '</span>' +
        '<span class="win-track"><span class="win-fill"></span></span>' +
        '<span class="win-remain">—</span></div>';
    }).join('');

    var f = c.flags || {};
    var badges = [];
    if (f.unackEscalated) badges.push(['badge-hot', 'Belum diakui']);
    if (f.serologyOverdue) badges.push(['badge-hot', 'Serologi lewat']);
    if (f.exclAny) badges.push(['badge-warn', 'Pengecualian = Ya']);
    if (f.medicoLegal) badges.push(['badge-warn', 'Medico-legal']);
    var badgesHtml = badges.length ? '<div class="case-badges">' +
      badges.map(function (b) { return '<span class="badge ' + b[0] + '">' + esc(b[1]) + '</span>'; }).join('') +
      '</div>' : '';

    var coordHtml = compact ? '' : buildCoord(c.coordination || {});

    var bed = c.bed ? '<span class="case-bed">Katil ' + esc(c.bed) + '</span>' : '';
    var owner = c.owner ? ' · ' + esc(c.owner) : '';

    return '<div class="case-card" data-tod="' + todMs + '">' +
      '<div class="case-top"><span class="case-ward">' + esc(c.ward || '—') + '</span>' + bed +
      '<span class="case-id">' + esc(c.id || '') + '</span></div>' +
      '<div class="case-sub"><span class="case-phase">' + esc(phaseLabel(c)) + '</span> · ' +
      'Berlalu <span class="case-elapsed">—</span>' + owner + '</div>' +
      windowsHtml + badgesHtml + coordHtml + '</div>';
  }

  function buildCoord(coord) {
    var items = COORD.map(function (c) {
      var done = !!coord[c[0]];
      return '<span class="coord-item' + (done ? ' done' : '') + '">' +
        '<span class="tick">' + (done ? '✓' : '○') + '</span>' + esc(c[1]) + '</span>';
    }).join('');
    return '<div class="coord"><div class="coord-lbl">Kesediaan koordinasi</div>' +
      '<div class="coord-list">' + items + '</div>' +
      '<div class="coord-note">Status daripada rekod kes (baca sahaja).</div></div>';
  }

  // =========================================================================
  // Live tick — recompute countdowns + elapsed each second from time-of-death
  // =========================================================================
  function refreshAll() {
    var effNow = Date.now() + clockOffset;
    var pane = (view === 'urgency') ? paneUrgency : paneBoard;
    var cards = pane.querySelectorAll('.case-card');
    for (var i = 0; i < cards.length; i++) updateCard(cards[i], effNow);
  }

  function updateCard(card, effNow) {
    var tod = parseInt(card.getAttribute('data-tod'), 10) || 0;
    var hasTod = tod > 0;
    if (hasTod) {
      var elapsedMin = Math.floor((effNow - tod) / 60000);
      var e = card.querySelector('.case-elapsed');
      if (e) e.textContent = fmtDur(elapsedMin);
    }
    var rows = card.querySelectorAll('.win-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var resolved = row.getAttribute('data-resolved') === '1';
      var limit = parseInt(row.getAttribute('data-limit'), 10);
      // Continuous remaining (ms) so the bar drains smoothly each tick; the
      // readout stays in whole minutes.
      var remainMs = hasTod ? (limit * 60000 - (effNow - tod)) : null;
      applyWindow(row, limit, remainMs, resolved, hasTod);
    }
  }

  function applyWindow(row, limitMin, remainMs, resolved, hasTod) {
    row.className = 'win-row';
    var fill = row.querySelector('.win-fill');
    var rem = row.querySelector('.win-remain');
    if (resolved) { row.classList.add('win-done'); fill.style.width = '100%'; rem.textContent = 'Selesai'; return; }
    if (!hasTod) { row.classList.add('win-na'); fill.style.width = '100%'; rem.textContent = '—'; return; }
    var frac = remainMs / (limitMin * 60000);
    fill.style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
    var state = (remainMs <= 0 || frac < 0.25) ? 'win-hot' : (frac < 0.5 ? 'win-warn' : 'win-ok');
    row.classList.add(state);
    rem.textContent = fmtRemain(remainMs / 60000);
  }

  // Sort key: soonest-closing unresolved window (resolved/unknown sink to the end).
  function urgency(c, effNow) {
    var tod = Date.parse(c.timeOfDeath || '');
    if (isNaN(tod)) return 1e9;
    var elapsed = Math.floor((effNow - tod) / 60000);
    var min = 1e9;
    for (var i = 0; i < WINDOWS.length; i++) {
      var w = WINDOWS[i];
      var srv = (c.windows && c.windows[w.key]) || {};
      if (srv.resolved) continue;
      var remain = w.limitMin - elapsed;
      if (remain < min) min = remain;
    }
    return min;
  }

  // =========================================================================
  // View toggle
  // =========================================================================
  viewUrgencyBtn.addEventListener('click', function () { setView('urgency'); });
  viewBoardBtn.addEventListener('click', function () { setView('board'); });

  function setView(v) {
    if (v === view) return;
    view = v;
    var urg = v === 'urgency';
    viewUrgencyBtn.setAttribute('aria-pressed', urg ? 'true' : 'false');
    viewBoardBtn.setAttribute('aria-pressed', urg ? 'false' : 'true');
    paneUrgency.classList.toggle('ck-hidden', !urg);
    paneBoard.classList.toggle('ck-hidden', urg);
    if (lastData) { if (urg) renderUrgency(lastData.cases || []); else renderBoard(lastData.cases || []); refreshAll(); }
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  function phaseLabel(c) {
    var key = normalizePhase(c.phase);
    for (var i = 0; i < PHASES.length; i++) if (PHASES[i][0] === key) return PHASES[i][1];
    // Unknown phase: show the raw value so nothing is silently lost.
    return String(c.phase || c.status || '—');
  }

  function normalizePhase(p) {
    var s = String(p || '').trim().toUpperCase();
    if (s === '' || s === 'NEW' || s === 'BAHARU') return 'NEW';
    if (s === 'ACKNOWLEDGED' || s.indexOf('DIAKUI') >= 0 || s.indexOf('AKUI') >= 0) return 'ACKNOWLEDGED';
    if (s.indexOf('SEROLOG') >= 0) return 'SEROLOGI';
    if (s.indexOf('PERUNDANG') >= 0 || s.indexOf('PELEPASAN') >= 0) return 'PELEPASAN PERUNDANGAN';
    if (s.indexOf('PEROLEH') >= 0) return 'PEROLEHAN';
    if (s.indexOf('JENAZAH') >= 0 || s.indexOf('DIPULANG') >= 0) return 'JENAZAH DIPULANGKAN';
    return 'LAIN';
  }

  function fmtDur(mins) {
    mins = Math.max(0, Math.round(mins));
    if (mins < 60) return mins + 'm';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + 'j' + (m ? (' ' + m + 'm') : '');
  }
  function fmtRemain(mins) {
    if (mins <= 0) return 'LEWAT ' + fmtDur(-mins);
    return fmtDur(mins);
  }
  function fmtClock(d) {
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // =========================================================================
  // Boot — resume an in-session token if present
  // =========================================================================
  (function boot() {
    var saved = '';
    try { saved = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    if (saved) {
      token = saved;
      var name = '';
      try { name = sessionStorage.getItem(NAME_KEY) || ''; } catch (e) {}
      startSession(name);
    }
  })();
})();
