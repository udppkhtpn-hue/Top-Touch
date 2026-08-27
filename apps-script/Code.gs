/**
 * Code.gs — WiraTisu web app entry points + shared helpers.
 *
 * ONE web app URL, routed by `action` (SPEC.md §8). All requests are POST with
 * a text/plain JSON body: { action, token?, code?, payload }.
 * Responses are ContentService JSON: { ok:true, data } or { ok:false, error }.
 *
 * Phase 1a: only `submitReferral` is live. Every other action is present in the
 * router but returns not_implemented so the structure is visible.
 *
 * NOTE: constants SPREADSHEET_NAME, PROP_SPREADSHEET_ID, SHEETS and the helper
 * sha256Hex_() live in Setup.gs. Apps Script shares one global scope across all
 * .gs files, so they are available here.
 */

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/**
 * POST router. Never throws to the client — always returns JSON.
 */
function doPost(e) {
  try {
    var req = {};
    if (e && e.postData && e.postData.contents) {
      req = JSON.parse(e.postData.contents);
    }
    var action = req.action;
    var payload = req.payload || {};
    var token = req.token || '';
    var code = req.code || '';

    var result;
    switch (action) {
      // ---- Phase 1a: live ----
      case 'submitReferral':
        result = submitReferral(payload, code);
        break;

      // ---- Phase 4: dashboard reads (Dashboard.gs) ----
      // Aggregate-only, dashboardCode-gated. `getDashboardPublic` is the SPEC §8
      // name; `getDashboard` is the alias used by the frontend.
      case 'getDashboard':
      case 'getDashboardPublic':
        result = getDashboard(payload, code);
        break;
      // Open cases + window status, token-gated, audited. `getDashboardAdmin` is
      // the SPEC §8 name; `getLiveCases` is the alias used by the cockpit.
      case 'getLiveCases':
      case 'getDashboardAdmin':
        result = getLiveCases(token);
        break;

      // ---- Later phases: stubbed, signatures visible ----
      case 'getEducation':      // Phase 3
      case 'getConfigPublic':   // Phase 3 (must never leak codes)
      case 'login':             // Phase 2
      case 'listReferrals':     // Phase 2
      case 'updateReferral':    // Phase 2
      case 'exportCsv':         // Phase 4
      case 'manageEducation':   // Phase 3
      case 'manageUsers':       // Phase 2
        result = notImplemented_(action);
        break;

      default:
        result = { ok: false, error: 'unknown_action' };
    }
    return jsonOutput_(result);
  } catch (err) {
    // Router-level safety net. Patient data never reaches here.
    return jsonOutput_({ ok: false, error: 'server_error', detail: String(err) });
  }
}

/**
 * GET is a health check only — returns no config and no data. Handy for
 * confirming the deployment resolves in a browser.
 */
function doGet(e) {
  return jsonOutput_({
    ok: true,
    data: { service: 'WiraTisu', status: 'ok', time: new Date().toISOString() }
  });
}

// ---------------------------------------------------------------------------
// Shared helpers (used across handlers)
// ---------------------------------------------------------------------------

/** Wrap any object as a ContentService JSON response. */
function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Standard response for an action that exists but isn't built yet. */
function notImplemented_(action) {
  return { ok: false, error: 'not_implemented', action: action };
}

/** Open the database spreadsheet by the ID stored in Script Properties. */
function getDb_() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID);
  if (!id) {
    throw new Error('Database not initialized. Run initializeDatabase() first.');
  }
  return SpreadsheetApp.openById(id);
}

/** Get a sheet by name, throwing a clear error if it's missing. */
function getSheet_(name) {
  var sheet = getDb_().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet not found: ' + name + '. Re-run initializeDatabase().');
  }
  return sheet;
}

/** Read the Config sheet into a plain {key: value} map. */
function getConfigMap_() {
  var values = getSheet_('Config').getDataRange().getValues();
  var map = {};
  for (var i = 1; i < values.length; i++) { // skip header row
    var key = values[i][0];
    if (key !== '' && key !== null && key !== undefined) {
      map[String(key)] = values[i][1];
    }
  }
  return map;
}

/** Append an identifier-light row to AuditLog. Never pass name/IC in detail. */
function appendAudit_(actor, action, referralId, detail) {
  try {
    getSheet_('AuditLog').appendRow([new Date(), actor, action, referralId, detail || '']);
  } catch (e) {
    Logger.log('AuditLog append failed: ' + e);
  }
}
