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
 *   - Per-case identity strip            — first name + MyKad-derived age/gender +
 *                                          first 6 of IC (or first 4 of passport /
 *                                          UNHCR). Built only from patientName + icNo.
 *   - "Respon" button per card           — the app's single status write; closes
 *                                          the case (status = RESPONDED) so it
 *                                          leaves the board. There is no phase
 *                                          board and no multi-step status lifecycle.
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
    { key: 'exclAny',         label: 'Kriteria pengecualian = Ya — menunggu semakan TOP', sev: 'warn' },
    { key: 'medicoLegal',     label: 'Kes perundangan (medico-legal) belum dilepaskan',   sev: 'warn' }
  ];


  // Phase labels for the case-phase pill. key -> Bahasa Melayu label. (Open cases
  // are all NEW now; the board that grouped by these phases has been retired.)
  var PHASES = [
    ['NEW',                   'Baharu'],
    ['ACKNOWLEDGED',          'Diakui'],
    ['SEROLOGI',              'Serologi'],
    ['PELEPASAN PERUNDANGAN', 'Pelepasan Perundangan'],
    ['PEROLEHAN',             'Perolehan'],
    ['JENAZAH DIPULANGKAN',   'Jenazah Dipulangkan']
  ];

  // Response decision-tree reason lists (rendered as radios in the Respon modal).
  // The stored value is the full Bahasa Melayu label, so the CSV export reads
  // directly. "Lain-lain" reveals a free-text field whose text is stored instead.
  var REFUSAL_REASONS = [
    'Keluarga tidak dapat menerima kematian',
    'Bertentangan dengan kepercayaan agama',
    'Keluarga tidak tahu hasrat si mati',
    'Tiada persetujuan / pendapat berbeza dalam kalangan ahli keluarga',
    'Takut jenazah dicederakan',
    'Bimbang pengebumian tertangguh',
    'Tidak mahu si mati menderita lagi',
    'Tidak dinyatakan',
    'Lain-lain'
  ];
  var NOT_DISCUSSED_REASONS = [
    'Tiada pelepasan daripada doktor utama',
    'Kakitangan tidak selesa untuk membuat permintaan',
    'Penderma tidak sesuai',
    'Tiada pelepasan perundangan (medico-legal)',
    'Tidak dapat menghubungi ahli keluarga'
  ];

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- State ----
  var token = '';
  var lastData = null;      // most recent getLiveCases payload
  var clockOffset = 0;      // serverTimeMs - clientNowMs, so countdowns match server
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
  var emptyUrgency = document.getElementById('emptyUrgency');
  var paneUrgency = document.getElementById('paneUrgency');
  // Case table + filters
  var caseTbody = document.getElementById('caseTbody');
  var fltSearch = document.getElementById('fltSearch');
  var fltWard = document.getElementById('fltWard');
  var fltSort = document.getElementById('fltSort');
  var fltExc = document.getElementById('fltExc');
  // Case detail pop-out
  var detailOverlay = document.getElementById('detailOverlay');
  var detailTitle = document.getElementById('detailTitle');
  var detailBody = document.getElementById('detailBody');
  var detailClose = document.getElementById('detailClose');
  var casesById = {};        // id -> case object, rebuilt each render (for tick + detail)

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

    apiPost('login', { username: username, pin: pin }, null, { retries: 2 })
      .then(function (res) {
        if (!res || res.ok !== true) {
          var lm = res && res.error === 'invalid_credentials'
            ? 'Nama pengguna atau PIN tidak sah.'
            : (res && res.error === 'too_many_attempts'
              ? 'Terlalu banyak cubaan. Sila tunggu seminit dan cuba lagi.'
              : 'Ralat pelayan. Cuba lagi.');
          throw new Error(lm);
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
    if (t) apiPost('logout', {}, { token: t }, { retries: 1 }).catch(function () {}); // best-effort
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
    apiPost('exportCsv', { from: from, to: to, status: status }, { token: token }, { retries: 2 })
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
    apiPost('getLiveCases', {}, { token: token }, { retries: 2 })
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
    renderTable();
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

  // ---- Filterable case table ----
  function hasAnyFlag(c) {
    var f = c.flags || {};
    return !!(f.unackEscalated || f.serologyOverdue || f.exclAny || f.medicoLegal);
  }
  function firstName(name) {
    var s = String(name || '').trim();
    return s ? s.split(/\s+/)[0] : '';
  }
  function dateMs(iso) { var t = Date.parse(iso || ''); return isNaN(t) ? 0 : t; }

  // Flag badge spans (shared by the table cell and the detail card).
  function flagBadges(f) {
    f = f || {};
    var badges = [];
    if (f.exclAny) badges.push(['badge-warn', 'Ada pengecualian']);
    if (f.medicoLegal) badges.push(['badge-warn', 'Medico-legal']);
    return badges.map(function (b) {
      return '<span class="badge ' + b[0] + '">' + esc(b[1]) + '</span>';
    }).join('');
  }

  // Status column cell: an unacknowledged case shows a blinking green Respon
  // button (the app's single status write); plus any flag badges. There is no
  // serology-result tracking, so no serology signal is shown.
  function statusCell(c) {
    var f = c.flags || {};
    var html = '';
    if (f.unackEscalated) {
      html += '<button type="button" class="btn-respond btn-respond--blink" data-id="' +
        esc(c.id || '') + '">Respon</button>';
    }
    html += flagBadges(f);
    return html;
  }

  // Rebuild the ward filter <option>s from the current cases, preserving selection.
  function populateWardFilter(cases) {
    var seen = {};
    cases.forEach(function (c) { if (c.ward) seen[c.ward] = 1; });
    var list = Object.keys(seen).sort();
    var cur = fltWard.value;
    var html = '<option value="">Semua wad</option>' +
      list.map(function (w) { return '<option value="' + esc(w) + '">' + esc(w) + '</option>'; }).join('');
    if (fltWard.innerHTML !== html) fltWard.innerHTML = html;
    fltWard.value = (list.indexOf(cur) >= 0) ? cur : '';
  }

  function rowHtml(c) {
    var bed = c.bed ? ' <span class="ct-bed">Katil ' + esc(c.bed) + '</span>' : '';
    return '<tr data-id="' + esc(c.id || '') + '">' +
      '<td class="ct-id">' + esc(c.id || '') + '</td>' +
      '<td><span class="ct-ward">' + esc(c.ward || '—') + '</span>' + bed + '</td>' +
      '<td>' + patientBits(c) + '</td>' +
      '<td class="ct-elapsed">—</td>' +
      '<td class="ct-urgency">—</td>' +
      '<td class="ct-flags ct-hide-sm">' + statusCell(c) + '</td>' +
      '</tr>';
  }

  // Render the table from lastData + the current filter controls. Called on each
  // poll (render) and whenever a filter changes (no refetch).
  function renderTable() {
    var cases = (lastData && lastData.cases) || [];
    casesById = {};
    cases.forEach(function (c) { casesById[c.id] = c; });

    populateWardFilter(cases);

    var q = (fltSearch.value || '').trim().toLowerCase();
    var wardF = fltWard.value || '';
    var excOnly = !!fltExc.checked;
    var effNow = Date.now() + clockOffset;

    var rows = cases.filter(function (c) {
      if (wardF && c.ward !== wardF) return false;
      if (excOnly && !hasAnyFlag(c)) return false;
      if (q) {
        var hay = (c.ward + ' ' + c.bed + ' ' + c.id + ' ' + firstName(c.patientName)).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    // Sort: 'latest' = newest referral first (by createdAt); default = urgency
    // (soonest-closing window first).
    var sortMode = fltSort ? fltSort.value : 'urgency';
    if (sortMode === 'latest') {
      rows.sort(function (a, b) { return dateMs(b.createdAt) - dateMs(a.createdAt); });
    } else {
      rows.sort(function (a, b) { return urgency(a, effNow) - urgency(b, effNow); });
    }

    if (!rows.length) {
      caseTbody.innerHTML = '';
      emptyUrgency.classList.remove('ck-hidden');
      emptyUrgency.textContent = cases.length
        ? 'Tiada kes sepadan dengan tapisan.'
        : 'Tiada kes aktif buat masa ini.';
      return;
    }
    emptyUrgency.classList.add('ck-hidden');
    caseTbody.innerHTML = rows.map(rowHtml).join('');
    refreshAll(); // fill elapsed/urgency immediately
  }

  // ---- Case card ----
  function caseCard(c) {
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

    var bhtml = flagBadges(c.flags);
    var badgesHtml = bhtml ? '<div class="case-badges">' + bhtml + '</div>' : '';

    var idHtml = patientBits(c);

    var bed = c.bed ? '<span class="case-bed">Katil ' + esc(c.bed) + '</span>' : '';
    var owner = c.owner ? ' · ' + esc(c.owner) : '';

    // The app's single status action: mark the case responded, which closes it
    // (server sets status = RESPONDED) so it drops off the live board on next poll.
    var respondHtml = '<div class="case-actions">' +
      '<button type="button" class="btn-respond" data-id="' + esc(c.id || '') + '">' +
      'Respon</button></div>';

    return '<div class="case-card" data-tod="' + todMs + '">' +
      '<div class="case-top"><span class="case-ward">' + esc(c.ward || '—') + '</span>' + bed +
      '<span class="case-id">' + esc(c.id || '') + '</span></div>' +
      idHtml +
      '<div class="case-sub"><span class="case-phase">' + esc(phaseLabel(c)) + '</span> · ' +
      'Berlalu <span class="case-elapsed">—</span>' + owner + '</div>' +
      windowsHtml + badgesHtml + respondHtml + '</div>';
  }

  // Patient identity strip, built ONLY from what the referral form actually
  // collects: patientName + icNo. Shows the first name; and from a 12-digit MyKad,
  // the derived age + gender + first 6 digits. A non-MyKad id (passport / UNHCR)
  // shows its first 4 characters only. Age, gender and race are NOT collected for
  // foreigners (and race is not collected for anyone) — so they are not shown.
  function patientBits(c) {
    var name = String(c.patientName || '').trim();
    var first = name ? name.split(/\s+/)[0] : '';
    var raw = String(c.icNo || '').trim();
    var digits = raw.replace(/\D/g, '');
    var parts = [];
    if (first) parts.push('<span class="pb-name">' + esc(first) + '</span>');
    if (digits.length === 12) {                 // MyKad: derive age + gender
      var yy = parseInt(digits.slice(0, 2), 10);
      var mm = parseInt(digits.slice(2, 4), 10);
      var dd = parseInt(digits.slice(4, 6), 10);
      var now = new Date(), nowY = now.getFullYear();
      var birthY = (2000 + yy) <= nowY ? 2000 + yy : 1900 + yy;
      var age = nowY - birthY;
      if ((now.getMonth() + 1) < mm || ((now.getMonth() + 1) === mm && now.getDate() < dd)) age--;
      var gender = (parseInt(digits.slice(11), 10) % 2 === 1) ? 'Lelaki' : 'Perempuan';
      if (age >= 0 && age < 130) parts.push('<span class="pb">' + age + ' tahun</span>');
      parts.push('<span class="pb">' + gender + '</span>');
      // First 6 (birthdate) shown; the rest masked — NNNNNN - XX - XXXX.
      parts.push('<span class="pb pb-id">' + esc(digits.slice(0, 6)) + ' - XX - XXXX</span>');
    } else if (raw) {                           // passport / UNHCR: first 4 shown, rest masked
      parts.push('<span class="pb pb-id">' + esc(raw.slice(0, 4).toUpperCase()) + ' - XXXX</span>');
    }
    if (!parts.length) return '';
    return '<div class="case-idbits">' + parts.join('<span class="pb-sep">·</span>') + '</div>';
  }

  // =========================================================================
  // Live tick — recompute countdowns + elapsed each second from time-of-death
  // =========================================================================
  function refreshAll() {
    var effNow = Date.now() + clockOffset;
    // Table rows: elapsed + soonest-window countdown.
    var trs = caseTbody.querySelectorAll('tr[data-id]');
    for (var i = 0; i < trs.length; i++) updateRow(trs[i], effNow);
    // The open detail pop-out's case card (full window bars).
    if (!detailOverlay.classList.contains('ck-hidden')) {
      var card = detailOverlay.querySelector('.case-card');
      if (card) updateCard(card, effNow);
    }
  }

  // Update one table row's elapsed + soonest-unresolved-window cells.
  function updateRow(tr, effNow) {
    var c = casesById[tr.getAttribute('data-id')];
    if (!c) return;
    var eCell = tr.querySelector('.ct-elapsed');
    var uCell = tr.querySelector('.ct-urgency');
    var tod = Date.parse(c.timeOfDeath || '');
    if (isNaN(tod)) {
      if (eCell) eCell.textContent = '—';
      if (uCell) { uCell.textContent = '—'; uCell.className = 'ct-urgency'; }
      return;
    }
    var elapsedMin = Math.floor((effNow - tod) / 60000);
    if (eCell) eCell.textContent = fmtDur(elapsedMin);

    var best = null; // soonest unresolved window
    for (var i = 0; i < WINDOWS.length; i++) {
      var w = WINDOWS[i];
      var srv = (c.windows && c.windows[w.key]) || {};
      if (srv.resolved) continue;
      var rem = w.limitMin - elapsedMin;
      if (best === null || rem < best.rem) best = { rem: rem, limit: w.limitMin, name: w.name };
    }
    uCell.className = 'ct-urgency';
    if (!best) { uCell.textContent = 'Selesai'; return; }
    var frac = best.rem / best.limit;
    var state = (best.rem <= 0 || frac < 0.25) ? 'win-hot' : (frac < 0.5 ? 'win-warn' : 'win-ok');
    uCell.classList.add(state);
    uCell.textContent = fmtRemain(best.rem) + ' · ' + best.name;
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
  // Filters — re-render the table (no refetch) as the controls change.
  // =========================================================================
  if (fltSearch) fltSearch.addEventListener('input', renderTable);
  if (fltWard) fltWard.addEventListener('change', renderTable);
  if (fltSort) fltSort.addEventListener('change', renderTable);
  if (fltExc) fltExc.addEventListener('change', renderTable);

  // =========================================================================
  // Case detail pop-out — full Rujuk Kes detail + live windows + Respon.
  // Opened by clicking a table row; its "Respon" button opens the decision-tree
  // modal below (which records the outcome and closes the case).
  // =========================================================================
  caseTbody.addEventListener('click', function (e) {
    // A Respon button in the Status column opens the decision-tree modal directly
    // (and must not also open the row's detail pop-out).
    var btn = e.target && e.target.closest ? e.target.closest('.btn-respond') : null;
    if (btn) {
      e.stopPropagation();
      var bid = btn.getAttribute('data-id');
      if (!bid) return;
      if (!token) { forceLogout('Sila log masuk semula.'); return; }
      openResp(bid);
      return;
    }
    var tr = e.target && e.target.closest ? e.target.closest('tr[data-id]') : null;
    if (!tr) return;
    var id = tr.getAttribute('data-id');
    if (id) openDetail(id);
  });

  function openDetail(id) {
    var c = casesById[id];
    if (!c) return;
    detailTitle.textContent = 'Kes ' + id;
    detailBody.innerHTML = caseCard(c) + detailInfoHtml(c);
    detailOverlay.classList.remove('ck-hidden');
    refreshAll(); // fill the card's countdowns immediately
  }

  function closeDetail() { detailOverlay.classList.add('ck-hidden'); }

  // Full referral detail (admin tier — token-gated + audited, so full name/IC
  // are shown here, as in the CSV export). Exclusion "Ya" answers are highlighted.
  function detailInfoHtml(c) {
    function esc2(v) { return esc(v == null || v === '' ? '—' : v); }
    function row(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc2(v) + '</dd>'; }
    function exl(k, v) {
      var cls = isAffirm(v) ? ' class="excl-yes"' : '';
      return '<dt>' + esc(k) + '</dt><dd' + cls + '>' + esc2(v) + '</dd>';
    }
    return '<div class="detail-section"><h3>Butiran Rujukan</h3><dl class="detail-grid">' +
      row('Nama pesakit', c.patientName) +
      row('No. KP / ID', c.icNo) +
      row('Wad', c.ward) +
      row('Katil', c.bed) +
      row('RN', c.rn) +
      row('Masa kematian', fmtDateTime(c.timeOfDeath)) +
      row('Masa dirujuk', fmtDateTime(c.createdAt)) +
      exl('Penyakit boleh dijangkiti', c.exclTransmissible) +
      exl('Malignansi (barah)', c.exclMalignancy) +
      exl('Sepsis', c.exclSepsis) +
      exl('Penyakit sistemik tidak terkawal', c.exclSystemic) +
      row('Kad pledger', c.pledgerCard) +
      row('Keluarga ditanya', c.familyApproached) +
      row('Kes medikolegal', c.medicoLegalRaw) +
      row('Staf merujuk', c.staffName) +
      row('Hubungan', c.contactExt) +
      row('Nota', c.notes) +
      '</dl></div>';
  }

  function isAffirm(v) {
    var s = String(v || '').trim().toLowerCase();
    return s === 'ya' || s === 'yes' || s === 'y' || s === 'sudah';
  }

  detailClose.addEventListener('click', closeDetail);
  detailOverlay.addEventListener('click', function (e) {
    if (e.target === detailOverlay) { closeDetail(); return; } // backdrop
    var btn = e.target && e.target.closest ? e.target.closest('.btn-respond') : null;
    if (btn) {
      var id = btn.getAttribute('data-id');
      if (!id) return;
      if (!token) { closeDetail(); forceLogout('Sila log masuk semula.'); return; }
      closeDetail();
      openResp(id); // hand off to the decision-tree modal
    }
  });

  // =========================================================================
  // Response decision-tree modal
  // =========================================================================
  var respOverlay = document.getElementById('respOverlay');
  var respForm = document.getElementById('respForm');
  var respTitle = document.getElementById('respTitle');
  var respErr = document.getElementById('respErr');
  var respSave = document.getElementById('respSave');
  var respSkip = document.getElementById('respSkip');
  var branchYa = document.getElementById('branchYa');
  var branchTidak = document.getElementById('branchTidak');
  var branchSetuju = document.getElementById('branchSetuju');
  var branchDecline = document.getElementById('branchDecline');
  var refusalList = document.getElementById('refusalList');
  var notDiscussedList = document.getElementById('notDiscussedList');
  var refusalOtherWrap = document.getElementById('refusalOtherWrap');
  var refusalOther = document.getElementById('refusalOther');
  var respCurrentId = '';

  // Render the two reason lists as radios (single source: the arrays above).
  function renderReasonRadios(container, name, reasons) {
    container.innerHTML = reasons.map(function (r, i) {
      return '<label class="resp-opt"><input type="radio" name="' + name + '" value="' +
        esc(r) + '"> ' + esc(r) + '</label>';
    }).join('');
  }
  renderReasonRadios(refusalList, 'refusal', REFUSAL_REASONS);
  renderReasonRadios(notDiscussedList, 'notDiscussed', NOT_DISCUSSED_REASONS);

  function openResp(id) {
    respCurrentId = id;
    respForm.reset();
    respErr.textContent = '';
    respSave.disabled = false; respSave.textContent = 'Simpan & tutup kes';
    respSkip.disabled = false;
    respTitle.textContent = 'Respons kes ' + id;
    syncBranches();
    respOverlay.classList.remove('ck-hidden');
    // Focus the first control for keyboard/screen-reader users.
    var first = respForm.querySelector('input[name="famDiscussed"]');
    if (first) first.focus();
  }

  function closeResp() {
    respOverlay.classList.add('ck-hidden');
    respCurrentId = '';
  }

  // Show only the branches that apply to the current selections.
  function syncBranches() {
    var fam = respForm.querySelector('input[name="famDiscussed"]:checked');
    var famVal = fam ? fam.value : '';
    branchYa.classList.toggle('ck-hidden', famVal !== 'Ya');
    branchTidak.classList.toggle('ck-hidden', famVal !== 'Tidak');

    var dec = respForm.querySelector('input[name="decision"]:checked');
    var decVal = (famVal === 'Ya' && dec) ? dec.value : '';
    branchSetuju.classList.toggle('ck-hidden', decVal !== 'Setuju');
    branchDecline.classList.toggle('ck-hidden', decVal !== 'Tidak bersetuju');

    var ref = respForm.querySelector('input[name="refusal"]:checked');
    var isOther = decVal === 'Tidak bersetuju' && ref && ref.value === 'Lain-lain';
    refusalOtherWrap.classList.toggle('ck-hidden', !isOther);
  }

  respForm.addEventListener('change', syncBranches);

  // Gather + validate the tree; returns { response } or throws with a message.
  function collectResponse() {
    var fam = respForm.querySelector('input[name="famDiscussed"]:checked');
    if (!fam) throw new Error('Sila pilih sama ada pendermaan dibincangkan dengan waris.');
    var out = { familyDiscussed: fam.value };

    if (fam.value === 'Ya') {
      var dec = respForm.querySelector('input[name="decision"]:checked');
      if (!dec) throw new Error('Sila pilih keputusan waris.');
      out.decision = dec.value;

      if (dec.value === 'Setuju') {
        var checks = respForm.querySelectorAll('input[name="tissue"]:checked');
        var tissues = { cornea: false, bone: false, skin: false, valve: false };
        for (var i = 0; i < checks.length; i++) tissues[checks[i].value] = true;
        out.tissues = tissues;
      } else { // Tidak bersetuju
        var ref = respForm.querySelector('input[name="refusal"]:checked');
        if (!ref) throw new Error('Sila pilih sebab tidak bersetuju.');
        if (ref.value === 'Lain-lain') {
          var other = refusalOther.value.trim();
          if (!other) throw new Error('Sila nyatakan sebab lain.');
          out.refusalReason = 'Lain-lain: ' + other;
        } else {
          out.refusalReason = ref.value;
        }
      }
    } else { // Tidak dibincangkan
      var nd = respForm.querySelector('input[name="notDiscussed"]:checked');
      if (!nd) throw new Error('Sila pilih sebab tidak dibincangkan.');
      out.notDiscussedReason = nd.value;
    }
    return out;
  }

  function submitResp(response) {
    if (!token) { closeResp(); forceLogout('Sila log masuk semula.'); return; }
    var id = respCurrentId;
    respSave.disabled = true; respSkip.disabled = true;
    respSave.textContent = 'Menyimpan…';
    var payload = { id: id };
    if (response) payload.response = response;
    apiPost('respondReferral', payload, { token: token }, { retries: 2 })
      .then(function (res) {
        if (!res || res.ok !== true) {
          if (res && res.error === 'unauthorized') { closeResp(); forceLogout('Sesi tamat. Sila log masuk semula.'); return; }
          throw new Error((res && res.error) || 'respond_error');
        }
        closeResp();
        poll(); // refetch; the closed case is gone from getLiveCases
      })
      .catch(function () {
        respSave.disabled = false; respSkip.disabled = false;
        respSave.textContent = 'Simpan & tutup kes';
        respErr.textContent = 'Ralat menutup kes. Cuba lagi.';
      });
  }

  respForm.addEventListener('submit', function (e) {
    e.preventDefault();
    respErr.textContent = '';
    var response;
    try { response = collectResponse(); }
    catch (err) { respErr.textContent = err.message; return; }
    submitResp(response);
  });

  respSkip.addEventListener('click', function () {
    if (!window.confirm('Tutup kes ' + respCurrentId + ' tanpa merekod keputusan? Ia akan keluar dari papan langsung.')) return;
    respErr.textContent = '';
    submitResp(null); // close-only, no decision-tree data
  });

  document.getElementById('respCancel').addEventListener('click', closeResp);
  document.getElementById('respClose').addEventListener('click', closeResp);
  respOverlay.addEventListener('click', function (e) {
    if (e.target === respOverlay) closeResp(); // click the backdrop
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // Close the topmost open overlay: the response form sits above the detail.
    if (!respOverlay.classList.contains('ck-hidden')) closeResp();
    else if (!detailOverlay.classList.contains('ck-hidden')) closeDetail();
  });

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
  // ISO string -> "YYYY-MM-DD HH:mm" in the viewer's local time (KL for the team).
  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
