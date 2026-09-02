/**
 * modul.js — standalone single-module video page (e.g. modul-2.html).
 *
 * Mounts the self-hosted portrait video in #modVideo (its `data-file` is a path
 * under /docs, e.g. "video/Modul-2.mp4"). Streams the file so a real download %
 * shows, then plays it from memory — no API call (the page is just one fixed
 * video). Loads on page open, since the video is the page's whole purpose.
 */
(function () {
  'use strict';

  var box = document.getElementById('modVideo');
  if (!box) return;
  var src = box.getAttribute('data-file');
  if (!src) return;

  function mount() {
    if (box.getAttribute('data-mounted') === '1') return;
    box.setAttribute('data-mounted', '1');

    box.innerHTML =
      '<div class="edu-loading">' +
        '<div class="edu-loading-pct">0%</div>' +
        '<div class="edu-loading-lbl">Memuatkan video…</div>' +
        '<div class="edu-bar"><div class="edu-bar-fill"></div></div>' +
      '</div>';
    var pctEl = box.querySelector('.edu-loading-pct');
    var fillEl = box.querySelector('.edu-bar-fill');

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
      box.innerHTML = '<video src="' + src + '" controls playsinline preload="auto" title="Video pendidikan"></video>';
    });
  }

  // The video is the whole point of this page, so load it straight away.
  mount();
})();
