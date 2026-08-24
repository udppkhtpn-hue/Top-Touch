/**
 * config.js — WiraTisu frontend configuration.
 *
 * The ONE value you must set after deploying the Apps Script web app:
 *   APPS_SCRIPT_URL  — the /exec URL from Deploy > New deployment > Web app.
 *
 * The ward list is hardcoded here (not fetched) on purpose: the referral form
 * must be usable instantly on the 60-second critical path, with no backend
 * round-trip and no failure mode before the form even loads. It mirrors the
 * Config sheet's `wardList`; keep the two in sync if wards change.
 */

// ⬇️ Deployed Apps Script web app URL (must end in /exec).
//    Re-paste this if you ever create a NEW deployment (a new version keeps the URL).
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwbea7RNtTTCwKeGV6WkC7yo5OK4MK1DCepXXdQ4pQ54a03peKbgJ2bEAvpOxQ8_XE/exec';

// App labels (Bahasa Melayu, English clinical terms where natural).
const APP_LABELS = {
  masthead: 'T.O.P. Touch',
  tagline: 'Sentuhan Keikhlasan',
  slogan: 'Menghubungkan Keikhlasan, Menyelamatkan Nyawa.'
};

// Sentinel value for the "Lain-lain (nyatakan)" option -> reveals a text box.
const LAINLAIN_VALUE = '__LAINLAIN__';

// Ward dropdown, grouped by facility. Values are building-qualified so the
// stored row and the alert are unambiguous (both buildings have an ICU).
const WARD_GROUPS = [
  {
    label: 'Bangunan Utama, HTPN',
    wards: [
      'Wad 1 (Bangunan Utama)',
      'Wad 2 (Bangunan Utama)',
      'Wad 3 (Bangunan Utama)',
      'Wad 4 (Bangunan Utama)',
      'Wad 5 (Bangunan Utama)',
      'Wad 6 (Bangunan Utama)',
      'Wad 7 (Bangunan Utama)',
      'Wad 8 (Bangunan Utama)',
      'ICU (Bangunan Utama)'
    ]
  },
  {
    label: 'Kompleks WCC, HTPN',
    wards: [
      'PICU (WCC)',
      'SCN (WCC)',
      'NICU (WCC)',
      'ICU (WCC)',
      'Wad 6A (WCC)',
      'Wad 6B (WCC)',
      'Wad 7A (WCC)',
      'Wad 7B (WCC)',
      'Wad 8A (WCC)',
      'Wad 8B (WCC)',
      'Wad 9A (WCC)'
    ]
  },
  {
    label: 'Unit Lain',
    wards: [
      'Jabatan Kecemasan (ED)',
      'Forensik / Mortuari'
    ]
  }
];

// Serology golden window, in minutes (SPEC.md §1: blood for serology = 4 hours).
const SEROLOGY_WINDOW_MIN = 240;
