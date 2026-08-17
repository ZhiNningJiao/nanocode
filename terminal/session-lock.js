/**
 * session-lock.js
 *
 * Cross-process singleton lock for Claude sessions. Prevents two nanocode
 * servers from simultaneously spawning/attaching Claude consumers to the
 * same conversation. The loser enters read-only follow mode.
 *
 * Lock files live at <home>/.nanocode/session-locks/<sessionId>.lock and
 * contain JSON: { pid, port, timestamp }.
 *
 * Stale-lock recovery: when the holder process dies its pid is no longer
 * alive, so the next acquire() silently overwrites the stale lock.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_SUBDIR = 'session-locks'

function resolveLockDir(home) {
  const base = home || process.env.HOME || '/tmp'
  return join(base, '.nanocode', LOCK_SUBDIR)
}

function ensureLockDir(lockDir) {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 })
}

function lockPath(sessionId, lockDir) {
  // Sanitize: a Claude sessionId is a UUID but be defensive.
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120)
  return join(lockDir, `${safe}.lock`)
}

/**
 * Check whether a pid is alive (signal 0 probe).
 * Returns false for invalid / non-existent / null pids.
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH → process does not exist (dead). EPERM → exists but not ours.
    return err.code === 'EPERM'
  }
}

/**
 * Read and parse a lock file. Returns { pid, port, timestamp } or null
 * if the file is missing / corrupt. Does NOT check pid-aliveness —
 * callers decide what to do with a stale lock.
 */
function readLock(filePath) {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8').trim()
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (typeof obj.pid !== 'number' || !obj.pid) return null
    return {
      pid: obj.pid,
      port: obj.port || null,
      timestamp: obj.timestamp || 0,
    }
  } catch {
    return null
  }
}

/**
 * Atomically write a lock file using O_EXCL|O_CREAT. Returns true on success.
 * If the file already exists, returns false (caller should retry or steal).
 */
function writeLockExclusive(filePath, data) {
  try {
    const fd = openSync(filePath, 'wx') // O_EXCL | O_CREAT | O_WRONLY
    try {
      writeFileSync(fd, data)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    // EEXIST → race lost; file already there
    return false
  }
}

/**
 * Overwrite a lock file unconditionally (used for stale-lock steal and
 * for the initial write after confirming the dir is clean).
 */
function writeLockOverwrite(filePath, data) {
  try {
    writeFileSync(filePath, data, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Acquire a session singleton lock.
 *
 * @param {string} sessionId  Claude conversation ID
 * @param {{ pid?: number, port?: * }} opts  pid defaults to process.pid
 * @param {string} [home]  Home dir (for test isolation)
 * @returns {{ acquired: boolean, holder?: { pid: number, port: *, timestamp: number } }}
 *   - acquired=true  → we now hold the lock
 *   - acquired=false → another live process holds it; `holder` describes it
 */
export function acquireSessionLock(sessionId, opts = {}, home) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const lockDir = resolveLockDir(home)
  ensureLockDir(lockDir)
  const filePath = lockPath(sessionId, lockDir)
  const data = JSON.stringify({ pid, port, timestamp: Date.now() })

  // Fast path: no lock file → atomic exclusive create.
  if (!existsSync(filePath)) {
    if (writeLockExclusive(filePath, data)) {
      return { acquired: true }
    }
    // Lost a race — another process created the file between our existsSync
    // and open. Fall through to the existing-file logic below.
  }

  const existing = readLock(filePath)
  if (!existing) {
    // Corrupt / empty lock file — safe to overwrite.
    writeLockOverwrite(filePath, data)
    return { acquired: true }
  }

  // Is the existing lock ours? (Same pid + port → re-entrant, keep it.)
  if (existing.pid === pid && existing.port === port) {
    return { acquired: true }
  }

  // Is the existing lock's process dead? → stale, steal it.
  if (!isPidAlive(existing.pid)) {
    writeLockOverwrite(filePath, data)
    return { acquired: true }
  }

  // Lock held by another live process.
  return { acquired: false, holder: existing }
}

/**
 * Get the current lock holder for a session, or null if unheld / stale.
 * A stale lock (dead pid) is cleaned up and returns null.
 */
export function getLockHolder(sessionId, home) {
  const lockDir = resolveLockDir(home)
  const filePath = lockPath(sessionId, lockDir)
  const existing = readLock(filePath)
  if (!existing) return null
  if (!isPidAlive(existing.pid)) {
    // Stale — best-effort cleanup.
    try { unlinkSync(filePath) } catch {}
    return null
  }
  return existing
}

/**
 * Release a session lock. Only removes the file if the recorded pid+port
 * match ours, so a process never accidentally clears another's lock.
 */
export function releaseSessionLock(sessionId, opts = {}, home) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const lockDir = resolveLockDir(home)
  const filePath = lockPath(sessionId, lockDir)
  const existing = readLock(filePath)
  if (!existing) return false
  if (existing.pid !== pid || existing.port !== port) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Check whether the lock for a session is held by a *different* live
 * process. Returns the holder if so, null otherwise.
 */
export function isLockHeldByOther(sessionId, opts = {}, home) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const holder = getLockHolder(sessionId, home)
  if (!holder) return null
  if (holder.pid === pid && holder.port === port) return null
  return holder
}

/**
 * Steal (forcibly overwrite) a session lock regardless of who holds it.
 *
 * Used when a USER message arrives at a read-only server: the user's intent
 * overrides the current holder, which will detect the steal via its lock
 * watch and gracefully degrade (interrupt its running turn + teardown its
 * streaming session). Non-user messages (waker/secretary briefings) must
 * NOT call this — they stay read-only.
 *
 * Unlike acquireSessionLock, this NEVER fails on "held by another live
 * process" — it overwrites unconditionally. A re-entrant steal (same pid +
 * port) is a no-op that still returns acquired=true.
 *
 * @returns {{ acquired: boolean, holder?: { pid: number, port: *, timestamp: number } | null }}
 *   - acquired=true  → we now hold the lock; `holder` is the previous
 *                      holder (or null if the lock was absent / stale / ours)
 */
export function stealSessionLock(sessionId, opts = {}, home) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const lockDir = resolveLockDir(home)
  ensureLockDir(lockDir)
  const filePath = lockPath(sessionId, lockDir)
  const data = JSON.stringify({ pid, port, timestamp: Date.now() })

  const previous = readLock(filePath)
  if (previous && previous.pid === pid && previous.port === port) {
    return { acquired: true, holder: null }
  }

  writeLockOverwrite(filePath, data)
  return { acquired: true, holder: previous || null }
}
