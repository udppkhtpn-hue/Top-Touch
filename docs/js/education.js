/**
 * education.js — Pendidikan hub (Phase 3, SPEC §6.3).
 *
 * Flow: apiPost('getEducation') -> render the active modules (from the Education
 * sheet, ordered by sortOrder). Each module's Google Drive video loads ONLY when
 * the staff taps its poster — the iframe is never inserted up front, so opening the
 * page costs almost no mobile data. Training content only; no gate, no patient data.
 */
(function () {
  'use strict';

  var listEl = document.getElementById('eduList');
  var stateEl = document.getElementById('eduState');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function driveThumb(id) { return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1280'; }
  function driveEmbed(id) { return 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/preview'; }

  function videoAreaHtml(m) {
    if (m.driveFileId) {
      return '<div class="edu-video" data-file="' + esc(m.driveFileId) + '">' +
        '<button type="button" class="edu-poster" aria-label="Mainkan video: ' + esc(m.title) + '">' +
        '<img src="' + esc(driveThumb(m.driveFileId)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<span class="edu-play-badge"><span class="tri">&#9654;</span> Main video</span>' +
        '</button></div>' +
        '<div class="edu-note">Video Google Drive &middot; dimuatkan bila dikelik</div>';
    }
    return '<div class="edu-soon-box">Video akan dimuat naik tidak lama lagi</div>';
  }

  function moduleHtml(m, i) {
    var soonClass = m.driveFileId ? '' : ' is-soon';
    var cat = m.category ? '<p class="edu-cat">' + esc(m.category) + '</p>' : '';
    var desc = m.description ? '<p class="edu-desc">' + esc(m.description) + '</p>' : '';
    return '<article class="edu-module' + soonClass + '">' +
      '<div class="edu-head">' +
        '<div class="edu-num">' + pad2(i + 1) + '</div>' +
        '<div class="edu-titles">' + cat + '<h2 class="edu-title">' + esc(m.title) + '</h2></div>' +
      '</div>' +
      desc +
      videoAreaHtml(m) +
    '</article>';
  }

  // Click-to-load: swap the poster for the Drive iframe on tap (saves mobile data).
  listEl.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.edu-poster') : null;
    if (!btn) return;
    var box = btn.closest('.edu-video');
    var id = box && box.getAttribute('data-file');
    if (!id) return;
    box.innerHTML = '<iframe src="' + esc(driveEmbed(id)) +
      '" allow="autoplay; fullscreen" allowfullscreen title="Video pendidikan"></iframe>';
  });

  function render(modules) {
    if (!modules.length) {
      stateEl.textContent = 'Modul akan datang.';
      stateEl.style.display = '';
      listEl.innerHTML = '';
      return;
    }
    stateEl.style.display = 'none';
    listEl.innerHTML = modules.map(moduleHtml).join('');
  }

  apiPost('getEducation', {})
    .then(function (res) {
      if (!res || res.ok !== true) throw new Error((res && res.error) || 'error');
      render((res.data && res.data.modules) || []);
    })
    .catch(function () {
      stateEl.textContent = 'Ralat memuatkan modul. Semak sambungan dan cuba lagi.';
      stateEl.style.display = '';
    });
})();
