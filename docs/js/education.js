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

  // A self-hosted video is a filename/path (e.g. "Modul-1.mp4"); anything else is a
  // Google Drive file id. Self-hosted plays in the phone's native <video> player
  // (its controls auto-hide during playback); Drive plays in Google's iframe player.
  function isLocalVideo(v) { return /\.(mp4|webm|ogg|mov|m4v)$/i.test(v) || v.indexOf('/') >= 0; }
  function localSrc(v) { return (v.indexOf('/') >= 0) ? v : 'video/' + v; }

  function videoAreaHtml(m) {
    var v = m.driveFileId;
    if (!v) return '<div class="edu-soon-box">Video akan dimuat naik tidak lama lagi</div>';
    var local = isLocalVideo(v);
    var posterImg = local ? '' :
      '<img src="' + esc(driveThumb(v)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
    var note = local ? 'Video &middot; dimuatkan bila dikelik' : 'Video Google Drive &middot; dimuatkan bila dikelik';
    return '<div class="edu-video" data-file="' + esc(v) + '" data-local="' + (local ? '1' : '0') + '">' +
      '<button type="button" class="edu-poster" aria-label="Mainkan video: ' + esc(m.title) + '">' +
      posterImg +
      '<span class="edu-play-badge"><span class="tri">&#9654;</span> Main video</span>' +
      '</button></div>' +
      '<div class="edu-note">' + note + '</div>';
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
    var v = box && box.getAttribute('data-file');
    if (!v) return;
    if (box.getAttribute('data-local') === '1') {
      // Native player — controls auto-hide during playback; plays inline (portrait).
      box.innerHTML = '<video src="' + esc(localSrc(v)) + '" controls playsinline autoplay ' +
        'preload="metadata" title="Video pendidikan"></video>';
    } else {
      box.innerHTML = '<iframe src="' + esc(driveEmbed(v)) +
        '" allow="autoplay; fullscreen" allowfullscreen title="Video pendidikan"></iframe>';
    }
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
