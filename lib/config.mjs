// Optional per-repo config: `.boxlite-review.yml` at the reviewed repo's head. The
// runner fetches + parses it (YAML parsing is injected so this module stays pure and
// testable); `focus`/`language`/`path_instructions` steer the model, `path_filters`
// gate which findings get published.
import { ghJson } from './github.mjs'

export const DEFAULT_CONFIG = {
  path_filters: [],
  path_instructions: [],
  focus: '',
  language: '',
  profile: 'lean',
}

/**
 * Fetch and normalize `.boxlite-review.yml`. Missing file → defaults. `parseYaml` is the
 * real `yaml` parser on the runner, injectable in tests.
 */
export async function fetchConfig({ repo, ref, token, parseYaml, fetchImpl = fetch }) {
  const file = await ghJson(
    `/repos/${repo}/contents/.boxlite-review.yml?ref=${encodeURIComponent(ref)}`,
    { token, fetchImpl, allow404: true },
  )
  if (!file || typeof file.content !== 'string') return { ...DEFAULT_CONFIG }
  const text = Buffer.from(file.content, 'base64').toString('utf8')
  let raw
  try {
    raw = parseYaml(text) || {}
  } catch (cause) {
    throw new Error(`.boxlite-review.yml is not valid YAML: ${cause.message}`)
  }
  return normalizeConfig(raw)
}

/** Coerce a parsed config object into the known shape, ignoring unknown keys. */
export function normalizeConfig(raw) {
  return {
    path_filters: Array.isArray(raw?.path_filters) ? raw.path_filters.filter((s) => typeof s === 'string') : [],
    path_instructions: Array.isArray(raw?.path_instructions)
      ? raw.path_instructions.filter((p) => p && typeof p.path === 'string' && typeof p.instructions === 'string')
      : [],
    focus: typeof raw?.focus === 'string' ? raw.focus : '',
    language: typeof raw?.language === 'string' ? raw.language : '',
    profile: raw?.profile === 'strict' ? 'strict' : 'lean',
  }
}

/**
 * Include-decision for a path against a glob filter list. `!glob` entries exclude. A
 * path is included when it matches at least one positive glob (or there are none) and no
 * negative glob. Mirrors CodeRabbit's `path_filters` semantics.
 */
export function isPathIncluded(path, filters = []) {
  if (!filters.length) return true
  const positives = filters.filter((f) => !f.startsWith('!'))
  const negatives = filters.filter((f) => f.startsWith('!')).map((f) => f.slice(1))
  const included = positives.length === 0 || positives.some((g) => globToRegExp(g).test(path))
  const excluded = negatives.some((g) => globToRegExp(g).test(path))
  return included && !excluded
}

/** Translate a path glob to a RegExp. `**` spans path segments, `*` stays within one. */
export function globToRegExp(glob) {
  const special = /[.+^${}()|[\]\\]/g
  let re = '^'
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
    } else if (glob[i] === '*') {
      re += '[^/]*'
      i += 1
    } else if (glob[i] === '?') {
      re += '[^/]'
      i += 1
    } else {
      re += glob[i].replace(special, '\\$&')
      i += 1
    }
  }
  return new RegExp(re + '$')
}
