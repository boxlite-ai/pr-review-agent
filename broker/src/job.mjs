// One-shot job token for the box → broker /publish callback. HMAC(STORE_SECRET) over the
// review job {repo, pr, headSha, boxId, installationId} + a 30-min expiry. The box receives
// this token; /publish accepts findings only with a valid, unexpired token — so a box can
// only publish the exact PR it was booted for.
const enc = new TextEncoder()

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')))

export async function mintJob(secret, claims) {
  const body = b64url({ ...claims, exp: Math.floor(Date.now() / 1000) + 1800 })
  return `${body}.${await hmac(secret, body)}`
}

/** @returns the claims if the token is authentic + unexpired, else null. */
export async function verifyJob(secret, token) {
  const [body, sig] = String(token).split('.')
  if (!body || !sig) return null
  const expected = await hmac(secret, body)
  if (sig.length !== expected.length) return null
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
  if (diff !== 0) return null
  let claims
  try { claims = unb64url(body) } catch { return null }
  return claims.exp && claims.exp >= Math.floor(Date.now() / 1000) ? claims : null
}
