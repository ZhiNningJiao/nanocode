/**
 * codex-history.js — reconstruct a codex tab's transcript from its CLI rollout
 * jsonl so an attaching client sees past conversation even on a fresh server
 * (in-memory cs.scrollback is empty after restart).
 *
 * Codex writes one rollout file per thread at
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<threadId>.jsonl
 * Each line is `{ timestamp, type, payload }`. We convert it into the SAME
 * scrollback TEXT grammar the SDK driver emits live (see codex-sdk-driver.js
 * formatCodexEventAsOutput), which CodexBlockRenderer._processLine already knows
 * how to render when replayed via a `history` WS message:
 *   `› <user text>`   `Running: <cmd>`   <command output>   <agent text>   `────────────`
 * Encrypted `reasoning` items are not reconstructable and are skipped.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TURN_SEPARATOR = '────────────\n'
const DEFAULT_MAX_BYTES = 250_000
const MAX_OUTPUT_CHARS = 2000 // cap each command output block so history stays lean

function safeList(dir) {
  try { return readdirSync(dir) } catch { return [] }
}
function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

/**
 * Find the newest rollout jsonl whose filename contains threadId. Searches
 * ~/.codex/sessions/YYYY/MM/DD newest-first and early-returns on the first
 * match (a thread lives in exactly one rollout file).
 */
export function resolveCodexRolloutPath(home, threadId) {
  if (!home || !threadId) return null
  const base = join(home, '.codex', 'sessions')
  if (!existsSync(base)) return null
  const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0) // reverse-lexicographic = newest date first
  const years = safeList(base).filter((y) => isDir(join(base, y))).sort(desc)
  for (const y of years) {
    const yp = join(base, y)
    for (const m of safeList(yp).filter((x) => isDir(join(yp, x))).sort(desc)) {
      const mp = join(yp, m)
      for (const d of safeList(mp).filter((x) => isDir(join(mp, x))).sort(desc)) {
        const dp = join(mp, d)
        const hits = safeList(dp).filter((f) => f.endsWith('.jsonl') && f.includes(threadId))
        if (hits.length) {
          // Multiple (rare): pick newest by mtime.
          let best = null, bestMt = -1
          for (const f of hits) {
            const fp = join(dp, f)
            const mt = statSync(fp).mtimeMs
            if (mt >= bestMt) { bestMt = mt; best = fp }
          }
          return best
        }
      }
    }
  }
  return null
}

// A first-turn user message bundles system wrappers (environment_context,
// permissions, AGENTS.md instructions) as separate blocks — skip those, keep
// only the human prompt. Mirrors sessions-browser.js isSystemWrapper.
function isSystemWrapper(text) {
  if (typeof text !== 'string') return true
  const t = text.trimStart()
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<system_') ||
    t.startsWith('<recommended_plugins>') ||
    t.startsWith('<INSTRUCTIONS') ||
    t.startsWith('<user_instructions')
  )
}

function ensureNl(s) {
  return s.endsWith('\n') ? s : `${s}\n`
}

// function_call_output.output is either a string ("…preamble…\nOutput:\n<stdout>")
// or an array of {type:'input_text', text}. Return just the stdout, capped.
function extractCommandOutput(output) {
  let text = ''
  if (typeof output === 'string') text = output
  else if (Array.isArray(output)) text = output.map((o) => (o && typeof o.text === 'string' ? o.text : '')).join('')
  else if (output && typeof output === 'object' && typeof output.output === 'string') text = output.output
  if (!text) return ''
  const marker = '\nOutput:\n'
  const idx = text.indexOf(marker)
  if (idx >= 0) text = text.slice(idx + marker.length)
  else if (text.startsWith('Output:\n')) text = text.slice('Output:\n'.length)
  text = text.replace(/\s+$/, '')
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + '\n… [output truncated]'
  }
  return text
}

function parseCmd(argumentsJson) {
  try {
    const a = JSON.parse(argumentsJson || '{}')
    let cmd = a.cmd || a.command || ''
    if (Array.isArray(cmd)) cmd = cmd.join(' ')
    return typeof cmd === 'string' ? cmd.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Reconstruct scrollback text from a rollout jsonl. Returns '' on any failure.
 */
export function reconstructCodexScrollback(jsonlPath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!jsonlPath || !existsSync(jsonlPath)) return ''
  let raw
  try { raw = readFileSync(jsonlPath, 'utf-8') } catch { return '' }

  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const p = e.payload || {}

    if (e.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim() && !isSystemWrapper(p.message)) {
        out.push(`› ${p.message.trim()}\n`)
      } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) {
        // agent_message carries the assistant's visible text (phase commentary|final).
        out.push(ensureNl(p.message.trim()))
      } else if (p.type === 'task_complete') {
        out.push(TURN_SEPARATOR)
      }
    } else if (e.type === 'response_item') {
      if (p.type === 'function_call') {
        const cmd = parseCmd(p.arguments)
        if (cmd) out.push(`Running: ${cmd}\n`)
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const text = extractCommandOutput(p.output)
        if (text) out.push(ensureNl(text))
      }
      // reasoning: encrypted, skip. message role=user/assistant: prefer the
      // clean event_msg copies above (avoids system-wrapper noise + duplication).
    }
  }

  let s = out.join('')
  if (s.length > maxBytes) {
    // Keep the newest maxBytes, then drop the partial first line so history
    // starts on a clean boundary (the renderer parses line-by-line).
    s = s.slice(-maxBytes)
    const nl = s.indexOf('\n')
    if (nl >= 0) s = s.slice(nl + 1)
  }
  return s
}

/**
 * Convenience: resolve + reconstruct in one call. Returns '' if no rollout.
 */
export function loadCodexScrollback(home, threadId, opts) {
  const path = resolveCodexRolloutPath(home, threadId)
  if (!path) return ''
  return reconstructCodexScrollback(path, opts)
}
