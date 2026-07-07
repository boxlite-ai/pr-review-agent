import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globToRegExp, isPathIncluded, normalizeConfig, DEFAULT_CONFIG } from '../lib/config.mjs'

test('globToRegExp: ** spans path segments, * stays within one', () => {
  const g = globToRegExp('src/**/*.ts')
  assert.ok(g.test('src/a.ts'))
  assert.ok(g.test('src/a/b/c.ts'))
  assert.ok(!g.test('lib/a.ts'))
  assert.ok(!g.test('src/a.tsx'))

  const single = globToRegExp('src/*.ts')
  assert.ok(single.test('src/a.ts'))
  assert.ok(!single.test('src/a/b.ts')) // * does not cross '/'
})

test('isPathIncluded: no filters → everything included', () => {
  assert.ok(isPathIncluded('anything.js', []))
})

test('isPathIncluded: a bare exclude keeps everything else', () => {
  assert.ok(!isPathIncluded('dist/bundle.js', ['!dist/**']))
  assert.ok(!isPathIncluded('a/b.lock', ['!**/*.lock']))
  assert.ok(isPathIncluded('src/app.js', ['!dist/**', '!**/*.lock']))
})

test('isPathIncluded: positives restrict to matches, excludes still subtract', () => {
  assert.ok(isPathIncluded('src/app.ts', ['src/**', '!**/*.test.ts']))
  assert.ok(!isPathIncluded('docs/readme.md', ['src/**'])) // not matched by any positive
  assert.ok(!isPathIncluded('src/app.test.ts', ['src/**', '!**/*.test.ts'])) // excluded wins
})

test('normalizeConfig coerces unknown/garbage to safe defaults', () => {
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG)

  const c = normalizeConfig({
    path_filters: ['src/**', 42, '!**/*.lock'],
    path_instructions: [{ path: '**/*.test.ts', instructions: 'edge cases' }, { path: 'x' }, 'nope'],
    focus: 'security',
    language: 'zh-CN',
    profile: 'strict',
    unknown: 'ignored',
  })
  assert.deepEqual(c.path_filters, ['src/**', '!**/*.lock']) // the non-string dropped
  assert.deepEqual(c.path_instructions, [{ path: '**/*.test.ts', instructions: 'edge cases' }])
  assert.equal(c.focus, 'security')
  assert.equal(c.language, 'zh-CN')
  assert.equal(c.profile, 'strict')
  assert.equal('unknown' in c, false)
})

test('normalizeConfig defaults an unrecognized profile to lean', () => {
  assert.equal(normalizeConfig({ profile: 'spicy' }).profile, 'lean')
})
