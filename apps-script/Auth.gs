/**
 * Auth.gs — Phase 2 admin authentication (SPEC §4 Admin tier, §8 `login`).
 *
 * The admin tier is username + PIN -> a session token. This file OWNS both:
 *   login(payload)   — verify credentials, issue + persist a session token.
 *   logout(token)    — clear the caller's token.
 *   validateToken_() — read-only token check, used by every token-gated handler
 *                      (getLiveCases, and later listReferrals / updateReferral / …).
 *
 * PIN hashing scheme (matches Setup.gs seeding): sha256Hex_(pin + perUserSalt),
 * compared against the stored `pinHash`. PINs are never stored or logged in the
 * clear, and no handler ever returns a PIN, hash, or salt to the client.
 *
 * Governance (CLAUDE.md, SPEC §4): every gate is enforced server-side here; the
 * public frontend cannot be trusted. Errors are deliberately generic
 * (`invalid_credentials`) so the endpoint never reveals whether a username exists.
 *
 * Shared globals (Apps Script has one global scope across .gs files):
 *   getSheet_, appendAudit_ (Code.gs); sha256Hex_ (Setup.gs);
 *   buildColIndex_, asDate_, toIso_ (Dashboard.gs).
 */

// Session lifetime. A TOP shift is long; 8 h covers a shift without a mid-shift
// re-login, and the token is cleared on logout or overwritten on next login.
var SESSION_HOURS = 8;

/**
 * @param {Object} payload  { username, pin }
 * @return {Object} { ok:true, data:{ token, name, role, expiresAt } }
 *                | { ok:false, error:'invalid_credentials' | 'server_error' }
 */
function login(payload) {
  payload = payload || {};
  var username = String(payload.username || '').trim();
  var pin = String(payload.pin || '');
  if (!username || !pin) return { ok: false, error: 'invalid_credentials' };

  // Serialize the read-verify-write so two logins can't interleave on the row.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return { ok: false, error: 'server_error' }; }

  try {
    var sheet = getSheet_('Users');
    var values = sheet.getDataRange().getValues();
    var idx = buildColIndex_(values[0]);

    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (String(row[idx.username] || '').trim() !== username) continue;

      var salt = String(row[idx.salt] || '');
      var expected = String(row[idx.pinHash] || '');
      // A user with no hash configured cannot log in (fail closed).
      if (!expected) { appendAudit_(username, 'LOGIN_FAIL', '', 'no_hash'); return { ok: false, error: 'invalid_credentials' }; }

      if (sha256Hex_(pin + salt) !== expected) {
        appendAudit_(username, 'LOGIN_FAIL', '', 'bad_pin');
        return { ok: false, error: 'invalid_credentials' };
      }

      // Success — mint a token and persist it (+expiry) on the user's row.
      var token = Utilities.getUuid() + Utilities.getUuid();
      var expiry = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
      var rowNum = i + 1; // 1-based; +1 for the header row
      sheet.getRange(rowNum, idx.sessionToken + 1).setValue(token);
      sheet.getRange(rowNum, idx.tokenExpiry + 1).setValue(toIso_(expiry));

      appendAudit_(username, 'LOGIN', '', 'role=' + String(row[idx.role] || ''));
      return {
        ok: true,
        data: {
          token: token,
          name: String(row[idx.name] || ''),
          role: String(row[idx.role] || ''),
          expiresAt: toIso_(expiry)
        }
      };
    }

    // Unknown username — same generic error + timing as a bad PIN.
    appendAudit_(username, 'LOGIN_FAIL', '', 'unknown_user');
    return { ok: false, error: 'invalid_credentials' };
  } catch (err) {
    return { ok: false, error: 'server_error' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Clear the token on the caller's row so it can no longer be used.
 * @param {string} token
 * @return {Object} { ok:true } (idempotent — an unknown token is a no-op success)
 */
function logout(token) {
  if (!token) return { ok: true };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return { ok: true }; }
  try {
    var sheet = getSheet_('Users');
    var values = sheet.getDataRange().getValues();
    var idx = buildColIndex_(values[0]);
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][idx.sessionToken] || '') === String(token)) {
        var rowNum = i + 1;
        sheet.getRange(rowNum, idx.sessionToken + 1).setValue('');
        sheet.getRange(rowNum, idx.tokenExpiry + 1).setValue('');
        appendAudit_(String(values[i][idx.username] || ''), 'LOGOUT', '', '');
        break;
      }
    }
  } catch (e) {
    // Logout is best-effort; the token also expires on its own.
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/**
 * Read-only session-token check. Returns the user (username/name/role/oncall) for
 * a valid, unexpired token, else null. This is the single validator used by every
 * token-gated handler.
 * @param {string} token
 * @return {?Object} { username, name, role, oncall } | null
 */
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
      role: String(row[idx.role] || ''),
      oncall: String(row[idx.oncall] || '')
    };
  }
  return null;
}
