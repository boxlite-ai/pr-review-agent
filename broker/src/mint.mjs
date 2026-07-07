// Mint a short-lived, repo-scoped installation token for the App. Uses @octokit/auth-app
// (the same path actions/create-github-app-token uses) so the app-JWT signing and the
// access-token call are library code, not hand-rolled. The App private key lives only
// here, in the Worker secret store — callers only ever receive the 1-hour scoped token.
import { createAppAuth } from '@octokit/auth-app'
import { BrokerError, TOKEN_PERMISSIONS } from './claims.mjs'

const GH_API = 'https://api.github.com'

/**
 * @returns {{ token: string, expiresAt: string }}
 */
export async function mintToken({ appId, privateKey, owner, repo }) {
  if (!appId || !privateKey) throw new BrokerError(500, 'broker app credentials not configured')
  const auth = createAppAuth({ appId, privateKey })

  // App JWT → resolve the installation for this repo. 404 = the App isn't installed there.
  const app = await auth({ type: 'app' })
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/installation`, {
    headers: {
      Authorization: `Bearer ${app.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'boxlite-token-broker',
    },
  })
  if (res.status === 404) throw new BrokerError(403, `@boxlite is not installed on ${owner}/${repo}`)
  if (!res.ok) throw new BrokerError(502, `installation lookup failed: ${res.status}`)
  const installationId = (await res.json()).id

  // Mint the token scoped to exactly this repo with least-privilege permissions.
  const installation = await auth({
    type: 'installation',
    installationId,
    repositoryNames: [repo],
    permissions: TOKEN_PERMISSIONS,
  })
  return { token: installation.token, expiresAt: installation.expiresAt }
}
