# CLAUDE.md — Club Membership Management System

## What this project is

A locally hosted admin tool for a university club's membership management, backed by an
existing Supabase database. Officers use it to manage members, verify payments, and view
fam rosters. New members sign up via a Google Form; a Google Apps Script bridges form
submissions into Supabase.

**Stack (deliberate constraints — do not change without discussion):**
- Vanilla JS, Supabase JS client via CDN (pinned version + SRI hash, not a floating tag),
  no build tools, no frameworks, no backend server/API. `club-admin.html` is the app;
  `logic.js` holds pure business logic (fee status, validity, duplicate-fee detection),
  split out so it's `require()`-able from `test/` without a browser or build step — this
  is the one deliberate exception to "single file," accepted now that the tool is
  primarily accessed via the Cloudflare Pages deployment rather than opened locally.
  Officers can still open `club-admin.html` directly for local/offline use; `logic.js`
  and `config.js` just need to sit alongside it.
- Supabase credentials (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) live in `config.js`
  (gitignored; `config.example.js` is the checked-in template — see Hosting section).
  Security model = key secrecy among a small officer team, now gated further by
  Cloudflare Access. RLS is **disabled**.
- Tests: `node --test` (or `npm test`), zero dependencies, covers `logic.js` only.
- `_headers` (Cloudflare Pages response headers: CSP + baseline hardening) is checked in
  and copied into `dist/` by `deploy.sh`.
- Google Apps Script (bound to the form's response sheet) handles form → DB inserts.
  Credentials live in `PropertiesService`, never in script source.
- The officers share one Google account (owns the form, sheet, and screenshot uploads in
  Drive — no cross-account permission issues).

## Database schema

### Existing tables

- **members**: `member_id` (PK), `first_name`, `last_name`, `email`,
  `gender` (male/female/other/prefer_not_to_say),
  `university_year` (1st/2nd/3rd/4th/5+),
  `role` (member/president/vice_president/vp_finance/vp_marketing/vp_operations/vp_events/
  vp_mentorship/vp_careers/events_committee/fams_committee/skip_committee/
  marketing_committee — committee roles are rank-and-file membership on a committee,
  distinct from and coexisting with the vp_* leadership roles; "SKIP" = Senpai/Kouhai
  Program. Fam leadership is separate — see `fam_role` below, not a `members.role` value),
  `joined_date`, `is_active` (boolean — **manual override only**, see Decisions),
  `notes`
- **membership_fees**: `fee_id` (PK), `member_id` (FK), `academic_year` (e.g. '2024-2025'),
  `plan` (semester_1/semester_2/full_year), `amount_paid`, `paid_date`,
  `valid_from`, `valid_until`, `payment_method`
- **fams**: `fam_id` (PK), `name` (Ryu/Tsuru/Kitsune/Koi), `description`, `color` (hex)
- **fam_memberships**: `fam_membership_id` (PK), `member_id` (FK), `fam_id` (FK),
  `joined_date`, `fam_role` (member/fam_leader/co_leader),
  `assignment_method` (selected/requested/transferred), `is_current` (boolean)
- **academic_periods**: `period_id` (PK), `academic_year`, `semester` (1 or 2),
  `start_date`, `end_date`.
  **Single source of truth for membership expiry dates.** Rows for a new academic year
  MUST exist before the signup form opens, or fee inserts will fail validity computation.

### Agreed schema changes (migration pending)

- `members`: **add** `discord` (text, null), `student_id` (text, null, **UNIQUE**)
- `membership_fees`: **add** `status` (pending/verified/rejected, default `pending`),
  `screenshot_url` (text, null);
  **migrate** `payment_method` enum → `venmo / zelle / cash`
  (old values cash/bank_transfer/online; table is empty from fresh start, so trivial)
- **New table** `membership_plans`: `academic_year`, `plan`, `price`,
  `late_from` (date, null), `late_price` (numeric, null).
  One row per plan per year; a new set of rows is added each year.
  Both the admin tool and the Apps Script read prices from here — **no hardcoded prices**.
  **Late pricing**: a payment is late iff `paid_date >= late_from` (actual paid
  date, NOT verification time); it then costs `late_price`, stored as the full
  amount (e.g. 20.00), never as a "+5" modifier in code. Nulls = no late tier.

## Core business rules

### Fee status (the most important invariant)

- A fee row counts toward active membership iff:
  `status = 'verified' AND valid_until >= today`
- **Never stored as a flag; always computed** — in code, `isFeeActive()` in the HTML file.
- Date comparisons are ISO-string (`YYYY-MM-DD`) lexicographic. Safe; keep it that way.
- Per-row badge in payment history, evaluated in this order:
  1. **Rejected** — status = rejected
  2. **Pending** — status = pending (never shows as Expired, even if dates lapse)
  3. **Verified** — status = verified and valid_until >= today
  4. **Expired** — status = verified and valid_until < today

### Validity computation (`computeValidity(academicYear, plan)`)

Looked up from `academic_periods` for the given year:
- `semester_1` → sem 1 start_date → sem 1 end_date
- `semester_2` → sem 2 start_date → sem 2 end_date
- `full_year` → sem 1 start_date → sem 2 end_date
Returns null (blocks insert with clear error) if the period rows don't exist.

### `is_active` semantics (settled after some back-and-forth — do not relitigate)

- `is_active` = "should this person appear/count at all" — **human judgment, manual only**
  (bans, mid-year departures, etc.). It is NOT a cache of fee status.
- There is no infrastructure to auto-flip it on expiry (static HTML + event-driven script;
  nothing runs on a schedule), and it must not become one.
- Expired members drop out of default views because the **filter is computed**
  (default members-list filter: `is_active = true AND fee-active`), not because a flag flips.
- The ONLY automated write to `is_active`: the Apps Script sets it `true` when a known
  student_id re-signs up (re-signup is a clear "I'm back" signal, overriding any manual
  deactivation).

### Identity & duplicates

- **`student_id` is the permanent identity. One member row per person, forever.**
  Returning members NEVER get a new member row; each payment is a new fee row.
- Apps Script branching on form submission:
  1. student_id **not found** → insert member + pending fee row.
  2. student_id **found**, no pending/verified fee for this academic year → insert
     pending fee row only; set `is_active = true`. (Renewals, returning members.)
  3. student_id **found**, pending/verified fee already exists for this academic year →
     insert the new pending fee row anyway, **flagged in the pending queue** as
     "member already has a fee this year." Treasurer verifies one / rejects the other.
     (Covers double-submits and sem-1 → full-year upgrades. Blast radius: one rejected row.)
- Member contact info is **never auto-updated** from resubmissions. The second submission
  might be the mistake, not the first. Admins edit member fields only via Edit Member.
- UNIQUE constraint on student_id is the backstop against race conditions.

## Google Form spec

Fields: first name, last name, discord, email, student ID, gender
(Male/Female/Other/Prefer not to say), university year,
fam interest (Y/N), mentorship interest (Y/N),
membership plan (**Semester 1 / Semester 2 / Full Year** — explicit, mapping 1:1 to the
enum; no date-inference of which semester), payment method (Venmo/Zelle/cash),
payment screenshot upload.

- **Goes to DB**: fn, ln, discord, email, student_id, gender, year → `members`;
  plan, payment method, screenshot Drive URL → `membership_fees` (as pending).
- **Stays in the Sheet only**: the two Y/N interest questions (rough headcount) and the
  raw screenshot files. Fam assignment happens later via a separate form (out of scope).
- `paid_date` defaults to the form submission timestamp; treasurer can edit at verification.
- `amount_paid` defaults from `membership_plans`; treasurer can edit at verification.
- Not on the form: role (defaults `member`), is_active (defaults true), joined_date
  (set by script), notes.
- Insert failures are logged to an errors tab in the response Sheet and handled manually.
  No email plumbing.

## Admin tool (club-admin.html) — current state & pending work

### Implemented and working

- Members list: search, default `is_active` filter + show-all toggle, fee badge, fam badge
- Member detail: all fields, fam with color, payment history, inline Edit Member form,
  Record Payment form with live validity preview
- Add member form (with optional fam assignment)
- Fam rosters: four color-coded columns, role badges, fee indicators
- Fam reassignment preserves history (closes old `is_current` row, inserts new with
  `assignment_method = 'transferred'`)
- All ID comparisons go through `idEq()` (String-coerced) — DOM datasets are strings,
  DB IDs may be numbers. **Never use `===` on IDs.** (This was a real bug.)

### Pending implementation (agreed, unblocked)

1. Run the schema migration (columns, status enum, payment-method enum, membership_plans)
2. Fee-active rule: add `status = 'verified'` condition to `isFeeActive()` and the
   per-row badge logic (four-state, ordered as above)
3. Currency display: `£` → `$` (single occurrence)
4. `PAYMENT_METHODS` constant → venmo/zelle/cash; update Record Payment form
5. Display `discord` and `student_id` in members list + detail view + edit/add forms
6. Default members-list filter becomes `is_active AND fee-active` (toggle shows all)
7. **New: Pending Verifications view** — top-level nav item with live count badge
   (count of pending rows). Each entry: member name, plan, amount, method, submitted
   date, screenshot link (new tab), and the "already has a fee this year" duplicate flag
   where applicable. Click → pre-populated, fully editable verification form
   (plan/method/amount/paid_date/valid_from/valid_until) with **Verify** and **Reject**.
   Verification does NOT edit member contact info — that stays in Edit Member only.
8. Amount defaults in Record Payment + verification pulled from `membership_plans`

### Then: Apps Script (fully specified, ready to write)

Per-submission: enum mapping (form labels → DB values), duplicate branching (above),
validity + price lookups, screenshot Drive URL capture, error-tab logging.

## Payment auto-verification (agreed in principle 2026-09-22; design in progress)

**Status:** New direction. Reverses the former "no verification automation beyond the
screenshot + treasurer flow" rejection (see out-of-scope list). Agreed **in principle**
only — the detailed design is still open. Treat this section as intent, not a finished
spec; **do not implement until the open questions below are resolved.**

**Goal:** cut the manual screenshot-eyeballing step by matching real Zelle/Venmo payment
receipts against pending fees and auto-verifying **only high-confidence matches**.
Everything uncertain still lands in the existing treasurer Pending Verifications queue —
this augments that flow, it does not replace it. Cash has no receipt → always manual.

**Input signal:** the treasurer's existing Google Apps Script parses Zelle/Venmo receipt
emails from Gmail into a payment sheet (one row per received payment: payer name, amount,
method, date). This sheet is an *input signal only*, the same role the signup form plays.
Supabase stays the sole source of truth — this is NOT the rejected two-way Sheets sync.

**Ordering (settled):** members always pay *before* submitting the form, so the receipt
generally exists first. Therefore:
- **Primary matcher = `onFormSubmit`** (event-driven): after inserting the pending fee,
  scan already-logged receipts and auto-verify against a confident match.
- **Catch-up hook in the treasurer's Gmail-parser script**: after appending a receipt,
  look for a now-waiting pending fee. Covers the gap when that parser (time-driven, and
  **external / pre-existing** — not part of this app's stack) processes the receipt email
  *after* the form has already arrived.
- One shared `matchFee_(fee, receipts)` serves both sides.

**Confidence rule — all must hold to auto-verify, else stays pending:**
- amount matches the expected `membership_plans` price (incl. late price), **and**
- receipt method matches the fee's `payment_method`, **and**
- payer name resolves to *exactly one* member with a `pending` fee for the current year.
- **Name is a hint, never identity.** `student_id` remains the identity key; payments can
  come from a parent's/roommate's account and names collide. **Never auto-verify on name
  alone.**

**Safety:**
- Idempotency / anti-double-use: mark each receipt row *consumed* (matched fee_id/member)
  on verify; the matcher skips consumed rows and only ever matches `pending` fees.
- Auditability: record on the fee that it was auto-verified and from which receipt, so an
  auto-verify is traceable and reversible.

**Open questions (blocking implementation):**
- Exact column layout + value formats of the treasurer's payment sheet (name field shape,
  amount as `"$15.00"` vs `15`, one sheet vs one per service).
- Name-matching algorithm + threshold (exact / normalized / fuzzy) and how aggressive.
- Whether the parser catch-up hook earns its cross-project wiring, or `onFormSubmit` alone
  suffices given the "pay before form" ordering.

## Rollout plan

1. Schema migration in Supabase
2. Admin tool updates (list above)
3. Seed `academic_periods` + `membership_plans` for the new academic year
4. Build the Google Form; write + test the Apps Script with one throwaway submission
   (delete the row after)
5. Officers sign up through the real form as the end-to-end test; assign their roles
   manually via the tool
6. Open to general membership

## Explicitly out of scope / rejected (do not re-add without discussion)

- Fam preference column on members (fam interest is Sheet-only headcount;
  assignment via a separate later form)
- Auto-updating member info from form resubmissions
- Email notifications (failure or welcome)
- ~~Payment collection/verification automation beyond the screenshot + treasurer flow~~
  → **reversed 2026-09-22.** Now in scope; see "Payment auto-verification" above (in design).
- Two-way Google Sheets sync (source of truth is Supabase, full stop). Note: the payment
  auto-verification receipt sheet is a one-way *input* signal, not sync — this stays rejected.
- Importing last year's data (all memberships expired; fresh start)
- Supabase Auth / RLS policies (revisit only if the officer team grows or the file leaks)
- Scheduled jobs in this app's stack (nothing time-driven runs in the admin tool or its
  Apps Script bridge; the primary auto-verify matcher is event-driven `onFormSubmit`). The
  treasurer's Gmail-parser script is time-driven but external / pre-existing — see
  "Payment auto-verification."

## Hosting

- Deployed to Cloudflare Pages (project `sjsu-jsa-admin`, `sjsu-jsa-admin.pages.dev`),
  gated by Cloudflare Access (One-Time PIN login, Allow policy = officer email list).
  Access protects page load; it does not proxy the Supabase calls themselves (those go
  browser → Supabase directly, same as the local-file model — see below).
- `config.js` holds the real Supabase credentials, is gitignored, and is never committed.
  `config.example.js` is the checked-in template. The repo (`naoxcv/sjsu-jsa`) is **public**,
  which is why credentials live outside it.
- To redeploy after editing `club-admin.html` or `logic.js`: run `./deploy.sh` (copies
  the file, `config.js`, `logic.js`, and `_headers` into `dist/`, then runs
  `wrangler pages deploy`). Requires local `wrangler` login.
- The `@supabase/supabase-js` `<script>` tag is pinned to an exact version with an SRI
  hash. Bumping the Supabase JS version means re-fetching that version's file, computing
  its `sha384` hash, and updating both the version number and `integrity` attribute
  together — never just the version number alone.
- Officers can still open `club-admin.html` directly in a browser for local/offline use,
  same as before — the hosted version is the day-to-day path, not a replacement.

## Known operational notes

- Anyone with the HTML file *or* past the Access gate has full DB access (RLS off +
  embedded anon key). Rotating the key means re-editing `config.js` + redeploying.
- Payment screenshots in Drive contain personal data; purge at end of year.
- Discord usernames change; expect to update them manually mid-year.
- Supabase free tier: no automated backups — export periodically.
- Annual rollover checklist: new `academic_periods` rows, new `membership_plans` rows,
  reopen the form.
