/**
 * Bounded, non-blocking disk scanning for request handlers.
 *
 * Why this exists: session/agent listings walk directories that may live on a
 * slow network mount (sshfs home). Synchronous readdirSync/openSync/readSync on
 * such a mount blocks the event loop, so ONE listing request froze every other
 * HTTP endpoint for 40 s – 2.5 min. Everything here uses fs/promises:
 *
 *   - mapLimit        : run an async fn over items with a concurrency cap (kept
 *                       below libuv's 4-thread pool so a stalled mount cannot
 *                       starve other fs work) and a cooperative stop signal.
 *   - readHead/readTail: read at most N bytes from the start/end of a file.
 *   - createScanCache : per-key stale-while-revalidate cache with single-flight
 *                       scans and a request-level deadline. A request waits at
 *                       most `deadlineMs`; if the scan is still running it gets
 *                       the progress so far marked partial (with a reason), the
 *                       scan keeps going in the background and the next
 *                       request gets the full result.
 */

import * as fsp from 'node:fs/promises'

export const DEFAULT_SCAN_CONCURRENCY = 2

// ── Home-filesystem budget: a stalled mount never takes the whole pool ──
// Every async fs call holds one libuv thread-pool worker until its syscall
// returns — on a stalled /jfs that is seconds to minutes. The pool is small
// (UV_THREADPOOL_SIZE, default 4) and also serves zlib (HTTP gzip, WS deflate)
// and express.static. Async-izing the sync calls moved the stall from the
// event loop into this pool: once 4 calls hang, every request that needs a
// worker hangs too (REPORT_nanolock_0730.md). So all home fs IO made through
// this module holds one of HOME_FS_CONCURRENCY slots; extra calls wait in JS,
// where waiting costs nothing, and the rest of the pool stays free.
export const HOME_FS_CONCURRENCY = 2
let _fsActive = 0
const _fsWaiters = []

/** Run `fn` (a multi-step fs sequence) while holding one home-fs slot. */
export function withFsSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _fsActive++
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        _fsActive--
        const next = _fsWaiters.shift()
        if (next) next()
      })
    }
    if (_fsActive < HOME_FS_CONCURRENCY) run()
    else _fsWaiters.push(run)
  })
}

// ── Slow calls are never silent ──────────────────────────────────────────
// A call still running after SLOW_FS_MS logs one "still pending" line; when it
// finally settles it logs one more line with the total time, so a /jfs stall
// shows up in the journal with the op and path that hit it.
export const SLOW_FS_MS = 2000
let _slowFsMs = SLOW_FS_MS
let _slowFsLog = (line) => console.warn(line)

/** Tests only: lower the threshold and/or capture the log lines. */
export function _setSlowFsForTesting({ slowMs, log } = {}) {
  _slowFsMs = slowMs ?? SLOW_FS_MS
  _slowFsLog = log ?? ((line) => console.warn(line))
}

async function slowWatch(op, target, fn) {
  const t0 = Date.now()
  const what = typeof target === 'string' ? target : String(target?.path ?? target)
  let warned = false
  const timer = setTimeout(() => {
    warned = true
    _slowFsLog(`[fs-slow] ${op} ${what} still pending after ${_slowFsMs}ms`)
  }, _slowFsMs)
  timer.unref?.()
  try {
    return await fn()
  } finally {
    clearTimeout(timer)
    if (warned) _slowFsLog(`[fs-slow] ${op} ${what} settled after ${Date.now() - t0}ms`)
  }
}

// timedFs = node:fs/promises with the slot budget + slow-call log. Every async
// fs call server code makes against the home filesystem goes through here.
const FS_OPS = ['access', 'copyFile', 'mkdir', 'open', 'readdir', 'readFile', 'readlink',
  'realpath', 'rename', 'stat', 'lstat', 'unlink', 'writeFile', 'appendFile']
export const timedFs = Object.fromEntries(FS_OPS.map((op) => [op,
  (...args) => withFsSlot(() => slowWatch(op, args[0], () => fsp[op](...args)))]))
const { readdir, stat } = timedFs

export async function mapLimit(items, limit, fn, shouldStop = () => false) {
  let next = 0
  const workers = []
  const n = Math.max(1, Math.min(limit, items.length))
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (next < items.length && !shouldStop()) {
        const i = next++
        await fn(items[i], i)
      }
    })())
  }
  await Promise.all(workers)
}

function readRange(filePath, maxBytes, fromEnd) {
  return withFsSlot(() => slowWatch('read', filePath, () => _readRange(filePath, maxBytes, fromEnd)))
}

async function _readRange(filePath, maxBytes, fromEnd) {
  let fh
  try {
    fh = await fsp.open(filePath, 'r')
    let position = 0
    let length = maxBytes
    if (fromEnd) {
      const { size } = await fh.stat()
      position = Math.max(0, size - maxBytes)
      length = Math.min(maxBytes, size)
    }
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, position)
    return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: position > 0, ok: true }
  } catch {
    return { text: '', truncated: false, ok: false }
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/** `length` bytes of a file starting at byte `start` as a Buffer, or null when unreadable. */
export function readByteRange(filePath, start, length) {
  return withFsSlot(() => slowWatch('read', filePath, async () => {
    let fh
    try {
      fh = await fsp.open(filePath, 'r')
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await fh.read(buf, 0, length, start)
      return buf.subarray(0, bytesRead)
    } catch {
      return null
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }))
}

/** First `maxBytes` of a file as utf8 ('' when unreadable). */
export async function readHead(filePath, maxBytes) {
  return (await readRange(filePath, maxBytes, false)).text
}

/**
 * Last `maxBytes` of a file split into complete lines. When the window does not
 * start at byte 0 the first (partial) line is dropped. Returns { lines, truncated, ok }
 * (ok=false: the file could not be opened/read).
 */
export async function readTailLines(filePath, maxBytes) {
  const { text, truncated, ok } = await readRange(filePath, maxBytes, true)
  let body = text
  if (truncated) {
    const nl = body.indexOf('\n')
    body = nl >= 0 ? body.slice(nl + 1) : ''
  }
  return { lines: body.split('\n').filter(Boolean), truncated, ok }
}

/**
 * Stream the complete lines of the first `capBytes` of a file (128 KB chunks),
 * calling onLine(line) for each. A final unterminated line is delivered only
 * when the cap/end is reached. Returns { size, truncated } or null when the
 * file is missing, unreadable or empty.
 */
export function forEachLine(filePath, capBytes, onLine) {
  return withFsSlot(() => slowWatch('read', filePath, () => _forEachLine(filePath, capBytes, onLine)))
}

async function _forEachLine(filePath, capBytes, onLine) {
  let fh
  try {
    fh = await fsp.open(filePath, 'r')
    const { size } = await fh.stat()
    if (size === 0) return null
    const readCap = Math.min(size, capBytes)
    const chunk = Buffer.allocUnsafe(128 * 1024)
    let pos = 0
    let tail = ''
    try {
      while (pos < readCap) {
        const { bytesRead: n } = await fh.read(chunk, 0, Math.min(chunk.length, readCap - pos), pos)
        if (n <= 0) break
        pos += n
        tail += chunk.subarray(0, n).toString('utf8')
        const lastNl = tail.lastIndexOf('\n')
        let block
        if (lastNl >= 0) {
          block = tail.slice(0, lastNl + 1)
          tail = tail.slice(lastNl + 1)
        } else if (pos >= readCap) {
          block = tail; tail = ''
        } else {
          continue
        }
        for (const line of block.split('\n')) onLine(line)
      }
      if (tail) onLine(tail)
    } catch {
      // best-effort: keep what was delivered so far
    }
    return { size, truncated: size > readCap }
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/** readdir that returns [] instead of throwing (missing dir / permission). */
export async function readdirSafe(dir, opts) {
  try { return await readdir(dir, opts) } catch { return [] }
}

/** stat that returns null instead of throwing. */
export async function statSafe(p) {
  try { return await stat(p) } catch { return null }
}

/** Async existsSync. */
export async function pathExists(p) {
  return (await statSafe(p)) !== null
}

/** Whole file as utf8, or null when missing/unreadable. */
export async function readTextSafe(p) {
  try { return await timedFs.readFile(p, 'utf8') } catch { return null }
}

/**
 * Per-key stale-while-revalidate cache with single-flight scans.
 *
 * `scan(key, progress)` must push results into `progress.items` as it goes and
 * may poll `progress.stopped` to stop early; its resolved value is ignored —
 * `progress.items` is the result. `scanTimeoutMs` caps one scan: when it fires
 * the scan is marked done+partial so a hung mount cannot pin the single-flight
 * slot forever (in-flight syscalls are bounded by the scan's own concurrency).
 *
 * get(key, { deadlineMs }) resolves to
 *   { items, partial, partialReason, stale, scannedAt }
 */
export function createScanCache({ ttlMs, scanTimeoutMs, scan, now = () => Date.now() }) {
  const entries = new Map() // key -> { items, scannedAt, partial, partialReason }
  const inflight = new Map() // key -> { promise, progress, startedAt }

  function start(key) {
    const existing = inflight.get(key)
    if (existing) return existing
    const progress = { items: [], stopped: false }
    const startedAt = now()
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        progress.stopped = true
        resolve({ partialReason: `scan exceeded ${scanTimeoutMs} ms` })
      }, scanTimeoutMs)
      timer.unref?.()
    })
    const run = Promise.resolve()
      .then(() => scan(key, progress))
      .then(() => ({ partialReason: progress.partialReason || null }),
        (err) => ({ partialReason: `scan failed: ${err?.message || err}` }))
    const promise = Promise.race([run, timeout]).then(({ partialReason }) => {
      clearTimeout(timer)
      // Age counts from completion: a scan slower than the TTL must not be
      // stale the moment it lands (that would rescan on every request).
      entries.set(key, {
        items: progress.items.slice(),
        scannedAt: now(),
        partial: !!partialReason,
        partialReason,
      })
      inflight.delete(key)
    })
    const flight = { promise, progress, startedAt }
    inflight.set(key, flight)
    return flight
  }

  async function get(key, { deadlineMs } = {}) {
    const cached = entries.get(key)
    const fresh = cached && !cached.partial && now() - cached.scannedAt < ttlMs
    if (fresh) return { ...cached, stale: false }
    const flight = start(key)
    // Stale-while-revalidate: an older complete result is served immediately
    // while the refresh runs in the background.
    if (cached && !cached.partial) return { ...cached, stale: true }
    let timer
    const waited = await Promise.race([
      flight.promise.then(() => 'done'),
      new Promise((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs) }),
    ])
    clearTimeout(timer)
    if (waited === 'done') return { ...entries.get(key), stale: false }
    // Deadline hit: return what the scan has found so far (or the previous
    // partial result if that is larger), explicitly labelled.
    const soFar = flight.progress.items
    const best = cached && cached.items.length > soFar.length ? cached.items : soFar
    return {
      items: best.slice(),
      partial: true,
      partialReason: `scan still running after ${deadlineMs} ms (background scan continues)`,
      stale: false,
      scannedAt: flight.startedAt,
    }
  }

  return {
    get,
    /** Resolves when the in-flight scan for `key` (if any) settles. Tests only. */
    settle: (key) => inflight.get(key)?.promise ?? Promise.resolve(),
    clear: () => { entries.clear(); inflight.clear() },
  }
}
