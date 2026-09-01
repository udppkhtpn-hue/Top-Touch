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
    if (isLocalVideo(v)) {
      // Self-hosted: auto-loads (showing a % progress) when it scrolls into view.
      return '<div class="edu-video" data-file="' + esc(v) + '" data-local="1"></div>';
    }
    // Google Drive fallback: tap-to-load poster + iframe player.
    return '<div class="edu-video" data-file="' + esc(v) + '" data-local="0">' +
      '<button type="button" class="edu-poster" aria-label="Mainkan video: ' + esc(m.title) + '">' +
      '<img src="' + esc(driveThumb(v)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
      '<span class="edu-play-badge"><span class="tri">&#9654;</span> Main video</span>' +
      '</button></div>';
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

  // Google Drive posters: tap to swap in the iframe player (self-hosted videos
  // auto-load instead — see setupLocalVideos below).
  listEl.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.edu-poster') : null;
    if (!btn) return;
    var box = btn.closest('.edu-video');
    var v = box && box.getAttribute('data-file');
    if (!v) return;
    box.innerHTML = '<iframe src="' + esc(driveEmbed(v)) +
      '" allow="autoplay; fullscreen" allowfullscreen title="Video pendidikan"></iframe>';
  });

  // Self-hosted videos auto-load once they scroll into view (module 1 is in view on
  // page load, so it starts immediately), showing a real download percentage.
  function setupLocalVideos() {
    var boxes = listEl.querySelectorAll('.edu-video[data-local="1"]');
    if (!boxes.length) return;
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < boxes.length; i++) mountLocalVideo(boxes[i]);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { io.unobserve(en.target); mountLocalVideo(en.target); }
      });
    }, { rootMargin: '250px' });
    for (var j = 0; j < boxes.length; j++) io.observe(boxes[j]);
  }

  function mountLocalVideo(box) {
    if (box.getAttribute('data-mounted') === '1') return;
    box.setAttribute('data-mounted', '1');
    var src = localSrc(box.getAttribute('data-file'));

    box.innerHTML =
      '<div class="edu-loading">' +
        '<div class="edu-loading-pct">0%</div>' +
        '<div class="edu-loading-lbl">Memuatkan video…</div>' +
        '<div class="edu-bar"><div class="edu-bar-fill"></div></div>' +
      '</div>';
    var pctEl = box.querySelector('.edu-loading-pct');
    var fillEl = box.querySelector('.edu-bar-fill');

    // Stream the file so we can show a real byte percentage, then play from memory.
    fetch(src).then(function (resp) {
      if (!resp.ok || !resp.body) throw new Error('no-stream');
      var total = parseInt(resp.headers.get('Content-Length'), 10) || 0;
      var received = 0, chunks = [];
      var reader = resp.body.getReader();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value); received += r.value.length;
          if (total > 0) {
            var p = Math.min(100, Math.round(received / total * 100));
            pctEl.textContent = p + '%';
            fillEl.style.width = p + '%';
          } else {
            pctEl.textContent = (received / 1048576).toFixed(1) + ' MB';
          }
          return pump();
        });
      }
      return pump().then(function () {
        var url = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
        box.innerHTML = '<video src="' + url + '" controls playsinline title="Video pendidikan"></video>';
      });
    }).catch(function () {
      // Older browser / stream failure: let the browser stream it directly (no %).
      box.innerHTML = '<video src="' + esc(src) + '" controls playsinline preload="auto" title="Video pendidikan"></video>';
    });
  }

  function render(modules) {
    if (!modules.length) {
      stateEl.textContent = 'Modul akan datang.';
      stateEl.style.display = '';
      listEl.innerHTML = '';
      return;
    }
    stateEl.style.display = 'none';
    listEl.innerHTML = modules.map(moduleHtml).join('');
    setupLocalVideos();
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
