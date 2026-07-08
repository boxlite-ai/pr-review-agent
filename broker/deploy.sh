#!/usr/bin/env bash
# One-command broker deploy.
#
# Run this AFTER you have (1) created the App by opening create-app.html and clicking
# "Create GitHub App", and (2) run `wrangler login` once.
#
#   bash deploy.sh <code>
#
# where <code> is the value from the URL GitHub redirected you to right after creating
# the App:  https://boxlite.ai/app-created?code=THIS_PART
#
# It turns that one-time code into the App ID + private key, loads them as Worker
# secrets, deploys, and prints the last (one-field) manual step.
set -uo pipefail
cd "$(dirname "$0")"

CODE="${1:-}"
if [ -z "$CODE" ]; then
  echo "usage: bash deploy.sh <code>   (the ?code=... GitHub gave you after creating the App)" >&2
  exit 2
fi

echo "→ Exchanging the one-time manifest code for App credentials…"
CONV=$(gh api -X POST "/app-manifests/${CODE}/conversions" 2>&1)
APP_ID=$(printf '%s' "$CONV" | jq -r '.id // empty' 2>/dev/null)
SLUG=$(printf '%s' "$CONV" | jq -r '.slug // empty' 2>/dev/null)
if [ -z "$APP_ID" ]; then
  echo "✘ Conversion failed — the code is single-use and expires in ~1h. Re-create the App and retry." >&2
  printf '%s\n' "$CONV" | jq -r '.message // .' 2>/dev/null >&2 || printf '%s\n' "$CONV" >&2
  exit 1
fi
printf '%s' "$CONV" | jq -r '.pem' > boxlite-app.pem
echo "  App: $SLUG  (id $APP_ID)"

echo "→ Converting the private key to PKCS#8 (what jose/@octokit need)…"
openssl pkcs8 -topk8 -nocrypt -in boxlite-app.pem -out boxlite-app.pkcs8.pem

echo "→ Installing deps + deploying the Worker…"
npm install --silent
DEPLOY_OUT=$(npx wrangler deploy 2>&1)
printf '%s\n' "$DEPLOY_OUT"
URL=$(printf '%s' "$DEPLOY_OUT" | grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

echo "→ Loading App credentials as Worker secrets…"
printf '%s' "$APP_ID" | npx wrangler secret put APP_ID
npx wrangler secret put APP_PRIVATE_KEY < boxlite-app.pkcs8.pem
# BROKER_AUDIENCE is optional — the Worker falls back to its own origin.

rm -f boxlite-app.pkcs8.pem
echo
echo "════════════════════════════════════════════════════════════════"
echo "✅ Broker live at: ${URL:-<see wrangler output above>}"
echo
echo "LAST STEP (one field, GitHub UI — there is no API for it):"
echo "  https://github.com/settings/apps/${SLUG}   (or your org → Settings → Developer settings → GitHub Apps)"
echo "  • Setup URL  = ${URL}/setup"
echo "  • check 'Redirect on update'  → Save"
echo
echo "Then share the install link:  https://github.com/apps/${SLUG}/installations/new"
echo "════════════════════════════════════════════════════════════════"
echo
echo "⚠  boxlite-app.pem is your App's master key. Store it in a password manager and delete"
echo "   the local copy once you've confirmed the broker works:  rm boxlite-app.pem"
