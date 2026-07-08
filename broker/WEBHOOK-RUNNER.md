# Webhook-runner — retire the GitHub Actions workflow

## Goal
Move reviews **off** per-repo GitHub Actions workflows. The broker receives
`pull_request` webhooks and runs the review itself, using the **BoxLite REST API** (not the
native SDK) to boot a box as the compute. Net: no workflow file, no repo secrets →
uninstall leaves nothing, new repos need nothing (#1 + #2 solved by design).

## Why the Worker can't run the review inline
- `@boxlite-ai/boxlite` is a **native napi module** — Cloudflare Workers can't load it → use raw REST (`fetch`).
- A review takes **minutes** (box boot + Claude) → past a Worker request budget → the box runs it **async** and calls back.

## Linchpin (confirmed feasible): fire-and-forget exec
`POST /v1/boxes/:id/exec` **starts** an execution and returns an `execId`; the I/O
`attach` is a **separate** WebSocket. So the Worker starts the reviewer and **does not
attach** — no long-held connection. The box runs for minutes on its own, then calls back.

## Flow
```
GitHub ── pull_request webhook ─▶ broker Worker /webhook
  Worker (fast, <10s — all fetches):
    1. verify HMAC (WEBHOOK_SECRET); ignore non-PR, drafts, bots
    2. mint boxlite-agent[bot] token (existing /exchange path, installation-scoped)
    3. load this installation's BoxLite + Claude keys from KV (existing store.mjs)
    4. mint a one-shot JOB token = HMAC(STORE_SECRET, {repo, pr, headSha, boxId, exp})
    5. REST createBox → startBox   (agent-node image, network: enabled)
    6. REST POST /exec (fire-and-forget), env carries the job:
         bash -lc 'curl -fsS $BROKER/reviewer.mjs -o /tmp/r.mjs && node /tmp/r.mjs'
         env = REPO, PR, HEAD_SHA, BASE_REF, GH_CLONE_TOKEN(contents:read),
               CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY, BOX_ID, JOB_TOKEN, BROKER
    7. return 200
  Box (minutes) — reviewer.mjs = today's review.mjs minus "print to stdout", plus:
    clone PR (GH_CLONE_TOKEN) → Claude in-box → findings JSON
      → POST $BROKER/publish  { boxId, job: JOB_TOKEN, findings }
  Worker /publish:
    verify JOB token → post inline review + sticky summary as boxlite-agent[bot]
      (reuse publish.mjs/findings.mjs) → DELETE the box
  Reaper: cron Worker removes boxes older than N min (crash / no-callback safety)
```

## BoxLite REST calls (Bearer = BOXLITE_API_KEY)
`POST /v1/boxes` · `POST /v1/boxes/:id/start` · `POST /v1/boxes/:id/exec` · `DELETE /v1/boxes/:id`

## New broker surface
- `POST /webhook`      — receive + kick off (above)
- `GET  /reviewer.mjs` — serve the in-box reviewer (nothing baked into the image)
- `POST /publish`      — job-token-authed callback: post the review, reap the box
- reuse: `/exchange` (mint), `store.mjs` (keys), `publish.mjs`+`findings.mjs` (posting)

## Retired
- `.github/workflows/boxlite-review.yml` (setup/webhook stop writing it)
- `action.yml` + the GitHub-Actions wrapper of `orchestrate.mjs`
- repo secrets (`BOXLITE_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` no longer written to repos)

## Security
- The GH **write** token (boxlite-agent[bot]) stays on the Worker; the box only receives a
  **contents:read** clone token + the Claude/BoxLite keys + a one-shot job token.
- Untrusted PR code still runs in the box alongside those keys (unchanged risk — harden via
  egress allowlist / short-lived scoped keys; existing open item).
- `/publish` trusts only a valid HMAC job token bound to {repo, pr, boxId, exp}.

## Risks to verify during build
1. A `POST /exec` execution keeps running with no `attach` (two-phase API implies yes — verify on a live box).
2. Box-boot + Claude latency vs. any exec timeout → set a generous exec timeout.
3. Orphan boxes if the callback never fires → the cron reaper.
4. Webhook 10s budget — all steps are fetches; fine.

## Rollout
Build on a branch; the current workflow path stays live until cutover. Already-installed
repos: reviewed by the runner on their next PR; leftover workflow files swept once (the app
has contents:write).
