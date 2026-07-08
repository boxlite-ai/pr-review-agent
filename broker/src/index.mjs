// BoxLite token broker — a Cloudflare Worker that turns a caller's GitHub Actions OIDC
// token into a short-lived, repo-scoped @boxlite[bot] installation token, WITHOUT ever
// handing out the App private key. This is what lets a public App review anyone's PRs as
// its branded bot: the key lives only here; each run gets a token scoped to its own repo.
//
//   POST /exchange   Authorization: Bearer <GitHub Actions OIDC JWT>
//   → 200 { token, expires_at, repository }
//
// Env (Worker secrets/vars): APP_ID, APP_PRIVATE_KEY (PKCS#8 — see broker/README.md),
// BROKER_AUDIENCE (this Worker's public URL; the value callers must set as the OIDC audience).
import { verifyOidc } from './verify.mjs'
import { resolveTarget, BrokerError } from './claims.mjs'
import { mintToken } from './mint.mjs'
import { handleSetup } from './setup.mjs'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      // Auto-configure: the App's post-install Setup URL — writes the secrets + review
      // workflow into the just-installed repos so the user does zero manual setup.
      if (url.pathname === '/setup') return await handleSetup(request, env, url)
      // OIDC → short-lived @boxlite[bot] token, scoped to the caller's own repo.
      if (request.method === 'POST' && url.pathname === '/exchange') {
        return await handleExchange(request, env, url)
      }
      return json(404, { error: 'POST /exchange or GET|POST /setup' })
    } catch (error) {
      const status = error instanceof BrokerError ? error.status : 401
      return json(status, { error: error.message })
    }
  },
}

async function handleExchange(request, env, url) {
  const bearer = (request.headers.get('authorization') || '').match(/^Bearer (.+)$/)
  if (!bearer) throw new BrokerError(401, 'missing OIDC bearer token')

  // The audience the caller must have requested — anti-replay binding to this broker.
  const audience = env.BROKER_AUDIENCE || url.origin

  const claims = await verifyOidc(bearer[1], { audience })
  const { owner, repo } = resolveTarget(claims, { audience })
  const { token, expiresAt } = await mintToken({
    appId: env.APP_ID,
    privateKey: env.APP_PRIVATE_KEY,
    owner,
    repo,
  })
  // Never log the token or key. Return only the scoped token to the caller.
  return json(200, { token, expires_at: expiresAt, repository: `${owner}/${repo}` })
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
