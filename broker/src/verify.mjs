// Verify a GitHub Actions OIDC token: signature (against GitHub's JWKS), issuer,
// audience, and expiry. Delegated to `jose` so the crypto is battle-tested, not
// hand-rolled. The issuer + its JWKS URL are hardcoded constants — we never derive a
// discovery/fetch URL from anything inside the untrusted token (cf. octo-sts
// GHSA-h3qp-hwvr-9xcq, an SSRF from trusting token-supplied issuer fields).
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { GITHUB_OIDC_ISSUER, BrokerError } from './claims.mjs'

const JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`))

/**
 * @returns the verified JWT payload (claims). Throws BrokerError(401) on any failure.
 */
export async function verifyOidc(jwt, { audience }) {
  try {
    const { payload } = await jwtVerify(jwt, JWKS, {
      issuer: GITHUB_OIDC_ISSUER,
      audience,
      algorithms: ['RS256'],
    })
    return payload
  } catch (error) {
    throw new BrokerError(401, `OIDC verification failed: ${error.code || error.message}`)
  }
}
