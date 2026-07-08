// Auto-configure — "install the bot and you're done."
//
// When someone installs the @boxlite App, GitHub redirects them to the App's Setup URL
// (this route) with ?installation_id=. We show a tiny form for their BoxLite + Claude
// keys, then — using the App's own installation token — write those as repo Actions
// secrets AND commit the review workflow into each installed repo. The user never
// hand-writes a workflow or opens GitHub's secrets settings.
//
// Custody note: the two keys pass through this handler once (to encrypt + write them as
// repo secrets) and are never stored. The App private key stays in the Worker.
import { createAppAuth } from '@octokit/auth-app'
import sealedbox from 'tweetnacl-sealedbox-js'
import { BrokerError } from './claims.mjs'

const GH = 'https://api.github.com'
const WORKFLOW_PATH = '.github/workflows/boxlite-review.yml'
/**
 * The review workflow written into each installed repo. `brokerUrl` (this Worker's own
 * origin) + `id-token: write` make runs post as @boxlite-agent[bot]: the action exchanges
 * the run's GitHub OIDC token at the broker for a repo-scoped installation token.
 */
function buildWorkflow(brokerUrl) {
  return `name: boxlite-review
on:
  pull_request: { types: [opened, synchronize, reopened, ready_for_review] }
  issue_comment: { types: [created] }
permissions: { contents: read, pull-requests: write, checks: write, id-token: write }
jobs:
  review:
    if: >-
      (github.event_name == 'pull_request' && !github.event.pull_request.draft) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
       contains(github.event.comment.body, '@boxlite-agent review'))
    runs-on: ubuntu-latest
    steps:
      - uses: boxlite-ai/pr-review-agent@v1
        with:
          boxlite-api-key: \${{ secrets.BOXLITE_API_KEY }}
          claude-code-oauth-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          broker-url: ${brokerUrl}
          trigger-phrase: '@boxlite-agent review'
`
}

async function gh(path, token, init = {}) {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'boxlite-setup',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) throw new BrokerError(res.status, `${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

// GitHub Actions secrets must be libsodium sealed-box encrypted with the repo's public key.
// tweetnacl-sealedbox-js implements crypto_box_seal in pure JS (bundles on Workers; no WASM).
function seal(value, publicKeyB64) {
  const publicKey = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0))
  const sealed = sealedbox.seal(new TextEncoder().encode(value), publicKey)
  return btoa(String.fromCharCode(...sealed))
}

async function setRepoSecret(owner, repo, name, value, token) {
  const pk = await gh(`/repos/${owner}/${repo}/actions/secrets/public-key`, token)
  const encrypted_value = seal(value, pk.key)
  await gh(`/repos/${owner}/${repo}/actions/secrets/${name}`, token, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_value, key_id: pk.key_id }),
  })
}

async function putWorkflow(owner, repo, token, workflow, branch) {
  let sha
  const ref = branch ? `?ref=${branch}` : ''
  try {
    sha = (await gh(`/repos/${owner}/${repo}/contents/${WORKFLOW_PATH}${ref}`, token)).sha
  } catch {
    /* file doesn't exist yet */
  }
  await gh(`/repos/${owner}/${repo}/contents/${WORKFLOW_PATH}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'ci: add BoxLite PR review workflow',
      content: btoa(workflow),
      ...(branch ? { branch } : {}),
      ...(sha ? { sha } : {}),
    }),
  })
}

/**
 * Add the review workflow. Tries a direct commit to the default branch; if that repo
 * protects its default branch (409 — required PRs / status checks / merge queue), falls
 * back to a branch + pull request the maintainer merges. Returns 'committed' or 'pr'.
 */
async function commitWorkflow(owner, repo, token, workflow) {
  try {
    await putWorkflow(owner, repo, token, workflow)
    return 'committed'
  } catch (e) {
    if (!(e instanceof BrokerError) || e.status !== 409) throw e
  }
  const base = (await gh(`/repos/${owner}/${repo}`, token)).default_branch
  const baseSha = (await gh(`/repos/${owner}/${repo}/git/ref/heads/${base}`, token)).object.sha
  const branch = 'boxlite-review-setup'
  await gh(`/repos/${owner}/${repo}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  }).catch(async (e) => {
    if (!(e instanceof BrokerError) || e.status !== 422) throw e // 422 = branch exists → reuse it
    await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ sha: baseSha, force: true }),
    })
  })
  await putWorkflow(owner, repo, token, workflow, branch)
  await gh(`/repos/${owner}/${repo}/pulls`, token, {
    method: 'POST',
    body: JSON.stringify({
      title: 'ci: add BoxLite PR review workflow',
      head: branch,
      base,
      body: 'Your default branch is protected, so BoxLite is adding its reviewer workflow via this PR. Merge it to enable `@boxlite-agent` reviews.',
    }),
  }).catch((e) => {
    if (!(e instanceof BrokerError) || e.status !== 422) throw e // 422 = PR already open
  })
  return 'pr'
}

/** GitHub App Setup URL handler: GET shows the form, POST configures the installation. */
export async function handleSetup(request, env, url) {
  if (request.method === 'GET') {
    return html(formPage(url.searchParams.get('installation_id') || ''))
  }
  const form = await request.formData()
  const installationId = form.get('installation_id')
  const boxliteKey = form.get('boxlite_key')
  const claudeToken = form.get('claude_token')
  if (!installationId || !boxliteKey || !claudeToken) {
    throw new BrokerError(400, 'installation_id, boxlite_key and claude_token are required')
  }

  // Installation token for THIS install — scoped to the repos the user granted.
  const auth = createAppAuth({ appId: env.APP_ID, privateKey: env.APP_PRIVATE_KEY })
  const { token } = await auth({ type: 'installation', installationId: Number(installationId) })

  const workflow = buildWorkflow(url.origin) // broker-url = this Worker → @boxlite-agent[bot] runs
  const { repositories } = await gh('/installation/repositories?per_page=100', token)
  const configured = []
  for (const r of repositories) {
    await setRepoSecret(r.owner.login, r.name, 'BOXLITE_API_KEY', boxliteKey, token)
    await setRepoSecret(r.owner.login, r.name, 'CLAUDE_CODE_OAUTH_TOKEN', claudeToken, token)
    await commitWorkflow(r.owner.login, r.name, token, workflow)
    configured.push(r.full_name)
  }
  return html(donePage(configured))
}

function html(body) {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function formPage(installationId) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem}
input{width:100%;padding:.6rem;margin:.3rem 0 1rem;font:inherit;box-sizing:border-box}
button{padding:.6rem 1.2rem;font:inherit;background:#6f42c1;color:#fff;border:0;border-radius:6px;cursor:pointer}
label{font-weight:600}.h{color:#57606a;font-size:.9em}</style>
<h2>📦 Finish setting up BoxLite PR Reviewer</h2>
<p class=h>These are stored as encrypted secrets in your repos and used to boot your review
microVM + run Claude on your own account. They pass through here once and are never kept.</p>
<form method=post>
<input type=hidden name=installation_id value="${installationId}">
<label>BoxLite org API key (blk_live_…)</label>
<input name=boxlite_key required autocomplete=off>
<label>Claude token (from <code>claude setup-token</code>, sk-ant-oat…)</label>
<input name=claude_token required autocomplete=off>
<button type=submit>Configure my repositories</button>
</form>`
}

function donePage(repos) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem}
li{margin:.2rem 0}code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}</style>
<h2>✅ BoxLite is set up</h2>
<p>Added the review workflow + secrets to:</p>
<ul>${repos.map((r) => `<li><code>${r}</code></li>`).join('') || '<li>(no repositories were granted)</li>'}</ul>
<p>Open a pull request in any of them — 📦 <b>BoxLite review</b> will run automatically.
Comment <code>@boxlite review</code> to re-run.</p>`
}
