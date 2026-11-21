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

import { open, readdir, stat } from 'node:fs/promises'

export const DEFAULT_SCAN_CONCURRENCY = 2

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

async function readRange(filePath, maxBytes, fromEnd) {
  let fh
  try {
    fh = await open(filePath, 'r')
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

/** readdir that returns [] instead of throwing (missing dir / permission). */
export async function readdirSafe(dir, opts) {
  try { return await readdir(dir, opts) } catch { return [] }
}

/** stat that returns null instead of throwing. */
export async function statSafe(p) {
  try { return await stat(p) } catch { return null }
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
      entries.set(key, {
        items: progress.items.slice(),
        scannedAt: startedAt,
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
