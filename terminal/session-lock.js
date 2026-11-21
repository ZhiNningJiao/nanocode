/**
 * session-lock.js
 *
 * Cross-process singleton lock for Claude sessions. Prevents two nanocode
 * servers from simultaneously spawning/attaching Claude consumers to the
 * same conversation. The loser enters read-only follow mode.
 *
 * Lock files live at <home>/.nanocode/session-locks/<sessionId>.lock and
 * contain JSON: { pid, port, host, timestamp, hb }.
 *
 * The lock dir sits on the shared home (JFS / sshfs), so two MACHINES can
 * contend for the same lock. A pid only means something on the machine that
 * wrote it, so liveness is judged per writer:
 *   - lock written by this host (or a legacy lock without `host`) → the pid
 *     must be alive here (signal-0 probe), exactly as before;
 *   - lock written by another host → alive while its heartbeat `hb` is younger
 *     than FOREIGN_TTL_MS. The holder refreshes `hb` from its lock-watch loop
 *     (touchSessionLock). A pid is never probed across machines.
 *
 * Legacy locks (no `host`) keep the old same-machine semantics, so a mixed
 * fleet (one server patched, one not) is NOT protected across machines — the
 * switch procedure stops the old server before the new one starts.
 *
 * Every rewrite goes through tmp + rename so a reader on another machine
 * never sees a half-written (empty) file and mistakes it for a corrupt lock.
 *
 * All file IO below is ASYNC (node:fs/promises). The lock dir sits on JFS/
 * sshfs, which has observed multi-second stalls in production; synchronous
 * calls here used to block the ENTIRE process (Node is single-threaded) for
 * every one of them, including unrelated HTTP requests like `GET /` — see
 * REPORT_nanostall_1600.md. Async calls hand the blocking syscall to libuv's
 * thread pool instead, so a stuck /jfs read no longer freezes the event loop.
 *
 * Async IO reintroduces a hazard synchronous code never had: two operations
 * on the SAME lock file, issued back-to-back from the SAME process (e.g. the
 * 3-second heartbeat and a WS-close release racing each other), used to be
 * impossible to interleave — a sync function body has no yield point. Now
 * every `await` is a yield point. `withLockQueue()` below serializes all
 * mutating/reading calls for a given lock file (keyed by its resolved path)
 * so they still run one-at-a-time within this process; cross-machine
 * ordering is unaffected and continues to rely on the filesystem's own
 * O_EXCL / rename atomicity, same as before.
 */

import { mkdir, readFile, writeFile, unlink, open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'

const LOCK_SUBDIR = 'session-locks'
// A foreign lock is stale once its heartbeat is older than this. The holder
// refreshes every HEARTBEAT_MS, so this tolerates several missed beats plus
// wall-clock skew between the two machines.
export const FOREIGN_TTL_MS = 120_000
export const HEARTBEAT_MS = 20_000
// A lock file that is EMPTY and this young is treated as "being written"
// (O_EXCL create happens before the payload write), not as garbage.
const YOUNG_CORRUPT_MS = 10_000

const HOST = hostname()

// ── Injectable fs seam (production default: real node:fs/promises) ────────
// Tests use this to simulate a slow/stuck filesystem (e.g. a FIFO with no
// writer) without touching any real disk. Nothing in production code calls
// _setFsImplForTesting — the default below is what always runs outside tests.
const _realFs = { mkdir, readFile, writeFile, unlink, open, rename, stat }
let _rawFs = _realFs
export function _setFsImplForTesting(impl) {
  _rawFs = impl ? { ..._rawFs, ...impl } : _realFs
}

// ── Thread-pool budget for lock IO ──────────────────────────────────────
// Every fs/promises call occupies one libuv thread-pool worker until its
// syscall returns — on a stalled /jfs that is seconds or longer. The pool is
// small (UV_THREADPOOL_SIZE, default 4) and shared with zlib: HTTP gzip
// (compression()) and WS permessage-deflate on /ws/terminal. Measured in
// nanolock2_2000: 12 tabs re-attaching against a 3 s lock dir filled the
// pool, WS frames could no longer be inflated/deflated, and no tab finished
// its attach within 30 s. So lock IO gets at most LOCK_FS_CONCURRENCY
// workers; the rest of the pool stays free. Extra calls wait here, in JS,
// where waiting costs nothing.
export const LOCK_FS_CONCURRENCY = 2
let _fsActive = 0
const _fsWaiters = []

function limitFs(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _fsActive++
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        _fsActive--
        const next = _fsWaiters.shift()
        if (next) next()
      })
    }
    if (_fsActive < LOCK_FS_CONCURRENCY) run()
    else _fsWaiters.push(run)
  })
}

const _fs = Object.fromEntries(
  Object.keys(_realFs).map((name) => [name, (...args) => limitFs(() => _rawFs[name](...args))])
)

// ── Per-lock-file serialization queue ───────────────────────────────────
// Keyed by the resolved lock file path so acquire/get/touch/release/steal
// calls for the SAME session, issued from async code in this process, never
// interleave. Self-cleaning: once a key's chain is idle, its entry is
// removed so this never grows unbounded across the life of a long-running
// server (thousands of distinct sessionIds can pass through over time).
const _queues = new Map()

function withLockQueue(key, fn) {
  const tail = _queues.get(key) || Promise.resolve()
  const result = tail.then(fn, fn) // run fn after the previous op settles, regardless of its outcome
  const settled = result.then(() => {}, () => {}) // never-rejecting tail so the chain can't wedge
  _queues.set(key, settled)
  settled.finally(() => {
    if (_queues.get(key) === settled) _queues.delete(key)
  })
  return result
}

// ── Bounded wait for latency-sensitive callers ──────────────────────────
// A lock call can sit behind a stalled /jfs syscall (or behind other calls
// for the same file in withLockQueue) for as long as the filesystem likes.
// WS attach, user-message steal and ws-close release must not wait on that
// indefinitely — a tab whose attach never finishes never comes back after a
// restart (nanolock2_2000). fs syscalls cannot be cancelled, so a timed-out
// call keeps running: the caller gets it back as `late` and must reconcile
// whatever it eventually does (adopt a late acquire, or give it back).
export const LOCK_OP_TIMEOUT_MS = 2000

/**
 * @returns {Promise<{ timedOut: false, value: * } | { timedOut: true, late: Promise<*> }>}
 *   Rejects only if `promise` rejects before the deadline.
 */
export function boundLockOp(promise, ms = LOCK_OP_TIMEOUT_MS) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, late: promise }), ms)
  })
  return Promise.race([promise.then((value) => ({ timedOut: false, value })), deadline])
    .finally(() => clearTimeout(timer))
}

function resolveLockDir(home) {
  const base = home || process.env.HOME || '/tmp'
  return join(base, '.nanocode', LOCK_SUBDIR)
}

async function ensureLockDir(lockDir) {
  await _fs.mkdir(lockDir, { recursive: true, mode: 0o700 })
}

function lockPath(sessionId, lockDir) {
  // Sanitize: a Claude sessionId is a UUID but be defensive.
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120)
  return join(lockDir, `${safe}.lock`)
}

function lockData(pid, port, host, now) {
  return JSON.stringify({ pid, port, host, timestamp: now, hb: now })
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
 * Is the recorded holder still alive, judged from THIS machine?
 * Same host (or legacy lock without host) → pid probe; other host → heartbeat age.
 */
export function isHolderAlive(holder, { host = HOST, now = Date.now(), foreignTtlMs = FOREIGN_TTL_MS } = {}) {
  if (!holder) return false
  if (!holder.host || holder.host === host) return isPidAlive(holder.pid)
  const beat = holder.hb || holder.timestamp || 0
  return now - beat < foreignTtlMs
}

/** Same pid + port + machine → this lock is ours. */
export function isOwnLock(holder, opts = {}) {
  if (!holder) return false
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const host = opts.host ?? HOST
  return holder.pid === pid && holder.port === port && (holder.host || host) === host
}

/**
 * Read and parse a lock file. Returns { pid, port, host, timestamp, hb },
 * { corrupt: true, ageMs } for an empty/garbled file, or null if missing.
 * Does NOT check liveness — callers decide what to do with a stale lock.
 */
async function readLock(filePath) {
  let ageMs = Infinity
  try {
    ageMs = Date.now() - (await _fs.stat(filePath)).mtimeMs
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    return null
  }
  try {
    const raw = (await _fs.readFile(filePath, 'utf8')).trim()
    if (!raw) return { corrupt: true, empty: true, ageMs }
    const obj = JSON.parse(raw)
    if (typeof obj.pid !== 'number' || !obj.pid) return { corrupt: true, ageMs }
    return {
      pid: obj.pid,
      port: obj.port || null,
      host: typeof obj.host === 'string' && obj.host ? obj.host : null,
      timestamp: obj.timestamp || 0,
      hb: obj.hb || obj.timestamp || 0,
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    return { corrupt: true, ageMs }
  }
}

async function pathExists(filePath) {
  try {
    await _fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Atomically write a lock file using O_EXCL|O_CREAT. Returns true on success.
 * If the file already exists, returns false (caller should retry or steal).
 */
async function writeLockExclusive(filePath, data) {
  let handle
  try {
    handle = await _fs.open(filePath, 'wx', 0o600) // O_EXCL | O_CREAT | O_WRONLY
  } catch {
    // EEXIST → race lost; file already there
    return false
  }
  try {
    await limitFs(() => handle.writeFile(data))
    return true
  } catch {
    return false
  } finally {
    try { await limitFs(() => handle.close()) } catch {}
  }
}

/**
 * Replace a lock file atomically (tmp + rename): used for stale-lock steal,
 * user-message steal and heartbeat refresh.
 */
async function writeLockOverwrite(filePath, data) {
  const tmp = `${filePath}.${HOST}.${process.pid}.tmp`
  try {
    await _fs.writeFile(tmp, data, { mode: 0o600 })
    await _fs.rename(tmp, filePath)
    return true
  } catch {
    try { await _fs.unlink(tmp) } catch {}
    return false
  }
}

function holderView(lock) {
  return { pid: lock.pid, port: lock.port, host: lock.host, timestamp: lock.timestamp, hb: lock.hb }
}

/**
 * Acquire a session singleton lock.
 *
 * @param {string} sessionId  Claude conversation ID
 * @param {{ pid?: number, port?: *, host?: string, now?: number, foreignTtlMs?: number }} opts
 *   pid defaults to process.pid, host to os.hostname() (overridable for tests)
 * @param {string} [home]  Home dir (for test isolation)
 * @returns {Promise<{ acquired: boolean, holder?: { pid: number, port: *, host: string|null, timestamp: number, hb: number } }>}
 *   - acquired=true  → we now hold the lock
 *   - acquired=false → another live holder (any machine) has it; `holder` describes it
 */
export async function acquireSessionLock(sessionId, opts = {}, home) {
  const lockDir = resolveLockDir(home)
  const filePath = lockPath(sessionId, lockDir)
  return withLockQueue(filePath, () => _acquireSessionLock(filePath, lockDir, opts))
}

async function _acquireSessionLock(filePath, lockDir, opts) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const host = opts.host ?? HOST
  const now = opts.now ?? Date.now()
  await ensureLockDir(lockDir)
  const data = lockData(pid, port, host, now)

  // Fast path: no lock file → atomic exclusive create.
  if (!(await pathExists(filePath))) {
    if (await writeLockExclusive(filePath, data)) {
      return { acquired: true }
    }
    // Lost a race — another process created the file between our existence
    // check and open. Fall through to the existing-file logic below.
  }

  const existing = await readLock(filePath)
  if (existing?.corrupt) {
    // A just-created lock whose payload is still in flight looks EMPTY: do not
    // steal it. Garbled content, or an empty file older than
    // YOUNG_CORRUPT_MS, is overwritten as before.
    if (existing.empty && existing.ageMs < YOUNG_CORRUPT_MS) {
      return { acquired: false, holder: { pid: 0, port: null, host: null, timestamp: 0, hb: 0 } }
    }
    return stealAndVerify(filePath, data, { pid, port, host })
  }
  if (!existing) {
    // Vanished between existence check and read — retry the exclusive create once.
    if (await writeLockExclusive(filePath, data)) return { acquired: true }
    const again = await readLock(filePath)
    if (again && !again.corrupt && !isOwnLock(again, { pid, port, host })) {
      return { acquired: false, holder: holderView(again) }
    }
    return { acquired: true }
  }

  // Is the existing lock ours? (Same pid + port + host → re-entrant, keep it.)
  if (isOwnLock(existing, { pid, port, host })) {
    return { acquired: true }
  }

  // Is the existing holder dead (pid on this host / heartbeat on another)? → steal.
  if (!isHolderAlive(existing, { host, now, foreignTtlMs: opts.foreignTtlMs })) {
    return stealAndVerify(filePath, data, { pid, port, host })
  }

  // Lock held by another live holder.
  return { acquired: false, holder: holderView(existing) }
}

// Overwrite, then read back: if a contender on another machine renamed its
// own lock in at the same moment, whoever's file survived wins.
async function stealAndVerify(filePath, data, own) {
  await writeLockOverwrite(filePath, data)
  const after = await readLock(filePath)
  if (after && !after.corrupt && !isOwnLock(after, own)) {
    return { acquired: false, holder: holderView(after) }
  }
  return { acquired: true }
}

/**
 * Get the current lock holder for a session, or null if unheld / stale.
 * A stale lock written by THIS host is cleaned up; a stale foreign lock is
 * left in place (the next acquire overwrites it) so we never delete a lock
 * whose holder refreshed it a moment after we read it.
 */
export async function getLockHolder(sessionId, home, opts = {}) {
  const lockDir = resolveLockDir(home)
  const filePath = lockPath(sessionId, lockDir)
  return withLockQueue(filePath, () => _getLockHolder(filePath, opts))
}

async function _getLockHolder(filePath, opts) {
  const host = opts.host ?? HOST
  const existing = await readLock(filePath)
  if (!existing || existing.corrupt) return null
  if (!isHolderAlive(existing, { host, now: opts.now, foreignTtlMs: opts.foreignTtlMs })) {
    if (!existing.host || existing.host === host) {
      try { await _fs.unlink(filePath) } catch {}
    }
    return null
  }
  return holderView(existing)
}

/**
 * Refresh our heartbeat so other machines keep seeing the lock as alive.
 * Rewrites only when the lock is ours and the last beat is older than
 * HEARTBEAT_MS. Returns true if the lock is (still) ours.
 */
export async function touchSessionLock(sessionId, opts = {}, home) {
  const filePath = lockPath(sessionId, resolveLockDir(home))
  return withLockQueue(filePath, () => _touchSessionLock(filePath, opts))
}

async function _touchSessionLock(filePath, opts) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const host = opts.host ?? HOST
  const now = opts.now ?? Date.now()
  const existing = await readLock(filePath)
  if (!existing || existing.corrupt || !isOwnLock(existing, { pid, port, host })) return false
  if (now - (existing.hb || 0) < (opts.heartbeatMs ?? HEARTBEAT_MS)) return true
  return writeLockOverwrite(filePath, JSON.stringify({
    pid, port, host, timestamp: existing.timestamp || now, hb: now,
  }))
}

/**
 * Release a session lock. Only removes the file if the recorded pid+port+host
 * match ours, so a process never accidentally clears another's lock.
 */
export async function releaseSessionLock(sessionId, opts = {}, home) {
  const lockDir = resolveLockDir(home)
  const filePath = lockPath(sessionId, lockDir)
  return withLockQueue(filePath, () => _releaseSessionLock(filePath, opts))
}

async function _releaseSessionLock(filePath, opts) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const host = opts.host ?? HOST
  const existing = await readLock(filePath)
  if (!existing || existing.corrupt) return false
  if (!isOwnLock(existing, { pid, port, host })) return false
  try {
    await _fs.unlink(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Check whether the lock for a session is held by a *different* live
 * holder. Returns the holder if so, null otherwise.
 */
export async function isLockHeldByOther(sessionId, opts = {}, home) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const host = opts.host ?? HOST
  const holder = await getLockHolder(sessionId, home, { host })
  if (!holder) return null
  if (isOwnLock(holder, { pid, port, host })) return null
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
 * port + host) is a no-op that still returns acquired=true.
 *
 * @returns {Promise<{ acquired: boolean, holder?: { pid: number, port: *, host: string|null, timestamp: number, hb: number } | null }>}
 *   - acquired=true  → we now hold the lock; `holder` is the previous
 *                      holder (or null if the lock was absent / stale / ours)
 */
export async function stealSessionLock(sessionId, opts = {}, home) {
  const lockDir = resolveLockDir(home)
  const filePath = lockPath(sessionId, lockDir)
  return withLockQueue(filePath, () => _stealSessionLock(filePath, lockDir, opts))
}

async function _stealSessionLock(filePath, lockDir, opts) {
  const pid = opts.pid ?? process.pid
  const port = opts.port ?? null
  const host = opts.host ?? HOST
  const now = opts.now ?? Date.now()
  await ensureLockDir(lockDir)

  const previous = await readLock(filePath)
  if (previous && !previous.corrupt && isOwnLock(previous, { pid, port, host })) {
    return { acquired: true, holder: null }
  }

  await writeLockOverwrite(filePath, lockData(pid, port, host, now))
  return { acquired: true, holder: previous && !previous.corrupt ? holderView(previous) : null }
}
