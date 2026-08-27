/**
 * Dashboard.gs — Phase 4 read endpoints.
 *
 *   getDashboard(payload, code)  — Coded tier (dashboardCode gate).
 *       Aggregate-only statistics. STRUCTURALLY INCAPABLE of returning a
 *       patient row (SPEC §4 rule 2 / DASHBOARD_PLAN §1): it reads rows, computes
 *       numbers, and only ever puts numbers in the response. Small-cell
 *       suppression (< smallCellThreshold, default 5) is applied to every
 *       categorical breakdown, and NO cross-tab (ward × outcome × refusal reason)
 *       is ever built.
 *
 *   getLiveCases(token)          — Admin tier (session token gate).
 *       Open referrals with elapsed time + serology/cornea/musculoskeletal window
 *       status. Identifiers are allowed here (token-gated), and every view writes
 *       one AuditLog row (DASHBOARD_PLAN §2).
 *
 * JSON shapes mirror DASHBOARD_PLAN.md §4 (getDashboardPublic / getDashboardAdmin).
 * Shared helpers getSheet_, getConfigMap_, appendAudit_ live in Code.gs.
 */

// Clinical windows from time of death, in minutes (SPEC §1; DASHBOARD_PLAN §0).
var WINDOW_SEROLOGY_MIN = 240;   // blood for serology ≤ 4 h
var WINDOW_CORNEA_MIN   = 720;   // corneas ≤ 12 h
var WINDOW_MSK_MIN      = 1440;  // heart valve / skin / bone ≤ 24 h
var SEROLOGY_RESULT_OVERDUE_MIN = 60; // result expected back ~ 1 h after blood taken

// Statuses that mean a case is closed — excluded from the live cockpit.
var CLOSED_STATUSES = { PROCURED: 1, NOT_PROCEEDED: 1, ESCALATION_EXHAUSTED: 1, SELESAI: 1 };

var DASHBOARD_CACHE_SECONDS = 300; // ~5 min aggregate cache (SPEC §13.5)

// ===========================================================================
// TIER: Coded — getDashboard (aggregate-only, dashboardCode-gated)
// ===========================================================================

/**
 * @param {Object} payload  { from?:'yyyy-MM-dd', to?:'yyyy-MM-dd' } date filter
 * @param {string} code     shared dashboardCode (server-checked)
 * @return {Object} { ok:true, data:{...aggregates...} } | { ok:false, error }
 */
function getDashboard(payload, code) {
  payload = payload || {};
  var config = getConfigMap_();

  // 1. Gate: shared dashboard code. A blank configured code denies everyone.
  var expected = String(config.dashboardCode || '');
  if (expected === '' || String(code || '') !== expected) {
    return { ok: false, error: 'invalid_code' };
  }

  var threshold = parseInt(config.smallCellThreshold, 10);
  if (isNaN(threshold) || threshold < 1) threshold = 5;

  var from = payload.from ? String(payload.from) : '';
  var to = payload.to ? String(payload.to) : '';

  // 2. Serve from cache if present (aggregate only; safe to cache).
  var cache = CacheService.getScriptCache();
  var cacheKey = 'dash_v1_' + from + '_' + to + '_' + threshold;
  var cached = cache.get(cacheKey);
  if (cached) {
    return { ok: true, data: JSON.parse(cached) };
  }

  var data = computeDashboard_(from, to, threshold);
  cache.put(cacheKey, JSON.stringify(data), DASHBOARD_CACHE_SECONDS);
  return { ok: true, data: data };
}

/**
 * Reads the Referrals sheet ONCE and computes aggregates. Returns only numbers.
 * There is deliberately no code path that copies a row into the output.
 */
function computeDashboard_(from, to, threshold) {
  var tz = 'Asia/Kuala_Lumpur';
  var now = new Date();
  var values = getSheet_('Referrals').getDataRange().getValues();
  var idx = buildColIndex_(values[0]);

  var currentMonth = Utilities.formatDate(now, tz, 'yyyy-MM');
  var currentYear = Utilities.formatDate(now, tz, 'yyyy');

  var monthToDate = 0, ytd = 0;

  // Period accumulators (respect the from/to filter).
  var byWard = {};          // ward -> count
  var refusal = {};         // reason -> count
  var trend = {};           // 'yyyy-MM' -> count
  var referred = 0, acknowledged = 0, familyApproached = 0, consented = 0, procured = 0;
  var tissue = { cornea: 0, valve: 0, bone: 0, skin: 0 };
  var excl = { transmissible: 0, malignancy: 0, sepsis: 0, systemic: 0, proceededDespiteFlag: 0 };
  var referToMins = [];     // death -> referral, minutes
  var ackMins = [];         // referral -> acknowledge, minutes

  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var createdAt = asDate_(r[idx.createdAt]);
    if (!createdAt) continue;

    // Month/YTD reference figures are calendar-based, independent of the filter.
    if (Utilities.formatDate(createdAt, tz, 'yyyy-MM') === currentMonth) monthToDate++;
    if (Utilities.formatDate(createdAt, tz, 'yyyy') === currentYear) ytd++;

    // Apply the date-range filter for every other tile.
    var cd = Utilities.formatDate(createdAt, tz, 'yyyy-MM-dd');
    if (from && cd < from) continue;
    if (to && cd > to) continue;

    referred++;
    trend[Utilities.formatDate(createdAt, tz, 'yyyy-MM')] =
      (trend[Utilities.formatDate(createdAt, tz, 'yyyy-MM')] || 0) + 1;

    var ward = String(r[idx.ward] || '').trim();
    if (ward) byWard[ward] = (byWard[ward] || 0) + 1;

    // Time death -> referral.
    var tod = asDate_(r[idx.timeOfDeath]);
    if (tod) referToMins.push(minutesBetween_(createdAt, tod));

    // Funnel.
    var ackAt = asDate_(r[idx.acknowledgedAt]);
    if (ackAt) { acknowledged++; ackMins.push(minutesBetween_(ackAt, createdAt)); }
    if (asDate_(r[idx.familyApproachedAt]) || isAffirmative_(r[idx.familyApproached])) familyApproached++;
    if (asDate_(r[idx.consentedAt])) consented++;
    var status = String(r[idx.status] || '');
    if (status === 'PROCURED') procured++;

    // Refusal reasons — hospital-wide, one dimension only (never ward × reason).
    var reason = String(r[idx.refusalReason] || '').trim();
    if (reason) refusal[reason] = (refusal[reason] || 0) + 1;

    // Tissue yield.
    if (isAffirmative_(r[idx.tissueCornea])) tissue.cornea++;
    if (isAffirmative_(r[idx.tissueValve])) tissue.valve++;
    if (isAffirmative_(r[idx.tissueBone])) tissue.bone++;
    if (isAffirmative_(r[idx.tissueSkin])) tissue.skin++;

    // Exclusion-flag patterns.
    var t = isAffirmative_(r[idx.exclTransmissible]);
    var m = isAffirmative_(r[idx.exclMalignancy]);
    var s = isAffirmative_(r[idx.exclSepsis]);
    var y = isAffirmative_(r[idx.exclSystemic]);
    if (t) excl.transmissible++;
    if (m) excl.malignancy++;
    if (s) excl.sepsis++;
    if (y) excl.systemic++;
    if ((t || m || s || y) && status === 'PROCURED') excl.proceededDespiteFlag++;
  }

  return {
    // Volume / funnel / medians are hospital-wide, month-level top-line figures —
    // not single-case cells — so they are NOT small-cell suppressed.
    volume: {
      monthToDate: monthToDate,
      ytd: ytd,
      trend: objToSortedArray_(trend, 'month', 'count') // ascending by month key
    },
    // byWard is bare volume-per-ward: one dimension, suppressed below threshold.
    byWard: countMapToArray_(byWard, 'ward', threshold, true),
    timeToReferMedianMin: median_(referToMins),
    timeToAckMedianMin: median_(ackMins),
    funnel: {
      referred: referred,
      acknowledged: acknowledged,
      familyApproached: familyApproached,
      consented: consented,
      procured: procured
    },
    refusalReasons: countMapToArray_(refusal, 'reason', threshold, true),
    tissueYield: {
      cornea: suppressCount_(tissue.cornea, threshold),
      valve: suppressCount_(tissue.valve, threshold),
      bone: suppressCount_(tissue.bone, threshold),
      skin: suppressCount_(tissue.skin, threshold)
    },
    exclusionFlags: {
      transmissible: suppressCount_(excl.transmissible, threshold),
      malignancy: suppressCount_(excl.malignancy, threshold),
      sepsis: suppressCount_(excl.sepsis, threshold),
      systemic: suppressCount_(excl.systemic, threshold),
      proceededDespiteFlag: suppressCount_(excl.proceededDespiteFlag, threshold)
    },
    meta: {
      smallCellThreshold: threshold,
      cachedAt: toIso_(new Date())
    }
  };
}

// ===========================================================================
// TIER: Admin — getLiveCases (open cases + window status, token-gated)
// ===========================================================================

/**
 * @param {string} token  session token (validated against the Users sheet)
 * @return {Object} { ok:true, data:{ cases:[...] } } | { ok:false, error }
 */
function getLiveCases(token) {
  var user = validateToken_(token);
  if (!user) return { ok: false, error: 'unauthorized' };

  var config = getConfigMap_();
  var escalationMinutes = parseInt(config.escalationMinutes, 10);
  if (isNaN(escalationMinutes)) escalationMinutes = 15;

  var now = new Date();
  var values = getSheet_('Referrals').getDataRange().getValues();
  var idx = buildColIndex_(values[0]);

  var cases = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var status = String(r[idx.status] || '');
    if (CLOSED_STATUSES[status]) continue; // open cases only

    var tod = asDate_(r[idx.timeOfDeath]);
    var elapsedMin = tod ? minutesBetween_(now, tod) : null;

    var bloodTaken = asDate_(r[idx.bloodTakenAt]);
    var serologyResult = asDate_(r[idx.serologyResultAt]);
    var createdAt = asDate_(r[idx.createdAt]);

    var t = isAffirmative_(r[idx.exclTransmissible]);
    var m = isAffirmative_(r[idx.exclMalignancy]);
    var s = isAffirmative_(r[idx.exclSepsis]);
    var y = isAffirmative_(r[idx.exclSystemic]);

    var caseObj = {
      id: String(r[idx.id] || ''),
      ward: String(r[idx.ward] || ''),
      bed: String(r[idx.bed] || ''),
      patientName: String(r[idx.patientName] || ''),
      icNo: String(r[idx.icNo] || ''),
      timeOfDeath: tod ? toIso_(tod) : '',
      elapsedMin: elapsedMin,
      phase: String(r[idx.phase] || status),
      windows: {
        serology: windowStatus_(WINDOW_SEROLOGY_MIN, elapsedMin, bloodTaken !== null),
        cornea: windowStatus_(WINDOW_CORNEA_MIN, elapsedMin, isAffirmative_(r[idx.tissueCornea])),
        musculoskeletal: windowStatus_(WINDOW_MSK_MIN, elapsedMin,
          isAffirmative_(r[idx.tissueValve]) || isAffirmative_(r[idx.tissueBone]) || isAffirmative_(r[idx.tissueSkin]))
      },
      flags: {
        exclAny: t || m || s || y,
        medicoLegal: isAffirmative_(r[idx.medicoLegal]),
        serologyOverdue: bloodTaken !== null && serologyResult === null &&
          minutesBetween_(now, bloodTaken) > SEROLOGY_RESULT_OVERDUE_MIN,
        unackEscalated: status === 'NEW' && createdAt !== null &&
          minutesBetween_(now, createdAt) > escalationMinutes
      },
      acknowledgedBy: String(r[idx.acknowledgedBy] || ''),
      owner: String(r[idx.acknowledgedBy] || '')
    };
    cases.push(caseObj);
  }

  // Most-urgent-first: the soonest-closing unresolved window leads.
  cases.sort(function (a, b) { return urgencyKey_(a) - urgencyKey_(b); });

  // Audit one identifier-light row per view (DASHBOARD_PLAN §2).
  appendAudit_(user.username || 'admin', 'VIEW_LIVE_CASES', '', 'openCases=' + cases.length);

  return { ok: true, data: { cases: cases } };
}

/** Per-window status: {limitMin, remainingMin, resolved}. remainingMin may be negative (overdue). */
function windowStatus_(limitMin, elapsedMin, resolved) {
  if (resolved) return { limitMin: limitMin, remainingMin: null, resolved: true };
  return {
    limitMin: limitMin,
    remainingMin: (elapsedMin === null) ? null : (limitMin - elapsedMin),
    resolved: false
  };
}

/** Sort key: minimum remaining minutes across unresolved windows (resolved/unknown last). */
function urgencyKey_(c) {
  var mins = [];
  var keys = ['serology', 'cornea', 'musculoskeletal'];
  for (var i = 0; i < keys.length; i++) {
    var w = c.windows[keys[i]];
    if (w && !w.resolved && w.remainingMin !== null) mins.push(w.remainingMin);
  }
  if (!mins.length) return 1e9;
  return Math.min.apply(null, mins);
}

// ===========================================================================
// Token validation — PROVISIONAL.
// Token ISSUANCE (login) is Phase 2 and belongs in Auth.gs. This validator only
// READS the Users sheet's existing sessionToken/tokenExpiry columns, so the
// admin gate is enforceable now. When Auth.gs is built it should OWN this
// function; remove this copy then to avoid a duplicate definition.
// ===========================================================================
function validateToken_(token) {
  if (!token) return null;
  var values = getSheet_('Users').getDataRange().getValues();
  var idx = buildColIndex_(values[0]);
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (String(row[idx.sessionToken] || '') !== String(token)) continue;
    var exp = asDate_(row[idx.tokenExpiry]);
    if (!exp || exp.getTime() <= Date.now()) return null; // missing/expired
    return {
      username: String(row[idx.username] || ''),
      name: String(row[idx.name] || ''),
      role: String(row[idx.role] || '')
    };
  }
  return null;
}

// ===========================================================================
// Small shared helpers
// ===========================================================================

/** header row -> { headerName: columnIndex }. Robust to appended columns. */
function buildColIndex_(header) {
  var idx = {};
  for (var i = 0; i < header.length; i++) idx[String(header[i]).trim()] = i;
  return idx;
}

/** A cell -> Date or null. Accepts Date objects and parseable strings; '' -> null. */
function asDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (v === '' || v === null || v === undefined) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Whole minutes between two Dates (a - b). */
function minutesBetween_(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

/** Integer median, or null for an empty set. */
function median_(nums) {
  if (!nums.length) return null;
  var s = nums.slice().sort(function (x, y) { return x - y; });
  var mid = Math.floor(s.length / 2);
  var val = (s.length % 2) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(val);
}

/** Affirmative test — Malay + English (Ya/Yes/Y/Sudah/true/1). */
function isAffirmative_(v) {
  var s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return s === 'ya' || s === 'yes' || s === 'y' || s === 'sudah' || s === 'true' || s === '1';
}

/**
 * Small-cell rule for a scalar count: a positive count below the threshold is a
 * potential single-case figure and is suppressed to null. Zero is not
 * identifying and is kept as 0.
 */
function suppressCount_(n, threshold) {
  return (n > 0 && n < threshold) ? null : n;
}

/**
 * Turn a {key: count} map into a sorted array of one-dimensional breakdown items,
 * applying small-cell suppression. Suppressed items carry count:null + suppressed:true
 * (the shape used by byWard / refusalReasons in DASHBOARD_PLAN §4). This is a bare
 * one-dimensional breakdown — never a cross-tab.
 */
function countMapToArray_(map, keyName, threshold, sortDescByCount) {
  var out = [];
  Object.keys(map).forEach(function (k) {
    var n = map[k];
    var item = {};
    item[keyName] = k;
    if (n > 0 && n < threshold) {
      item.count = null;
      item.suppressed = true;
    } else {
      item.count = n;
    }
    // Keep the true count only for local sorting; strip before returning.
    item.__n = n;
    out.push(item);
  });
  if (sortDescByCount) out.sort(function (a, b) { return b.__n - a.__n; });
  out.forEach(function (item) { delete item.__n; });
  return out;
}

/** {key: count} -> [{[keyName]:key, [countName]:count}] sorted ascending by key. */
function objToSortedArray_(map, keyName, countName) {
  var keys = Object.keys(map).sort();
  return keys.map(function (k) {
    var o = {};
    o[keyName] = k;
    o[countName] = map[k];
    return o;
  });
}

/** Date -> ISO 8601 with the Asia/KL offset, e.g. 2026-08-27T12:00:00+08:00. */
function toIso_(d) {
  return Utilities.formatDate(d, 'Asia/Kuala_Lumpur', "yyyy-MM-dd'T'HH:mm:ssXXX");
}
