# DASHBOARD\_PLAN.md — T.O.P. Touch

**Status:** current work (SPEC v2.0 Phase 4, extends §6). **Read `CLAUDE.md` first** — the governance rules there are binding for everything below. **Precedence:** where README, SPEC v2.0, and this file differ, the newer wins (README \> SPEC v2.0).

---

## 0\. Where each surface lives (SPEC v2.0 §4 access model)

The daily job of a TOP coordinator is driven by **time windows closing on live cases**, not by monthly charts. But the three-tier access model dictates where each surface can live:

| Surface | Gate | Endpoint | Data |
| :---- | :---- | :---- | :---- |
| **Coded Dashboard** (`dashboard.html`, "Papan Data") | shared `dashboardCode`, server-checked | `getDashboardPublic` | **aggregate counts only — never a patient row** |
| **Admin Live Cockpit \+ inbox** (`admin.html`) | username \+ PIN → token | `getDashboardAdmin`, `listReferrals` | full per-case detail, identifiers, CSV |

So: the aggregate analytics are the **coded** surface (visible to ward staff \+ TOP team); the identifiable **live operations cockpit** is an **admin-tier** feature, audited. These are two different builds with different endpoints — do not merge them.

The clinical windows that make the cockpit the operational priority (SPEC §1; Cornea SOP §2.2, §3.3; DCD checklist): **serology blood ≤ 4 h**, **cornea ≤ 12 h**, **valve/skin/bone ≤ 24 h**, serology **results back \~ 1 h**.

---

## 1\. Coded Dashboard  (`getDashboardPublic`, aggregate-only)

Behind `dashboardCode`. **Primary safety property: structurally incapable of returning a patient row** — it computes numbers server-side and returns only numbers, even with a valid code. All tiles below are aggregate. Date-range filterable.

Tiles:

- **Referral volume** — month / YTD, trend line, and **by ward** (bar). By-ward is the education-targeting signal (which wards refer, which never do).  
- **Time death → referral** — median, trended monthly. The real outcome measure.  
- **Time to acknowledge** — median. TOP-team responsiveness KPI.  
- **Conversion funnel** — Referred → Acknowledged → Family approached → Consented → Procured.  
- **Refusal reasons** — doughnut, using the **Death Audit Form** categories exactly (family did not accept death, religious beliefs, deceased's wishes unknown, differing family opinion, concern about mutilation, funeral delay, did not want deceased to suffer more, 3rd-party intervention, not stated, others).  
- **Tissue yield** — counts of kornea / injap jantung / tulang / kulit per period.  
- **Exclusion-flag patterns** — how often each of the 4 criteria is flagged, and how often flagged cases still proceed (quantifies "jangan tapis sendiri").

Governance (strengthens the row-incapable property — a bare count can still re-identify):

- **Small-cell suppression:** any count `< smallCellThreshold` (Config, default 5\) is returned as `null` with `suppressed:true`; UI renders "\<5" or hides it. Never a single-case figure.  
- **No cross-tabs:** one-dimensional breakdowns only. Never ward × outcome × refusal reason.  
- `noindex` meta \+ `robots.txt` on the page (robots.txt already exists at repo root).  
- **No public publication until institutional clearance is confirmed** (SPEC §14 open item).

Performance (SPEC §13.5): read the sheet once via `getDataRange().getValues()`, aggregate in Apps Script, cache the result \~5 min in `CacheService`. No per-row `getRange()`.

---

## 2\. Admin Live Operations Cockpit  (`getDashboardAdmin` / `listReferrals`, token)

Inside the admin panel. Token required; **write one AuditLog row per view.** Poll \~30–60 s.

### C1. Active case board (pipeline)

Open referrals as cards grouped by phase (mirrors DCD checklist \+ Peta Misi): `NEW → ACKNOWLEDGED → SEROLOGI → PELEPASAN PERUNDANGAN → PEROLEHAN → JENAZAH DIPULANGKAN → SELESAI`. Card: ward, bed, time-of-death, elapsed, phase, owner. Tap → detail.

### C2. Live window countdowns  *(highest-value tile)*

Per case, three shrinking bars — serology ≤4h, cornea ≤12h, musculoskeletal/valve ≤24h — colour-shifting **green → amber → red**, sorted **most-urgent-first**. When `bloodTakenAt` is set, the 4h bar resolves. Informational motion: keep the countdown readable under `prefers-reduced-motion` (stop animating, still show remaining time).

### C3. Exceptions strip — "what is wrong right now"

- Unacknowledged past `escalationMinutes`  
- Serology sent but no result after \~60 min (`serologyResultAt` empty, blood taken \>1h)  
- Any exclusion toggle \= Ya awaiting TOP clinical review  
- Medico-legal case awaiting IO / magistrate (`medicoLegal = Y`, not cleared)  
- Any window \< 30 min from closing with no procurement scheduled

### C4. On-call & coordination readiness

Who's on call \+ backup. Per case, live checkboxes for the DCD-checklist coordination steps: NTRC informed; procurement teams alerted (Ophthal / Ortho / Plastic / IJN); OT alerted; forensics alerted; ice & consumables ready; family resting area.

---

## 3\. Data model additions (Referrals sheet)

Add these columns (update `Setup.gs` → `initializeDatabase()` headers \+ write logic). ISO, Asia/Kuala\_Lumpur.

| Column | Purpose |
| :---- | :---- |
| `bloodTakenAt` | resolves the 4h serology window |
| `serologyResultAt` | flags "result overdue" in C3 |
| `medicoLegal` | Y/N — gates the medico-legal exception |
| `teamAlertedOphthal` / `Ortho` / `Plastic` / `IJN` | C4 readiness |
| `otAlerted` / `forensicsAlerted` | C4 readiness |
| `phase` | pipeline phase for C1 (stored or derived from status/timestamps) |
| `tissueCornea` / `tissueValve` / `tissueBone` / `tissueSkin` | per-tissue outcome for yield |
| `familyApproachedAt` / `consentedAt` | funnel timing |

**Config:** `dashboardCode` already exists (the coded gate). **Add** `smallCellThreshold` (default `5`).

---

## 4\. API additions (names per SPEC v2.0 §8)

### `getDashboardPublic` — gate: **dashboardCode**

Aggregates server-side; suppression applied **before** returning (suppressed values leave the server as `null`, never the real number). Structurally cannot select/return a row.

```json
{ "action":"getDashboardPublic", "code":"...", "payload":{"from":"2026-08-01","to":"2026-08-31"} }
→ { "ok":true, "data": {
  "volume": { "monthToDate":23, "ytd":181, "trend":[{"month":"2026-08","count":23}] },
  "byWard": [ {"ward":"Wad 7B (WCC)","count":9}, {"ward":"ICU (Main)","count":null,"suppressed":true} ],
  "timeToReferMedianMin": 95,
  "timeToAckMedianMin": 12,
  "funnel": {"referred":23,"acknowledged":21,"familyApproached":18,"consented":11,"procured":9},
  "refusalReasons": [ {"reason":"Deceased's wishes unknown","count":5} ],
  "tissueYield": {"cornea":7,"valve":null,"bone":null,"skin":null},
  "exclusionFlags": {"transmissible":2,"malignancy":3,"sepsis":null,"systemic":null,"proceededDespiteFlag":6},
  "meta": {"smallCellThreshold":5,"cachedAt":"2026-08-27T12:00:00+08:00"}
} }
```

### `getDashboardAdmin` — gate: **token**

Stats \+ per-case live detail for the cockpit (identifiers allowed; view is audited).

```json
{ "action":"getDashboardAdmin", "token":"..." }
→ { "ok":true, "data": { "cases": [
  { "id":"REF-20260827-001", "ward":"Wad 7B (WCC)", "bed":"12",
    "patientName":"...", "icNo":"...",
    "timeOfDeath":"2026-08-27T03:10:00+08:00", "elapsedMin":48, "phase":"SEROLOGI",
    "windows":{
      "serology":{"limitMin":240,"remainingMin":192,"resolved":false},
      "cornea":{"limitMin":720,"remainingMin":672,"resolved":false},
      "musculoskeletal":{"limitMin":1440,"remainingMin":1392,"resolved":false}
    },
    "flags":{"exclAny":true,"medicoLegal":false,"serologyOverdue":false,"unackEscalated":false},
    "acknowledgedBy":"...", "owner":"..." }
] } }
```

---

## 5\. OPEN DECISION — Chart.js: CDN vs self-hosted

Conflict in the source docs:

- **SPEC §13:** "Frontend dependencies must be loadable via a plain `<script src>` CDN tag … Chart.js (dashboard) is the expected one."  
- **README:** fonts are **self-hosted, "no CDN, per the restricted-network constraint."**

If the hospital network blocks external CDNs (as the self-hosted fonts imply), a CDN Chart.js will fail on the ward/hospital browsers that most need the dashboard.

**Default in this plan: vendor Chart.js locally** — commit `docs/js/vendor/chart.umd.min.js` and load it with a local `<script src>`, exactly as the fonts are handled. No build step; it's still a plain script tag. **Confirm with Fairis before building the dashboard page.** (If a local Chart.js feels heavy, the aggregate tiles are simple enough to draw with inline SVG \+ the zero-dependency motion toolkit, which sidesteps the question entirely.)

---

## 6\. Build sequence

1. **Data model** — add the Referrals columns \+ `smallCellThreshold`; update `Setup.gs`. Don't touch the referral critical path.  
2. **Resolve §5** — confirm Chart.js hosting (vendor vs CDN vs inline SVG).  
3. **Coded dashboard backend** — `getDashboardPublic` in a new `Dashboard.gs`: aggregate via one `getDataRange().getValues()`, apply suppression \+ the no-cross-tab rule, cache \~5 min. Verify it cannot return a row.  
4. **Coded dashboard page** — `dashboard.html` behind the `dashboardCode` gate; tiles from §1; `noindex` \+ robots.txt; chart entry animation \+ reduced-motion.  
5. **Auth dependency** — the cockpit needs the admin login/token system (SPEC Phase 2). If it isn't built, build `Auth.gs` (login, token, PIN hashing, code checks) first.  
6. **Admin cockpit** — `getDashboardAdmin`; pipeline, window countdowns, exceptions, readiness; token-gated; AuditLog per view; poll 30–60 s.  
7. **CSV export** — `exportCsv` (token) for NTRC.  
8. **Governance pass** — confirm no coded view renders a single-case figure or a re-identifying cross-tab, and the coded endpoint has no code path that returns a row.

---

## 7\. Acceptance criteria

- [ ] `getDashboardPublic` returns only numbers — no code path can return a patient row — and every count `<5` is suppressed server-side; no ward × outcome × reason cross-tab exists.  
- [ ] Coded dashboard reachable only with a valid `dashboardCode`; `noindex` \+ robots.txt present.  
- [ ] Aggregation reads the sheet once and caches \~5 min; no per-row range calls.  
- [ ] Admin cockpit lists all open cases; window bars count down and re-colour green→amber→red; `bloodTakenAt` resolves the serology bar; the five C3 exceptions fire correctly.  
- [ ] Every admin cockpit view writes an AuditLog row; no admin data returns without a valid token.  
- [ ] CSV export matches on-screen filtered aggregates.  
- [ ] Referral form load/submit time unchanged; reduced-motion honoured.

