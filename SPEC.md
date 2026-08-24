# SPEC.md — WiraTisu

**Hospital TOP Team Organ & Tissue Donation Referral Platform**

**Owner:** Hospital Tissue & Organ Procurement (TOP) Team
**Version:** 2.0
**Supersedes:** v1.0 draft

> Changes from v1: three-tier access model (open / ward code / admin login), Google Chat added as primary push channel, dashboard moved out from behind admin login, Phase 1 split into 1a and 1b.

---

## 1. Problem Statement

The TOP Team faces **late notification or no notification** of potential organ/tissue donor cases from wards and critical care areas. Tissue viability is time-critical:

| Tissue | Window from death |
|---|---|
| Blood for serology | 4 hours |
| Corneas | 12 hours |
| Heart valves, skin, bone | 24 hours |

Every hour of delay reduces the chance of successful donation.

Secondary problem: **low awareness** among ward staff about organ/tissue donation — who qualifies, how to prepare the body, how to approach families — which suppresses referral rates.

## 2. Goals

1. Any ward/clinical staff can notify the TOP team of a potential donor in **under 60 seconds** from a phone.
2. **Instant push alert** to the TOP team on-call, with automatic escalation if unacknowledged.
3. An **education hub** (videos + PDF e-flyers streamed from Google Drive) to raise staff awareness.
4. A **real-time dashboard** of referral statistics, visible to ward staff as well as the TOP team, for monitoring and NTRC reporting.

## 3. Non-Goals (v1)

- Not a clinical record system. The full Green Form, consent forms (Borang A/B/C KKM, Borang A PDRM) and serology workflow remain on existing paper/hospital systems.
- No brain-death donor coordination workflow. DCD tissue donation is the primary use case.
- No public/family-facing features. This is an internal staff tool.
- No patient identifiers ever leave the Google Sheet — not in alerts, not in the dashboard, not in URLs.

## 4. Access Model — Three Tiers

| Tier | Gate | Pages | Data exposed |
|---|---|---|---|
| **Open** | None — shared link / QR poster | Landing, referral form, education hub, QR poster | None readable. Write-only (form submission). |
| **Coded** | Shared ward code, checked server-side | Dashboard | Aggregate counts only. Never a patient row. |
| **Admin** | Username + PIN → session token | Admin panel | Full referral detail, CSV export, user/content management. |

### Rationale

- **Open tier is write-only.** Anyone with the QR can submit a referral, but no open endpoint returns patient data. The blast radius of a leaked poster is junk submissions, not a data breach.
- **Coded tier exists because GitHub Pages is the public internet.** An ungated dashboard would publish hospital procurement statistics worldwide. A shared code is not real security — it is a barrier to publication. It is acceptable precisely because what sits behind it is aggregate-only and would be low-harm if leaked.
- **Admin tier is the only one that touches identifiers.** Real accounts, real audit trail.

### Admin auth (pragmatic)

- Username + PIN checked server-side in Apps Script. PIN stored as SHA-256 with per-user salt.
- On success the server returns a session token (random UUID) stored in the Users sheet with a 12-hour expiry.
- All admin API calls include the token; the server validates on every call.
- This is pragmatic security appropriate for an internal tool on MOH Google Workspace, not bank-grade auth. The Sheet itself is private to the TOP team account.

### Non-negotiable server-side rules

1. **Every gate is enforced in Apps Script, never in browser JS.** The frontend is public on GitHub — anyone can read `dashboard.js` and call the endpoint directly. A check that lives only in the browser is decorative.
2. **`getDashboardPublic` must be structurally incapable of returning a patient row**, even when called with a valid code. It aggregates server-side and returns only computed numbers. This is the primary safety property; the code is the secondary one.
3. **No patient data in URLs, query strings, or the confirmation screen.** The confirmation shows the referral ID only.

## 5. Architecture

```
Browser (mobile-first, staff + admin)
   │
   ▼
Frontend — GitHub Pages (static HTML + CSS + vanilla JS, no build step)
   │  fetch() JSON over HTTPS, Content-Type: text/plain
   ▼
Backend — Google Apps Script Web App (single URL, action router)
   │
   ├─▶ Google Sheets      = database
   ├─▶ sendAlert() fan-out ─┬─▶ Gmail (MailApp)        — reliable baseline
   │                        ├─▶ Google Chat webhook    — instant push
   │                        └─▶ WhatsApp (CallMeBot)   — optional, pilot
   ├─▶ Google Drive       = education video/PDF hosting
   └─▶ Time-driven trigger = escalation for unacknowledged referrals
```

### Key architectural rules

- Frontend is **statically hosted** — no server-side rendering, no build step, no bundler. GitHub Pages serves the files in the repo exactly as they are. Vanilla HTML/CSS/JS, mobile-first.
- "Static" describes hosting, not the interface. Once the files reach the browser, animation and interactivity are fully in scope — see §9.1. What is excluded is anything requiring compilation (Sass, Tailwind CLI, JSX, a bundler), because that is what keeps deployment to "push to GitHub".
- All dynamic data flows through ONE Apps Script Web App URL with an `action` parameter routing to handlers.
- Deployed as: Execute as **Me** (TOP team account), accessible to **Anyone with the link**.
- CORS is handled by returning `ContentService` JSON and POSTing `text/plain` bodies from the frontend to avoid preflight. `ContentService` cannot set CORS headers, so this is mandatory, not stylistic.
- **`sendAlert(referral)` is one function that fans out to channel senders.** Each channel — `sendEmail()`, `sendChat()`, `sendWhatsApp()` — has an identical signature and is individually swappable. A channel failure must never block the others or fail the submission.
- Config values (Apps Script URL) live in a single `config.js` in the frontend.

### Why Google Chat is the primary push channel

CallMeBot is a free personal-use relay operated by one individual. Routing hospital referral alerts through it makes an unaccountable third party a critical dependency. Google Chat gives instant phone push notification, stays inside MOH Workspace, costs nothing, and is a two-line `UrlFetchApp.fetch()` POST to a space webhook. **Gmail is the reliability baseline, Chat is the speed layer, WhatsApp is a bonus.** If Chat performs well in testing, WhatsApp can be dropped from the critical path entirely.

## 6. Features

### 6.1 Referral Form — Open tier

Mobile-first single page. Fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| Ward / Location | dropdown | ✔ | from Config sheet `wardList` |
| Bed number | text | ✔ | |
| Patient name | text | ✔ | |
| IC number | text | ✔ | validate 12-digit MyKad; allow old format / passport |
| RN (registration number) | text | ✔ | |
| Date & time of death | datetime | ✔ | default = now; live "time since death" display |
| Exclusion screen | 4 × Yes/No | ✔ | transmissible viral disease / high-risk behaviour, malignancy, sepsis, uncontrolled systemic illness |
| Pledger card? | Yes/No/Unknown | ✔ | |
| Family aware / approached? | Yes/No/Not yet | ✔ | |
| Referring staff name | text | ✔ | |
| Contact (ext / phone) | text | ✔ | |
| Notes | textarea | ✘ | |

Behaviour:

- Submit → POST → append to Referrals sheet with status `NEW` → fire `sendAlert()` → confirmation screen showing referral ID and *"TOP Team telah dimaklumkan. Terima kasih, Wira Tisu!"*
- **Any exclusion = Yes still submits.** The flag is surfaced prominently in the alert. Final eligibility is ALWAYS the TOP team's decision — the app never auto-rejects.
- Prominent elapsed-time indicator: the 4-hour golden serology window, counting from time of death.
- Optional ward access code (Config `wardCode`) checked server-side before accepting the submission — stops prank and accidental submissions from a photographed poster. Enable via Config; off by default.

### 6.2 Alerting & Escalation — Backend

On new referral, `sendAlert()` fires to all Users with `oncall = Y`.

**Identifier-light message format — no name, no IC:**

```
🚨 RUJUKAN PENDERMA BERPOTENSI
Wad: {ward} | Katil: {bed} | RN: {rn}
Masa kematian: {timeOfDeath}
⏳ {elapsed} sejak kematian — baki tempoh emas serologi: {remaining}
Skrin eksklusi: {flags summary}
Hubungi: {staffName} ext {ext}
Buka app untuk akui: {adminUrl}
```

Full patient details are viewable inside the app only.

**Escalation:** time-driven trigger every 5 minutes. Any referral still `NEW` after `escalationMinutes` (default 15) → re-alert with a `⚠️ BELUM DIAKUI` prefix. Max 3 repeats, then status `ESCALATION_EXHAUSTED`.

**Channels:**

| Channel | Role | Implementation |
|---|---|---|
| Gmail | Baseline, always on | `MailApp.sendEmail()` |
| Google Chat | Primary push | `UrlFetchApp.fetch()` to space webhook, URL in Config |
| WhatsApp | Optional | CallMeBot per-user key in Users sheet; upgrade path is Meta Cloud API behind the same `sendWhatsApp()` signature |

### 6.3 Education Hub — Open tier

- Content from the `Education` sheet: title, description, type (`video` | `pdf`), Drive file ID, category, sortOrder, active.
- Videos: `<iframe src="https://drive.google.com/file/d/{FILE_ID}/preview" allow="autoplay">`. Drive handles streaming.
- PDFs: same `/preview` iframe plus a "Muat turun" button → `https://drive.google.com/uc?export=download&id={FILE_ID}`.
- Categories: Siapa Boleh Derma · Persediaan Jenazah (4 Langkah) · Dialog Pendermaan · Proses & Carta Alir · Umum/FAQ.
- Sticky **"🚨 RUJUK KES SEKARANG"** button on every education view, linking to the referral form.
- Admin can add/edit/deactivate content from the admin panel. No redeployment needed.

### 6.4 Dashboard — Coded tier

Aggregate statistics, Chart.js from CDN, filterable by month.

- Total referrals (month / YTD); referrals by ward (bar)
- Median time-to-acknowledge; median time from death to referral (KPI cards)
- Conversion funnel: Referred → Acknowledged → Family approached → Consented → Procured
- Refusal reasons breakdown (doughnut)
- Tissue procured counts (kornea, injap jantung, tulang, kulit)

**Small-numbers privacy rule.** At under 50 referrals a month, a chart reading *"Wad 7B — 1 referral, not proceeded, reason: religious beliefs, 17 August"* identifies a specific deceased patient to anyone who worked that ward. Therefore:

- Report by **month**, never by date.
- **Never cross-tabulate.** Refusal reasons hospital-wide only. Ward figures are bare counts — never ward × outcome, never ward × reason.
- Suppress any ward with a count below 5 into an "Lain-lain" bucket.
- `<meta name="robots" content="noindex">` plus a `robots.txt` disallow on the whole site.

**Governance check before go-live:** confirm with hospital management or NTRC whether there is any rule about who may publish procurement figures. This is a governance question, not a technical one, and is worth asking before the dashboard is reachable.

**CSV export stays in the admin tier** — it carries identifiers.

### 6.5 Admin Panel — Admin tier

- **Login** → token session.
- **Referral inbox:** newest first, status chips (NEW / ACKNOWLEDGED / IN_PROGRESS / PROCURED / NOT_PROCEEDED). Tap → detail → actions:
  - Acknowledge (records `acknowledgedBy` + timestamp, stops escalation)
  - Update status & outcome
  - Record refusal reason (dropdown mirroring Death Audit Form categories: family did not accept death · religious beliefs · deceased's wishes unknown · differing family opinion · concern about mutilation · funeral delay · did not want deceased to suffer more · 3rd party intervention · not stated · others)
- **Education manager:** CRUD on the Education sheet.
- **Roster manager:** add/remove admins, set on-call flags, WhatsApp numbers, CallMeBot keys.
- **CSV export** for NTRC reporting.

## 7. Data Model (Google Sheets)

Spreadsheet `TOP_App_Database`, private to the TOP team account.

**Referrals** — id (`REF-20260817-001`), createdAt, ward, bed, patientName, icNo, rn, timeOfDeath, exclTransmissible, exclMalignancy, exclSepsis, exclSystemic, pledgerCard, familyApproached, staffName, contactExt, notes, status, acknowledgedBy, acknowledgedAt, outcome, refusalReason, escalationCount

**Users** — username, pinHash, salt, name, role, oncall, whatsappNumber, callmebotKey, sessionToken, tokenExpiry

**Education** — id, title, description, type, driveFileId, category, sortOrder, active

**AuditLog** — timestamp, actor, action, referralId, detail

**Config** — key/value: `wardList`, `escalationMinutes`, `maxEscalations`, `adminUrl`, `dashboardCode`, `wardCode`, `wardCodeEnabled`, `chatWebhookUrl`, `alertEmails`, `alertProvider`

## 8. API Contract

All requests `POST` JSON `{ action, token?, code?, payload }` → `{ ok: true, data }` or `{ ok: false, error }`.

| action | gate | purpose |
|---|---|---|
| `submitReferral` | none (+ wardCode if enabled) | create referral, fire alerts |
| `getEducation` | none | list active education items |
| `getConfigPublic` | none | ward list etc. — must not leak codes |
| `getDashboardPublic` | dashboardCode | aggregate stats only |
| `login` | none | returns token |
| `listReferrals` | token | inbox with filters |
| `updateReferral` | token | acknowledge / status / outcome |
| `getDashboardAdmin` | token | stats + row detail |
| `exportCsv` | token | NTRC export |
| `manageEducation` | token | CRUD education rows |
| `manageUsers` | token | CRUD users / roster |

`getConfigPublic` returns the ward list and app labels **only**. It must never return `dashboardCode`, `wardCode`, `chatWebhookUrl`, or `alertEmails`.

## 9. UI / Language

- Primary language **Bahasa Melayu**, English clinical terms where natural.
- Mobile-first. Admin panel also usable on desktop.
- Calm, clean design. Palette: green `#1B7A43` + white, echoing existing UPOH / Jom Ikrar materials.
- Large tap targets on the referral form — it will be used one-handed, at speed, under stress.
- Masthead: **WiraTisu — Rujukan Penderma TOP Team**

### 9.1 Motion

Animation is in scope and wanted. Static hosting does not constrain it — the browser's compositor drives motion regardless of how the files were served.

**Toolkit** (all zero-dependency): CSS transitions and `@keyframes`, CSS transforms, the Web Animations API, `requestAnimationFrame`, inline SVG animation, and the View Transitions API for cross-page navigation. Because this is a genuine multi-page site rather than an SPA, View Transitions give smooth page-to-page motion in a couple of lines of CSS, degrading to an instant swap where unsupported. Chart.js supplies its own entry animations on the dashboard.

**Motion budget differs sharply by page, and this is deliberate:**

| Page | Approach |
|---|---|
| Referral form | **Minimal and functional only.** Used one-handed, at speed, often at night, by someone who has just certified a death. Any motion that delays a tap works against the 60-second goal. No page-load flourishes, no staggered field reveals, no transition on submit beyond immediate feedback. |
| Landing, education hub | Polish is welcome. These are read at leisure, and a credible-feeling app is what persuades ward staff to use it at all — which is the secondary goal in §2. |
| Dashboard | Chart entry animations plus restrained transitions on filter changes. |
| Admin panel | Functional motion — status chip transitions, exit animation on acknowledge so a card leaving the inbox is visible rather than abrupt. |

**The one piece of motion the referral form must have:** the elapsed-time indicator against the 4-hour serology window. A draining ring or bar communicates urgency far better than a text string and earns the frames it costs.

**Accessibility (required, not optional):** wrap all decorative animation in `@media (prefers-reduced-motion: reduce)` and disable it there. Motion that carries information — the countdown — may remain, but should stop animating and simply display its current state. Build this in from the start; it is tedious to retrofit.

## 10. Repository Structure

```
top-team-app/
├── SPEC.md
├── README.md                ← setup & deployment guide
├── robots.txt
├── docs/                    ← GitHub Pages root (Settings → Pages → /docs)
│   ├── index.html           ← landing: Rujuk Kes / Edukasi / Papan Data / Admin
│   ├── refer.html
│   ├── education.html
│   ├── dashboard.html       ← ward-code gate
│   ├── admin.html
│   ├── qr.html              ← printable ward poster
│   ├── css/style.css
│   └── js/
│       ├── config.js        ← APPS_SCRIPT_URL constant
│       ├── api.js           ← fetch wrapper
│       └── refer.js · education.js · dashboard.js · admin.js
└── apps-script/
    ├── Code.gs              ← doGet/doPost router
    ├── Referrals.gs         ← referral logic + escalation trigger
    ├── Alerts.gs            ← sendAlert() fan-out + channel senders
    ├── Auth.gs              ← login, token validation, PIN hashing, code checks
    ├── Education.gs
    ├── Dashboard.gs
    ├── Setup.gs             ← initializeDatabase()
    └── appsscript.json
```

`Setup.gs` must include a one-time `initializeDatabase()` that creates the spreadsheet with all sheets, headers, a default admin user, and sample config. Deployment becomes: run one function → deploy web app → paste URL into `config.js` → push to GitHub.

## 11. Build Phases

| Phase | Scope | Done when |
|---|---|---|
| **1a** | `Setup.gs` + referral form + Sheet write + email alert | A phone submits a referral, a row appears, an email arrives |
| **1b** | Google Chat webhook + WhatsApp, behind `sendAlert()` | Push notification lands on an on-call phone |
| **2** | Auth, inbox, acknowledge, status updates, escalation trigger | Unacknowledged referral re-alerts after 15 min |
| **3** | Education hub + admin content manager | Ward staff can watch a video from the QR link |
| **4** | Dashboard (coded) + CSV export (admin) | Monthly figures render; NTRC export downloads |
| **5** | QR poster page, PWA manifest, dark mode, Meta Cloud API | — |

**Phase 1 is split deliberately.** 1a proves the whole pipe end-to-end using only Gmail, which is the most reliable channel and needs no external setup. Push channels come after there is something working to attach them to — so a CallMeBot or webhook problem can never block the core path.

## 12. Acceptance Criteria — Phase 1a

- [ ] Staff can submit a referral from a phone in under 60 seconds.
- [ ] Row appears in Referrals sheet with correct data, status `NEW`, and a unique sequential ID under concurrent submission.
- [ ] Backup email arrives within ~30 seconds, identifier-light.
- [ ] Time-since-death displays correctly on the form and in the alert.
- [ ] Works on Chrome and Safari mobile; degrades gracefully on hospital desktop browsers.
- [ ] No patient identifier appears in any URL, alert body, or confirmation screen.

## 13. Constraints & Implementation Notes

**Budget:** zero. GitHub Pages free, Apps Script free, Google Chat free, CallMeBot free, Meta Cloud API free tier.

**Volume:** under 50 referrals/month. Well inside every Apps Script quota.

**Apps Script gotchas — each of these costs an hour if hit blind:**

1. Editing code changes nothing until you deploy a **new version** (Manage deployments → edit → New version). Silent failure otherwise, and it is the single most common time sink.
2. Set `"timeZone": "Asia/Kuala_Lumpur"` in `appsscript.json`, not just on the Sheet.
3. Wrap referral append + ID generation in `LockService.getScriptLock()`. Two concurrent submissions will otherwise collide on the same sequential ID.
4. `ContentService` cannot set CORS headers — the `text/plain` POST body is mandatory. Set `redirect: 'follow'` on the fetch; Apps Script bounces to `googleusercontent.com`.
5. Dashboard reads the whole sheet once via `getDataRange().getValues()` and aggregates in Apps Script. Per-row `getRange()` calls will time out. Cache the aggregate in `CacheService` for ~5 minutes.
6. Time-driven triggers have a minimum interval of 1 minute; 5 minutes is right for escalation.
7. `MailApp` and `UrlFetchApp` failures must be caught individually — one dead channel must not fail the submission or block the other channels.

**Other:**

- Frontend dependencies must be loadable via a plain `<script src>` CDN tag with no install and no build step. Chart.js (dashboard) is the expected one; a small animation library such as Motion One is permitted if hand-written CSS proves limiting. Anything requiring `npm install` is out.
- All timestamps Asia/Kuala_Lumpur.
- Final donor eligibility is decided by the TOP team, never auto-rejected by the app.

## 14. Open Items

- [ ] Ward list — needed for Config `wardList`
- [ ] TOP team alert email address(es)
- [ ] Google Chat space created and webhook URL obtained
- [ ] Decision: enable the ward code on the referral form?
- [ ] Governance clearance for the coded dashboard
