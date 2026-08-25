/**
 * Alerts.gs — sendAlert() fan-out (SPEC.md §5, §6.2).
 *
 * sendAlert(referral) fans out to channel senders that share ONE signature:
 *   sendEmail(referral, config), sendChat(referral, config), sendWhatsApp(referral, config)
 * so any channel is individually swappable.
 *
 * Phase 1b: all three channels are live. Each stays INERT until configured, so
 * enabling one is a Config-sheet edit, never a code change or redeploy:
 *   - sendEmail    fires when Config `alertEmails` is set.
 *   - sendChat     fires when Config `chatWebhookUrl` is set (Google Chat space).
 *   - sendWhatsApp fires when Config `whatsappEnabled` = true AND at least one
 *                  on-call user has a CallMeBot key + number in the Users sheet.
 *
 * Constraints:
 *   - Each channel is wrapped in its own try/catch — one dead channel must never
 *     block the others or fail the submission (§13.7).
 *   - Alerts carry the FULL referral detail, incl. patient name + IC. This is a
 *     deliberate owner decision — the app is internal and staff-only, so the TOP
 *     team wants the whole form in the alert. (Amends the identifier-light rule
 *     in SPEC §6.2.)
 *   - CAUTION for WhatsApp: CallMeBot is a third-party relay, so enabling it
 *     sends those identifiers through an outside service. It is off by default
 *     (`whatsappEnabled`) and needs an explicit opt-in.
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
  var msg = buildAlertMessage_(referral, config, !!referral.isEscalation);
  MailApp.sendEmail({ to: to, subject: msg.subject, body: msg.body, name: 'T.O.P. Touch' });
  return true;
}

// ---------------------------------------------------------------------------
// Channel: Google Chat webhook (primary push) — LIVE
// POSTs the identifier-light message as text to a Chat space incoming webhook.
// Inert until config.chatWebhookUrl is set. Same signature as sendEmail.
// ---------------------------------------------------------------------------
function sendChat(referral, config) {
  var url = String(config.chatWebhookUrl || '').trim();
  if (!url) {
    Logger.log('sendChat: no chatWebhookUrl configured — channel off.');
    return false;
  }

  var msg = buildAlertMessage_(referral, config, !!referral.isEscalation);
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: msg.body }),
    muteHttpExceptions: true // inspect the code ourselves instead of throwing raw
  });

  var httpCode = res.getResponseCode();
  if (httpCode >= 200 && httpCode < 300) return true;

  // Non-2xx: throw so sendAlert's try/catch records it in AuditLog with detail.
  throw new Error('chat_webhook_http_' + httpCode + ': ' + res.getContentText());
}

// ---------------------------------------------------------------------------
// Channel: WhatsApp via CallMeBot (optional pilot) — LIVE, opt-in only
// Fans out to every on-call user that has a CallMeBot key + WhatsApp number.
// Two locks before anything is sent:
//   1. Config `whatsappEnabled` must be true (explicit opt-in), and
//   2. at least one on-call user must have a key + number.
// CAUTION: the message carries full detail (incl. name/IC) like the other
// channels, but CallMeBot is a THIRD-PARTY relay — enabling this sends those
// identifiers through an outside service. That is why it is opt-in and off by
// default. One bad number never blocks the others; this function handles its
// own errors and returns a boolean.
// ---------------------------------------------------------------------------
function sendWhatsApp(referral, config) {
  var enabled = String(config.whatsappEnabled || '').toLowerCase() === 'true';
  if (!enabled) {
    Logger.log('sendWhatsApp: disabled (Config whatsappEnabled != true).');
    return false;
  }

  var recipients = getWhatsAppRecipients_();
  if (!recipients.length) {
    Logger.log('sendWhatsApp: no on-call user has a CallMeBot key + number.');
    return false;
  }

  var text = buildWhatsAppText_(referral, config, !!referral.isEscalation);
  var sent = 0, failed = 0;
  recipients.forEach(function (u) {
    try {
      var apiUrl = 'https://api.callmebot.com/whatsapp.php'
        + '?phone=' + encodeURIComponent(u.whatsappNumber)
        + '&text=' + encodeURIComponent(text)
        + '&apikey=' + encodeURIComponent(u.callmebotKey);
      var res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
      var httpCode = res.getResponseCode();
      if (httpCode >= 200 && httpCode < 300) {
        sent++;
      } else {
        failed++;
        Logger.log('sendWhatsApp: ' + maskPhone_(u.whatsappNumber) + ' -> HTTP ' + httpCode);
      }
    } catch (e) {
      failed++;
      Logger.log('sendWhatsApp: ' + maskPhone_(u.whatsappNumber) + ' failed: ' + e);
    }
  });

  Logger.log('sendWhatsApp: sent=' + sent + ' failed=' + failed + ' of ' + recipients.length);
  return sent > 0;
}

/**
 * On-call users eligible for WhatsApp: oncall = Y AND a CallMeBot key AND a
 * WhatsApp number. Reads the Users sheet by header name so column order can
 * change without breaking this.
 */
function getWhatsAppRecipients_() {
  var values = getSheet_('Users').getDataRange().getValues();
  if (values.length < 2) return [];
  var idx = {};
  values[0].forEach(function (h, i) { idx[String(h)] = i; });

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var oncall = String(row[idx.oncall] || '').trim().toLowerCase();
    var num = String(row[idx.whatsappNumber] || '').trim();
    var key = String(row[idx.callmebotKey] || '').trim();
    var onCallYes = (oncall === 'y' || oncall === 'yes' || oncall === 'true');
    if (onCallYes && num && key) {
      out.push({ name: String(row[idx.name] || ''), whatsappNumber: num, callmebotKey: key });
    }
  }
  return out;
}

/** Mask a phone number for logs — never write a full staff number to a log. */
function maskPhone_(p) {
  p = String(p || '');
  return p.length <= 4 ? '****' : (p.slice(0, 3) + '****' + p.slice(-2));
}

// ---------------------------------------------------------------------------
// Message builder — shared by email + Chat. Carries the full referral detail,
// including patient name and IC (owner decision; internal staff-only tool).
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
    'Pesakit: ' + (referral.patientName || '-') + '  |  IC: ' + (referral.icNo || '-'),
    'Wad: ' + referral.ward + ' | Katil: ' + referral.bed + ' | RN: ' + referral.rn,
    'Masa kematian: ' + todText,
    '⏳ ' + t.elapsedText + ' sejak kematian',
    '   Baki tempoh emas serologi (4 jam): ' + t.remainingText,
    '',
    'Skrin eksklusi: ' + flags,
    'Kad pledger: ' + (referral.pledgerCard || '-') +
      '  |  Keluarga: ' + (referral.familyApproached || '-'),
    (referral.notes ? ('Nota: ' + referral.notes) : null),
    '',
    'Hubungi: ' + referral.staffName + ' (' + referral.contactExt + ')',
    'ID Rujukan: ' + referral.id,
    'Buka app untuk akui: ' + adminUrl,
    '',
    '— T.O.P. Touch (mesej automatik untuk kegunaan dalaman TOP Team.)'
  ].filter(function (l) { return l !== null; }); // drop the notes line when empty

  return { subject: subject, body: lines.join('\n') };
}

/**
 * WhatsApp message — carries the same full detail as email/Chat (incl. name/IC),
 * per the owner decision. NOTE: CallMeBot is a third-party relay, so this text
 * transits an outside service; the channel is opt-in and off by default.
 */
function buildWhatsAppText_(referral, config, isEscalation) {
  var tz = 'Asia/Kuala_Lumpur';
  var todText = (referral.timeOfDeath instanceof Date)
    ? Utilities.formatDate(referral.timeOfDeath, tz, 'dd/MM/yyyy HH:mm')
    : String(referral.timeOfDeath || '-');

  var t = computeSerology_(referral.timeOfDeath);
  var flags = buildExclusionSummary_(referral);
  var adminUrl = String(config.adminUrl || '').trim() || '(admin URL belum ditetapkan)';
  var prefix = isEscalation ? '⚠️ BELUM DIAKUI — ' : '';

  var lines = [
    prefix + '🚨 RUJUKAN PENDERMA BERPOTENSI',
    'Pesakit: ' + (referral.patientName || '-') + ' | IC: ' + (referral.icNo || '-'),
    'Wad: ' + referral.ward + ' | Katil: ' + referral.bed + ' | RN: ' + (referral.rn || '-'),
    'Masa kematian: ' + todText,
    '⏳ ' + t.elapsedText + ' sejak kematian (baki serologi: ' + t.remainingText + ')',
    'Eksklusi: ' + flags,
    (referral.notes ? ('Nota: ' + referral.notes) : null),
    'Hubungi: ' + referral.staffName + ' (' + referral.contactExt + ')',
    'ID: ' + referral.id,
    'Buka app: ' + adminUrl
  ].filter(function (l) { return l !== null; });
  return lines.join('\n');
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
// Editor test helpers — exercise a channel without writing a Referrals row.
// Run any of these from the Apps Script editor (Run > choose function) and read
// the execution log. A channel with nothing configured logs "off" and no-ops.
// ---------------------------------------------------------------------------

/** A representative sample referral (malignancy = Ya on purpose, to show a flag). */
function sampleReferral_() {
  return {
    id: 'REF-TEST-000',
    ward: 'Wad 7 (Bangunan Utama)',
    bed: '12',
    patientName: 'Ali Bin Abu (UJIAN)',
    icNo: '900101-01-1234',
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
}

/** Fire all channels at once (email + chat + whatsapp), same as a real submit. */
function testSendAlert() {
  Logger.log(JSON.stringify(sendAlert(sampleReferral_())));
}

/** Chat only — verifies the Config chatWebhookUrl posts to your Space. */
function testSendChat() {
  Logger.log('sendChat -> ' + sendChat(sampleReferral_(), getConfigMap_()));
}

/** WhatsApp only — needs whatsappEnabled = true and an on-call CallMeBot key. */
function testSendWhatsApp() {
  Logger.log('sendWhatsApp -> ' + sendWhatsApp(sampleReferral_(), getConfigMap_()));
}
