/**
 * api.js — thin fetch wrapper for the Apps Script web app.
 *
 * Why these exact options (SPEC.md §5, §13.4):
 *   - Content-Type: text/plain  -> avoids a CORS preflight; ContentService
 *     cannot set CORS headers, so a "simple" request is mandatory.
 *   - redirect: 'follow'        -> Apps Script bounces /exec to a
 *     googleusercontent.com URL; the fetch must follow it.
 * The body is still JSON — only the Content-Type is text/plain.
 *
 * Transient-error handling: the /exec -> script.googleusercontent.com redirect
 * intermittently returns a Google HTML error page ("ppConfig…") instead of our
 * JSON — a known Apps Script flake, most common right after a deploy or under
 * load. Callers that are SAFE TO RETRY (idempotent reads/writes: login,
 * getLiveCases, respondReferral, exportCsv, logout) pass { retries: N } to
 * absorb it. submitReferral (the ward's ~60-second path) deliberately does NOT
 * retry: its response can be lost AFTER the row is written, so an auto-retry
 * could create a duplicate referral. It instead surfaces the friendly error and
 * lets the user decide.
 */

/**
 * POST an action to the backend.
 * @param {string} action   e.g. 'submitReferral'
 * @param {Object} payload  action-specific data
 * @param {Object} [extra]  optional top-level fields, e.g. { code, token }
 * @param {Object} [opts]   { retries?: number } — max extra attempts on a
 *                          transient (non-JSON / network) failure. Default 0.
 * @return {Promise<Object>} parsed { ok, data } or { ok:false, error }
 */
async function apiPost(action, payload, extra, opts) {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf('PASTE_YOUR') === 0) {
    throw new Error('APPS_SCRIPT_URL belum ditetapkan dalam config.js');
  }

  opts = opts || {};
  var maxRetries = Math.max(0, opts.retries || 0);
  var body = Object.assign({ action: action, payload: payload || {} }, extra || {});
  var lastRaw = '';

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      var res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      var text = await res.text();
      try {
        return JSON.parse(text); // success — return parsed JSON
      } catch (parseErr) {
        // Not JSON: the transient Google HTML error page. Retry if allowed.
        lastRaw = text;
        console.warn('apiPost(' + action + '): non-JSON response (attempt ' +
          (attempt + 1) + '/' + (maxRetries + 1) + '):', text.slice(0, 120));
      }
    } catch (netErr) {
      // Network/fetch failure. Retry if allowed.
      lastRaw = String(netErr);
      console.warn('apiPost(' + action + '): network error (attempt ' +
        (attempt + 1) + '/' + (maxRetries + 1) + '):', netErr);
    }

    // Back off before the next attempt (800ms, 1600ms, …). No wait after the last.
    if (attempt < maxRetries) {
      await new Promise(function (r) { setTimeout(r, 800 * (attempt + 1)); });
    }
  }

  // All attempts exhausted — friendly message; raw kept in the console above.
  throw new Error('Pelayan sibuk atau sambungan terganggu. Sila cuba lagi sebentar lagi.');
}
