# HANDOVER — T.O.P. Touch

**Last updated:** 2025-09-01 · **Owner:** Ferwahn Fairis (HIO, HTPN Kajang)
**Purpose:** Snapshot to continue work in a new chat/session. Read `CLAUDE.md` first (binding project rules), then this file for the current state and what's next.

> **Note for whoever reads this:** write instructions to Ferwahn in plain, numbered, layman steps (separate "what I'll do" from "what you do"). Terse bullets caused friction before.

---

## 1. TL;DR — where things stand

T.O.P. Touch is a **staff-only organ & tissue donation referral app** for the TOP Team at HTPN Kajang. It's **live and working**. This session simplified the app to "ward-notification data only", added an in-app respond-to-close action, added a Telegram alert channel, and built the **Pendidikan (education)** hub with a self-hosted video.

- **Live site:** https://udppkhtpn-hue.github.io/Top-Touch/ (GitHub Pages, serves `/docs`)
- **Repo:** https://github.com/udppkhtpn-hue/Top-Touch (branch `main`)
- **Backend:** one Google Apps Script web app. **Live deployment version: @12** (id `AKfycbwbea7RNtTTCwKeGV6WkC7yo5OK4MK1DCepXXdQ4pQ54a03peKbgJ2bEAvpOxQ8_XE`, same `/exec` URL in `docs/js/config.js`).
- **Database:** Google Sheets ("TOP App Database"), private to the TOP team account.
- Everything committed & pushed; working tree clean. Last commit: `fbbe9f9`.

---

## 2. Stack (do not change without asking — see CLAUDE.md)

- **Frontend:** static HTML + CSS + vanilla JS in `/docs`. No framework/build step. Self-hosted deps (fonts, Chart.js) — hospital network blocks CDNs.
- **Backend:** Apps Script, single `/exec` URL, `action`-routed POST with `Content-Type: text/plain` (avoids CORS preflight).
- **Data:** Google Sheets. Sheets: Referrals, Users, Education, AuditLog, Config.

---

## 3. What was done THIS session (most recent first)

1. **Pendidikan (education) hub** — new page `docs/pendidikan.html` + `docs/js/education.js`, backend `apps-script/Education.gs` (`getEducation`, open tier). Modules come from the **Education sheet** (add/reorder by editing the sheet). Nav link enabled on all pages.
   - Module videos are **self-hosted** in `docs/video/` (Google Drive's iframe player wouldn't auto-hide controls on iOS). Module 1 = `docs/video/Modul-1.mp4` (25 MB, 720×1280 portrait).
   - Player: native `<video>`, **portrait 9:16 frame**, **auto-loads when scrolled into view** with a **% progress bar** (streamed via fetch + Content-Length → blob). Drive still supported as a fallback if a sheet value is a Drive id instead of a filename.
2. **Telegram alert channel** — `apps-script/Alerts.gs` `sendTelegram()` + `buildTelegramNudge_()`. **Identifier-light nudge only** (ward, bed, referring staff+contact, referral id, app link — NEVER patient name/IC), because Telegram is a non-MOH third party. Config keys `telegramBotToken` + `telegramChatId`. **Live and configured** (user set it up).
3. **Simplify to ward-notification data + respond-to-close** (`aea8b48`):
   - Cockpit renamed **Kokpit Operasi → Pusat Operasi**. Added a **"Respon"** button per case → `respondReferral` (token-gated, audited) sets `status = RESPONDED` (closes it off the live board). This is the app's ONLY status write — no more hand-editing the Sheet, no multi-step lifecycle. Retired the phase board. Header label: "Keutamaan — kritikal dahulu".
   - Cockpit case cards show a **limited identity strip**: first name + MyKad-derived age/gender + first 6 of IC (masked `NNNNNN - XX - XXXX`); foreigner = first 4 of passport/UNHCR. (Race is NOT collected by the form — see open items.)
   - Removed the sourceless "Kesediaan koordinasi" panel (its columns were never populated).
   - **Papan Data** trimmed to ward-notification tiles: volume, by-ward, death→referral median, exclusion-flag counts, pledge-card & family-approached counts. Removed funnel / time-to-acknowledge / refusal-reasons / tissue-yield (no data feeds them). Added **year** and **ward/location** filters.
4. **Self-host Chart.js** (`f033070`) — `docs/js/vendor/chart.umd.min.js` (v4.4.1), like the fonts.

---

## 4. File map

**Frontend (`docs/`):** `index.html`, `refer.html` (referral form — the ~60s critical path), `pendidikan.html`, `dashboard.html` (Papan Data), `admin.html` (Pusat Operasi). JS: `config.js` (the `/exec` URL + ward list), `api.js`, `refer.js`, `dashboard.js`, `admin.js`, `education.js`, `nav.js`. Media in `docs/video/`, `docs/img/`, self-hosted Chart.js in `docs/js/vendor/`.

**Backend (`apps-script/`):** `Code.gs` (router + shared helpers `getSheet_`, `getConfigMap_`, `appendAudit_`, `buildColIndex_` is in Dashboard.gs), `Referrals.gs` (`submitReferral`, `respondReferral`), `Alerts.gs` (email/chat/telegram fan-out), `Dashboard.gs` (`getDashboard`, `getLiveCases`, `exportCsv`), `Auth.gs` (`login`/`logout`/`validateToken_`), `Education.gs` (`getEducation`), `Setup.gs` (schema + `initializeDatabase` + `migrateReferralsColumns` + Config seed).

**Live API actions:** `submitReferral`, `getDashboard`/`getDashboardPublic`, `getLiveCases`/`getDashboardAdmin`, `respondReferral`, `login`/`logout`, `exportCsv`, `getEducation`. Stubbed (`not_implemented`): `getConfigPublic`, `listReferrals`, `updateReferral`, `manageEducation`, `manageUsers`.

---

## 5. How to deploy (TWO separate steps)

**Frontend** (anything in `/docs`): just `git push` to `main` → GitHub Pages rebuilds in ~1–2 min. (Then hard-refresh: Cmd/Ctrl+Shift+R.)

**Backend** (any `apps-script/*.gs` change): `clasp` is configured (`apps-script/.clasp.json`, scriptId set; `~/.clasprc.json` auth present). Two commands, run from `apps-script/`:
```bash
clasp push --force
clasp deploy -i AKfycbwbea7RNtTTCwKeGV6WkC7yo5OK4MK1DCepXXdQ4pQ54a03peKbgJ2bEAvpOxQ8_XE -d "message"
```
- `clasp push` uploads code; `clasp deploy -i <that id>` cuts a **new version on the LIVE deployment** (keeps the same `/exec` URL — that id matches `config.js`). The other deployment (`AKfycbx1...@HEAD`) is a separate test one; don't point the frontend at it.
- `clasp run` does NOT work here (project not set up for remote execution) — to run a function (e.g. `testSendTelegram`), do it in the Apps Script editor.
- Git commits/pushes go to `main` via a short-lived feature branch, fast-forwarded (see recent history). **Never `git push` without Ferwahn's OK.**

---

## 6. Config / data the app reads

**Config sheet** (edit values live, no redeploy): `alertEmails`, `chatWebhookUrl` (OFF — org disabled Chat webhooks), `telegramBotToken` + `telegramChatId` (set/live), `adminUrl` (set to `.../admin.html`), `dashboardCode`, `smallCellThreshold` (5), `wardList`, `escalationMinutes`, `wardCodeEnabled` (false). Secrets live ONLY here, never in the repo.

**Education sheet** — columns: `id, title, description, type, driveFileId, category, sortOrder, active`. To add a module: fill a row, put the **video filename** (e.g. `Modul-2.mp4`, case-sensitive, must end `.mp4`) in `driveFileId`, set `sortOrder`, `active = Y`. Put the video file in `docs/video/`, commit+push. (`driveFileId` also accepts a Google Drive id/URL for the Drive-iframe fallback.)

**Alerts:** `sendAlert()` fans out to email + chat + telegram, each inert until configured, each wrapped so one failing never blocks the submission. Email + Chat carry full detail (in-Workspace); **Telegram carries the identifier-light nudge only**.

**Referrals status model:** `NEW` (open) → `RESPONDED` (closed) only. No multi-step lifecycle.

---

## 7. Open items / possible next steps

- **Race on cockpit cards** — the referral form does NOT collect race (or gender/DOB for foreigners), so race isn't shown. To add it, add fields to the **Rujuk Kes form** (`refer.html`/`refer.js`): Bangsa, Jantina, Warganegara/ID-type — a change to the ~60s critical-path form (do carefully; confirm first).
- **Education modules 2–5** — user has 1 done. Repeat the flow in §6 for each.
- **The guide artifact** — a bilingual (EN/BM) onboarding guide exists at `https://claude.ai/code/artifact/da2f9f86-e606-4d2a-af78-9342f250e642` (private artifact, not in the repo). It is CURRENTLY BEHIND: it doesn't yet cover the Telegram setup, the email-first alert reality (Chat is blocked), or the education hub, and its cockpit/dashboard sections predate a couple of tweaks. Offer to refresh it.
- **Exceptions strip** in the cockpit: two cards ("serology overdue", "medico-legal") can never trigger now (nothing populates those fields) — always 0. Harmless; could be trimmed.
- **Repo doc drift:** `CLAUDE.md` was updated for the status model + alerts + Pusat rename, but `README.md`, `SPEC.md`, `DASHBOARD_PLAN.md` still describe the older multi-status lifecycle and the removed dashboard tiles. Reconcile if it matters.
- **`docs/video/Modul-1.mp4` is 25 MB in git** — fine, but future modules add up; keep videos compressed (~25 MB).

---

## 8. Gotchas & governance (from CLAUDE.md — binding)

- **Never slow/break the referral form's ~60s critical path.**
- **Final donor eligibility is always the TOP team's decision** — the app never auto-rejects; a "Ya" flag only flags.
- **Every gate is server-side in Apps Script** (frontend is public).
- **`getDashboardPublic` must be structurally incapable of returning a patient row** — aggregate only, small-cell suppression (<5).
- **No patient identifiers in URLs / query strings / the confirmation screen.**
- **WhatsApp is banned** (non-MOH third party). **Telegram is allowed ONLY as an identifier-light nudge** — never put patient data through it.
- Apps Script: new-version redeploy required after any edit; wrap referral append+ID in `LockService`; read the whole sheet once (`getDataRange().getValues()`), cache ~5 min.

---

## 9. Loose ends / housekeeping

- **`git stash@{0}`** holds an "alert-only teardown" WIP from another session (someone tried to strip the app to alert-only). It was preserved on request and is NOT applied. Drop it (`git stash drop`) if definitely unwanted.
- Default admin login is seeded `admin` / `1234` in `Setup.gs` — **should be changed** before real use (public repo). Salted SHA-256 PIN in the Users sheet; can't be read back once changed.
- A spare copy of `Modul-1.mp4` may still sit in the top-level "TOP Team" folder (outside the repo) — safe to delete.
