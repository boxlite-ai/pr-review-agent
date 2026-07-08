// BoxLite REST client — only the calls the runner needs, over plain fetch (Cloudflare
// Worker; the native @boxlite-ai/boxlite SDK can't load here). Auth: Bearer <the installer's
// BoxLite API key, from KV>. Base defaults to app.boxlite.ai.
import { BrokerError } from './claims.mjs'

export const AGENT_IMAGE = 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3'
const base = (url) => (url || 'https://app.boxlite.ai/api').replace(/\/+$/, '')

async function call(apiKey, url, method, path, body) {
  const res = await fetch(`${base(url)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    throw new BrokerError(502, `boxlite ${method} ${path} → ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
  return res.status === 204 ? null : res.json().catch(() => ({}))
}

/** Create a box. The VM starts lazily on first exec. @returns Box (with `.id`). */
export async function createBox(apiKey, url, name) {
  return call(apiKey, url, 'POST', '/v1/boxes', {
    name,
    image: AGENT_IMAGE,
    cpus: 2,
    memory_mib: 4096,
    network: { mode: 'enabled' }, // open egress: npm + api.anthropic.com + github (harden later)
  })
}

/**
 * Start an async execution — returns `{ execution_id }` IMMEDIATELY (box auto-starts, the
 * command runs for minutes on its own; we never attach). This is the linchpin of the runner.
 */
export async function startExecution(apiKey, url, boxId, { command, args, env, timeoutSeconds }) {
  return call(apiKey, url, 'POST', `/v1/boxes/${boxId}/exec`, {
    command,
    args,
    env,
    timeout_seconds: timeoutSeconds,
  })
}

export async function removeBox(apiKey, url, boxId) {
  return call(apiKey, url, 'DELETE', `/v1/boxes/${boxId}`).catch(() => null) // best-effort teardown
}
