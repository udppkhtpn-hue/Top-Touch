/**
 * Education.gs — Phase 3 education hub (getEducation).
 *
 * OPEN tier: returns the active learning modules from the Education sheet, sorted
 * by sortOrder. This is training content only — NO patient data — so there is no
 * gate. The frontend (pendidikan.html) embeds each module's Google Drive video by
 * its driveFileId; the sheet is the single source, so modules are added / reordered
 * by editing the sheet, never by touching code.
 *
 * Education sheet columns (Setup.gs SHEETS.Education):
 *   id | title | description | type | driveFileId | category | sortOrder | active
 *
 * Shared helpers getSheet_, buildColIndex_, isAffirmative_ live in Code.gs /
 * Dashboard.gs (one global scope across all .gs files).
 */
function getEducation(payload, code) {
  var values;
  try {
    values = getSheet_('Education').getDataRange().getValues();
  } catch (e) {
    // Sheet missing / DB not initialised — return empty, never error the page.
    return { ok: true, data: { modules: [] } };
  }
  if (values.length < 2) return { ok: true, data: { modules: [] } };

  var idx = buildColIndex_(values[0]);
  var modules = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!isAffirmative_(r[idx.active])) continue; // only rows flagged active
    var title = String(r[idx.title] || '').trim();
    if (!title) continue; // skip blank/partial rows

    modules.push({
      id: String(r[idx.id] || ''),
      title: title,
      description: String(r[idx.description] || ''),
      type: String(r[idx.type] || 'video').trim().toLowerCase() || 'video',
      driveFileId: normalizeDriveId_(r[idx.driveFileId]),
      category: String(r[idx.category] || '').trim(),
      sortOrder: parseInt(r[idx.sortOrder], 10) || 0
    });
  }
  modules.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
  return { ok: true, data: { modules: modules } };
}

/**
 * Accept either a bare Drive file id or a full share URL in the sheet, and always
 * return the bare id. So staff can paste whichever Drive gives them.
 *   https://drive.google.com/file/d/<ID>/view?usp=sharing  -> <ID>
 *   https://drive.google.com/open?id=<ID>                   -> <ID>
 */
function normalizeDriveId_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var m = s.match(/\/d\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : s;
}
