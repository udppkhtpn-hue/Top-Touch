/**
 * Alerts.gs — sendAlert() fan-out (SPEC.md §5, §6.2).
 *
 * sendAlert(referral) fans out to channel senders that share ONE signature:
 *   sendEmail(referral, config), sendChat(referral, config)
 * so any channel is individually swappable.
 *
 * Two channels, both inside MOH Workspace. Each stays INERT until configured, so
 * enabling one is a Config-sheet edit, never a code change or redeploy:
 *   - sendEmail  fires when Config `alertEmails` is set.
 *   - sendChat   fires when Config `chatWebhookUrl` is set (Google Chat space).
 *
 * (WhatsApp was evaluated and dropped: every route goes through Meta/CallMeBot,
 * i.e. outside MOH — a data-governance concern for patient detail. Email + Chat
 * keep everything in-Workspace, so both carry the FULL referral detail incl.
 * patient name + IC per owner decision, amending the identifier-light alert rule
 * in SPEC §6.2.)
 *
 * Constraints:
 *   - Each channel is wrapped in its own try/catch — one dead channel must never
 *     block the others or fail the submission (§13.7).
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

  try { results.telegram = sendTelegram(referral, config); }
  catch (e) { results.telegram = false; logAlertError_('telegram', referral.id, e); }

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
// Channel: Telegram bot (identifier-light nudge) — LIVE when configured.
// IMPORTANT: Telegram is a non-MOH third party (same category as the dropped
// WhatsApp). To keep patient data out of it, this message is DELIBERATELY
// identifier-light: NO patient name, NO IC, NO time of death — only ward, bed,
// the referring staff + contact, the referral ID, and a link to open the app.
// Full detail stays in-Workspace (email) and in the Sheet. Inert until BOTH
// telegramBotToken and telegramChatId are set in Config. Same signature as the
// other channels, so it is individually swappable.
// ---------------------------------------------------------------------------
function sendTelegram(referral, config) {
  var token = String(config.telegramBotToken || '').trim();
  var chatId = String(config.telegramChatId || '').trim();
  if (!token || !chatId) {
    Logger.log('sendTelegram: not configured (telegramBotToken/telegramChatId) — channel off.');
    return false;
  }

  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: chatId,
      text: buildTelegramNudge_(referral, config),
      disable_web_page_preview: true
    }),
    muteHttpExceptions: true // inspect the code ourselves instead of throwing raw
  });

  var httpCode = res.getResponseCode();
  if (httpCode >= 200 && httpCode < 300) return true;
  throw new Error('telegram_http_' + httpCode + ': ' + res.getContentText());
}

/**
 * Identifier-light Telegram text: ward + bed + referring staff/contact + referral
 * ID + a tap-through link. NO patient name / IC / time-of-death ever — that is the
 * whole point of routing this (and only this) through a third party.
 */
function buildTelegramNudge_(referral, config) {
  var prefix = referral.isEscalation ? '⚠️ BELUM DIAKUI — ' : '';
  var appUrl = String(config.adminUrl || '').trim();
  var lines = [
    prefix + '🚨 RUJUKAN PENDERMA BERPOTENSI',
    'Wad: ' + (referral.ward || '-') + ' | Katil: ' + (referral.bed || '-'),
    'Dirujuk oleh: ' + (referral.staffName || '-') +
      (referral.contactExt ? ' (' + referral.contactExt + ')' : ''),
    'ID rujukan: ' + (referral.id || '-'),
    appUrl ? ('Buka app: ' + appUrl) : null,
    '— T.O.P. Touch · tiada maklumat pesakit dihantar melalui Telegram'
  ].filter(function (l) { return l !== null; });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Message builder — shared by email + Chat. Carries the full referral detail,
// including patient name and IC (owner decision; internal staff-only tool).
// (Telegram does NOT use this — it uses buildTelegramNudge_ above.)
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

/** Fire all channels at once (email + chat), same as a real submit. */
function testSendAlert() {
  Logger.log(JSON.stringify(sendAlert(sampleReferral_())));
}

/** Chat only — verifies the Config chatWebhookUrl posts to your Space. */
function testSendChat() {
  Logger.log('sendChat -> ' + sendChat(sampleReferral_(), getConfigMap_()));
}

/** Telegram only — verifies the Config telegramBotToken/telegramChatId nudge posts. */
function testSendTelegram() {
  Logger.log('sendTelegram -> ' + sendTelegram(sampleReferral_(), getConfigMap_()));
}
