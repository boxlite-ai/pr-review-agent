// GitHub App webhook — the trigger for the runner. Two jobs:
//   • pull_request (opened/synchronize/reopened/ready_for_review) → boot a box and
//     fire-and-forget the in-box reviewer, which calls back to /publish.
//   • installation.deleted → drop the stored keys.
// Payload authenticity is verified with the App's webhook secret (HMAC-SHA256).
import { BrokerError } from './claims.mjs'
import { loadKeys, deleteKeys } from './store.mjs'
import { mintToken } from './mint.mjs'
import { mintJob } from './job.mjs'
import { createBox, startExecution } from './boxes.mjs'

async function verifySignature(secret, body, header) {
  if (!secret || !header) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const expected = 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review'])

export async function handleWebhook(request, env, url) {
  const body = await request.text()
  if (!(await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) {
    throw new BrokerError(401, 'invalid webhook signature')
  }
  const event = request.headers.get('x-github-event')
  const payload = JSON.parse(body)
  const installationId = payload.installation?.id

  if (event === 'installation' && payload.action === 'deleted') {
    if (installationId) await deleteKeys(env, installationId)
    return new Response('keys dropped', { status: 200 })
  }

  if (event !== 'pull_request' || !PR_ACTIONS.has(payload.action)) return new Response('ignored', { status: 200 })
  const pr = payload.pull_request
  if (pr.draft) return new Response('draft — skipped', { status: 200 })

  const repo = payload.repository.full_name
  const [owner, name] = repo.split('/')
  const keys = await loadKeys(env, installationId)
  if (!keys) return new Response('not configured — run /setup once to store keys', { status: 200 })

  // contents:read clone token for the box; the PR-write token is minted at /publish.
  const { token: cloneToken } = await mintToken({
    appId: env.APP_ID,
    privateKey: env.APP_PRIVATE_KEY,
    owner,
    repo: name,
    permissions: { contents: 'read', metadata: 'read' },
  })

  const box = await createBox(keys.boxliteKey, env.BOXLITE_URL, `pr-review-${name}-${pr.number}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60))
  const boxId = box.id || box.name
  const job = await mintJob(env.STORE_SECRET, {
    repo,
    pr: pr.number,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    boxId,
    installationId,
  })

  // Fire-and-forget: exec returns an execution_id immediately; the box runs for minutes and
  // calls /publish. We never attach.
  await startExecution(keys.boxliteKey, env.BOXLITE_URL, boxId, {
    command: 'bash',
    args: ['-lc', 'curl -fsS "$BROKER/reviewer.mjs" -o /tmp/r.mjs && node /tmp/r.mjs'],
    env: {
      REPO: repo,
      PR: String(pr.number),
      HEAD_SHA: pr.head.sha,
      BASE_REF: pr.base.ref,
      GH_CLONE_TOKEN: cloneToken,
      CLAUDE_CODE_OAUTH_TOKEN: keys.claudeToken,
      JOB_TOKEN: job,
      BROKER: url.origin,
      BOX_ID: boxId,
    },
    timeoutSeconds: 900,
  })
  return new Response(`review started: ${repo}#${pr.number} in box ${boxId}`, { status: 200 })
}
