# BoxLite PR Reviewer

AI code review for every pull request — running inside an isolated [BoxLite](https://boxlite.ai)
microVM. Claude reviews the diff in a single-kernel sandbox and posts one sticky comment.
Untrusted PR code never touches your CI runner.

It's also a **showcase of BoxLite managed agents**: a small, readable example of booting a
microVM on demand, shipping a task into it, and tearing it down — copy it to build your own.

It is a **consumer of [app.boxlite.ai](https://app.boxlite.ai)**, not part of it. GitHub Actions
triggers the run, the review boots on **your own** BoxLite org with **your own** keys, and those
keys live in your GitHub Secrets. BoxLite never custodies your credentials.

## Quick start

1. Add repo (or org) secrets — Settings → Secrets and variables → Actions:
   - `BOXLITE_API_KEY` — your app.boxlite.ai org key (`blk_live_…`)
   - **one** Claude credential:
     - `ANTHROPIC_API_KEY` — an Anthropic Console key (`sk-ant-api…`), or
     - `CLAUDE_CODE_OAUTH_TOKEN` — a Claude Pro/Max subscription token from `claude setup-token`
       (`sk-ant-oat…`). The box runs genuine Claude Code, so this is a sanctioned use.

2. Add `.github/workflows/boxlite-review.yml` (see [`examples/caller-workflow.yml`](examples/caller-workflow.yml)):

   ```yaml
   name: boxlite-review
   on:
     pull_request:
       types: [opened, synchronize, reopened, ready_for_review]
   jobs:
     review:
       if: ${{ !github.event.pull_request.draft && github.event.pull_request.user.type != 'Bot' }}
       runs-on: ubuntu-latest
       permissions: { contents: read, pull-requests: write }
       steps:
         - uses: boxlite-ai/pr-review-agent@v1
           with:
             boxlite-api-key: ${{ secrets.BOXLITE_API_KEY }}
             anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

Open a PR — a review comment appears in a minute or two. Push a commit and the same comment
updates in place.

## Branded bot (optional, one-click install)

By default comments post as `github-actions[bot]`. To post as your own `your-app[bot]` and offer a
one-click **Install** button, register a GitHub App (Pull requests: Read & write, Contents: Read,
Metadata: Read), install it, store the App id + private key as secrets, and pass them:

```yaml
- uses: boxlite-ai/pr-review-agent@v1
  with:
    boxlite-api-key: ${{ secrets.BOXLITE_API_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    app-id: ${{ secrets.BOXLITE_REVIEWER_APP_ID }}
    app-private-key: ${{ secrets.BOXLITE_REVIEWER_APP_PRIVATE_KEY }}
```

The Action mints a short-lived, repo-scoped installation token from the App key via
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).

## How it works

```
PR opened / pushed
      │  GitHub fires the workflow (your Actions minutes)
      ▼
GitHub-hosted runner  ── thin orchestrator (this Action, ~120 lines)
   holds for this job only: a GitHub token + your two secrets
      │  JsBoxlite.rest(app.boxlite.ai, your BOXLITE_API_KEY)
      ▼
BoxLite microVM  ── booted in YOUR org, its own kernel
   clone PR → `claude -p` reviews the diff (read-only tools, no write token)
   → post one sticky comment
      │
      ▼
runner removes the box → compute back to zero
```

All review compute is the box; the runner is only the trigger plus orchestration
([`orchestrate.mjs`](orchestrate.mjs)). Secrets reach the box **per-exec** — never baked into the
box image or persisted in box env. That is the whole BoxLite pattern: `create → exec → remove`.

## Security model

- **Isolation is the point.** Each review runs in its own microVM with its own kernel. Untrusted
  PR code is reviewed there, not on your CI runner — it can't reach your runner's filesystem,
  secrets, or other jobs.
- **Least privilege in-box.** The clone token is scrubbed from `.git/config` before the model runs;
  Claude runs read-only (`Read`, `Grep`, `Glob`, and `git diff/log/show` only) and never sees the
  GitHub write token.
- **No custody.** Your BoxLite and Anthropic keys live in your GitHub Secrets and reach the box
  per-exec. Nothing is stored on a BoxLite-run service.
- **Network.** The box has outbound internet (it clones the repo and calls the Claude API);
  isolation is at the VM boundary, not the network.
- **Fork PRs.** `pull_request` runs from forks don't receive secrets (GitHub policy), so this
  reviews same-repo PRs. Reviewing fork PRs needs the hosted-App path.

## Local dry run

Test the whole pipeline from a laptop against a real microVM, no GitHub App:

```bash
npm install --no-save @boxlite-ai/boxlite
export BOXLITE_API_KEY=blk_live_…
export ANTHROPIC_API_KEY=sk-ant-…            # or: export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…
export REPO=owner/repo PR_NUMBER=<n> GH_TOKEN=$(gh auth token) BASE_REF=main
export HEAD_SHA=$(gh pr view $PR_NUMBER --repo $REPO --json headRefOid -q .headRefOid)
node orchestrate.mjs
```

A sticky comment on the PR means the pipeline works.

## Configuration

`payload/pr-review/prompt.md` is the review policy — edit it to change what the reviewer flags.

| Input | Required | Default | Notes |
|---|---|---|---|
| `boxlite-api-key` | yes | — | Boots the review box in your org |
| `anthropic-api-key` | one of | — | Anthropic Console API key |
| `claude-code-oauth-token` | one of | — | `claude setup-token` subscription token |
| `boxlite-url` | no | `https://app.boxlite.ai/api` | REST base URL |
| `boxlite-image` | no | curated node image | Box image (must be curated) |
| `model` | no | Claude Code default | Explicit model id; empty tracks the latest |
| `app-id` / `app-private-key` | no | — | Set both for the branded bot |

## Tests

Pure logic is unit-tested (no network, no microVM):

```bash
node --test test/*.test.mjs
```

Covers the sticky-comment upsert/truncation and the Claude credential selection.

## License

[Apache-2.0](LICENSE) © BoxLite AI. Built on [BoxLite](https://boxlite.ai) — microVMs for every agent.
