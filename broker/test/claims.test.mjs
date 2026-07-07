import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveTarget, GITHUB_OIDC_ISSUER, BrokerError } from '../src/claims.mjs'

const AUD = 'https://broker.boxlite.ai'
const good = (over = {}) => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: AUD,
  repository: 'acme/app',
  repository_owner: 'acme',
  repository_id: '12345',
  job_workflow_ref: 'acme/app/.github/workflows/review.yml@refs/heads/main',
  ...over,
})

test('valid claims → owner/repo derived from the repository claim', () => {
  const t = resolveTarget(good(), { audience: AUD })
  assert.deepEqual({ owner: t.owner, repo: t.repo, repositoryId: t.repositoryId }, {
    owner: 'acme',
    repo: 'app',
    repositoryId: '12345',
  })
})

test('scope comes ONLY from the verified claim — a spoofed body cannot redirect it', () => {
  // resolveTarget takes claims + audience; there is no request-body parameter, by design.
  // Whatever repo a caller *wants*, the token is scoped to the claim's repository.
  const t = resolveTarget(good({ repository: 'acme/private-repo', repository_owner: 'acme' }), { audience: AUD })
  assert.equal(t.repo, 'private-repo')
})

test('wrong issuer → 401', () => {
  assert.throws(() => resolveTarget(good({ iss: 'https://evil.example' }), { audience: AUD }), (e) => e instanceof BrokerError && e.status === 401)
})

test('audience mismatch → 401 (token minted for another STS is rejected)', () => {
  assert.throws(() => resolveTarget(good({ aud: 'sts.amazonaws.com' }), { audience: AUD }), (e) => e.status === 401)
  // array-form audience is honored
  assert.doesNotThrow(() => resolveTarget(good({ aud: ['x', AUD] }), { audience: AUD }))
})

test('missing broker audience config → 500 (fail closed, never skip the check)', () => {
  assert.throws(() => resolveTarget(good(), { audience: '' }), (e) => e.status === 500)
})

test('repository not under repository_owner → 400 (guards a forged split)', () => {
  assert.throws(() => resolveTarget(good({ repository: 'evil/app', repository_owner: 'acme' }), { audience: AUD }), (e) => e.status === 400)
})

test('missing repository claims → 400', () => {
  assert.throws(() => resolveTarget(good({ repository: undefined }), { audience: AUD }), (e) => e.status === 400)
  assert.throws(() => resolveTarget(good({ repository_owner: undefined }), { audience: AUD }), (e) => e.status === 400)
})

test('extra path segment in repo → 400', () => {
  assert.throws(() => resolveTarget(good({ repository: 'acme/a/b', repository_owner: 'acme' }), { audience: AUD }), (e) => e.status === 400)
})
