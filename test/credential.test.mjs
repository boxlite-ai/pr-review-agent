import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCredential } from '../lib/credential.mjs'

test('API key → ANTHROPIC_API_KEY only', () => {
  const r = resolveCredential({ apiKey: 'sk-ant-api-xxx', oauthToken: '' })
  assert.deepEqual(r.env, { ANTHROPIC_API_KEY: 'sk-ant-api-xxx' })
})

test('OAuth token → CLAUDE_CODE_OAUTH_TOKEN only', () => {
  const r = resolveCredential({ apiKey: '', oauthToken: 'sk-ant-oat01-yyy' })
  assert.deepEqual(r.env, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-yyy' })
})

test('never emits an empty ANTHROPIC_API_KEY that would shadow the OAuth token', () => {
  const r = resolveCredential({ apiKey: '', oauthToken: 'sk-ant-oat01-yyy' })
  assert.ok(!('ANTHROPIC_API_KEY' in r.env))
})

test('both provided → rejected (ambiguous precedence)', () => {
  assert.throws(() => resolveCredential({ apiKey: 'sk-ant-api', oauthToken: 'sk-ant-oat' }), /only one/)
})

test('neither provided → rejected', () => {
  assert.throws(() => resolveCredential({ apiKey: '', oauthToken: '' }), /provide anthropic-api-key or claude-code-oauth-token/)
  assert.throws(() => resolveCredential({}), /provide anthropic-api-key or claude-code-oauth-token/)
})
