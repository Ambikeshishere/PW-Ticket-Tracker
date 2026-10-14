# PW Analytics Ticket Portal

A ticket / request tracking portal for the PW Analytics team.

- **Front-end** — a plain static site (HTML + CSS + vanilla JS) at the repo root.
  Host it anywhere (GitHub Pages, S3, `python3 -m http.server`). No build step.
- **Back-end** — a Google Apps Script **JSON API** in `backend/`, deployed as a
  Web App and backed by a Google Sheet (the Sheet *is* the database).
- **No demo mode** — login is real email OTP; nothing is faked in the UI.

> **Hinglish quick summary:** Front-end repo root me hai (`index.html`, `styles.css`,
> `js/`). Back-end `backend/` me hai — ek Apps Script Web App jo JSON API deta hai
> (`{api, token, payload}` → `{ok, data|error}`). Sheet ke 11 tabs database hain.
> Login email-OTP se, session token hash banake `Sessions` tab me. Roles:
> USER / CBA / ANALYST / ADMIN. Ticket raise → CBA assign → ANALYST kaam → USER
> close. External approval email link se, reassignment CBA approval se.

---

## 1. File map

### Front-end (repo root — deploy this to GitHub Pages)

| File | Responsibility |
|------|----------------|
| `index.html` | The SPA shell: auth screen, app shell, approval screen, drawer/modal/toast containers. Loads `js/config.js` first. |
| `styles.css` | All CSS (light + dark theme via CSS variables). |
| `js/config.js` | **The only file you edit to point the portal at your backend.** Sets `window.PW_CONFIG.API_URL`. |
| `js/api.js` | Network client. `API.call(name, payload)` → POSTs JSON to `API_URL` (as `text/plain`), falls back to JSONP GET. Holds the session token. |
| `js/ui.js` | The whole UI: auth wiring, role-based nav, every view, ticket drawer, modals, approval page. |
| `js/api.local.js` | A localStorage-backed implementation of the same `API.call` surface — kept as an offline reference / used by `dev/web-test.js`. **Not loaded by `index.html`.** |
| `js/store.js` | Legacy localStorage DB + seed (pre-API prototype). **Not loaded by `index.html`.** |

### Back-end (`backend/` — deploy with `clasp`)

| File | Responsibility |
|------|----------------|
| `Api.gs` | Web-app entry points (`doGet`/`doPost`), the **JSON router** `handle()`, `PUBLIC_API` / `PRIVATE_API` maps, `api()` wrapper, `ensureSetup_()` lazy bootstrap, `clean_()`, sheet menu. |
| `Config.gs` | `SHEET_ID`, `PORTAL_URL`, sheet names (`SHEETS`), roles, statuses, priorities, `DEFAULT_CONFIG`, `cfg()` / `cfgNum()` / `setCfg()`, `slaDueDate()`. |
| `Db.gs` | The **only** code that touches the Sheet (`Db` object) + shared helpers (`withLock`, `now`, `addHours`, `toMs`, `sha256`, `randomToken`, `randomOtp`, `normEmail`, `escHtml`, `portalUrl`, `logErr`). |
| `Setup.gs` | One-time provisioning: `portalHeaders_()`, `setup()`, `authorize()`, `seedConfig_()`, `seedAdmin_()`. |
| `Auth.gs` | `Auth` object: signup, OTP request/verify, sessions, `requireSession`, `logout`, `publicUser`, `logActivity`. |
| `Tickets.gs` | `Tickets` object: visibility, create, list, get, assign, status flow, close/reopen/rate, comments, dashboard. |
| `Approvals.gs` | `Approvals` object: external email approval request, public `getInfo`, public `decide`, token lookup. |
| `Reassign.gs` | `Reassign` object: analyst→analyst reassignment request, list, CBA/admin decision. |
| `Admin.gs` | `Admin` object: public clusters, team workload, user/cluster CRUD, analytics, activity ranking, CSV export. |
| `Triggers.gs` | Time-driven jobs: `setupTriggers()`, `dailyReminders()`, `hourlySlaCheck()`, `cleanupExpired()`. |
| `Mail.gs` | All outbound email (`sendMail`, `shell`, `kvTable`, `button`, and every workflow mail). |
| `appsscript.json` | Manifest: timezone, V8 runtime, OAuth scopes, web-app access. |
| `.clasp.json` | `clasp` project binding (`scriptId`). |

**Load-order note:** Apps Script runs every file's top-level code in an arbitrary
order, so all cross-file tables are built **inside functions** (e.g.
`portalHeaders_()`, `PUBLIC_API` closures) and resolved at call time.

---

## 2. Data model — the 11 tabs

Created automatically by `setup()` (or lazily on the first API call). Headers are
defined in `Setup.gs` (`portalHeaders_()`).

### `Users`
`UserID, Name, Email, Phone, Department, DefaultPriority, Role, ClusterID, ReportsTo, Status, CreatedAt, LastLoginAt`
- `Role` ∈ `USER | CBA | ANALYST | ADMIN`.
- `Status` ∈ `ACTIVE | INACTIVE`.
- `ClusterID` links a user to a cluster (used for CBA/ANALYST scoping).
- `ReportsTo` is the CBA email an analyst reports to (informational).

### `Clusters`
`ClusterID, ClusterName, CBA_Email, Status`
- One row per business cluster. `CBA_Email` is the Cluster Business Analyst who
  triages tickets raised in that cluster.

### `Tickets`
`TicketID, Title, Description, Category, Priority, Status, RaisedByEmail, RaisedByName, RaisedByPhone, Department, ClusterID, CBA_Email, AnalystEmail, ApprovalRequired, ApprovalStatus, ApprovedBy, AttachmentLinks, DueAt, CreatedAt, UpdatedAt, ResolvedAt, ClosedAt, Rating, Feedback`
- `TicketID` format: `TKT-<year>-00001`.
- `ApprovalStatus` ∈ `NONE | PENDING | APPROVED | REJECTED`.
- `AttachmentLinks` is a comma-separated list of URLs (Phase 2).

### `TicketLogs`
`LogID, TicketID, Action, ByEmail, ByRole, OldValue, NewValue, Note, Timestamp`
- Append-only audit trail. Every meaningful change writes one row.

### `Comments`
`CommentID, TicketID, ByEmail, ByName, Text, Timestamp`

### `Approvals`
`ApprovalID, TicketID, RequestedByEmail, ApproverEmail, TokenHash, Status, RequestNote, DecisionNote, RequestedAt, ExpiresAt, DecidedAt`
- `TokenHash` = `sha256(rawToken)` — the raw token only ever lives in the email link.

### `ReassignRequests`
`ReqID, TicketID, FromAnalyst, ToAnalyst, Reason, Status, CBA_Email, DecisionNote, RequestedAt, DecidedAt`

### `OTP`
`Email, OtpHash, ExpiresAt, Attempts, CreatedAt`
- `OtpHash` = `sha256(code + '|' + email + SALT)`.

### `Sessions`
`TokenHash, Email, Role, CreatedAt, ExpiresAt, LastSeenAt`
- `TokenHash` = `sha256(rawToken + SALT)`.

### `ActivityLog`
`Timestamp, Email, Role, Event, Meta`
- High-level analytics events (`LOGIN`, `TICKET_CREATE`, `ASSIGN`, `COMMENT`, …).

### `Config`
`Key, Value`
- Runtime settings, editable without touching code. See §9.

---

## 3. Roles & permissions

| Capability | USER | ANALYST | CBA | ADMIN |
|---|:--:|:--:|:--:|:--:|
| Sign up (self) | ✅ | – | – | – |
| Raise a ticket | ✅ | – | – | ✅ |
| See tickets | own only | assigned only | own cluster | all |
| Assign analyst | – | – | ✅ | ✅ |
| Move status | – | own tickets | cluster | ✅ |
| Request external approval | – | – | ✅ | ✅ |
| Request reassignment | – | own tickets | – | – |
| Approve reassignment | – | – | ✅ | ✅ |
| Close / reopen / rate | own | – | – | ✅ |
| Manage users / clusters | – | – | – | ✅ |
| Analytics / activity / CSV | – | – | – | ✅ |

Visibility is enforced in one place: `Tickets.canSee(user, ticket)`.
Role checks are enforced in one place: the `roles` array on each `PRIVATE_API` route.

---

## 4. Auth flow (`Auth.gs`)

### Sign-up
1. Client posts name, email, phone, department, cluster, default priority.
2. Server validates: email format, **domain must equal `ALLOWED_DOMAIN`** (`pw.live`),
   email not already registered, name present, phone matches `^[6-9]\d{9}$`,
   department present, cluster (if given) exists.
3. **Role is always forced to `USER`** — a client-supplied role is ignored.
4. Inserts the user, logs `SIGNUP`, sends a welcome mail.

### Login (email OTP)
1. `requestOtp(email)`:
   - Rate-limited to one OTP per `OTP_RESEND_SEC` (60s) window.
   - **Email-enumeration guard:** for unknown/inactive emails it returns a generic
     success message and sends nothing.
   - For real users: generates a 6-digit OTP, stores `sha256(otp + '|' + email + SALT)`
     with an expiry, emails the code.
2. `verifyOtp(email, code)`:
   - Rejects if no OTP record, if expired, or if `Attempts >= OTP_MAX_ATTEMPTS`.
   - Wrong code → increments `Attempts` and reports attempts left.
   - Correct code → deletes the OTP, updates `LastLoginAt`, creates a session,
     logs `LOGIN`, returns `{ token, user }`.

### Sessions
- `createSession` stores `sha256(token + SALT)` with an expiry (`SESSION_HOURS`, default 12h).
- `requireSession(token)` is called by the router for every private endpoint:
  validates the hash, checks expiry, loads the user, checks `Status = ACTIVE`,
  and refreshes `LastSeenAt` at most once per `SILENT_SESSION_MIN` minutes.
- `logout` deletes the session row. `killSessions(email)` nukes all sessions for a
  user (used when an admin changes a user's role or status).

**Nothing sensitive is stored in plain text** — OTPs and session tokens are hashed
with a per-deployment `SALT`.

---

## 5. The API contract (`Api.gs`)

The front-end only ever calls one function: `API.call(name, payload)` in `js/api.js`.

### Transport
```
POST  <API_URL>            body: {"api":name,"token":"..","payload":{..}}
GET   <API_URL>?api=..&token=..&payload=<json>&callback=cb     (JSONP fallback)
```
- The POST body is sent as `Content-Type: text/plain;charset=utf-8` so the browser
  treats it as a **simple request** and skips the CORS pre-flight (Apps Script
  cannot answer `OPTIONS`).
- The JSONP GET form is the fallback where POST is blocked.
- Opening `API_URL` in a browser shows a small info page linking to the portal.

### Response
Every call returns `{ ok: true, data }` or `{ ok: false, error }`.

### Routes
- **`PUBLIC_API`** — no session needed: `signup`, `requestOtp`, `verifyOtp`,
  `getClusters`, `getApproval`, `decideApproval`.
- **`PRIVATE_API`** — each entry is `{ fn, roles }`. The router calls
  `Auth.requireSession(token)`, checks `roles.indexOf(user.Role)`, then runs
  `fn(user, payload)`.

Private routes: `logout`, `me`, `createTicket`, `listTickets`, `getTicket`,
`addComment`, `assignTicket`, `updateStatus`, `closeTicket`, `reopenTicket`,
`rateTicket`, `myAnalysts`, `requestApproval`, `requestReassign`, `listReassign`,
`decideReassign`, `teamWorkload`, `adminUsers`, `adminSaveUser`, `adminClusters`,
`adminSaveCluster`, `adminAnalytics`, `adminActivity`, `adminExportCsv`, `dashboard`.

### Lazy bootstrap
`handle()` calls `ensureSetup_()` first. On a brand-new deployment the very first
API call runs `setup()` once (guarded by the script property `SETUP_DONE` + a
`LockService` lock), so the Sheet is provisioned automatically — nobody has to
open the editor just to run `setup()`.

---

## 6. Ticket lifecycle (`Tickets.gs`)

### Status machine
```
NEW ──assign──▶ ASSIGNED ──start──▶ IN_PROGRESS ──resolve──▶ RESOLVED ──close──▶ CLOSED
                    ▲                    │  ▲                                          │
                    │                    │  └── resume ── ON_HOLD ◀── hold ────────────┘
                    │                    └── request approval ──▶ PENDING_APPROVAL
                    └────────────── reopen ◀── REOPENED ◀── reopen (owner)
```
- `updateStatus` enforces an allowed-transition map for ANALYST/CBA:
  `ASSIGNED→IN_PROGRESS`, `IN_PROGRESS→{ON_HOLD,RESOLVED}`, `ON_HOLD→IN_PROGRESS`,
  `PENDING_APPROVAL→IN_PROGRESS`, `REOPENED→{IN_PROGRESS,ASSIGNED}`, `NEW→IN_PROGRESS`.
- Only the **requester** (or admin) can close/reopen/rate (`mustOwn`).
- `close` requires status `RESOLVED`; `reopen` requires `RESOLVED|CLOSED` + a reason;
  `rate` requires `CLOSED` and is one-time (1–5).

### Create
- Validates title + description.
- **Duplicate guard:** same requester + same title + not `CLOSED` → returns
  `{ duplicate: true, existingTicketId }` unless `force` is set.
- Resolves the cluster's CBA email, computes `DueAt` from SLA, inserts the ticket
  inside `withLock` (so IDs never collide), logs `CREATED`, emails CBA + requester.

### List / get
- `list` filters by `canSee`, then status/priority/cluster/analyst/date/`q`,
  sorts by `UpdatedAt` desc, paginates (`page`, `pageSize`).
- `get` returns the ticket plus its logs, comments, approvals, and reassign requests.

### SLA state (derived, never stored)
`Tickets.publicTicket` computes `slaState`:
- `MET` if `RESOLVED`/`CLOSED`
- `BREACHED` if now > `DueAt`
- `DUE_SOON` if < 4h remain
- `ON_TRACK` otherwise

### Dashboard
Role-aware counts (total/open/closed/unassigned/assignedToMe/overdue), breakdowns
by status & priority, 5 most recent tickets, and — for CBA/ADMIN — pending
reassignments and pending external approvals.

---

## 7. External approval flow (`Approvals.gs`)

1. A CBA/admin calls `requestApproval(ticketId, approverEmail, note)`.
2. Server generates a random token, stores **only** `sha256(token)`, sets the
   ticket to `ApprovalStatus=PENDING` + `Status=PENDING_APPROVAL`, and emails the
   approver a link: `<PORTAL_URL>#approve/<approvalId>/<token>`.
3. The static front-end renders the **approval screen** (never auto-decides on
   load). It calls the public `getApproval` to show the ticket, then the approver
   clicks Approve/Reject, which calls the public `decideApproval`.
4. `decide` validates the token hash, checks `PENDING` + not expired, records the
   decision, and moves the ticket to `IN_PROGRESS` (approved) or `ON_HOLD` (rejected).
   Approvals are **single-use** and expire after `APPROVAL_EXPIRY_HRS` (72h).

---

## 8. Reassignment flow (`Reassign.gs`)

1. The **assigned analyst** calls `requestReassign(ticketId, toAnalystEmail, reason)`.
2. Server validates: caller is the assigned analyst, target is an active ANALYST in
   the same cluster, no other pending request exists. Ticket → `PENDING_APPROVAL`.
3. The CBA (or admin) sees it under Approvals and calls `decideReassign(reqId, approve, note)`.
   - Approve → ticket's `AnalystEmail` changes, status → `ASSIGNED`.
   - Reject → status → `IN_PROGRESS`, analyst unchanged.
4. Both parties are emailed the outcome.

---

## 9. Config keys (`Config` tab)

| Key | Default | Meaning |
|-----|---------|---------|
| `APP_NAME` | PW Analytics Ticket Portal | Shown in UI + emails |
| `ADMIN_EMAIL` | ambikesh.srivastava@pw.live | Seeded admin + escalation target |
| `ALLOWED_DOMAIN` | pw.live | Sign-up domain lock (`''` = any) |
| `OTP_EXPIRY_MIN` | 5 | OTP lifetime |
| `OTP_MAX_ATTEMPTS` | 3 | Wrong-code attempts before reset |
| `OTP_RESEND_SEC` | 60 | Resend cooldown |
| `SESSION_HOURS` | 12 | Session lifetime |
| `SILENT_SESSION_MIN` | 5 | `LastSeenAt` refresh interval |
| `SLA_HIGH_HRS` | 24 | High priority SLA |
| `SLA_MED_HRS` | 72 | Medium priority SLA |
| `SLA_LOW_HRS` | 168 | Low priority SLA (7 days) |
| `APPROVAL_EXPIRY_HRS` | 72 | Approval link lifetime |
| `AUTO_CLOSE_DAYS` | 3 | Auto-close resolved tickets after N days |
| `SALT` | random on setup | Hash salt (auto-generated) |

Values are cached for 5 minutes (`CacheService`); `setCfg()` clears the cache.

---

## 10. Automation (`Triggers.gs`)

Run `setupTriggers()` once. It installs three time-driven triggers:

- **`dailyReminders`** (09:00 daily) — digest of unassigned tickets to each CBA and
  open tickets to each analyst.
- **`hourlySlaCheck`** (hourly) — emails a warning when < 4h remain, and escalates
  overdue tickets to the CBA + admin. (Overdue is derived at read time; nothing is
  written to the ticket.)
- **`cleanupExpired`** (02:00 daily) — deletes expired OTPs/sessions/pending
  approvals and auto-closes tickets that have been `RESOLVED` for `AUTO_CLOSE_DAYS`.

---

## 11. Email (`Mail.gs`)

Every mail goes through `sendMail()`, which **never throws** — a failed mail returns
`false` and is logged, so it can never break a user action. All bodies are built with
`shell()` (branded wrapper), `kvTable()` (key/value rows) and `button()` (CTA), and
all user text is passed through `escHtml()`.

Mails: OTP, welcome, new-ticket→CBA, ticket-received→requester, assigned→analyst,
assigned→requester, status change, comment, approval request, approval decision,
reassign request, reassign decision, SLA warning, overdue.

---

## 12. Setup & deployment

### A. Back-end (Apps Script JSON API)

The project is a **standalone** script (not bound to a Sheet). It creates its own
spreadsheet on first run.

1. Install `clasp` and log in (once):
   ```bash
   npx --yes @google/clasp login
   ```
2. Enable the **Apps Script API** at <https://script.google.com/home/usersettings>
   (needed for `clasp push`).
3. Push the backend:
   ```bash
   npm run push          # cd backend && clasp push -f
   ```
4. Deploy as a Web App (Execute as **Me**, access **Anyone**):
   ```bash
   cd backend && npx --yes @google/clasp deploy -d "v1 JSON API"
   ```
   Copy the printed deployment ID; the Web App URL is
   `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`.
5. **Authorize the scopes once.** Open the script editor
   (`https://script.google.com/d/<SCRIPT_ID>/edit`), pick **`authorize`** in the
   function dropdown, click **Run**, and approve the consent screen. This grants
   `spreadsheets`, `script.send_mail`, and `script.scriptapp` in one go.
   > If you skip this, every API call fails with *"You do not have permission to
   > call SpreadsheetApp.openById"* — the Web App keeps running with the OAuth
   > grant it had when it was first authorized, and the manifest's scopes changed.
6. (Optional) Run **`setupTriggers`** once to install the time-driven jobs.
   The Sheet itself is provisioned automatically on the first API call
   (`ensureSetup_()`), or run **`setup`** manually to do it now.

### B. Front-end (static site)

1. Set the API URL in `js/config.js`:
   ```js
   window.PW_CONFIG = {
     API_URL: 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec'
   };
   ```
   (You can also override at runtime with `?api=<url>` in the page query string.)
2. Serve the repo root — e.g. GitHub Pages, or locally:
   ```bash
   npm run serve         # python3 -m http.server 8080
   ```
3. Open the site, sign in with the admin email (`ADMIN_EMAIL`) via OTP.
4. As admin: create **Clusters** (with a CBA email), then create **CBA** and
   **ANALYST** users and assign them to clusters.

### First-run checklist
- [ ] `clasp push` + `clasp deploy` succeeded
- [ ] `authorize()` ran and the consent screen was approved
- [ ] `js/config.js` `API_URL` points at the deployment
- [ ] `Config` tab has a random `SALT`
- [ ] Admin can log in via OTP
- [ ] At least one cluster + one CBA + one analyst exist
- [ ] `setupTriggers()` installed 3 triggers

---

## 13. Security notes

- OTPs and session tokens are stored **hashed** (salted SHA-256), never in plain text.
- Approval links carry a raw token; only its hash is stored; links are single-use + expiring.
- Role is never trusted from the client — it is read from the `Users` tab on every request.
- All writes that allocate IDs run inside `withLock()` (LockService) to avoid races.
- Login responses are generic to prevent email enumeration.
- All user-supplied text is HTML-escaped before it reaches mail or the UI.
- `ALLOWED_DOMAIN` restricts self sign-up to the company domain.

---

## 14. Development & testing (offline)

The `dev/` folder is a **local test harness** — it is *not* part of the deployed
Apps Script project (don't push it). It emulates the Apps Script runtime in Node so
the real `.gs` logic and the static front-end can be exercised without deploying.

```bash
npm test          # static front-end test suite (dev/web-test.js)
npm run test:api  # backend JSON API test (dev/backend-test.js)
npm run test:gas  # Apps Script logic test (dev/run.js)
npm run check     # front-end ↔ API contract check (dev/check-client.js)
npm run verify    # all of the above
npm run mock      # local mock API server on :8090 (dev/mock-server.js)
npm run serve     # static server on :8080
```

- `dev/mock.js` — in-memory `SpreadsheetApp` (incl. `openById`/`create`/`getId`),
  `PropertiesService`, `CacheService`, `LockService`, `MailApp`, `Utilities`,
  `ScriptApp`, etc.
- `dev/run.js` — loads the real `backend/*.gs` files into a `vm` context and runs
  `dev/tests.js` (72 assertions: setup, signup, OTP, sessions, tickets, assignment,
  status flow, approvals, reassignment, close/rate, analytics, and the `api()` router
  including role denial).
- `dev/backend-test.js` — drives the JSON API end-to-end (42 assertions).
- `dev/web-test.js` — exercises the static front-end against `js/api.local.js`
  (64 assertions).
- `dev/check-client.js` — verifies every `call('name')` in `js/ui.js` has a route in
  `backend/Api.gs`, and every `$('id')` referenced in `js/ui.js` exists in `index.html`.
- `dev/mock-server.js` — a tiny HTTP server that loads `backend/*.gs` and serves the
  JSON API on `:8090`, so you can run the real front-end against real backend logic
  locally (point `js/config.js` at `http://localhost:8090`).

> The harness is a safety net, not a substitute for a real deployment smoke test —
> always run `authorize()` + `setup()` and click through the web app once after deploying.

---

## 15. Known limitations / Phase 2

- **Attachments** — `AttachmentLinks` column exists but the upload UI is not built yet.
- **SMS OTP** — email OTP only for now.
- **Real-time** — the client polls on navigation; there is no live push.
- **Analytics** — computed on read from the sheet; fine for thousands of rows, not millions.
- **`Reassign.decide` reject** always returns the ticket to `IN_PROGRESS` (it does not
  remember the pre-request status).
