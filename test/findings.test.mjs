import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseReview, normalizeReview } from '../lib/findings.mjs'

test('parseReview accepts a bare JSON object', () => {
  const r = parseReview('{"verdict":"1 issue","changeMap":[],"findings":[{"path":"a.js","line":3,"severity":"blocker","title":"T","body":"B"}]}')
  assert.equal(r.verdict, '1 issue')
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].path, 'a.js')
})

test('parseReview unwraps a ```json fence', () => {
  const r = parseReview('```json\n{"verdict":"looks good","findings":[]}\n```')
  assert.equal(r.verdict, 'looks good')
})

test('parseReview tolerates a prose preamble before a fenced object (the dune#1 failure)', () => {
  const r = parseReview('Not even exported/used elsewhere.\n\n```json\n{"verdict":"1 issue","findings":[]}\n```')
  assert.equal(r.verdict, '1 issue')
})

test('parseReview throws a clear error on non-JSON and on empty', () => {
  assert.throws(() => parseReview('the code looks fine'), /not JSON/)
  assert.throws(() => parseReview('   '), /empty/)
})

test('normalizeReview drops malformed findings and coerces fields', () => {
  const r = normalizeReview({
    findings: [
      { path: 'a.js', line: 5, severity: 'blocker', title: 'ok', body: 'b' },
      { path: '', line: 5, severity: 'blocker', title: 'no path', body: 'b' }, // dropped
      { path: 'b.js', line: 'notnum', severity: 'warning', title: 'bad line', body: 'b' }, // dropped
      { path: 'c.js', line: 9, severity: 'purple', title: 'bad severity', body: 'b' }, // severity → warning
    ],
  })
  assert.deepEqual(r.findings.map((f) => f.title), ['ok', 'bad severity'])
  assert.equal(r.findings[1].severity, 'warning')
})

test('normalizeReview nulls an endLine that is not past line', () => {
  const r = normalizeReview({ findings: [{ path: 'a.js', line: 10, endLine: 8, severity: 'nit', title: 't', body: 'b' }] })
  assert.equal(r.findings[0].endLine, null)
})

test('normalizeReview derives the verdict from the finding count when absent', () => {
  assert.equal(normalizeReview({ findings: [] }).verdict, 'looks good')
  assert.equal(normalizeReview({ findings: [{ path: 'a', line: 1, severity: 'nit', title: 't', body: 'b' }] }).verdict, '1 issue')
  assert.equal(
    normalizeReview({ findings: [{ path: 'a', line: 1, severity: 'nit', title: 't', body: 'b' }, { path: 'b', line: 2, severity: 'nit', title: 't', body: 'b' }] }).verdict,
    '2 issues',
  )
})
