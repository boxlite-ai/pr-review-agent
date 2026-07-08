import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt, precheckJson } from '../payload/pr-review/review.mjs'

const base = 'BASE POLICY'

test('buildPrompt appends the PR trailer to the base policy', () => {
  const p = buildPrompt({ basePrompt: base, repo: 'acme/app', pr: '7', baseRef: 'main', shortHead: 'abc1234' })
  assert.ok(p.startsWith('BASE POLICY'))
  assert.match(p, /PR #7 of acme\/app\. Base: origin\/main\. Head: abc1234\./)
})

test('buildPrompt folds in optional config context only when set', () => {
  const p = buildPrompt({
    basePrompt: base, repo: 'a/b', pr: '1', baseRef: 'main', shortHead: 'h',
    env: { FOCUS: 'security', LANGUAGE: 'zh-CN', PATH_INSTRUCTIONS: 'for tests: edge cases', IGNORE_GLOBS: 'dist/**' },
  })
  assert.match(p, /Extra focus: security/)
  assert.match(p, /Write every string value in zh-CN\./)
  assert.match(p, /for tests: edge cases/)
  assert.match(p, /Do not review files matching: dist\/\*\*/)

  const bare = buildPrompt({ basePrompt: base, repo: 'a/b', pr: '1', baseRef: 'main', shortHead: 'h', env: {} })
  assert.ok(!bare.includes('Extra focus'))
  assert.ok(!bare.includes('Write every string value'))
})

test('buildPrompt reflects the review profile', () => {
  const strict = buildPrompt({ basePrompt: base, repo: 'a/b', pr: '1', baseRef: 'main', shortHead: 'h', env: { PROFILE: 'strict' } })
  assert.match(strict, /Review strictly: include minor issues/)
  const lean = buildPrompt({ basePrompt: base, repo: 'a/b', pr: '1', baseRef: 'main', shortHead: 'h', env: { PROFILE: 'lean' } })
  assert.match(lean, /Review for signal/)
})

test('precheckJson extracts the JSON object — bare, fenced, or after a prose preamble', () => {
  const bare = '{"verdict":"looks good","findings":[]}'
  assert.equal(precheckJson(bare), bare)

  // a ```json fence is unwrapped to the bare object
  assert.equal(precheckJson('```json\n{"verdict":"1 issue"}\n```'), '{"verdict":"1 issue"}')

  // the live failure on boxlite-ai/dune#1: the model explained first, THEN emitted the fence.
  const withPreamble = 'Not even exported/used elsewhere, and no test exists.\n\n```json\n{"verdict":"1 issue","findings":[]}\n```'
  assert.equal(precheckJson(withPreamble), '{"verdict":"1 issue","findings":[]}')
})

test('precheckJson throws on non-JSON (the fail-fast the box relies on)', () => {
  assert.throws(() => precheckJson('I reviewed the PR and it looks fine.'))
  assert.throws(() => precheckJson(''))
})
