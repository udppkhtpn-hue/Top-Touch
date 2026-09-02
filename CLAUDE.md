# CLAUDE.md — T.O.P. Touch

Project context for Claude Code. Read this every session before making changes.

> **Source of truth & precedence:** `README.md` is newest, then `SPEC.md` (v2.0), then this file's summaries. Where they conflict, the newer one wins. If a change would contradict any of them, stop and confirm.

## What this is

Internal, staff-only organ & tissue donation **referral** platform for a hospital **Tissue & Organ Procurement (TOP) Team**, HTPN. Ward staff notify the team of a potential donor from a phone in under 60 seconds; the team gets an instant alert. Tagline: *"Menghubungkan Keikhlasan, Menyelamatkan Nyawa."* (Formerly prototyped as "WiraTisu" — do not use that name in new UI.)

Live: [https://udppkhtpn-hue.github.io/Top-Touch/](https://udppkhtpn-hue.github.io/Top-Touch/)

## Stack — do not change without asking first

- **Frontend:** static HTML \+ CSS \+ vanilla JS. **No framework, no build step, no bundler** (no Sass/Tailwind CLI/JSX). GitHub Pages serves `/docs` as-is. Mobile-first.  
- **Backend:** one Google Apps Script web app — single `/exec` URL, `action`\-routed `POST` with `Content-Type: text/plain` (avoids CORS preflight; `ContentService` can't set CORS headers).  
- **Database:** Google Sheets, private to the TOP team account.  
- **Dependencies:** self-hosted, no CDN (restricted-network constraint). Fonts and **Chart.js** (`docs/js/vendor/chart.umd.min.js`, v4.4.1 UMD) are self-hosted; see DASHBOARD\_PLAN.md §5. **Do not add a CDN `<script>` — vendor it locally instead.**

## What is built (README)

- **Phase 1a \+ 1b:** referral form → Sheet row → `sendAlert()` fan-out (email always, Google Chat when configured).  
- **apps-script built:** `Setup.gs`, `Code.gs`, `Referrals.gs`, `Alerts.gs`.  
- **Not built yet:** admin panel, auth, dashboard, education hub, escalation trigger. Their router cases exist but return `not_implemented`. `Dashboard.gs` / `Auth.gs` don't exist yet — add them when building those phases.

## Deploy workflow

- **Frontend:** `git push` → GitHub Pages serves `/docs`.  
- **Backend:** edit `/apps-script/*.gs`, paste into the Apps Script project, then **Deploy → Manage deployments → edit → Version: New version**. Editing code without a new version silently keeps the old code live. The `/exec` URL stays the same.  
- Timestamps are **Asia/Kuala\_Lumpur** in both `appsscript.json` and the Sheet.

## Alerts (README amends SPEC §6.2)

- One `sendAlert(referral)` fans out to `sendEmail()` (MailApp, baseline), `sendChat()` (Google Chat webhook), and `sendTelegram()` (Telegram bot). Each channel is individually swappable, wrapped in its own try/catch, and **must never fail the submission**. Each is inert until its Config keys are set.
- **In-Workspace channels carry full detail** (name, IC, ward, bed, RN, time of death, flags, notes, contact): `sendEmail` (any `alertEmails`) and `sendChat` (any `chatWebhookUrl`) — safe because they stay inside MOH Workspace.
- **Google Chat is effectively unavailable**: the org has **disabled incoming webhooks**, so `sendChat` can't be turned on there. Email is the working in-Workspace channel.
- **Telegram is a non-MOH third party** (same category as the dropped WhatsApp), so it carries an **identifier-light nudge only** — ward, bed, referring staff + contact, referral ID, and an app link; **never patient name/IC/time-of-death** (`buildTelegramNudge_`). That "notification, not data transfer" design is the sanctioned exception; keep it identifier-light. Config: `telegramBotToken` + `telegramChatId`.
- **WhatsApp was dropped** (every route runs through a non-MOH third party, and it carried full detail). Do not reintroduce it without a governance decision.

## Access model — three tiers (SPEC v2.0 §4)

| Tier | Gate | Sees |
| :---- | :---- | :---- |
| **Open** | none (link/QR) | write-only; no readable data returned |
| **Coded** | shared `dashboardCode`, server-checked | **aggregate counts only — never a patient row** |
| **Admin** | username \+ PIN → session token | full referral detail, CSV export, management |

## Hard rules — safety & governance

1. **Never slow or break the referral form's \~60-second critical path.** Minimal motion there (only the draining serology ring). Ward list is hardcoded in `config.js` on purpose.  
2. **Final donor eligibility is always the TOP team's decision.** The app never auto-rejects, even if all four exclusion toggles are "Ya" — a "Ya" only flags the case.  
3. **Every gate is enforced server-side in Apps Script, never in browser JS.** The frontend is public on GitHub; anyone can read the JS and call the endpoint directly.  
4. **`getDashboardPublic` must be structurally incapable of returning a patient row**, even with a valid code. It aggregates server-side and returns only computed numbers. This is the primary safety property; the code is secondary.  
5. **No patient identifier** in any URL, query string, or the confirmation screen (which shows the referral ID only). Identifiers live only in the Sheet, the internal alerts, and the admin tier.  
6. **Additional dashboard privacy** (strengthens rule 4): suppress any aggregate count below `smallCellThreshold` (proposed Config key, default 5); no cross-tabulation of ward × outcome × refusal reason; `noindex` \+ `robots.txt` on dashboard pages; do not publish procurement statistics publicly until institutional clearance is confirmed; any ward ranking uses training / death-audit-form completion, never donors or consent.

## Apps Script gotchas (SPEC §13 — each costs an hour if hit blind)

- New-version redeploy required after any edit (see Deploy).  
- Wrap referral append \+ ID generation in `LockService.getScriptLock()` — concurrent submissions otherwise collide on the sequential `REF-YYYYMMDD-NNN` id.  
- Dashboard aggregation reads the whole sheet once via `getDataRange().getValues()` and aggregates in JS; per-row `getRange()` calls time out. Cache the aggregate \~5 min in `CacheService`.  
- `MailApp`/`UrlFetchApp` failures caught individually; never block the submission.

## Data model (Google Sheets — SPEC §7)

- **Referrals** — one row per referral. Status is now just **`NEW` (open) → `RESPONDED` (closed)**: there is no multi-step lifecycle. The ward creates a case `NEW`; an admin taps "Respons & tutup" in the cockpit, which sets `status = RESPONDED` (the app's single status write, `respondReferral`, token-gated + audited) and drops it off the live board. No one hand-edits the Sheet to advance status. (Legacy closed statuses `PROCURED / NOT_PROCEEDED / SELESAI` still count as closed if present.)  
- **Users** — admins/roster: username, **pin (plaintext — the Users sheet is private to the TOP team; change the password by editing this cell)**, role, oncall, chat/contact, sessionToken, tokenExpiry. Legacy `pinHash` + `salt` columns remain for backward compatibility; `login` uses them only when `pin` is empty.  
- **Education**, **AuditLog**, **Config**.  
- **Config keys (README):** `wardList`, `escalationMinutes`, `maxEscalations`, `adminUrl`, `dashboardCode`, `wardCode`/`wardCodeEnabled`, `chatWebhookUrl`, `alertEmails`, `alertProvider`. `getConfigPublic` must never leak `dashboardCode`, `wardCode`, `chatWebhookUrl`, or `alertEmails`.

## API (Apps Script) — SPEC v2.0 §8

`POST` JSON `{ action, token?, code?, payload }` → `{ ok, data }` | `{ ok:false, error }`. Actions: `submitReferral` (open, \+wardCode if enabled), `getDashboardPublic`/`getDashboard` (dashboardCode — aggregate, **ward-notification data only**: volume, by-ward, death→referral median, exclusion-flag counts, pledge-card & family-approached counts; no funnel / ack-time / refusal / tissue-yield), `login`/`logout`, `getDashboardAdmin`/`getLiveCases` (token — live cockpit), `respondReferral` (token — close a case), `exportCsv` (token). Stubbed/not built: `getEducation`, `getConfigPublic`, `listReferrals`, `updateReferral`, `manageEducation`, `manageUsers`.

The admin cockpit UI is **"Pusat Operasi"** (formerly "Kokpit Operasi"). It shows the on-call bar, an exceptions strip, and the live window countdowns; each card has a "Respons & tutup" close button. No status/phase board (retired).

## UI / motion

- Bahasa Melayu first, English clinical terms where natural. Palette green `#1B7A43` \+ white.  
- Zero-dependency motion only (CSS transitions/keyframes, WAAPI, rAF, SVG, View Transitions).  
- Dashboard: chart entry animations \+ restrained filter transitions. Wrap decorative motion in `@media (prefers-reduced-motion: reduce)`; informational motion (the countdown) stops animating but still shows its state.

## Working style

- Review diffs before every commit — this is a clinical tool; eyes on every change to the referral path. Prefer small, reviewable changes. Flag anything touching the critical path or a governance rule and confirm before proceeding.

