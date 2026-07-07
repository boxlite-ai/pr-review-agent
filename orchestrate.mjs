// BoxLite PR Reviewer — orchestrator.
//
// Runs on the GitHub Actions runner (thin trigger + trusted publisher). Boots a microVM
// on app.boxlite.ai in the caller's own org, ships the pr-review payload into it, runs
// the read-only review, then turns the box's structured findings into GitHub surfaces:
// one batched inline review, one sticky summary comment, one check run. All review
// compute is the box; all GitHub writes are here. The box never posts.
//
// Consumed by action.yml, which maps the GitHub event context to the env below.
// Also runnable locally for a dry run — see pr-reviewer/README.md.
import { JsBoxlite, BoxliteRestOptions, ApiKeyCredential, SimpleBox } from '@boxlite-ai/boxlite'
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveCredential } from './lib/credential.mjs'
import { ghJson } from './lib/github.mjs'
import { fetchConfig, isPathIncluded } from './lib/config.mjs'
import { parseReview } from './lib/findings.mjs'
import { upsertComment } from './lib/comment.mjs'
import {
  fetchChangedLines,
  partition,
  buildReviewComments,
  postReview,
  renderSummary,
  postCheckRun,
} from './lib/publish.mjs'

// copyIn only lands files under /workspace (the box's writable workdir); a copyIn to a
// path outside it silently no-ops. And box.stop() does not remove the box despite
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
  EVENT_NAME = 'pull_request',
  COMMENT_BODY = '',
  TRIGGER_PHRASE = '@boxlite review',
  REPO,
  PR_NUMBER,
} = process.env
let { HEAD_SHA, BASE_REF } = process.env

// Always required; HEAD_SHA/BASE_REF come from the pull_request payload or, for an
// issue_comment re-trigger, are fetched from the PR below.
const required = { BOXLITE_API_KEY, GH_TOKEN, REPO, PR_NUMBER }
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

// An `@boxlite review` comment re-triggers a review. Skip cleanly if the phrase is absent
// (defense-in-depth; the workflow `if:` should already gate this), and resolve the PR's
// head/base since the comment payload carries neither.
if (EVENT_NAME === 'issue_comment') {
  if (!COMMENT_BODY.includes(TRIGGER_PHRASE)) {
    console.log(`comment does not contain "${TRIGGER_PHRASE}"; nothing to do`)
    process.exit(0)
  }
  const pull = await ghJson(`/repos/${REPO}/pulls/${PR_NUMBER}`, { token: GH_TOKEN })
  HEAD_SHA = pull.head.sha
  BASE_REF = pull.base.ref
}

if (!HEAD_SHA || !BASE_REF) {
  console.error('could not resolve HEAD_SHA / BASE_REF for this event')
  process.exit(1)
}

// Optional per-repo policy at the PR head.
const config = await fetchConfig({ repo: REPO, ref: HEAD_SHA, token: GH_TOKEN, parseYaml })
const pathInstructions = config.path_instructions
  .map((p) => `For files matching ${p.path}: ${p.instructions}`)
  .join('\n')
const ignoreGlobs = config.path_filters
  .filter((f) => f.startsWith('!'))
  .map((f) => f.slice(1))
  .join(', ')

const here = path.dirname(fileURLToPath(import.meta.url))
const payloadDir = path.join(here, 'payload', 'pr-review')
const PAYLOAD_FILES = ['review.mjs', 'prompt.md']

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

  // Run the read-only review inside the box; it prints the review JSON to stdout.
  // Secrets travel per-exec (never in box env). GH_TOKEN is used only to clone and is
  // scrubbed before the model runs — the box performs no GitHub writes.
  const boxEnv = {
    GH_TOKEN,
    ...credential.env,
    ...(MODEL ? { MODEL } : {}),
    ...(config.profile ? { PROFILE: config.profile } : {}),
    ...(config.focus ? { FOCUS: config.focus } : {}),
    ...(config.language ? { LANGUAGE: config.language } : {}),
    ...(pathInstructions ? { PATH_INSTRUCTIONS: pathInstructions } : {}),
    ...(ignoreGlobs ? { IGNORE_GLOBS: ignoreGlobs } : {}),
  }
  const result = await box.exec(
    'node',
    [`${BOX_WORKDIR}/review.mjs`, REPO, PR_NUMBER, HEAD_SHA, BASE_REF],
    boxEnv,
    { timeoutSecs: 900 },
  )
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr)
    console.error(`review failed in the box (exit ${result.exitCode})`)
    exitCode = result.exitCode
  } else {
    process.stderr.write(result.stderr)
    exitCode = await publish(result.stdout)
  }
} finally {
  // stop() does not remove the box despite autoRemove — delete it explicitly.
  const boxId = await box.getId().catch(() => undefined)
  if (boxId) {
    await runtime
      .remove(boxId)
      .catch((error) => console.error(`failed to remove box ${boxId}: ${error?.message ?? error}`))
  }
}
process.exit(exitCode)

/**
 * Publish the box's structured review to GitHub. The sticky summary must post (it is the
 * reliable surface); the inline review and check run are best-effort — a permission gap on
 * one must not sink the whole review. When inline posting fails, its findings fall back
 * into the summary so nothing is lost.
 */
async function publish(reviewJson) {
  const review = parseReview(reviewJson)
  const changed = await fetchChangedLines({ repo: REPO, pr: PR_NUMBER, token: GH_TOKEN })
  const isIncluded = (p) => isPathIncluded(p, config.path_filters)
  const { inline, summaryOnly } = partition(review.findings, changed, isIncluded)

  let inlinePosted = false
  try {
    const posted = await postReview({
      repo: REPO,
      pr: PR_NUMBER,
      headSha: HEAD_SHA,
      verdict: review.verdict,
      comments: buildReviewComments(inline),
      token: GH_TOKEN,
    })
    inlinePosted = !posted.skipped
  } catch (error) {
    console.error(`inline review failed (findings fall back to the summary): ${error?.message ?? error}`)
  }

  const summaryFindings = inlinePosted ? summaryOnly : [...summaryOnly, ...inline]
  const summary = renderSummary({
    verdict: review.verdict,
    changeMap: review.changeMap,
    summaryOnly: summaryFindings,
    headSha: HEAD_SHA,
  })
  const upserted = await upsertComment({ repo: REPO, pr: PR_NUMBER, body: summary, token: GH_TOKEN })
  console.log(`${upserted.action} sticky summary ${upserted.id} · ${review.verdict}`)

  try {
    await postCheckRun({ repo: REPO, headSha: HEAD_SHA, verdict: review.verdict, findings: review.findings, token: GH_TOKEN })
  } catch (error) {
    console.error(`check run failed (needs checks: write): ${error?.message ?? error}`)
  }
  return 0
}
