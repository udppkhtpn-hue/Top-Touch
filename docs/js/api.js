/**
 * api.js — thin fetch wrapper for the Apps Script web app.
 *
 * Why these exact options (SPEC.md §5, §13.4):
 *   - Content-Type: text/plain  -> avoids a CORS preflight; ContentService
 *     cannot set CORS headers, so a "simple" request is mandatory.
 *   - redirect: 'follow'        -> Apps Script bounces /exec to a
 *     googleusercontent.com URL; the fetch must follow it.
 * The body is still JSON — only the Content-Type is text/plain.
 */

/**
 * POST an action to the backend.
 * @param {string} action   e.g. 'submitReferral'
 * @param {Object} payload  action-specific data
 * @param {Object} [extra]  optional top-level fields, e.g. { code, token }
 * @return {Promise<Object>} parsed { ok, data } or { ok:false, error }
 */
async function apiPost(action, payload, extra) {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf('PASTE_YOUR') === 0) {
    throw new Error('APPS_SCRIPT_URL belum ditetapkan dalam config.js');
  }

  const body = Object.assign({ action: action, payload: payload || {} }, extra || {});

  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Respons tidak sah daripada pelayan: ' + text.slice(0, 200));
  }
  return data;
}
