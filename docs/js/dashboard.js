/**
 * dashboard.js — Coded-tier analytics (SPEC §6.4, DASHBOARD_PLAN §1).
 *
 * Flow: shared-code gate -> apiPost('getDashboard', {from,to}, {code}) -> render.
 *
 * The server (Dashboard.gs getDashboard) is the single source of truth for
 * privacy: it aggregates, applies small-cell suppression (< smallCellThreshold),
 * and never returns a patient row. This file only *displays* numbers it is given;
 * it performs no re-identifying computation and builds no cross-tabs.
 *
 * Chart.js is self-hosted (docs/js/vendor/chart.umd.min.js), like the fonts, because
 * the hospital network blocks CDNs (see DASHBOARD_PLAN §5). If the library is ever
 * unavailable, every chart degrades to a plain data table so the numbers are still
 * readable.
 */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasChart = typeof window.Chart !== 'undefined';

  // The shared code, held in memory only for the session (never persisted).
  var currentCode = '';
  var charts = {}; // id -> Chart instance, so we can destroy before re-render

  // ---- Palette (concrete colours; Chart.js can't read CSS vars) ----
  var GREEN = '#1B7A43', GREEN_DARK = '#145c33', GREEN_LIGHT = '#8fc7a6';
  // ---- DOM refs ----
  var gate = document.getElementById('gate');
  var gateInput = document.getElementById('dashCode');
  var gateBtn = document.getElementById('gateBtn');
  var gateErr = document.getElementById('gateErr');
  var dashboard = document.getElementById('dashboard');
  var cdnWarn = document.getElementById('cdnWarn');
  var fMonth = document.getElementById('fMonth');
  var fScope = document.getElementById('fScope');
  var fYear = document.getElementById('fYear');
  var fWard = document.getElementById('fWard');
  var fMonthField = document.getElementById('fMonthField');
  var fYearField = document.getElementById('fYearField');
  var fApply = document.getElementById('fApply');
  var asOf = document.getElementById('asOf');

  // ---- Gate ----
  function setGateError(msg) { gateErr.textContent = msg || ''; }

  gate.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = gateInput.value.trim();
    if (!code) { setGateError('Sila masukkan kod.'); return; }
    setGateError('');
    gateBtn.disabled = true;
    gateBtn.textContent = 'Menyemak…';

    load(code, currentRange())
      .then(function (data) {
        currentCode = code;
        gate.classList.add('dash-hidden');
        dashboard.classList.remove('dash-hidden');
        if (!hasChart) cdnWarn.classList.remove('dash-hidden');
        render(data);
      })
      .catch(function (err) {
        setGateError(errMessage(err));
      })
      .then(function () {
        gateBtn.disabled = false;
        gateBtn.textContent = 'Lihat papan data';
      });
  });

  // ---- Filter ----
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function currentRange() {
    var scope = fScope.value;
    var ward = fWard ? fWard.value : '';
    if (scope === 'all') return { from: '', to: '', ward: ward };
    if (scope === 'year') {
      var yr = (fYear && fYear.value) || String(new Date().getFullYear());
      return { from: yr + '-01-01', to: yr + '-12-31', ward: ward };
    }
    // month (default): use the month picker, or current month if empty
    var now = new Date();
    var ym = fMonth.value || (now.getFullYear() + '-' + pad2(now.getMonth() + 1));
    var parts = ym.split('-');
    var yy = parseInt(parts[0], 10), mm = parseInt(parts[1], 10);
    var lastDay = new Date(yy, mm, 0).getDate();
    return { from: ym + '-01', to: ym + '-' + pad2(lastDay), ward: ward };
  }

  // Show only the field relevant to the chosen scope (month picker vs year list).
  function updateScopeFields() {
    var scope = fScope.value;
    if (fMonthField) fMonthField.style.display = (scope === 'month') ? '' : 'none';
    if (fYearField) fYearField.style.display = (scope === 'year') ? '' : 'none';
  }
  fScope.addEventListener('change', updateScopeFields);

  fApply.addEventListener('click', function () {
    if (!currentCode) return;
    fApply.disabled = true;
    var prev = fApply.textContent; fApply.textContent = 'Memuatkan…';
    load(currentCode, currentRange())
      .then(render)
      .catch(function (err) { alert(errMessage(err)); })
      .then(function () { fApply.disabled = false; fApply.textContent = prev; });
  });

  fMonth.addEventListener('change', function () { if (fScope.value !== 'month') fScope.value = 'month'; });

  // ---- Backend call ----
  function load(code, range) {
    var payload = {};
    if (range.from) payload.from = range.from;
    if (range.to) payload.to = range.to;
    if (range.ward) payload.ward = range.ward;
    return apiPost('getDashboard', payload, { code: code }).then(function (res) {
      if (!res || res.ok !== true) {
        var e = new Error((res && res.error) || 'unknown_error');
        e.code = res && res.error;
        throw e;
      }
      return res.data;
    });
  }

  function errMessage(err) {
    var c = err && err.code;
    if (c === 'invalid_code') return 'Kod tidak sah. Sila cuba lagi.';
    if (c === 'not_implemented') return 'Papan data belum diaktifkan di pelayan.';
    return 'Ralat sambungan. Semak rangkaian dan cuba lagi.';
  }

  // ---- Render ----
  function num(n) { return (n === null || n === undefined) ? '<5' : String(n); }

  function render(data) {
    // Threshold labels
    var th = (data.meta && data.meta.smallCellThreshold) || 5;
    setText('threshVal', th); setText('threshVal2', th); setText('threshVal3', th);

    // "As of"
    if (data.meta && data.meta.cachedAt) {
      asOf.textContent = 'Sehingga ' + formatStamp(data.meta.cachedAt);
    }

    // KPIs — all from ward-submission data. A suppressed count comes back null
    // -> show "<5" (0 stays 0).
    var v = data.volume || {};
    setText('kpiMonth', v.monthToDate == null ? '<5' : v.monthToDate);
    setText('kpiYtd', v.ytd == null ? '<5' : v.ytd);
    setHtml('kpiRefer', minutesTile(data.timeToReferMedianMin));
    setText('kpiPledge', data.pledgeCardCount == null ? '<5' : data.pledgeCardCount);
    setText('kpiFamily', data.familyApproachedCount == null ? '<5' : data.familyApproachedCount);

    // Range guard: when the whole filtered range is 1..threshold-1 referrals the
    // server suppresses every range-scoped figure. Show one notice instead of a
    // grid of blanked charts (the calendar KPIs above stay, already suppressed).
    var rs = !!(data.meta && data.meta.rangeSuppressed);
    var rangeNote = document.getElementById('rangeNote');
    var cardGrid = document.getElementById('cardGrid');
    if (rangeNote) rangeNote.classList.toggle('dash-hidden', !rs);
    if (cardGrid) cardGrid.classList.toggle('dash-hidden', rs);
    if (rs) return; // nothing range-scoped to draw

    renderWard(data.byWard || []);
    renderExcl(data.exclusionFlags || {});
  }

  function minutesTile(mins) {
    if (mins === null || mins === undefined) return '—';
    if (mins < 60) return mins + '<span class="unit">min</span>';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + '<span class="unit">j</span> ' + m + '<span class="unit">min</span>';
  }

  // ---- Ward volume (bar) ----
  function renderWard(byWard) {
    var shown = byWard.filter(function (w) { return w.count !== null && w.count !== undefined; });
    var suppressed = byWard.length - shown.length;
    shown.sort(function (a, b) { return b.count - a.count; });

    var labels = shown.map(function (w) { return w.ward; });
    var values = shown.map(function (w) { return w.count; });

    setText('wardNote', suppressed > 0
      ? suppressed + ' wad lain mempunyai <5 rujukan (disekat).'
      : '');

    if (!hasChart) {
      return fallbackTable('chartWard', ['Wad', 'Rujukan'],
        shown.map(function (w) { return [w.ward, w.count]; }));
    }
    drawBar('chartWard', labels, values, GREEN, 'Rujukan');
  }

  // ---- Exclusion-flag patterns (bar) ----
  // How often each of the 4 criteria was flagged on the referral form. A flag is
  // never a rejection — the final call is always the TOP team's (SPEC §6.1).
  function renderExcl(x) {
    var rows = [
      ['Berjangkit', x.transmissible], ['Malignansi', x.malignancy],
      ['Sepsis', x.sepsis], ['Sistemik', x.systemic]
    ];
    var anySuppressed = rows.some(function (r) { return r[1] === null; });
    setText('exclNote', anySuppressed
      ? 'Nilai <5 disekat (dipapar sebagai 0). Bendera hanya menanda — bukan penolakan.'
      : 'Bendera hanya menanda kes — keputusan akhir sentiasa pasukan TOP.');

    var labels = rows.map(function (r) { return r[0]; });
    var values = rows.map(function (r) { return r[1] == null ? 0 : r[1]; });

    if (!hasChart) {
      return fallbackTable('chartExcl', ['Kriteria', 'Ditanda'],
        rows.map(function (r) { return [r[0], num(r[1])]; }));
    }
    drawBar('chartExcl', labels, values, GREEN, 'Ditanda');
  }

  // ---- Chart helpers ----
  function baseOptions(extra) {
    var o = {
      responsive: true, maintainAspectRatio: false,
      animation: reduce ? false : { duration: 500 },
      plugins: { legend: { display: false } },
      scales: undefined
    };
    return Object.assign(o, extra || {});
  }

  function drawBar(id, labels, values, color, seriesLabel) {
    if (charts[id]) charts[id].destroy();
    var ctx = freshCanvas(id);
    charts[id] = new window.Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: seriesLabel, data: values, backgroundColor: color, borderRadius: 6 }] },
      options: baseOptions({
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      })
    });
  }

  // Replace a <canvas> with a fresh one (Chart needs a clean context on re-render).
  function freshCanvas(id) {
    var old = document.getElementById(id);
    var box = old.parentNode;
    var c = document.createElement('canvas');
    c.id = id;
    box.innerHTML = '';
    box.appendChild(c);
    return c.getContext('2d');
  }

  // Render a data table into a chart box (Chart.js fallback).
  function fallbackTable(id, headers, rows) {
    var canvas = document.getElementById(id);
    var box = canvas ? canvas.parentNode : document.getElementById(id + 'Box');
    if (!box) return;
    var html = '<table class="fallback-table"><thead><tr>' +
      headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
      }).join('') : '<tr><td colspan="' + headers.length + '">Tiada data.</td></tr>') +
      '</tbody></table>';
    box.style.height = 'auto';
    box.innerHTML = html;
  }

  // ---- Small utilities ----
  function setText(id, val) { var el = document.getElementById(id); if (el) el.textContent = String(val); }
  function setHtml(id, val) { var el = document.getElementById(id); if (el) el.innerHTML = val; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function formatStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString('ms-MY', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return d.toISOString().replace('T', ' ').slice(0, 16);
    }
  }

  // Default the month picker to the current month; populate the year + ward lists.
  (function initFilters() {
    var now = new Date(), y = now.getFullYear();
    fMonth.value = y + '-' + pad2(now.getMonth() + 1);

    if (fYear) {
      var yopts = '';
      for (var yr = y; yr >= y - 4; yr--) yopts += '<option value="' + yr + '">' + yr + '</option>';
      fYear.innerHTML = yopts;
    }

    // Ward list mirrors the referral form (config.js WARD_GROUPS), grouped by facility.
    if (fWard && typeof WARD_GROUPS !== 'undefined') {
      var html = '<option value="">Semua wad</option>';
      WARD_GROUPS.forEach(function (g) {
        html += '<optgroup label="' + esc(g.label) + '">';
        g.wards.forEach(function (w) { html += '<option value="' + esc(w) + '">' + esc(w) + '</option>'; });
        html += '</optgroup>';
      });
      fWard.innerHTML = html;
    }

    updateScopeFields();
  })();
})();
