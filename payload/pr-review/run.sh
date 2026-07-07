#!/usr/bin/env bash
# PR-review agent entrypoint, executed inside a BoxLite box via exec:
#   run.sh <owner/repo> <pr-number> <head-sha> <base-ref>
#
# Required env (passed per-exec, never stored in box env):
#   GH_TOKEN                  GitHub token with PR write on the repo
#   ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (exactly one)
# Optional env:
#   MODEL                     explicit model id; omitted = Claude Code's default
set -euo pipefail

REPO=$1; PR=$2; HEAD_SHA=$3; BASE_REF=$4
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Self-heal on images without the CLI (M0 dogfood runs on boxlite-agent-node).
command -v claude >/dev/null 2>&1 || sudo npm install -g @anthropic-ai/claude-code >/dev/null

WORK=$(mktemp -d)
cd "$WORK"
git clone -q --depth 200 "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" repo
cd repo
# Fetch the PR head + base while the token-authenticated remote is still in place
# (private repos need auth here).
git fetch -q --depth 200 origin "+refs/pull/${PR}/head" \
                                "+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"
git checkout -q FETCH_HEAD
# Only now scrub the token from .git/config, before the model runs, so it can never
# read the write token back. The review works from local objects, needing no remote.
git remote set-url origin "https://github.com/${REPO}.git"

# Read-only review: allowlisted git commands only, and no GH_TOKEN in the model's env.
# </dev/null: run non-interactively (no 3s stdin wait). Capture rc + stderr explicitly
# so a failing review surfaces its cause instead of being swallowed by `set -e`.
set +e
env -u GH_TOKEN claude -p "$(cat "$AGENT_DIR/prompt.md")

PR #${PR} of ${REPO}. Base branch: origin/${BASE_REF}. Head: $(git rev-parse --short HEAD)." \
  ${MODEL:+--model "$MODEL"} \
  --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)" \
  --output-format json --max-turns 50 </dev/null >/tmp/claude-out.json 2>/tmp/claude-err.txt
claude_rc=$?
set -e
if [ "$claude_rc" -ne 0 ]; then
  echo "claude exited $claude_rc" >&2
  sed -n '1,40p' /tmp/claude-err.txt >&2
  head -c 2000 /tmp/claude-out.json >&2
  exit 1
fi

# Extract the review text. jq is not guaranteed in the box image, so fall back to node.
if command -v jq >/dev/null 2>&1; then
  jq -r '.result // empty' /tmp/claude-out.json > /tmp/result.md
else
  node -e 'const fs=require("node:fs");try{process.stdout.write(JSON.parse(fs.readFileSync("/tmp/claude-out.json","utf8")).result||"")}catch(e){console.error("parse failed:",e.message);process.exit(3)}' > /tmp/result.md
fi
if [ ! -s /tmp/result.md ]; then
  echo "review produced no result; claude-out.json head:" >&2
  head -c 2000 /tmp/claude-out.json >&2
  exit 1
fi

# Marker + footer stay script-side so prompt content can never break the sticky upsert.
{
  echo "<!-- boxlite-pr-review -->"
  cat /tmp/result.md
  echo
  echo "<sub>reviewed \`${HEAD_SHA:0:7}\` in a <a href=\"https://boxlite.ai\">BoxLite</a> microVM · push a commit to re-review</sub>"
} > /tmp/body.md

node "$AGENT_DIR/post-comment.mjs" "$REPO" "$PR" /tmp/body.md
