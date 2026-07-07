// Resolve which Claude credential the box runs with. Exactly one of the two must
// be provided; passing both is rejected rather than silently resolved, because an
// ANTHROPIC_API_KEY (even an empty one) shadows CLAUDE_CODE_OAUTH_TOKEN in Claude
// Code's credential precedence — so the caller's intent must be unambiguous, and
// only the chosen variable is ever placed in the box env.

/**
 * @param {{ apiKey?: string, oauthToken?: string }} input
 * @returns {{ env: Record<string,string> }}
 */
export function resolveCredential({ apiKey, oauthToken }) {
  const hasApiKey = Boolean(apiKey)
  const hasOauth = Boolean(oauthToken)

  if (hasApiKey && hasOauth) {
    throw new Error('provide only one of anthropic-api-key / claude-code-oauth-token, not both')
  }
  if (hasApiKey) {
    return { env: { ANTHROPIC_API_KEY: apiKey } }
  }
  if (hasOauth) {
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } }
  }
  throw new Error('provide anthropic-api-key or claude-code-oauth-token')
}
