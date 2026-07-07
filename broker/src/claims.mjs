// The security core of the broker: given the *already-signature-verified* GitHub
// Actions OIDC claims, decide who the caller is and what install to scope a token to.
//
// The one rule that makes "repo A can never get repo B's token" true by construction:
// the target repo is derived ONLY from the cryptographically-verified `repository` /
// `repository_owner` claims — never from anything in the request body. A caller can only
// obtain an OIDC token whose `repository` claim is its own repo, so it can only ever be
// scoped to its own repo. This module is pure and unit-tested.

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com'

// Least privilege: exactly what the reviewer needs to post. The minted token can never
// exceed the permissions the App was granted at registration, so register it with these.
export const TOKEN_PERMISSIONS = { pull_requests: 'write', checks: 'write', contents: 'read' }

export class BrokerError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Validate the trust-relevant claims and return the install target. Assumes the JWT
 * signature, issuer, audience, and expiry were already checked by the verifier (jose);
 * this re-asserts issuer + audience defensively and derives the scope.
 * @returns {{ owner: string, repo: string, repositoryId: string|undefined, workflowRef: string|undefined }}
 */
export function resolveTarget(claims, { audience }) {
  if (!claims || claims.iss !== GITHUB_OIDC_ISSUER) throw new BrokerError(401, 'bad issuer')

  // Anti-replay / confused-deputy: the OIDC token must have been minted FOR this broker.
  // The caller sets it via core.getIDToken(<broker-url>); a token for AWS/another STS is rejected.
  if (!audience) throw new BrokerError(500, 'broker audience not configured')
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!auds.includes(audience)) throw new BrokerError(401, 'audience mismatch')

  // Scope is the verified repository claim — the request body is never consulted.
  const repository = claims.repository
  const owner = claims.repository_owner
  if (typeof owner !== 'string' || owner === '' || typeof repository !== 'string') {
    throw new BrokerError(400, 'missing repository claims')
  }
  const prefix = owner + '/'
  if (!repository.startsWith(prefix)) throw new BrokerError(400, 'repository does not match owner')
  const repo = repository.slice(prefix.length)
  if (repo === '' || repo.includes('/')) throw new BrokerError(400, 'malformed repository claim')

  return {
    owner,
    repo,
    repositoryId: typeof claims.repository_id === 'string' ? claims.repository_id : undefined,
    workflowRef: typeof claims.job_workflow_ref === 'string' ? claims.job_workflow_ref : undefined,
  }
}
