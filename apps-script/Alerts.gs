/**
 * Alerts.gs — sendAlert() fan-out (SPEC.md §5, §6.2).
 *
 * sendAlert(referral) fans out to channel senders that share ONE signature:
 *   sendEmail(referral, config), sendChat(referral, config), sendWhatsApp(referral, config)
 * so any channel is individually swappable.
 *
 * Phase 1a: sendEmail() is live. sendChat() and sendWhatsApp() are stubs with
 * the correct signature, wired for Phase 1b.
 *
 * Constraints:
 *   - Each channel is wrapped in its own try/catch — one dead channel must never
 *     block the others or fail the submission (§13.7).
 *   - The message is identifier-light: ward, bed, RN, time of death, elapsed,
 *     exclusion flags, referring-staff contact. NEVER patient name or IC (§6.2).
 */

var SEROLOGY_WINDOW_MIN = 240; // 4-hour golden window for serology blood

/**
 * Fan out one referral to every channel. Returns a per-channel result map.
 * Never throws — the submission already succeeded before this runs.
 */
function sendAlert(referral) {
  var config = getConfigMap_();
  var results = {};

  try { results.email = sendEmail(referral, config); }
  catch (e) { results.email = false; logAlertError_('email', referral.id, e); }

  try { results.chat = sendChat(referral, config); }
  catch (e) { results.chat = false; logAlertError_('chat', referral.id, e); }

  try { results.whatsapp = sendWhatsApp(referral, config); }
  catch (e) { results.whatsapp = false; logAlertError_('whatsapp', referral.id, e); }

  Logger.log('sendAlert(' + referral.id + ') results: ' + JSON.stringify(results));
  return results;
}

// ---------------------------------------------------------------------------
// Channel: Gmail (baseline, always on) — LIVE
// ---------------------------------------------------------------------------
function sendEmail(referral, config) {
  var to = String(config.alertEmails || '').trim();
  if (!to) {
    Logger.log('sendEmail: no alertEmails configured in Config sheet.');
    return false;
  }
  var msg = buildAlertMessage_(referral, config, false);
  MailApp.sendEmail({ to: to, subject: msg.subject, body: msg.body, name: 'T.O.P. Touch' });
  return true;
}

// ---------------------------------------------------------------------------
// Channel: Google Chat webhook (primary push) — STUB for Phase 1b
// Same signature as sendEmail. Implementation will be a UrlFetchApp.fetch()
// POST of a card/text to config.chatWebhookUrl.
// ---------------------------------------------------------------------------
function sendChat(referral, config) {
  var url = String(config.chatWebhookUrl || '').trim();
  if (!url) {
    Logger.log('sendChat: no chatWebhookUrl configured (Phase 1b).');
    return false;
  }
  Logger.log('sendChat: not implemented yet (Phase 1b).');
  return false;
}

// ---------------------------------------------------------------------------
// Channel: WhatsApp via CallMeBot (optional) — STUB for Phase 1b
// Same signature. Implementation will POST per-user CallMeBot keys from Users.
// NOTE for 1b: RN is a patient-mapping identifier; routing it through CallMeBot
// (a third-party relay) is the sharpest version of the identifier-leak concern —
// revisit before enabling.
// ---------------------------------------------------------------------------
function sendWhatsApp(referral, config) {
  Logger.log('sendWhatsApp: not implemented yet (Phase 1b).');
  return false;
}

// ---------------------------------------------------------------------------
// Message builder — shared by all channels. Identifier-light by construction:
// it only reads fields that exist on the alert payload, which never includes
// patientName or icNo.
// ---------------------------------------------------------------------------
function buildAlertMessage_(referral, config, isEscalation) {
  var tz = 'Asia/Kuala_Lumpur';
  var todText = (referral.timeOfDeath instanceof Date)
    ? Utilities.formatDate(referral.timeOfDeath, tz, 'dd/MM/yyyy HH:mm')
    : String(referral.timeOfDeath || '-');

  var t = computeSerology_(referral.timeOfDeath);
  var flags = buildExclusionSummary_(referral);
  var adminUrl = String(config.adminUrl || '').trim() || '(admin URL belum ditetapkan)';
  var prefix = isEscalation ? '⚠️ BELUM DIAKUI — ' : '';

  var subject = prefix + '🚨 RUJUKAN PENDERMA BERPOTENSI — ' +
    referral.ward + ' / Katil ' + referral.bed;

  var lines = [
    prefix + '🚨 RUJUKAN PENDERMA BERPOTENSI',
    'Wad: ' + referral.ward + ' | Katil: ' + referral.bed + ' | RN: ' + referral.rn,
    'Masa kematian: ' + todText,
    '⏳ ' + t.elapsedText + ' sejak kematian',
    '   Baki tempoh emas serologi (4 jam): ' + t.remainingText,
    '',
    'Skrin eksklusi: ' + flags,
    'Kad pledger: ' + (referral.pledgerCard || '-') +
      '  |  Keluarga: ' + (referral.familyApproached || '-'),
    '',
    'Hubungi: ' + referral.staffName + ' (' + referral.contactExt + ')',
    'ID Rujukan: ' + referral.id,
    'Buka app untuk akui: ' + adminUrl,
    '',
    '— T.O.P. Touch (mesej automatik. Tiada nama/IC pesakit dihantar atas sebab privasi.)'
  ];

  return { subject: subject, body: lines.join('\n') };
}

/** Elapsed since death and remaining serology window, as BM text. */
function computeSerology_(tod) {
  if (!(tod instanceof Date) || isNaN(tod.getTime())) {
    return { elapsedText: '-', remainingText: '-', overdue: false };
  }
  var elapsedMin = Math.floor((new Date().getTime() - tod.getTime()) / 60000);
  if (elapsedMin < 0) elapsedMin = 0; // guard future time-of-death
  var remainMin = SEROLOGY_WINDOW_MIN - elapsedMin;
  return {
    elapsedText: fmtDuration_(elapsedMin),
    remainingText: remainMin <= 0 ? 'TEMPOH TAMAT' : fmtDuration_(remainMin),
    overdue: remainMin <= 0
  };
}

function fmtDuration_(min) {
  var h = Math.floor(min / 60);
  var m = min % 60;
  return h > 0 ? (h + ' jam ' + m + ' minit') : (m + ' minit');
}

/**
 * Summarise the four exclusion flags. Any "Yes" is surfaced prominently — but
 * the app never rejects; final eligibility is the TOP team's call (§6.1).
 */
function buildExclusionSummary_(r) {
  var items = [
    ['Penyakit boleh jangkit / risiko tinggi', r.exclTransmissible],
    ['Malignansi', r.exclMalignancy],
    ['Sepsis', r.exclSepsis],
    ['Penyakit sistemik tak terkawal', r.exclSystemic]
  ];
  var yes = [];
  items.forEach(function (it) {
    var v = String(it[1]).toLowerCase();
    if (v === 'ya' || v === 'yes' || v === 'true') yes.push(it[0]);
  });
  if (!yes.length) return 'Tiada bendera (semua Tidak).';
  return '⚠️ BENDERA: ' + yes.join('; ') +
    '. Keputusan kelayakan akhir oleh TOP Team — rujukan TIDAK ditolak automatik.';
}

/** Log a channel failure and record it in AuditLog (identifier-light). */
function logAlertError_(channel, referralId, err) {
  Logger.log('Alert channel "' + channel + '" failed for ' + referralId + ': ' + err);
  appendAudit_('system', 'ALERT_FAIL:' + channel, referralId, String(err));
}

// ---------------------------------------------------------------------------
// Editor test helper — send a sample alert without writing a row.
// ---------------------------------------------------------------------------
function testSendAlert() {
  var referral = {
    id: 'REF-TEST-000',
    ward: 'Wad 7 (Bangunan Utama)',
    bed: '12',
    rn: 'RN123456',
    timeOfDeath: new Date(new Date().getTime() - 45 * 60000),
    exclTransmissible: 'Tidak',
    exclMalignancy: 'Ya',
    exclSepsis: 'Tidak',
    exclSystemic: 'Tidak',
    pledgerCard: 'Tidak pasti',
    familyApproached: 'Belum',
    staffName: 'Jururawat Siti (UJIAN)',
    contactExt: 'ext 2345'
  };
  Logger.log(JSON.stringify(sendAlert(referral)));
}
