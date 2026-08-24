/**
 * refer.js — referral form behaviour.
 * Motion budget: minimal. The only animation is the serology ring, which
 * carries information (SPEC.md §9.1).
 */
(function () {
  'use strict';

  // ---- Form background video (Logo A) — respect reduced motion ----------
  var bgVid = document.querySelector('.form-bg');
  if (bgVid) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      bgVid.removeAttribute('autoplay');
      bgVid.removeAttribute('loop');
      bgVid.pause(); // poster (logo.png) stays visible
    } else {
      var p = bgVid.play();
      if (p && p.catch) { p.catch(function () {}); }
    }
  }

  // ---- Build ward dropdown (grouped) + Lain-lain -------------------------
  var wardSelect = document.getElementById('ward');
  WARD_GROUPS.forEach(function (group) {
    var og = document.createElement('optgroup');
    og.label = group.label;
    group.wards.forEach(function (w) {
      var opt = document.createElement('option');
      opt.value = w; opt.textContent = w;
      og.appendChild(opt);
    });
    wardSelect.appendChild(og);
  });
  // Lain-lain catch-all at the very bottom
  var lainOpt = document.createElement('option');
  lainOpt.value = LAINLAIN_VALUE;
  lainOpt.textContent = 'Lain-lain (nyatakan)…';
  wardSelect.appendChild(lainOpt);

  var lainWrap = document.getElementById('lainlainWrap');
  var wardOther = document.getElementById('wardOther');
  wardSelect.addEventListener('change', function () {
    var isOther = wardSelect.value === LAINLAIN_VALUE;
    lainWrap.hidden = !isOther;
    if (isOther) { wardOther.focus(); }
  });

  // ---- Build segmented Yes/No controls -----------------------------------
  document.querySelectorAll('.segmented').forEach(function (seg) {
    var name = seg.getAttribute('data-name');
    var opts = (seg.getAttribute('data-options') || 'Ya,Tidak').split(',');
    opts.forEach(function (raw) {
      var val = raw.trim();
      var id = name + '_' + val.replace(/\s+/g, '_');
      var label = document.createElement('label');
      label.className = 'seg';
      label.innerHTML =
        '<input type="radio" name="' + name + '" value="' + val + '" id="' + id + '">' +
        '<span>' + val + '</span>';
      seg.appendChild(label);
    });
  });

  // ---- Default time of death = now (local / MYT) -------------------------
  var todInput = document.getElementById('timeOfDeath');
  function localNowValue() {
    var d = new Date();
    var pad = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  todInput.value = localNowValue();

  // ---- Serology ring -----------------------------------------------------
  var RING_R = 37;
  var RING_C = 2 * Math.PI * RING_R;
  var progCircle = document.querySelector('#serology .prog');
  var trackCircle = document.querySelector('#serology .track');
  [progCircle, trackCircle].forEach(function (c) {
    c.setAttribute('stroke-dasharray', RING_C.toFixed(2));
  });
  progCircle.setAttribute('stroke-dashoffset', '0');

  var seroBox = document.getElementById('serology');
  var ringPct = document.getElementById('ringPct');
  var seroElapsed = document.getElementById('seroElapsed');
  var seroRemain = document.getElementById('seroRemain');

  function fmtDur(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? (h + ' jam ' + m + ' minit') : (m + ' minit');
  }
  function fmtClock(min) {
    if (min <= 0) return 'TAMAT';
    min = Math.floor(min); // whole minutes only, else "59.13" slices to "13"
    var h = Math.floor(min / 60), m = min % 60;
    return h + ':' + ('0' + m).slice(-2);
  }

  function updateSerology() {
    var val = todInput.value;
    if (!val) {
      seroBox.setAttribute('data-state', 'ok');
      ringPct.textContent = '4:00';
      seroElapsed.textContent = '— sejak kematian';
      seroRemain.textContent = 'Baki: —';
      progCircle.setAttribute('stroke-dashoffset', '0');
      return;
    }
    var tod = new Date(val);
    var elapsedMin = (Date.now() - tod.getTime()) / 60000;

    if (elapsedMin < 0) { // time of death in the future
      seroBox.setAttribute('data-state', 'ok');
      ringPct.textContent = '4:00';
      seroElapsed.textContent = 'Masa kematian pada masa hadapan?';
      seroRemain.textContent = 'Baki: 4 jam 0 minit';
      progCircle.setAttribute('stroke-dashoffset', '0');
      return;
    }

    var remainMin = SEROLOGY_WINDOW_MIN - elapsedMin;
    var fraction = Math.max(0, Math.min(1, remainMin / SEROLOGY_WINDOW_MIN));
    progCircle.setAttribute('stroke-dashoffset', (RING_C * (1 - fraction)).toFixed(2));

    seroElapsed.textContent = fmtDur(elapsedMin) + ' sejak kematian';

    if (remainMin <= 0) {
      seroBox.setAttribute('data-state', 'over');
      ringPct.textContent = 'TAMAT';
      seroRemain.textContent = 'Baki serologi: TEMPOH TAMAT';
    } else {
      var remainWhole = Math.floor(remainMin); // ring and text must agree
      seroBox.setAttribute('data-state', remainWhole <= 60 ? 'warn' : 'ok');
      ringPct.textContent = fmtClock(remainWhole);
      seroRemain.textContent = 'Baki: ' + fmtDur(remainWhole);
    }
  }
  todInput.addEventListener('input', updateSerology);
  updateSerology();
  setInterval(updateSerology, 1000); // ticks the countdown

  // ---- Submit ------------------------------------------------------------
  var form = document.getElementById('referForm');
  var submitBtn = document.getElementById('submitBtn');
  var errorBanner = document.getElementById('errorBanner');
  var formView = document.getElementById('formView');
  var confirmView = document.getElementById('confirmView');

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.hidden = false;
    errorBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function clearError() { errorBanner.hidden = true; errorBanner.textContent = ''; }

  function segValue(name) {
    var checked = form.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : '';
  }

  var ERROR_MESSAGES = {
    missing_fields: 'Sila lengkapkan semua ruangan bertanda *.',
    invalid_ward_code: 'Kod wad tidak sah.',
    server_error: 'Ralat pelayan. Sila cuba lagi.',
    unknown_action: 'Ralat sistem. Sila hubungi TOP Team.'
  };

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();

    // Resolve ward (handle Lain-lain).
    var wardVal = wardSelect.value;
    if (wardVal === LAINLAIN_VALUE) {
      wardVal = wardOther.value.trim();
    }

    var payload = {
      ward: wardVal,
      bed: document.getElementById('bed').value.trim(),
      patientName: document.getElementById('patientName').value.trim(),
      icNo: document.getElementById('icNo').value.trim(),
      rn: document.getElementById('rn').value.trim(),
      timeOfDeath: todInput.value,
      exclTransmissible: segValue('exclTransmissible'),
      exclMalignancy: segValue('exclMalignancy'),
      exclSepsis: segValue('exclSepsis'),
      exclSystemic: segValue('exclSystemic'),
      pledgerCard: segValue('pledgerCard'),
      familyApproached: segValue('familyApproached'),
      staffName: document.getElementById('staffName').value.trim(),
      contactExt: document.getElementById('contactExt').value.trim(),
      notes: document.getElementById('notes').value.trim()
    };

    // Client-side required check (mirrors server). IC format is NOT enforced.
    var required = ['ward', 'bed', 'patientName', 'icNo', 'rn', 'timeOfDeath',
      'exclTransmissible', 'exclMalignancy', 'exclSepsis', 'exclSystemic',
      'pledgerCard', 'familyApproached', 'staffName', 'contactExt'];
    var missing = required.filter(function (k) { return !payload[k]; });
    if (missing.length) {
      showError('Sila lengkapkan semua ruangan bertanda * (' + missing.length + ' belum diisi).');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Menghantar…';

    apiPost('submitReferral', payload, { code: '' })
      .then(function (res) {
        if (res && res.ok) {
          document.getElementById('confirmRefId').textContent = res.data.referralId;
          formView.hidden = true;
          confirmView.hidden = false;
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          var msg = (res && ERROR_MESSAGES[res.error]) || 'Rujukan gagal dihantar. Sila cuba lagi.';
          showError(msg);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Hantar Rujukan';
        }
      })
      .catch(function (err) {
        showError('Rangkaian bermasalah. Rujukan belum dihantar — sila cuba lagi. (' + err.message + ')');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Hantar Rujukan';
      });
  });

  // "Rujuk Kes Lain" — reset for another referral.
  document.getElementById('anotherBtn').addEventListener('click', function () {
    form.reset();
    lainWrap.hidden = true;
    todInput.value = localNowValue();
    updateSerology();
    confirmView.hidden = true;
    formView.hidden = false;
    clearError();
    submitBtn.disabled = false;
    submitBtn.textContent = 'Hantar Rujukan';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
