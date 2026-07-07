import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseAddedLines,
  partition,
  buildReviewComments,
  buildAnnotations,
  renderChangeMap,
  renderSummary,
  postReview,
} from '../lib/publish.mjs'
import { isPathIncluded } from '../lib/config.mjs'
import { MARKER } from '../lib/comment.mjs'

// A unified-diff patch as GitHub returns it in `pulls/{n}/files[].patch`.
const PATCH = ['@@ -1,3 +1,4 @@', ' context', '-gone', '+added-a', '+added-b', ' tail'].join('\n')

test('parseAddedLines returns only RIGHT-side added lines', () => {
  const added = parseAddedLines(PATCH)
  assert.deepEqual([...added].sort((a, b) => a - b), [2, 3]) // +added-a=2, +added-b=3
  assert.ok(!added.has(1)) // context, not added
  assert.ok(!added.has(4)) // trailing context
})

test('a finding off the diff is demoted to the summary (never sent inline → no 422)', () => {
  const changed = new Map([['src/a.js', parseAddedLines(PATCH)]])
  const findings = [
    { path: 'src/a.js', line: 2, endLine: null, severity: 'blocker', title: 'in', body: 'b', suggestion: null },
    { path: 'src/a.js', line: 99, endLine: null, severity: 'warning', title: 'off-diff', body: 'b', suggestion: null },
    { path: 'other.js', line: 1, endLine: null, severity: 'nit', title: 'other-file', body: 'b', suggestion: null },
  ]
  const { inline, summaryOnly } = partition(findings, changed, (p) => isPathIncluded(p, []))
  assert.deepEqual(inline.map((f) => f.title), ['in'])
  assert.deepEqual(summaryOnly.map((f) => f.title).sort(), ['off-diff', 'other-file'])
})

test('partition drops findings under an excluded path entirely', () => {
  const changed = new Map([['dist/bundle.js', parseAddedLines(PATCH)]])
  const findings = [{ path: 'dist/bundle.js', line: 2, endLine: null, severity: 'nit', title: 'x', body: 'b', suggestion: null }]
  const { inline, summaryOnly } = partition(findings, changed, (p) => isPathIncluded(p, ['!dist/**']))
  assert.equal(inline.length, 0)
  assert.equal(summaryOnly.length, 0)
})

test('buildReviewComments carries a severity badge, a suggestion block, and a multi-line range', () => {
  const [single, ranged] = buildReviewComments([
    { path: 'a.js', line: 5, endLine: null, severity: 'blocker', title: 'Null deref', body: 'x may be null', suggestion: 'if (x) x.run()' },
    { path: 'b.js', line: 10, endLine: 12, severity: 'warning', title: 'Race', body: 'unsynced', suggestion: null },
  ])
  assert.equal(single.line, 5)
  assert.equal(single.start_line, undefined)
  assert.match(single.body, /🛑 \*\*Null deref\*\*/)
  assert.match(single.body, /```suggestion\nif \(x\) x\.run\(\)\n```/)

  assert.equal(ranged.line, 12) // GitHub anchors a range at its end line
  assert.equal(ranged.start_line, 10)
  assert.equal(ranged.start_side, 'RIGHT')
})

test('buildAnnotations maps severity → GitHub annotation level and clamps to 50', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    path: 'a.js', line: i + 1, endLine: null, severity: 'nit', title: 't', body: 'b', suggestion: null,
  }))
  const annotations = buildAnnotations(many)
  assert.equal(annotations.length, 50)

  const levels = buildAnnotations([
    { path: 'a', line: 1, endLine: null, severity: 'blocker', title: 't', body: 'b' },
    { path: 'a', line: 2, endLine: null, severity: 'warning', title: 't', body: 'b' },
    { path: 'a', line: 3, endLine: null, severity: 'nit', title: 't', body: 'b' },
  ]).map((a) => a.annotation_level)
  assert.deepEqual(levels, ['failure', 'warning', 'notice'])
})

test('postReview is skipped when there is nothing to inline', async () => {
  let called = false
  const result = await postReview({
    repo: 'a/b', pr: '1', headSha: 'sha', verdict: 'looks good', comments: [], token: 't',
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } },
  })
  assert.deepEqual(result, { skipped: true })
  assert.equal(called, false)
})

test('renderChangeMap groups entries by file as a monospace call graph', () => {
  const graph = renderChangeMap([
    { file: 'orchestrate.mjs', symbol: 'publish()', loc: '+40/-2', note: 'new poster' },
    { file: 'orchestrate.mjs', symbol: 'bootBox()', loc: '+3', note: 'retry' },
    { file: 'lib/publish.mjs', symbol: null, loc: '+80', note: 'new file' },
  ])
  assert.match(graph, /^```text/)
  assert.match(graph, /orchestrate\.mjs\n {2}publish\(\) {2}\+40\/-2 {2}new poster/)
  assert.match(graph, /lib\/publish\.mjs\n {2}\+80 {2}new file/) // no symbol → loc leads
})

test('renderSummary leads with the marker and verdict and ends with the BoxLite footer', () => {
  const body = renderSummary({
    verdict: '2 issues',
    changeMap: [{ file: 'a.js', symbol: 'f()', loc: '+1', note: 'x' }],
    summaryOnly: [{ path: 'a.js', line: 9, endLine: null, severity: 'warning', title: 'T', body: 'B', suggestion: null }],
    headSha: 'abcdef1234',
  })
  assert.ok(body.startsWith(MARKER))
  assert.match(body, /\*\*2 issues\*\* · `abcdef1`/)
  assert.match(body, /<details><summary>1 finding outside the diff<\/summary>/)
  assert.match(body, /powered by <a href="https:\/\/boxlite\.ai">BoxLite<\/a>/)
})
