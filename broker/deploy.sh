#!/usr/bin/env bash
# Deploy the broker Worker. Two ways to pass App credentials:
#
#   Manual App (recommended — the manifest one-click is broken by SameSite cookies):
#     Create the App via the form (see SETUP.md), click "Generate a private key", then:
#       npx wrangler login                                  # once
#       bash deploy.sh <APP_ID> <path-to-private-key.pem>
#
#   Manifest code (only if you registered via a manifest and got a ?code=…):
#       bash deploy.sh <code>
#
# Either way it loads APP_ID + APP_PRIVATE_KEY as Worker secrets, deploys, and prints
# the final Setup-URL step.
set -uo pipefail
cd "$(dirname "$0")"

APP_ID=""; PEM=""; SLUG=""
if [ "$#" -ge 2 ]; then
  # Manual path: <APP_ID> <pem-file>
  APP_ID="$1"; PEM="$2"
  [ -f "$PEM" ] || { echo "✘ private-key file not found: $PEM" >&2; exit 1; }
elif [ "$#" -eq 1 ]; then
  # Manifest path: <code> → exchange for App ID + key
  echo "→ Exchanging the one-time manifest code for App credentials…"
  CONV=$(gh api -X POST "/app-manifests/$1/conversions" 2>&1)
  APP_ID=$(printf '%s' "$CONV" | jq -r '.id // empty' 2>/dev/null)
  SLUG=$(printf '%s' "$CONV" | jq -r '.slug // empty' 2>/dev/null)
  [ -n "$APP_ID" ] || { echo "✘ code invalid/expired (single-use, ~1h) — re-create + retry." >&2; printf '%s\n' "$CONV" | jq -r '.message // .' >&2; exit 1; }
  PEM=boxlite-app.pem; printf '%s' "$CONV" | jq -r '.pem' > "$PEM"
  echo "  App: $SLUG (id $APP_ID)"
else
  echo "usage:" >&2
  echo "  bash deploy.sh <APP_ID> <private-key.pem>   # manual App (recommended)" >&2
  echo "  bash deploy.sh <code>                        # manifest ?code= flow" >&2
  exit 2
fi

echo "→ Converting the private key to PKCS#8…"
openssl pkcs8 -topk8 -nocrypt -in "$PEM" -out /tmp/boxlite-pkcs8.pem || { echo "✘ openssl failed on $PEM" >&2; exit 1; }

echo "→ Installing deps + deploying the Worker…"
npm install --silent
DEPLOY_OUT=$(npx wrangler deploy 2>&1); printf '%s\n' "$DEPLOY_OUT"
URL=$(printf '%s' "$DEPLOY_OUT" | grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

echo "→ Loading App credentials as Worker secrets…"
printf '%s' "$APP_ID" | npx wrangler secret put APP_ID
npx wrangler secret put APP_PRIVATE_KEY < /tmp/boxlite-pkcs8.pem
rm -f /tmp/boxlite-pkcs8.pem
# BROKER_AUDIENCE is optional — the Worker falls back to its own origin.

echo
echo "════════════════════════════════════════════════════════════════"
echo "✅ Broker live at: ${URL:-<see wrangler output above>}"
echo
echo "LAST STEP (one field, GitHub UI — no API for it):"
echo "  App settings → Post installation → Setup URL = ${URL}/setup   (check 'Redirect on update')"
[ -n "$SLUG" ] && echo "  Install link: https://github.com/apps/${SLUG}/installations/new"
echo "════════════════════════════════════════════════════════════════"
if [ "$PEM" = boxlite-app.pem ]; then echo; echo "⚠  boxlite-app.pem is your App's master key — store it safely, then: rm boxlite-app.pem"; fi
