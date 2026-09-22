# SJSU JSA — Club Membership Admin

A lightweight admin tool for managing a university club's membership: members,
payment verification, and fam (small-group) rosters. New members sign up through
a Google Form; a Google Apps Script bridges submissions into a Supabase database,
and officers manage everything from a single-page admin tool.

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
| `apps-script.gs` | Google Apps Script: signup form → Supabase. |
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
