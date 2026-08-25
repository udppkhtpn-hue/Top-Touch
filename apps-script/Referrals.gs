/**
 * Referrals.gs — create a referral, then fire alerts.
 *
 * Hard rules enforced here (SPEC.md §11, §13, Acceptance §12):
 *   - The row is written FIRST and always, even if every alert fails (§13.7).
 *   - ID generation + append run inside LockService so concurrent submissions
 *     never collide on the sequential ID (§13.3).
 *   - The app NEVER auto-rejects. An exclusion = Yes still submits; the flag is
 *     surfaced in the alert, not used to block (§6.1).
 *   - The response carries ONLY the referral ID — no patient data (§4, §12).
 *   - Alerts DO carry full referral detail incl. patientName / icNo. Deliberate
 *     owner decision: this is an internal, staff-only tool, so the TOP team wants
 *     the complete form in the alert. (Amends the identifier-light alert rule in
 *     SPEC §6.2.) Identifiers are still kept out of URLs, query strings and the
 *     confirmation screen.
 */

// Fields the server requires before it will write a row. IC format is validated
// leniently on the client; here we only insist the required fields are present,
// so a stressed user is never blocked by over-strict server validation.
var REQUIRED_REFERRAL_FIELDS = [
  'ward', 'bed', 'patientName', 'icNo', 'rn', 'timeOfDeath',
  'exclTransmissible', 'exclMalignancy', 'exclSepsis', 'exclSystemic',
  'pledgerCard', 'familyApproached', 'staffName', 'contactExt'
];

/**
 * @param {Object} payload  referral fields from the form
 * @param {string} code     optional ward code (checked only if enabled)
 * @return {Object} { ok:true, data:{ referralId } } or { ok:false, error }
 */
function submitReferral(payload, code) {
  payload = payload || {};

  // 1. Required-field check.
  var missing = [];
  REQUIRED_REFERRAL_FIELDS.forEach(function (f) {
    var v = payload[f];
    if (v === undefined || v === null || String(v).trim() === '') missing.push(f);
  });
  if (missing.length) {
    return { ok: false, error: 'missing_fields', fields: missing };
  }

  // 2. Optional ward-code gate (server-side; off by default).
  var config = getConfigMap_();
  var wardCodeEnabled = String(config.wardCodeEnabled).toLowerCase() === 'true';
  if (wardCodeEnabled) {
    var expected = String(config.wardCode || '');
    if (String(code || '') !== expected || expected === '') {
      return { ok: false, error: 'invalid_ward_code' };
    }
  }

  // 3. Write the row under a script lock so the sequential ID can't collide.
  var tod = parseDateSafe_(payload.timeOfDeath);
  var referralId;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // up to 30s; concurrent submits queue here
  try {
    var sheet = getSheet_('Referrals');
    referralId = generateReferralId_(sheet);

    var row = [
      referralId,                       // id
      new Date(),                       // createdAt
      payload.ward,                     // ward
      payload.bed,                      // bed
      payload.patientName,              // patientName  (stored, never alerted)
      payload.icNo,                     // icNo         (stored, never alerted)
      payload.rn,                       // rn
      tod,                              // timeOfDeath
      payload.exclTransmissible,        // exclTransmissible
      payload.exclMalignancy,           // exclMalignancy
      payload.exclSepsis,               // exclSepsis
      payload.exclSystemic,             // exclSystemic
      payload.pledgerCard,              // pledgerCard
      payload.familyApproached,         // familyApproached
      payload.staffName,                // staffName
      payload.contactExt,               // contactExt
      payload.notes || '',              // notes
      'NEW',                            // status
      '',                               // acknowledgedBy
      '',                               // acknowledgedAt
      '',                               // outcome
      '',                               // refusalReason
      0                                 // escalationCount
    ];
    sheet.appendRow(row);
    SpreadsheetApp.flush(); // guarantee the write lands before releasing the lock
  } finally {
    lock.releaseLock();
  }

  // Audit — identifier-light (no name/IC).
  appendAudit_(payload.staffName || 'ward', 'SUBMIT', referralId, 'ward=' + payload.ward + '; status=NEW');

  // 4. Fire alerts AFTER the row is safely written and the lock released.
  //    A total alert failure must not fail the submission (§13.7), so this is
  //    wrapped; sendAlert() also guards each channel individually.
  try {
    var referral = {
      id: referralId,
      ward: payload.ward,
      bed: payload.bed,
      patientName: payload.patientName, // included in alerts by owner decision —
      icNo: payload.icNo,               // internal staff-only tool (see note below)
      rn: payload.rn,
      timeOfDeath: tod,
      exclTransmissible: payload.exclTransmissible,
      exclMalignancy: payload.exclMalignancy,
      exclSepsis: payload.exclSepsis,
      exclSystemic: payload.exclSystemic,
      pledgerCard: payload.pledgerCard,
      familyApproached: payload.familyApproached,
      staffName: payload.staffName,
      contactExt: payload.contactExt,
      notes: payload.notes || ''
    };
    sendAlert(referral);
  } catch (alertErr) {
    Logger.log('sendAlert failed (submission still succeeded): ' + alertErr);
    appendAudit_('system', 'ALERT_FAIL:all', referralId, String(alertErr));
  }

  // 5. Confirmation carries the ID only.
  return { ok: true, data: { referralId: referralId } };
}

/**
 * Build the next sequential ID: REF-YYYYMMDD-NNN (per-day, Asia/KL, zero-padded).
 * Must be called inside the script lock. Scans the id column — cheap at this
 * volume (<50/month).
 */
function generateReferralId_(sheet) {
  var tz = 'Asia/Kuala_Lumpur';
  var datePart = Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
  var prefix = 'REF-' + datePart + '-';

  var maxSeq = 0;
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var v = String(ids[i][0] || '');
      if (v.indexOf(prefix) === 0) {
        var seq = parseInt(v.substring(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    }
  }
  var next = maxSeq + 1;
  return prefix + ('000' + next).slice(-3);
}

/** Parse a datetime-local string to a Date (Asia/KL local). Falls back to raw. */
function parseDateSafe_(s) {
  if (!s) return '';
  var d = new Date(s);
  return isNaN(d.getTime()) ? s : d;
}

// ---------------------------------------------------------------------------
// Editor test helper — run this from the Apps Script editor to exercise the
// whole pipe (row write + email) WITHOUT the frontend. Uses fake data.
// ---------------------------------------------------------------------------
function testSubmitReferral() {
  var deathMinutesAgo = 45;
  var tod = Utilities.formatDate(
    new Date(new Date().getTime() - deathMinutesAgo * 60000),
    'Asia/Kuala_Lumpur', "yyyy-MM-dd'T'HH:mm"
  );
  var fake = {
    ward: 'Wad 7 (Bangunan Utama)',
    bed: '12',
    patientName: 'Ali Bin Abu (UJIAN)',
    icNo: '900101-01-1234',
    rn: 'RN123456',
    timeOfDeath: tod,
    exclTransmissible: 'Tidak',
    exclMalignancy: 'Ya',        // deliberately Yes -> should surface as a flag, NOT block
    exclSepsis: 'Tidak',
    exclSystemic: 'Tidak',
    pledgerCard: 'Tidak pasti',
    familyApproached: 'Belum',
    staffName: 'Jururawat Siti (UJIAN)',
    contactExt: 'ext 2345',
    notes: 'Ini adalah submission UJIAN — sila abaikan.'
  };
  var res = submitReferral(fake, '');
  Logger.log('testSubmitReferral result: ' + JSON.stringify(res));
  Logger.log('Check: (1) a NEW row in Referrals, (2) an alert email with the malignancy flag shown AND the patient name/IC included.');
}
