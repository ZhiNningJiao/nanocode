/**
 * opencode session listing (MES-13740 需求15 item1)
 *
 * Lists recent opencode sessions for the AutoResume picker so Fable5/opencode
 * tabs can 继续 a prior session — mirroring the claude jsonl resume picker.
 *
 * Data source: `opencode session list --format json -n <N>` (scoped to the
 * project cwd by the opencode CLI). The JSON shape (per 11-A research + live
 * probe) is an array of:
 *   { id, title, updated (epoch ms), created (epoch ms), projectId, directory }
 *
 * `normalizeOpencodeSessions` is a PURE normaliser (unit-tested with no
 * subprocess) — mirrors the exportToEvents pattern in opencode-adapter.js.
 * `listOpencodeSessions` is the thin execFile wrapper used by the route.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Relative time formatter — kept local (identical to recent-agents.js
// relTimeFromMtime) to avoid a cross-module dependency for one helper.
function relTimeFromMtime(mtimeMs, nowMs) {
  const diff = nowMs - mtimeMs
  if (!Number.isFinite(diff) || diff < 0) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/**
 * Pure: normalise `opencode session list --format json` stdout into a
 * conversation list shaped for the resume picker.
 *
 * Returns { conversations: [{ sessionId, title, updated, created, directory, relTime }] }
 * Never throws — unparseable / non-array input yields an empty list so the
 * picker degrades to "no sessions" instead of a 500.
 */
export function normalizeOpencodeSessions(stdout, nowMs = Date.now()) {
  if (typeof stdout !== 'string' || !stdout.trim()) return { conversations: [] }
  let arr
  try {
    arr = JSON.parse(stdout)
  } catch {
    return { conversations: [] }
  }
  if (!Array.isArray(arr)) return { conversations: [] }
  const conversations = arr
    .filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id)
    .map((s) => {
      const updated = typeof s.updated === 'number' ? s.updated : null
      return {
        sessionId: s.id,
        title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : '(untitled)',
        updated,
        created: typeof s.created === 'number' ? s.created : null,
        directory: typeof s.directory === 'string' && s.directory ? s.directory : null,
        relTime: updated !== null ? relTimeFromMtime(updated, nowMs) : '',
      }
    })
    // Most-recent-first by updated time (defensive: CLI already sorts, but
    // don't trust the order across opencode versions).
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  return { conversations }
}

/**
 * Wrap `opencode session list --format json -n <limit>` in the project cwd.
 * Carries the AIGW key + colour-suppression env so the CLI bootstraps cleanly
 * (same env recipe as handleOpencodeHistory's `opencode export`).
 */
export function listOpencodeSessions(home, cwd, limit, cb) {
  const env = { ...process.env }
  delete env.FORCE_COLOR
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  try {
    const keyFile = join(home, '.config', 'meshy-aigw.key')
    if (existsSync(keyFile)) env.MESHY_AIGW_KEY = readFileSync(keyFile, 'utf8').trim()
  } catch { /* best-effort */ }
  const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 5))
  execFile(
    'opencode',
    ['session', 'list', '--format', 'json', '-n', String(n)],
    { cwd, env, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout) => {
      if (err) return cb(err, null)
      cb(null, normalizeOpencodeSessions(stdout, Date.now()))
    }
  )
}
