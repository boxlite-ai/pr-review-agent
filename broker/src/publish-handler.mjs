// Worker /publish — the box's callback lands here. Verify the one-shot job token, re-mint the
// boxlite-agent[bot] token, post the inline review + sticky summary + check run (reusing the
// shared fetch-based publisher), then tear the box down. All GitHub writes happen here on the
// trusted Worker — never in the box.
import { BrokerError } from './claims.mjs'
import { verifyJob } from './job.mjs'
import { mintToken } from './mint.mjs'
import { loadKeys } from './store.mjs'
import { removeBox } from './boxes.mjs'
import { normalizeReview } from '../../lib/findings.mjs'
import {
  fetchChangedLines,
  partition,
  buildReviewComments,
  postReview,
  renderSummary,
  postCheckRun,
} from '../../lib/publish.mjs'
import { upsertComment, MARKER } from '../../lib/comment.mjs'

export async function handlePublish(request, env) {
  const { boxId, job, findings, error } = await request.json().catch(() => ({}))
  const claims = await verifyJob(env.STORE_SECRET, job)
  if (!claims) throw new BrokerError(401, 'invalid or expired job token')
  const { repo, pr, headSha, installationId } = claims
  const [owner, name] = repo.split('/')
  const keys = await loadKeys(env, installationId)

  try {
    const { token } = await mintToken({ appId: env.APP_ID, privateKey: env.APP_PRIVATE_KEY, owner, repo: name })

    if (error) {
      await upsertComment({
        repo,
        pr,
        token,
        body: `${MARKER}\n### 📦 BoxLite review — couldn't complete\n\n\`\`\`\n${String(error).slice(0, 800)}\n\`\`\`\n<sub>powered by <a href="https://boxlite.ai">BoxLite</a></sub>`,
      })
      return new Response('posted error', { status: 200 })
    }

    const review = normalizeReview(findings)
    const changed = await fetchChangedLines({ repo, pr, token })
    const { inline, summaryOnly } = partition(review.findings, changed)

    let inlinePosted = false
    try {
      const posted = await postReview({ repo, pr, headSha, verdict: review.verdict, comments: buildReviewComments(inline), token })
      inlinePosted = !posted.skipped
    } catch {
      /* inline failed → findings fall into the sticky summary */
    }
    const summaryFindings = inlinePosted ? summaryOnly : [...summaryOnly, ...inline]
    const summary = renderSummary({ verdict: review.verdict, changeMap: review.changeMap, summaryOnly: summaryFindings, headSha })
    await upsertComment({ repo, pr, token, body: summary })
    try {
      await postCheckRun({ repo, headSha, verdict: review.verdict, findings: review.findings, token })
    } catch {
      /* checks:write not granted — best-effort */
    }
    return new Response('published', { status: 200 })
  } finally {
    if (keys && boxId) await removeBox(keys.boxliteKey, env.BOXLITE_URL, boxId)
  }
}
