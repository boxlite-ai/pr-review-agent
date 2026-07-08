// Per-installation key storage. The two keys a repo needs (BoxLite + Claude) are entered
// once at /setup, encrypted at rest (AES-GCM, key derived from a Worker secret), and kept
// in Workers KV under the installation id. The webhook handler reads them back to
// auto-configure repos added later — so "install → done" holds for future repos too.
//
// Trust note (the tradeoff the user chose): the broker now holds the caller's keys. They
// are encrypted with STORE_SECRET (never in KV plaintext) and deleted on uninstall.

const enc = new TextEncoder()
const dec = new TextDecoder()

async function aesKey(secret) {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(secret))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** Encrypt + store { boxliteKey, claudeToken } for an installation. */
export async function storeKeys(env, installationId, keys) {
  const key = await aesKey(env.STORE_SECRET)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(keys))))
  await env.INSTALL_STORE.put(`install:${installationId}`, b64(new Uint8Array([...iv, ...ct])))
}

/** @returns { boxliteKey, claudeToken } or null if none stored. */
export async function loadKeys(env, installationId) {
  const blob = await env.INSTALL_STORE.get(`install:${installationId}`)
  if (!blob) return null
  const bytes = unb64(blob)
  const key = await aesKey(env.STORE_SECRET)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
  return JSON.parse(dec.decode(pt))
}

export async function deleteKeys(env, installationId) {
  await env.INSTALL_STORE.delete(`install:${installationId}`)
}
