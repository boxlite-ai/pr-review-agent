// Upsert the sticky review comment: find our marker, PATCH in place, else POST new.
// Usage: node post-comment.mjs <owner/repo> <pr-number> <body-file>   (env: GH_TOKEN)
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MARKER = '<!-- boxlite-pr-review -->'
export const MAX_BODY_CHARS = 60000 // GitHub rejects comment bodies above 65536 chars.

/** GitHub caps a comment body; truncate with a visible marker before sending. */
export function clampBody(body) {
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '\n\n…(truncated)' : body
}

/**
 * One sticky comment per PR: reuse the comment carrying our marker (PATCH), else
 * create it (POST). Marker-based, not author-based, so it survives a bot-identity
 * change. `fetchImpl` is injectable for tests.
 */
export async function upsertComment({ repo, pr, body, token, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'boxlite-pr-reviewer',
  }
  const clamped = clampBody(body)

  const api = async (path, init = {}) => {
    const res = await fetchImpl(`https://api.github.com${path}`, { ...init, headers })
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
    }
    return res.json()
  }

  const comments = await api(`/repos/${repo}/issues/${pr}/comments?per_page=100`)
  const mine = comments.find((c) => c.body?.startsWith(MARKER))
  if (mine) {
    await api(`/repos/${repo}/issues/comments/${mine.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: clamped }),
    })
    return { action: 'updated', id: mine.id }
  }
  const created = await api(`/repos/${repo}/issues/${pr}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: clamped }),
  })
  return { action: 'created', id: created.id }
}

// CLI entrypoint — only when run directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo, pr, bodyFile] = process.argv.slice(2)
  const result = await upsertComment({
    repo,
    pr,
    body: readFileSync(bodyFile, 'utf8'),
    token: process.env.GH_TOKEN,
  })
  console.log(`${result.action} sticky comment ${result.id}`)
}
