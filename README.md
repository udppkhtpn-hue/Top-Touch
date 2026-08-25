# T.O.P. Touch (Sentuhan Keikhlasan)

**Touch of Promise — "Menghubungkan Keikhlasan, Menyelamatkan Nyawa."**

An organ & tissue donation **referral** platform for the Hospital TOP (Tissue & Organ
Procurement) Team, HTPN. Ward staff notify the TOP team of a potential donor from a
phone in under 60 seconds; the team gets an instant, **identifier-light** alert.
(Formerly prototyped as "WiraTisu".)

- **Frontend:** static HTML/CSS/vanilla JS on GitHub Pages (no build step).
- **Backend:** one Google Apps Script web app (`action` router).
- **Database:** Google Sheets.
- **Alerts:** Gmail baseline + Google Chat push, behind one `sendAlert()` fan-out;
  each stays off until configured. Both stay inside MOH Workspace. (WhatsApp was
  evaluated and dropped — every route runs through a non-MOH third party.)

> **Phase 1a + 1b** (this build): referral form → Sheet row → alert fan-out
> (email always, Chat when configured).
> Not yet built: admin panel, auth, dashboard, education hub, escalation trigger.
> Their router cases exist but return `not_implemented`.

---

## Repository layout

```
docs/                     ← GitHub Pages root (Settings → Pages → /docs)
  index.html              landing (video + loading %)
  refer.html              referral form
  css/style.css
  js/config.js            APPS_SCRIPT_URL + ward list  ← edit this
  js/api.js               fetch wrapper
  js/refer.js             form logic + serology ring
  img/  video/  fonts/    assets
  robots.txt
apps-script/              ← paste these into the Apps Script project
  Setup.gs                initializeDatabase()
  Code.gs                 doPost/doGet router + shared helpers
  Referrals.gs            submitReferral + sequential ID + lock
  Alerts.gs               sendAlert() fan-out (email + Google Chat)
  appsscript.json         timezone + scopes + web app config
SPEC.md
```

---

## Deploy from scratch

### 1. Create the database + backend (Google Apps Script)

1. Sign in as the account that should **own the data** (production: an official
   hospital/TOP account — the spreadsheet will hold patient names & IC).
2. Create a blank Google Sheet at **sheets.google.com**, name it `TOP_App_Database`.
3. **Extensions → Apps Script**. In the editor:
   - **Project Settings (⚙️)** → tick **“Show appsscript.json manifest file”**.
   - Replace `appsscript.json` with `apps-script/appsscript.json`.
   - Create script files **`Setup`, `Code`, `Referrals`, `Alerts`** and paste in the
     matching `.gs` contents. **Save (Ctrl+S).**
4. Run **`initializeDatabase`** once (function dropdown → Run). Authorize when asked
   (Spreadsheets, Send email, External requests). This builds all five sheets, a
   default admin user, and sample Config.
5. In the **Config** sheet, confirm/edit:
   - `wardList` — the ward dropdown source of truth.
   - `alertEmails` — comma-separated recipients of the Gmail alert.
   - `wardCodeEnabled` — `false` (default) means no code required on the form.

   Optional editor test: run **`testSubmitReferral`** — it writes a fake row and
   sends a test email. Check the Referrals sheet and the inbox.

#### Phase 1b — Google Chat push (optional, config-only — no redeploy)

Off until you fill in the Config sheet. Not a code change.

- In the target Chat space → **Apps & integrations → Webhooks → Add** → copy the
  URL into Config `chatWebhookUrl`. Verify with the editor helper **`testSendChat`**
  — a test message should land in the space. Blank URL = channel off.

> WhatsApp was evaluated as a push channel and dropped: every route (CallMeBot or
> Meta's WhatsApp Cloud API, direct or via a BSP) runs through a non-MOH third
> party, a data-governance concern for patient detail. Email + Chat both stay
> inside MOH Workspace.

### 2. Deploy the web app

1. **Deploy → New deployment** → gear ⚙️ → **Web app**.
2. **Execute as: Me** · **Who has access: Anyone** → **Deploy** → authorize.
3. Copy the **Web app URL** (ends in `/exec`).
   - Sanity check: open it in a browser → `{"ok":true,...}` (health check).

> ⚠️ **After editing any `.gs` file you must redeploy a NEW VERSION**
> (Manage deployments → edit ✏️ → Version: New version → Deploy), or the live URL
> keeps running the old code. The URL itself stays the same.

### 3. Wire up and publish the frontend

1. In `docs/js/config.js`, set `APPS_SCRIPT_URL` to the `/exec` URL from step 2.
   Keep `WARD_GROUPS` in sync with the Config sheet `wardList` if wards change.
2. Push the repo to GitHub.
3. **Repo Settings → Pages** → Source: **Deploy from a branch**, branch `main`,
   folder **`/docs`** → Save. Your site appears at
   `https://<user>.github.io/<repo>/`.
4. Open `.../refer.html` on a phone and submit a test referral.

---

## Key behaviours & safeguards (Phase 1a)

- **Full detail in the internal alerts** (owner decision — staff-only tool). The
  Gmail/Chat alert carries the same fields as the form: patient name, IC, ward, bed,
  RN, time of death, exclusion flags, notes, and staff contact. Both channels stay
  inside MOH Workspace. Patient identifiers are still kept **out of** URLs, query
  strings, and the confirmation screen (which shows the referral ID only).
  *Amends the identifier-light alert rule in SPEC §6.2.*
- **Never auto-rejects.** An exclusion answered “Ya” still submits; the flag is
  surfaced in the alert. Final eligibility is always the TOP Team’s clinical decision.
- **Concurrent-safe IDs.** ID generation + row append run inside `LockService`, so two
  simultaneous submissions can’t collide on the sequential `REF-YYYYMMDD-NNN` id.
- **Alerts never fail the submission.** The row is written first; each alert channel is
  wrapped in its own try/catch.
- **Serology countdown.** The form shows a live draining ring against the 4-hour
  serology window, counting from the entered time of death.
- **Timezone** is `Asia/Kuala_Lumpur` in both `appsscript.json` and the spreadsheet.

## Assets

Optimised images belong in `docs/img/` (originals kept at the repo root, untouched).
Replace `docs/img/*.jpg` with smaller versions using the **same filenames** — no code
change needed. Landing videos: `docs/video/organ-donation.mp4` (hero) and
`docs/video/mo-timelapse.mp4`.

**Fonts** are self-hosted (no CDN, per the restricted-network constraint):
`docs/fonts/BricolageGrotesque.woff2` (display) and `docs/fonts/HankenGrotesk.woff2`
(body), both OFL-licensed variable fonts. They're committed with the repo — nothing to
fetch at deploy time. If missing, the CSS falls back to a grotesque system stack.

## Configuration reference (Config sheet)

| key | meaning |
|---|---|
| `wardList` | comma-separated ward options (mirror of `config.js`) |
| `escalationMinutes` | Phase 2 escalation delay (default 15) |
| `maxEscalations` | Phase 2 max re-alerts (default 3) |
| `adminUrl` | link shown in alerts to open the app (set after Pages is live) |
| `dashboardCode` | Phase 4 coded-dashboard gate |
| `wardCode` / `wardCodeEnabled` | optional anti-spam code on the form (off by default) |
| `chatWebhookUrl` | Google Chat space incoming-webhook URL (blank = channel off) |
| `alertEmails` | Gmail alert recipients (comma-separated) |
| `alertProvider` | active baseline channel (`email`) |

## Security note

Admin auth, the coded dashboard, and CSV export are later phases. Until then, only the
write-only referral path and the landing page are live. Every access gate is enforced
server-side in Apps Script — never trust the public frontend JS.
