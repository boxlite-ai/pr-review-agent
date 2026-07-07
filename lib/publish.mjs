// Runner-side publisher. Turns the box's structured findings into GitHub surfaces: one
// batched PR review with inline comments, one sticky summary comment, one check run.
// The model stays read-only and never holds the write token — this step does all writes.
import { ghJson } from './github.mjs'
import { MARKER } from './comment.mjs'
import { SEVERITY_META } from './findings.mjs'

// ── diff mapping ──────────────────────────────────────────────────────────────────
// GitHub's Reviews API rejects (422) an inline comment whose line is not part of the
// diff. We parse each file's patch to the set of RIGHT-side lines it adds, and only
// comment on those — reviewdog's `added` filter. Everything else rolls into the summary.

/** RIGHT-side line numbers added by a unified-diff patch (context/removed excluded). */
export function parseAddedLines(patch) {
  const added = new Set()
  if (typeof patch !== 'string') return added
  let newLine = 0
  for (const row of patch.split('\n')) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10)
      continue
    }
    if (row.startsWith('+++') || row.startsWith('---')) continue // defensive: file headers
    if (row.startsWith('+')) {
      added.add(newLine)
      newLine += 1
    } else if (row.startsWith('-')) {
      // removed line: advances the old side only
    } else {
      newLine += 1 // context (leading space) advances the new side
    }
  }
  return added
}

/** Map every changed file in the PR to the set of RIGHT-side lines it adds. */
export async function fetchChangedLines({ repo, pr, token, fetchImpl = fetch }) {
  const changed = new Map()
  for (let page = 1; page <= 20; page++) {
    const files = await ghJson(`/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`, { token, fetchImpl })
    for (const file of files) {
      if (file.status === 'removed') continue
      changed.set(file.filename, parseAddedLines(file.patch || ''))
    }
    if (files.length < 100) break
  }
  return changed
}

/**
 * Split findings into those that can be posted inline (path + line[s] are in the diff and
 * the path is not excluded by config) and those that can only go in the summary. A path
 * excluded by `isIncluded` is dropped entirely.
 */
export function partition(findings, changed, isIncluded = () => true) {
  const inline = []
  const summaryOnly = []
  for (const f of findings) {
    if (!isIncluded(f.path)) continue
    const lines = changed.get(f.path)
    const anchored = lines?.has(f.line) && (f.endLine ? lines.has(f.endLine) : true)
    if (anchored) inline.push(f)
    else summaryOnly.push(f)
  }
  return { inline, summaryOnly }
}

// ── inline review ─────────────────────────────────────────────────────────────────

/** Build GitHub review-comment objects (severity badge + optional suggestion block). */
export function buildReviewComments(inline) {
  return inline.map((f) => {
    const { badge } = SEVERITY_META[f.severity]
    let body = `${badge} **${f.title}**\n${f.body}`
    if (f.suggestion) body += `\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``
    const multiline = f.endLine && f.endLine > f.line
    const comment = { path: f.path, side: 'RIGHT', line: multiline ? f.endLine : f.line, body }
    if (multiline) {
      comment.start_line = f.line
      comment.start_side = 'RIGHT'
    }
    return comment
  })
}

/**
 * Post ONE review carrying every inline comment (a single notification). Returns
 * `{ skipped: true }` when there is nothing to inline — the sticky summary covers those.
 */
export async function postReview({ repo, pr, headSha, verdict, comments, token, fetchImpl = fetch }) {
  if (comments.length === 0) return { skipped: true }
  await ghJson(`/repos/${repo}/pulls/${pr}/reviews`, {
    token,
    fetchImpl,
    method: 'POST',
    body: {
      commit_id: headSha,
      body: `**BoxLite review — ${verdict}**`,
      event: 'COMMENT', // never APPROVE/REQUEST_CHANGES — an automated reviewer must not gate merges
      comments,
    },
  })
  return { posted: comments.length }
}

// ── sticky summary ──────────────────────────────────────────────────────────────────

/** The change map as a monospace call graph, grouped by file. */
export function renderChangeMap(changeMap) {
  if (!changeMap.length) return ''
  const byFile = new Map()
  for (const entry of changeMap) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, [])
    byFile.get(entry.file).push(entry)
  }
  const lines = []
  for (const [file, entries] of byFile) {
    lines.push(file)
    for (const e of entries) {
      const row = [e.symbol, e.loc, e.note].filter(Boolean).join('  ')
      if (row) lines.push(`  ${row}`)
    }
  }
  return '```text\n' + lines.join('\n') + '\n```'
}

/** Findings that could not be inlined (outside the diff), as a collapsible list. */
export function renderOffDiff(findings) {
  if (!findings.length) return ''
  const items = findings.map((f) => {
    const { badge } = SEVERITY_META[f.severity]
    const range = f.endLine && f.endLine > f.line ? `${f.line}-${f.endLine}` : `${f.line}`
    return `- ${badge} \`${f.path}:${range}\` **${f.title}** — ${f.body}`
  })
  const label = `${findings.length} finding${findings.length === 1 ? '' : 's'} outside the diff`
  return `<details><summary>${label}</summary>\n\n${items.join('\n')}\n</details>`
}

/** The full sticky-comment body: marker + verdict + call graph + off-diff + promo footer. */
export function renderSummary({ verdict, changeMap, summaryOnly, headSha }) {
  const sha7 = (headSha || '').slice(0, 7)
  const parts = [MARKER, `**${verdict}**${sha7 ? ` · \`${sha7}\`` : ''}`]
  const graph = renderChangeMap(changeMap)
  if (graph) parts.push(graph)
  const offDiff = renderOffDiff(summaryOnly)
  if (offDiff) parts.push(offDiff)
  parts.push(
    `<sub>reviewed${sha7 ? ` \`${sha7}\`` : ''} in a BoxLite microVM · \`@boxlite review\` to re-run · powered by <a href="https://boxlite.ai">BoxLite</a></sub>`,
  )
  return parts.join('\n\n')
}

// ── check run ───────────────────────────────────────────────────────────────────────

/** Findings → check-run annotations (GitHub caps these at 50 per request). */
export function buildAnnotations(findings) {
  return findings.slice(0, 50).map((f) => ({
    path: f.path,
    start_line: f.line,
    end_line: f.endLine && f.endLine > f.line ? f.endLine : f.line,
    annotation_level: SEVERITY_META[f.severity].level,
    title: f.title,
    message: f.body,
  }))
}

/**
 * Create a completed check run. No findings → `success` (green); any findings → `neutral`
 * (visible but never blocks merge). Requires `checks: write`; best-effort at the call site.
 */
export async function postCheckRun({ repo, headSha, verdict, findings, token, fetchImpl = fetch }) {
  const count = findings.length
  await ghJson(`/repos/${repo}/check-runs`, {
    token,
    fetchImpl,
    method: 'POST',
    body: {
      name: 'BoxLite review',
      head_sha: headSha,
      status: 'completed',
      conclusion: count ? 'neutral' : 'success',
      output: {
        title: verdict,
        summary: `${count} finding${count === 1 ? '' : 's'} · reviewed in a BoxLite microVM`,
        annotations: buildAnnotations(findings),
      },
    },
  })
  return { count }
}
