// BoxLite PR Reviewer — orchestrator.
//
// Runs on the GitHub Actions runner (thin trigger). Boots a microVM on
// app.boxlite.ai in the caller's own org, ships the pr-review payload into it,
// runs the review, and tears the box down. All review compute is the box; this
// process only orchestrates. Secrets travel per-exec and are never persisted in
// box env (box env is server-persisted and part of the warm-pool match key).
//
// Consumed by action.yml, which maps the GitHub event context to the env below.
// Also runnable locally for a dry run — see pr-reviewer/README.md.
import { JsBoxlite, BoxliteRestOptions, ApiKeyCredential, SimpleBox } from '@boxlite-ai/boxlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveCredential } from './lib/credential.mjs'

// copyIn only lands files under /workspace (the box's writable workdir); a copyIn to
// a path outside it silently no-ops. And box.stop() does not remove the box despite
// autoRemove — deletion needs runtime.remove(id). Both are worked around below.
const BOX_WORKDIR = '/workspace/pr-review'

const {
  BOXLITE_URL = 'https://app.boxlite.ai/api',
  BOXLITE_API_KEY,
  BOXLITE_IMAGE = 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3',
  ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN,
  MODEL,
  GH_TOKEN,
  REPO,
  PR_NUMBER,
  HEAD_SHA,
  BASE_REF,
} = process.env

const required = { BOXLITE_API_KEY, GH_TOKEN, REPO, PR_NUMBER, HEAD_SHA, BASE_REF }
const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key)
if (missing.length > 0) {
  console.error(`missing required env: ${missing.join(', ')}`)
  process.exit(1)
}

// Exactly one Claude credential — API key or subscription OAuth token.
let credential
try {
  credential = resolveCredential({ apiKey: ANTHROPIC_API_KEY, oauthToken: CLAUDE_CODE_OAUTH_TOKEN })
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const payloadDir = path.join(here, 'payload', 'pr-review')
const PAYLOAD_FILES = ['run.sh', 'prompt.md', 'post-comment.mjs']

const runtime = JsBoxlite.rest(
  new BoxliteRestOptions({
    url: BOXLITE_URL,
    credential: new ApiKeyCredential(BOXLITE_API_KEY),
  }),
)

const makeBox = () =>
  new SimpleBox({
    runtime,
    image: BOXLITE_IMAGE,
    // Unique per head SHA so a fresh box is always created. A clean run removes the box
    // in finally; crash-orphans are reaped by the org's auto-stop.
    name: `pr-review-${REPO.replace(/[^a-zA-Z0-9]/g, '-')}-${PR_NUMBER}-${HEAD_SHA.slice(0, 7)}`,
    cpus: 2,
    memoryMib: 4096,
    // Open egress (no allowNet): app.boxlite.ai fails to install a listed host's egress
    // rule in ~half of freshly-booted boxes, silently connection-refusing it for the
    // box's whole life (api.anthropic.com hit hardest). An allowlist is unusable until
    // that is fixed upstream, so the review box runs with unrestricted outbound.
    network: { mode: 'enabled' },
    // No env here: box env is persisted server-side and part of the warm-pool match
    // key — secrets travel per-exec below instead.
  })

// Boot with retries: app.boxlite.ai intermittently refuses the create call
// ("connect failed reaching …/v1/boxes"). The first exec forces creation, so retry it
// on a fresh box until one comes up.
async function bootBox(attempts = 5) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const candidate = makeBox()
    try {
      await candidate.exec('mkdir', '-p', BOX_WORKDIR)
      return candidate
    } catch (error) {
      lastError = error
      const id = await candidate.getId().catch(() => undefined)
      if (id) await runtime.remove(id).catch(() => {})
      console.error(`box boot attempt ${attempt}/${attempts} failed: ${error?.message ?? error}`)
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt))
    }
  }
  throw lastError
}

const box = await bootBox()

let exitCode = 1
try {
  for (const file of PAYLOAD_FILES) {
    await box.copyIn(path.join(payloadDir, file), `${BOX_WORKDIR}/${file}`)
  }
  await box.exec('chmod', '+x', `${BOX_WORKDIR}/run.sh`)

  const result = await box.exec(
    'bash',
    [`${BOX_WORKDIR}/run.sh`, REPO, PR_NUMBER, HEAD_SHA, BASE_REF],
    { GH_TOKEN, ...credential.env, ...(MODEL ? { MODEL } : {}) },
    { timeoutSecs: 900 },
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  exitCode = result.exitCode
} finally {
  // stop() does not remove the box despite autoRemove — delete it explicitly.
  const boxId = await box.getId().catch(() => undefined)
  if (boxId) {
    await runtime.remove(boxId).catch((error) => console.error(`failed to remove box ${boxId}: ${error?.message ?? error}`))
  }
}
process.exit(exitCode)
