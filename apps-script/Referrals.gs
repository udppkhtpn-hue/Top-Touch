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
 *   - Email + Chat alerts carry full referral detail incl. patientName / icNo
 *     (owner decision — internal staff-only tool; amends SPEC §6.2). Both channels
 *     stay inside MOH Workspace. Identifiers are still kept out of URLs, query
 *     strings and the confirmation screen.
 */

// Fields the server requires before it will write a row. IC format is validated
// leniently on the client; here we only insist the required fields are present,
// so a stressed user is never blocked by over-strict server validation.
var REQUIRED_REFERRAL_FIELDS = [
  'ward', 'bed', 'patientName', 'icNo', 'rn', 'timeOfDeath',
  'exclTransmissible', 'exclMalignancy', 'exclSepsis', 'exclSystemic',
  'pledgerCard', 'familyApproached', 'medicoLegal', 'staffName', 'contactExt'
];

/**
 * @param {Object} payload  referral fields from the form
 * @param {string} code     optional ward code (checked only if enabled)
 * @return {Object} { ok:true, data:{ referralId } } or { ok:false, error }
 */
function submitReferral(payload, code) {
  payload = payload || {};

  // 0a. Honeypot — abuse control for this deliberately-open endpoint.
  // The form carries a hidden `website` field that a human never sees or fills
  // (see refer.html). If it comes back non-empty the sender is a bot: silently
  // accept with a fake success so it never learns it was caught, and write NO
  // row and fire NO alert. A real referral always leaves this blank, so a
  // genuine submission is never affected (fails open for humans).
  if (String(payload.website || '').trim() !== '') {
    appendAudit_('system', 'SPAM_HONEYPOT', '', 'ward=' + String(payload.ward || ''));
    return { ok: true, data: { referralId: 'REF-00000000-000' } };
  }

  // 0b. Flood backstop — a per-minute ceiling far above any real clinical rate.
  // This form sees <50 referrals/month; 20/minute is astronomically above real
  // usage (even a mass-casualty surge), so only an automated flood can reach it.
  // FAILS OPEN on any cache error — a genuine referral is never blocked by infra.
  try {
    var rlCache = CacheService.getScriptCache();
    var rlBucket = 'rl_' + Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyyMMddHHmm');
    var rlCount = parseInt(rlCache.get(rlBucket) || '0', 10) + 1;
    rlCache.put(rlBucket, String(rlCount), 120); // 2-min TTL covers the 1-min bucket
    if (rlCount > 20) {
      appendAudit_('system', 'RATE_LIMITED', '', 'count=' + rlCount);
      return { ok: false, error: 'rate_limited' };
    }
  } catch (rlErr) { /* fail open — never block a referral on cache trouble */ }

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
      0,                                // escalationCount
      // --- Dashboard/cockpit columns (DASHBOARD_PLAN.md §3). ---
      // The form never sets these; the admin cockpit fills them in later. They
      // are written empty here ONLY to keep the row width aligned with the
      // header, so their column indices stay fixed. Order must match SHEETS
      // .Referrals in Setup.gs exactly.
      '',                               // bloodTakenAt
      '',                               // serologyResultAt
      payload.medicoLegal || '',        // medicoLegal (now set by the ward at referral)
      '',                               // teamAlertedOphthal
      '',                               // teamAlertedOrtho
      '',                               // teamAlertedPlastic
      '',                               // teamAlertedIJN
      '',                               // otAlerted
      '',                               // forensicsAlerted
      'NEW',                            // phase (mirrors status at creation)
      '',                               // tissueCornea
      '',                               // tissueValve
      '',                               // tissueBone
      '',                               // tissueSkin
      '',                               // familyApproachedAt
      '',                               // consentedAt
      '',                               // familyDiscussed    (admin response form)
      ''                                // notDiscussedReason (admin response form)
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
      patientName: payload.patientName, // email + Chat alerts include these
      icNo: payload.icNo,               // (owner decision; internal staff-only tool)
      rn: payload.rn,
      timeOfDeath: tod,
      exclTransmissible: payload.exclTransmissible,
      exclMalignancy: payload.exclMalignancy,
      exclSepsis: payload.exclSepsis,
      exclSystemic: payload.exclSystemic,
      pledgerCard: payload.pledgerCard,
      familyApproached: payload.familyApproached,
      medicoLegal: payload.medicoLegal,
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
 * respondReferral — an admin marks a live case as responded, closing it out of the
 * cockpit. This is the ONLY status write in the app. There is deliberately no
 * multi-step lifecycle: the ward creates a case as NEW, and when a TOP team member
 * goes to attend it they tap "Respons & tutup", which sets status = RESPONDED (a
 * CLOSED status, so getLiveCases drops it from the live board) and records who
 * responded and when. It replaces the old plan of hand-editing the Google Sheet.
 *
 * Admin-tier: token-gated and audited. It never touches the ward's ~60-second
 * submission path (that is submitReferral, above).
 *
 * Optionally carries the family-approach decision tree the TOP team records when
 * they attend a case (payload.response). The tree — and the columns each branch
 * writes — is:
 *
 *   familyDiscussed = 'Ya'
 *     outcome = 'Setuju'          -> tissueCornea/Bone/Skin/Valve = 'Ya' per checked;
 *                                    familyApproachedAt + consentedAt stamped now
 *     outcome = 'Tidak bersetuju' -> refusalReason = <one of 9>; familyApproachedAt stamped
 *   familyDiscussed = 'Tidak'
 *     notDiscussedReason = <one of 5>
 *
 * `response` is OPTIONAL: with no response object the case is simply closed
 * (the "Tutup tanpa data" path), exactly as before — so this stays backward
 * compatible. All writes are by column NAME via buildColIndex_, so they are
 * safe against appended columns.
 *
 * @param {Object} payload  { id: 'REF-YYYYMMDD-NNN', response?: {...} }
 * @param {string} token    admin session token (validated in Auth.gs)
 * @return {Object} { ok:true, data:{ id, status } } | { ok:false, error }
 */
function respondReferral(payload, token) {
  var user = validateToken_(token);
  if (!user) return { ok: false, error: 'unauthorized' };

  payload = payload || {};
  var id = String(payload.id || '').trim();
  if (!id) return { ok: false, error: 'missing_id' };
  var resp = payload.response || null;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_('Referrals');
    var values = sheet.getDataRange().getValues();
    var idx = buildColIndex_(values[0]); // shared helper (Dashboard.gs)

    var rowNum = -1; // 1-based sheet row
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][idx.id] || '').trim() === id) { rowNum = i + 1; break; }
    }
    if (rowNum === -1) return { ok: false, error: 'not_found' };

    sheet.getRange(rowNum, idx.status + 1).setValue('RESPONDED');
    sheet.getRange(rowNum, idx.phase + 1).setValue('RESPONDED');
    // Record who responded + when (reuses the acknowledged* columns; there is no
    // separate lifecycle step). Only stamp if not already set, so a re-tap is a no-op.
    if (!String(values[rowNum - 1][idx.acknowledgedBy] || '').trim()) {
      sheet.getRange(rowNum, idx.acknowledgedBy + 1).setValue(user.username || 'admin');
      sheet.getRange(rowNum, idx.acknowledgedAt + 1).setValue(new Date());
    }

    // Optional decision-tree data. Written by column name so appended columns are safe.
    if (resp) writeResponseTree_(sheet, rowNum, idx, resp);

    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  var auditDetail = 'status=RESPONDED';
  if (resp) {
    // Identifier-light audit: categorical outcome only, never patient data.
    auditDetail += '; familyDiscussed=' + String(resp.familyDiscussed || '');
    if (String(resp.familyDiscussed || '') === 'Ya') auditDetail += '; outcome=' + String(resp.decision || '');
  }
  appendAudit_(user.username || 'admin', 'RESPOND', id, auditDetail);
  return { ok: true, data: { id: id, status: 'RESPONDED' } };
}

/**
 * Write one row's family-approach decision tree. A helper so respondReferral
 * stays readable. Only sets a cell when idx has that column (defensive against a
 * sheet not yet migrated) and only writes the branch that applies, leaving the
 * other branch's columns untouched. Values are stored human-readable (Bahasa
 * Melayu) so the CSV export reads directly.
 */
function writeResponseTree_(sheet, rowNum, idx, resp) {
  function set(colName, val) {
    if (idx[colName] === undefined) return;
    sheet.getRange(rowNum, idx[colName] + 1).setValue(val);
  }

  var famDiscussed = String(resp.familyDiscussed || '').trim();
  set('familyDiscussed', famDiscussed);

  if (famDiscussed === 'Ya') {
    set('familyApproachedAt', new Date());
    var decision = String(resp.decision || '').trim();
    set('outcome', decision);

    if (decision === 'Setuju') {
      set('consentedAt', new Date());
      var t = resp.tissues || {};
      set('tissueCornea', t.cornea ? 'Ya' : '');
      set('tissueBone',   t.bone   ? 'Ya' : '');
      set('tissueSkin',   t.skin   ? 'Ya' : '');
      set('tissueValve',  t.valve  ? 'Ya' : '');
      set('refusalReason', ''); // clear any stale decline reason
    } else if (decision === 'Tidak bersetuju') {
      set('refusalReason', String(resp.refusalReason || '').trim());
    }
    set('notDiscussedReason', ''); // not applicable when discussed
  } else if (famDiscussed === 'Tidak') {
    set('notDiscussedReason', String(resp.notDiscussedReason || '').trim());
    // Not discussed -> no outcome / tissue / decline-reason.
    set('outcome', '');
    set('refusalReason', '');
  }
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
    medicoLegal: 'Tidak pasti',
    staffName: 'Jururawat Siti (UJIAN)',
    contactExt: 'ext 2345',
    notes: 'Ini adalah submission UJIAN — sila abaikan.'
  };
  var res = submitReferral(fake, '');
  Logger.log('testSubmitReferral result: ' + JSON.stringify(res));
  Logger.log('Check: (1) a NEW row in Referrals, (2) an alert email with the malignancy flag shown AND the patient name/IC included.');
}
