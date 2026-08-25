/**
 * Setup.gs — WiraTisu one-time database bootstrap.
 *
 * Run initializeDatabase() ONCE from the Apps Script editor. It:
 *   1. Creates a standalone spreadsheet named TOP_App_Database
 *   2. Stores its ID in Script Properties (SPREADSHEET_ID) so the web app
 *      is NOT container-bound — every other .gs file opens the sheet by this ID
 *   3. Builds all 5 sheets with the exact headers from SPEC.md §7
 *   4. Seeds a default admin user (PIN hashed SHA-256 + per-user salt)
 *   5. Seeds sample Config rows
 *
 * Idempotent: if SPREADSHEET_ID already exists it will NOT create a second
 * spreadsheet — it logs the existing URL and stops. To rebuild from scratch,
 * run resetDatabasePointer() first (this only clears the pointer; it never
 * deletes your data).
 */

// ---------------------------------------------------------------------------
// Schema — single source of truth for sheet names and headers (SPEC.md §7)
// ---------------------------------------------------------------------------
var SPREADSHEET_NAME = 'TOP_App_Database';
var PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';

var SHEETS = {
  Referrals: [
    'id', 'createdAt', 'ward', 'bed', 'patientName', 'icNo', 'rn', 'timeOfDeath',
    'exclTransmissible', 'exclMalignancy', 'exclSepsis', 'exclSystemic',
    'pledgerCard', 'familyApproached', 'staffName', 'contactExt', 'notes',
    'status', 'acknowledgedBy', 'acknowledgedAt', 'outcome', 'refusalReason',
    'escalationCount'
  ],
  Users: [
    'username', 'pinHash', 'salt', 'name', 'role', 'oncall',
    'whatsappNumber', 'callmebotKey', 'sessionToken', 'tokenExpiry'
  ],
  Education: [
    'id', 'title', 'description', 'type', 'driveFileId', 'category',
    'sortOrder', 'active'
  ],
  AuditLog: [
    'timestamp', 'actor', 'action', 'referralId', 'detail'
  ],
  Config: [
    'key', 'value'
  ]
};

// ---------------------------------------------------------------------------
// Default admin credentials — CHANGE THE PIN after first login (Phase 2).
// Auth is not built until Phase 2; this row just seeds the schema so the
// Users sheet is not empty and the hashing scheme is demonstrable.
// ---------------------------------------------------------------------------
var DEFAULT_ADMIN = {
  username: 'admin',
  pin: '1234',           // <-- change this after Phase 2 auth is live
  name: 'TOP Admin',
  role: 'admin',
  oncall: 'Y'
};

// ---------------------------------------------------------------------------
// Sample Config (SPEC.md §7 key/value). Edit these values in the sheet later
// WITHOUT redeploying the web app.
//   - wardList     : REPLACE with the real ward list before go-live.
//   - alertEmails  : who receives the Gmail baseline alert (comma-separated).
//   - wardCodeEnabled : 'false' = no code required on the form (recommended).
//   - chatWebhookUrl : Google Chat space webhook; left blank = Chat channel off.
// ---------------------------------------------------------------------------
var DEFAULT_CONFIG = [
  // key                value
  ['wardList',          'Wad 1 (Bangunan Utama), Wad 2 (Bangunan Utama), Wad 3 (Bangunan Utama), Wad 4 (Bangunan Utama), Wad 5 (Bangunan Utama), Wad 6 (Bangunan Utama), Wad 7 (Bangunan Utama), Wad 8 (Bangunan Utama), ICU (Bangunan Utama), PICU (WCC), SCN (WCC), NICU (WCC), ICU (WCC), Wad 6A (WCC), Wad 6B (WCC), Wad 7A (WCC), Wad 7B (WCC), Wad 8A (WCC), Wad 8B (WCC), Wad 9A (WCC), Jabatan Kecemasan (ED), Forensik / Mortuari'],
  ['escalationMinutes', '15'],
  ['maxEscalations',    '3'],
  ['adminUrl',          ''],                       // fill with .../admin.html after Pages is live
  ['dashboardCode',     'TOPDASH'],               // change before dashboard go-live (Phase 4)
  ['wardCode',          ''],                       // set a code only if wardCodeEnabled = true
  ['wardCodeEnabled',   'false'],                  // off by default
  ['chatWebhookUrl',    ''],                        // Google Chat space incoming-webhook URL (blank = channel off)
  ['alertEmails',       ''],                          // set this in the Config sheet (kept out of the public repo)
  ['alertProvider',     'email']                    // Phase 1a baseline channel
];

/**
 * ONE-TIME bootstrap. Safe to read the log afterward for the spreadsheet URL.
 */
function initializeDatabase() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty(PROP_SPREADSHEET_ID);

  if (existingId) {
    var existingUrl = 'https://docs.google.com/spreadsheets/d/' + existingId + '/edit';
    Logger.log('Database already initialized.');
    Logger.log('SPREADSHEET_ID = ' + existingId);
    Logger.log('URL = ' + existingUrl);
    Logger.log('To rebuild, run resetDatabasePointer() first (does not delete data).');
    return existingUrl;
  }

  // 1. Get the spreadsheet. Works in BOTH modes:
  //    - Container-bound (script created from Extensions > Apps Script inside a
  //      sheet): use that sheet.
  //    - Standalone (script created at script.google.com): create a new sheet.
  //    Pin the timezone either way (belt-and-braces with appsscript.json).
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  }
  ss.setSpreadsheetTimeZone('Asia/Kuala_Lumpur');
  var ssId = ss.getId();
  props.setProperty(PROP_SPREADSHEET_ID, ssId);

  // 2. Build each sheet with headers.
  Object.keys(SHEETS).forEach(function (name) {
    var headers = SHEETS[name];
    var sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  });

  // 3. Remove the default "Sheet1" created with the spreadsheet.
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet) {
    ss.deleteSheet(defaultSheet);
  }

  // 4. Seed the default admin user (salted SHA-256 PIN).
  var salt = Utilities.getUuid();
  var pinHash = sha256Hex_(DEFAULT_ADMIN.pin + salt);
  var usersSheet = ss.getSheetByName('Users');
  usersSheet.appendRow([
    DEFAULT_ADMIN.username, // username
    pinHash,                // pinHash
    salt,                   // salt
    DEFAULT_ADMIN.name,     // name
    DEFAULT_ADMIN.role,     // role
    DEFAULT_ADMIN.oncall,   // oncall
    '',                     // whatsappNumber
    '',                     // callmebotKey
    '',                     // sessionToken
    ''                      // tokenExpiry
  ]);

  // 5. Seed sample Config.
  var configSheet = ss.getSheetByName('Config');
  configSheet.getRange(2, 1, DEFAULT_CONFIG.length, 2).setValues(DEFAULT_CONFIG);

  // Order sheets so Referrals is first when the sheet opens.
  ss.setActiveSheet(ss.getSheetByName('Referrals'));
  ss.moveActiveSheet(1);

  var url = ss.getUrl();
  Logger.log('WiraTisu database created.');
  Logger.log('SPREADSHEET_ID = ' + ssId);
  Logger.log('URL = ' + url);
  Logger.log('Default admin: username "' + DEFAULT_ADMIN.username + '", PIN "' + DEFAULT_ADMIN.pin + '" — CHANGE THIS in Phase 2.');
  Logger.log('IMPORTANT: replace the sample wardList in the Config sheet with the real ward list.');
  return url;
}

/**
 * Clears ONLY the stored spreadsheet pointer so initializeDatabase() can build
 * a fresh spreadsheet. Does NOT delete the existing spreadsheet or any data —
 * the old spreadsheet remains in your Drive.
 */
function resetDatabasePointer() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_SPREADSHEET_ID);
  Logger.log('Pointer cleared. Run initializeDatabase() to build a new spreadsheet.');
}

/**
 * Convenience: logs the current database URL (useful after deployment).
 */
function logDatabaseUrl() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID);
  if (!id) {
    Logger.log('No database yet. Run initializeDatabase().');
    return;
  }
  Logger.log('https://docs.google.com/spreadsheets/d/' + id + '/edit');
}

// ---------------------------------------------------------------------------
// Shared helper: SHA-256 -> lowercase hex. Used for PIN hashing (and reused
// by Auth.gs in Phase 2). Kept here because Setup seeds the first hash.
// ---------------------------------------------------------------------------
function sha256Hex_(input) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;           // convert signed byte to unsigned
    var h = b.toString(16);
    if (h.length === 1) h = '0' + h;
    hex += h;
  }
  return hex;
}
