// GitHub App webhook → zero-touch repo config. On repos being added to an installation
// (and on uninstall), the broker acts on the App's behalf using the keys stored at /setup:
// writes the secrets + review workflow (PR on protected branches), or drops the keys on
// uninstall. Payload authenticity is verified with the App's webhook secret (HMAC-SHA256).
import { createAppAuth } from '@octokit/auth-app'
import { BrokerError } from './claims.mjs'
import { loadKeys, deleteKeys } from './store.mjs'
import { buildWorkflow, setRepoSecret, commitWorkflow } from './setup.mjs'

async function verifySignature(secret, body, header) {
  if (!secret || !header) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const expected = 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

export async function handleWebhook(request, env, url) {
  const body = await request.text()
  if (!(await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) {
    throw new BrokerError(401, 'invalid webhook signature')
  }
  const event = request.headers.get('x-github-event')
  const payload = JSON.parse(body)
  const installationId = payload.installation?.id
  if (!installationId) return new Response('no installation', { status: 200 })

  // Uninstall → forget the stored keys. (The workflow file can't be removed — GitHub
  // revokes the App's access the instant it's uninstalled.)
  if (event === 'installation' && payload.action === 'deleted') {
    await deleteKeys(env, installationId)
    return new Response('keys dropped', { status: 200 })
  }

  let repos = []
  if (event === 'installation' && payload.action === 'created') repos = payload.repositories || []
  else if (event === 'installation_repositories' && payload.action === 'added') repos = payload.repositories_added || []
  else return new Response('ignored', { status: 200 })

  const keys = await loadKeys(env, installationId)
  if (!keys) return new Response('no stored keys yet — /setup provides them first', { status: 200 })

  const auth = createAppAuth({ appId: env.APP_ID, privateKey: env.APP_PRIVATE_KEY })
  const { token } = await auth({ type: 'installation', installationId })
  const workflow = buildWorkflow(url.origin)
  const done = []
  for (const r of repos) {
    const [owner, repo] = r.full_name.split('/')
    await setRepoSecret(owner, repo, 'BOXLITE_API_KEY', keys.boxliteKey, token)
    await setRepoSecret(owner, repo, 'CLAUDE_CODE_OAUTH_TOKEN', keys.claudeToken, token)
    await commitWorkflow(owner, repo, token, workflow)
    done.push(r.full_name)
  }
  return new Response(`configured: ${done.join(', ') || 'none'}`, { status: 200 })
}
