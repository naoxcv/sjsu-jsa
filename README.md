# SJSU JSA — Club Membership Admin

A lightweight admin tool for managing a university club's membership: members,
payment verification, and fam (small-group) rosters. New members sign up through
a Google Form; a Google Apps Script bridges submissions into a Supabase database,
and officers manage everything from a single-page admin tool. The bridge also
**auto-verifies payments** by matching high-confidence signups against the
treasurer's finance ledger, leaving only uncertain ones for manual review.

## Stack

- **Frontend:** vanilla JS in a single `club-admin.html`, with pure business logic
  split into `logic.js` so it can be unit-tested without a browser. No build step,
  no framework. The Supabase JS client loads from a CDN (pinned version + SRI hash).
- **Database:** Supabase (Postgres + auto-generated REST API).
- **Signup bridge:** Google Apps Script (`apps-script.gs`), bound to the signup
  form's response sheet, inserts submissions into Supabase.
- **Hosting:** Cloudflare Pages. Access to the deployed tool is restricted to
  officers.
- **Tests:** `node --test`, zero dependencies, covering `logic.js`.

## Repository layout

| Path | What it is |
| --- | --- |
| `club-admin.html` | The admin tool (single-page app). |
| `logic.js` | Pure business logic (fee status, validity, duplicate detection). |
| `apps-script.gs` | Google Apps Script: signup form → Supabase, plus payment auto-verification. |
| `schema.sql` | Database schema. |
| `migration.sql` | Schema migrations. |
| `test/` | Unit tests for `logic.js`. |
| `config.example.js` | Template for local configuration (see below). |
| `_headers` | Cloudflare Pages response headers. |
| `deploy.sh` | Build + deploy script for Cloudflare Pages. |

## Configuration

Credentials are kept out of the repo. Copy the template and fill in your own
Supabase project values:

```bash
cp config.example.js config.js
# then edit config.js
```

`config.js` is gitignored and must never be committed.

## Local development

Open `club-admin.html` directly in a browser (with `config.js` and `logic.js`
alongside it), or serve the directory with any static file server.

## Tests

```bash
npm test        # or: node --test
```

## Deployment

```bash
./deploy.sh
```

This stages the app into `dist/` and deploys it to Cloudflare Pages
(requires a local `wrangler` login).

## Payment auto-verification

The Apps Script bridge can auto-verify payments by matching pending fees against
the treasurer's finance ledger (a Google Sheet). It only verifies **high-confidence,
unambiguous matches** — method, amount (incl. late pricing), date, and the member's
**full name** must all line up, and the match must be unique. Everything else stays
`pending` for the treasurer. Cash is matched too (a recorded cash row is official),
but ledger rows that carry only a first name can't identify the payer, so they go to
the manual queue — log full names to auto-verify them. The ledger is **read-only** to
the script; all state lives in Supabase.

**Two entry points, one matcher:**

- **`onFormSubmit`** — runs automatically on every signup. Since members pay before
  submitting, most payments verify instantly at signup. Best-effort and isolated: a
  ledger/matching error never fails the submission.
- **Batch sweep** — run manually from the Apps Script editor to clear a backlog or
  catch stragglers:
  - `sweepDryRun()` — logs proposed matches, writes nothing (run this first).
  - `sweepApply()` — commits the confident matches.
  - `sweepDiagnose()` — categorizes every *unmatched* pending fee (wrong amount,
    name mismatch, no receipt, duplicate, etc.).

  All three log to a "Sweep Log" tab in the form-response sheet.

**Configuration** (Apps Script → Project Settings → Script Properties):

| Property | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase REST access. |
| `ACADEMIC_YEAR` | e.g. `2026-2027`; update at annual rollover. |
| `LEDGER_SHEET_ID` | The finance ledger spreadsheet ID (from its URL). |
| `LEDGER_TAB` | The ledger tab name, e.g. `Cashflow F26`. |

The auto-verify features stay dormant until `LEDGER_SHEET_ID` and `LEDGER_TAB` are
set, so submissions keep working even before the ledger is wired up. The executing
account needs read access to the ledger (share it, or own it). The database needs
the audit columns from `migration.sql` (`verified_at`, `verification_source`,
`auto_match_ref`).
