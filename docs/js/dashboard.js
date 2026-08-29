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
  var CAT_COLORS = [
    '#1B7A43', '#2f9e60', '#57b37e', '#cc7a00', '#c0392b',
    '#7a5195', '#3f7cac', '#bc5090', '#8a8d3b', '#5b6b62'
  ];

  // Death Audit Form refusal categories -> Bahasa Melayu display labels
  // (SPEC §6.5). Matching is case-insensitive; unknown reasons show verbatim.
  var REFUSAL_LABELS = {
    'family did not accept death': 'Keluarga tidak menerima kematian',
    'religious beliefs': 'Kepercayaan agama',
    "deceased's wishes unknown": 'Hasrat si mati tidak diketahui',
    'differing family opinion': 'Perbezaan pendapat keluarga',
    'concern about mutilation': 'Bimbang kecacatan jenazah',
    'funeral delay': 'Kelewatan pengebumian',
    'did not want deceased to suffer more': 'Tidak mahu si mati menderita lagi',
    '3rd party intervention': 'Campur tangan pihak ketiga',
    'not stated': 'Tidak dinyatakan',
    'others': 'Lain-lain'
  };
  function refusalLabel(r) {
    var k = String(r || '').trim().toLowerCase();
    return REFUSAL_LABELS[k] || String(r || '').trim() || 'Tidak dinyatakan';
  }

  // ---- DOM refs ----
  var gate = document.getElementById('gate');
  var gateInput = document.getElementById('dashCode');
  var gateBtn = document.getElementById('gateBtn');
  var gateErr = document.getElementById('gateErr');
  var dashboard = document.getElementById('dashboard');
  var cdnWarn = document.getElementById('cdnWarn');
  var fMonth = document.getElementById('fMonth');
  var fScope = document.getElementById('fScope');
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
    if (scope === 'all') return { from: '', to: '' };
    var now = new Date();
    if (scope === 'ytd') {
      var y = now.getFullYear();
      return { from: y + '-01-01', to: y + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) };
    }
    // month (default): use the month picker, or current month if empty
    var ym = fMonth.value || (now.getFullYear() + '-' + pad2(now.getMonth() + 1));
    var parts = ym.split('-');
    var yy = parseInt(parts[0], 10), mm = parseInt(parts[1], 10);
    var lastDay = new Date(yy, mm, 0).getDate();
    return { from: ym + '-01', to: ym + '-' + pad2(lastDay) };
  }

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

    // KPIs. A suppressed count comes back null -> show "<5" (0 stays 0).
    var v = data.volume || {};
    setText('kpiMonth', v.monthToDate == null ? '<5' : v.monthToDate);
    setText('kpiYtd', v.ytd == null ? '<5' : v.ytd);
    setHtml('kpiRefer', minutesTile(data.timeToReferMedianMin));
    setHtml('kpiAck', minutesTile(data.timeToAckMedianMin));

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
    renderFunnel(data.funnel || {});
    renderRefusal(data.refusalReasons || []);
    renderTissue(data.tissueYield || {});
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

  // ---- Conversion funnel (horizontal bar) ----
  function renderFunnel(f) {
    var stages = [
      ['Dirujuk', f.referred], ['Diakui', f.acknowledged],
      ['Keluarga didekati', f.familyApproached], ['Setuju', f.consented],
      ['Diperoleh', f.procured]
    ];
    var labels = stages.map(function (s) { return s[0]; });
    // A suppressed stage (<5) arrives as null; draw it as 0 so no small count is
    // shown, and say so — a 0 here may mean "<5 disekat", not a true zero.
    var anySuppressed = stages.some(function (s) { return s[1] === null; });
    var values = stages.map(function (s) { return s[1] == null ? 0 : s[1]; });
    setText('funnelNote', anySuppressed ? 'Peringkat dengan <5 kes disekat (dipapar sebagai 0).' : '');

    if (!hasChart) {
      return fallbackTable('chartFunnel', ['Peringkat', 'Bilangan'],
        stages.map(function (s) { return [s[0], s[1] == null ? 0 : s[1]]; }));
    }
    if (charts.chartFunnel) charts.chartFunnel.destroy();
    var ctx = freshCanvas('chartFunnel');
    charts.chartFunnel = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Bilangan', data: values,
          backgroundColor: labels.map(function (_, i) { return shade(i, labels.length); }),
          borderRadius: 6
        }]
      },
      options: baseOptions({ indexAxis: 'y' })
    });
  }

  // ---- Refusal reasons (doughnut) ----
  function renderRefusal(reasons) {
    var shown = reasons.filter(function (r) { return r.count !== null && r.count !== undefined && r.count > 0; });
    var suppressed = reasons.length - shown.length;

    setText('refusalNote', suppressed > 0
      ? suppressed + ' kategori lain disekat (<5).'
      : (shown.length ? '' : 'Tiada data keengganan bagi julat ini.'));

    var labels = shown.map(function (r) { return refusalLabel(r.reason); });
    var values = shown.map(function (r) { return r.count; });

    if (!hasChart) {
      return fallbackTable('chartRefusal', ['Sebab', 'Bilangan'],
        shown.map(function (r) { return [refusalLabel(r.reason), r.count]; }));
    }
    if (charts.chartRefusal) charts.chartRefusal.destroy();
    var ctx = freshCanvas('chartRefusal');
    charts.chartRefusal = new window.Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{ data: values, backgroundColor: CAT_COLORS.slice(0, labels.length), borderWidth: 0 }]
      },
      options: baseOptions({
        cutout: '58%',
        plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } }
      })
    });
  }

  // ---- Tissue yield (bar) ----
  function renderTissue(t) {
    var rows = [
      ['Kornea', t.cornea], ['Injap jantung', t.valve],
      ['Tulang', t.bone], ['Kulit', t.skin]
    ];
    var anySuppressed = rows.some(function (r) { return r[1] === null; });
    setText('tissueNote', anySuppressed ? 'Nilai <5 disekat (dipapar sebagai “<5”).' : '');

    var labels = rows.map(function (r) { return r[0]; });
    var values = rows.map(function (r) { return r[1] == null ? 0 : r[1]; });

    if (!hasChart) {
      return fallbackTable('chartTissue', ['Tisu', 'Bilangan'],
        rows.map(function (r) { return [r[0], num(r[1])]; }));
    }
    drawBar('chartTissue', labels, values, GREEN_DARK, 'Diperoleh');
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

  function shade(i, n) {
    // green gradient across the funnel stages
    var stops = [GREEN, '#2f9e60', GREEN_LIGHT, '#b7dcc6', '#d7ecdf'];
    return stops[Math.min(i, stops.length - 1)];
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

  // Default the month picker to the current month.
  (function initMonth() {
    var now = new Date();
    fMonth.value = now.getFullYear() + '-' + pad2(now.getMonth() + 1);
  })();
})();
