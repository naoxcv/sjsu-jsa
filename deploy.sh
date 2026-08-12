#!/bin/bash
# Deploys club-admin.html to Cloudflare Pages (project: sjsu-jsa-admin).
# config.js (real Supabase credentials) is copied from the repo root into
# dist/ but is gitignored and never committed.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist
cp club-admin.html dist/index.html
cp config.js dist/config.js
cp logic.js dist/logic.js
cp _headers dist/_headers

npx wrangler pages deploy dist --project-name=sjsu-jsa-admin
