#!/usr/bin/env node
// PR-review agent entrypoint, executed INSIDE a BoxLite box:
//   node review.mjs <owner/repo> <pr-number> <head-sha> <base-ref>
//
// Pure Node, no imports beyond stdlib, so only this file + prompt.md are copied in. It
// clones the PR, runs Claude read-only, and prints Claude's raw review JSON to stdout.
// The runner (orchestrate.mjs) validates + publishes — the box performs no GitHub writes.
//
// Diagnostics go to stderr; stdout carries ONLY the review JSON so the runner reads it
// straight from the exec result.
//
// Required env (passed per-exec, never stored in box env):
//   GH_TOKEN                                      used only to clone; scrubbed before the model runs
//   ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN  exactly one
// Optional env: MODEL, FOCUS, LANGUAGE, PATH_INSTRUCTIONS, IGNORE_GLOBS
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Read-only: read the tree + allowlisted git history. `git diff:*` already covers
// `git diff --numstat` (used for the change-map LOC deltas).
const ALLOWED_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)'

/** Assemble the review prompt: base policy + optional config context + PR trailer. */
export function buildPrompt({ basePrompt, repo, pr, baseRef, shortHead, env = {} }) {
  const lines = [basePrompt.trim(), '', `PR #${pr} of ${repo}. Base: origin/${baseRef}. Head: ${shortHead}.`]
  if (env.FOCUS) lines.push(`Extra focus: ${env.FOCUS}`)
  if (env.PROFILE === 'strict') lines.push('Review strictly: include minor issues (nits), not only blockers and warnings.')
  else if (env.PROFILE === 'lean') lines.push('Review for signal: report issues that matter and omit trivial nits unless they bite.')
  if (env.PATH_INSTRUCTIONS) lines.push(env.PATH_INSTRUCTIONS)
  if (env.LANGUAGE) lines.push(`Write every string value in ${env.LANGUAGE}.`)
  if (env.IGNORE_GLOBS) lines.push(`Do not review files matching: ${env.IGNORE_GLOBS}`)
  return lines.join('\n')
}

/** Fail fast if the model didn't emit a JSON object. Returns the text unchanged. */
export function precheckJson(text) {
  const unfenced = String(text)
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
  JSON.parse(unfenced) // throws on non-JSON
  return text
}

function main() {
  const [repo, pr, headSha, baseRef] = process.argv.slice(2)
  if (!repo || !pr || !headSha || !baseRef) {
    console.error('usage: review.mjs <owner/repo> <pr> <head-sha> <base-ref>')
    process.exit(2)
  }
  const token = process.env.GH_TOKEN
  if (!token) {
    console.error('GH_TOKEN is required')
    process.exit(2)
  }
  const agentDir = path.dirname(fileURLToPath(import.meta.url))

  // git stdout is captured (not echoed) so it can't pollute the review on fd 1; stderr is
  // inherited so failures stay visible.
  const git = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })

  // Self-heal on images without the CLI (M0 dogfood runs on boxlite-agent-node).
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
  } catch {
    execFileSync('sudo', ['npm', 'install', '-g', '@anthropic-ai/claude-code'], { stdio: ['ignore', 2, 2] })
  }

  const repoDir = path.join(mkdtempSync(path.join(tmpdir(), 'pr-review-')), 'repo')
  // Token passed as an arg (not shell-interpolated → no quoting bugs), then scrubbed from
  // .git/config before the model runs so Claude can never read the write token back.
  git(['clone', '-q', '--depth', '200', `https://x-access-token:${token}@github.com/${repo}.git`, repoDir])
  git([
    '-C', repoDir, 'fetch', '-q', '--depth', '200', 'origin',
    `+refs/pull/${pr}/head`,
    `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
  ])
  git(['-C', repoDir, 'checkout', '-q', 'FETCH_HEAD'])
  git(['-C', repoDir, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`])

  const basePrompt = readFileSync(path.join(agentDir, 'prompt.md'), 'utf8')
  const shortHead = git(['-C', repoDir, 'rev-parse', '--short', 'HEAD']).trim()
  const prompt = buildPrompt({ basePrompt, repo, pr, baseRef, shortHead, env: process.env })

  const args = ['-p', prompt, '--allowedTools', ALLOWED_TOOLS, '--output-format', 'json', '--max-turns', '50']
  if (process.env.MODEL) args.push('--model', process.env.MODEL)

  // The model runs without GH_TOKEN — it reviews from local objects and needs no remote.
  const childEnv = { ...process.env }
  delete childEnv.GH_TOKEN
  const res = spawnSync('claude', args, {
    cwd: repoDir,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (res.status !== 0) {
    console.error(`claude exited ${res.status}`)
    if (res.stderr) console.error(res.stderr.slice(0, 4000))
    if (res.stdout) console.error(res.stdout.slice(0, 4000))
    process.exit(1)
  }

  let result
  try {
    result = JSON.parse(res.stdout).result
  } catch (e) {
    console.error(`could not parse claude --output-format json envelope: ${e.message}`)
    console.error(String(res.stdout).slice(0, 4000))
    process.exit(1)
  }
  try {
    precheckJson(result)
  } catch (e) {
    console.error(`model did not emit review JSON: ${e.message}`)
    console.error(String(result).slice(0, 4000))
    process.exit(1)
  }
  process.stdout.write(result)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
