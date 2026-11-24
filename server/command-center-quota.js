/**
 * Command Center P0-5 — quota (额度) per pool.
 *
 * Reads the header-reading cache another program keeps on disk (one JSON file
 * per pool, written when it already talks to the model API). This module NEVER
 * calls a model API itself. Cache file shape (per pool):
 *   { pool, fetched_at, util_5h, reset_5h_bjt, util_7d, reset_7d_bjt,
 *     status, overage_status, error }
 *   util_* = used fraction 0..1, times = "YYYY-MM-DD HH:MM:SS+08:00".
 *
 * Display rules borrowed from Claude-Code-Usage-Monitor `read_official_limits()`
 * (src/claude_monitor/output/official.py, MIT) and agent-deck `MarkExpired()`
 * (internal/statedb/claude_statusline.go, MIT) — ideas only, no code copied:
 *   - the number shown is the official reading, labelled with its source and
 *     read time;
 *   - a window whose reset time has passed is void (shown as such, no %);
 *   - a reading older than staleSec (default 15 min) is marked stale ("旧");
 *   - the stored file is never rewritten — expiry is decided at read time.
 *
 * mapQuotaReading / buildQuotaView are pure; createQuotaSource does the IO;
 * createQuotaSnapshotSource (bottom of file) caches createQuotaSource's scan
 * so the HTTP route never blocks on it (REPORT_nanoquota_1340.md).
 */

import { timedFs } from '../terminal/bounded-scan.js'
const { readdir, readFile, stat } = timedFs // home fs: slot budget + slow-call log
import { join } from 'node:path'
import { str } from './command-center-fields.js'
import { readdirSafe, statSafe, readTailLines, mapLimit, DEFAULT_SCAN_CONCURRENCY, createScanCache } from '../terminal/bounded-scan.js'

export const DEFAULT_QUOTA_STALE_SEC = 15 * 60
const TIGHTEST_SHOWN = 2

// ─── Extra readings sources (nanofix2_0120) ──────────────────────────────────
//
// The cache dir above is written only when another program already happened
// to talk to a pool's model API — on a quiet pool it can sit stale for hours.
// Two other programs already produce fresher per-pool readings as a side
// effect of their own work, in formats this module can parse WITHOUT ever
// making a model-API call itself:
//   - usage_snap.log: one line per pool every ~30 min ("usage_snap" source).
//   - dispatch logs under ~/codex_work (and similar dirs): a `QUOTA_HDR
//     stage=PRE|POST pool=T1 {...}` line each time a dispatch script reads a
//     pool's header before/after launching a car ("quota_hdr_dispatch_log").
// For each pool, createQuotaSource.get() below picks whichever of the three
// candidates (cache file / usage_snap line / dispatch-log line) has the
// newest `fetched_at`, so a pool missing from the cache dir (or stuck on an
// old cache file) still shows the freshest reading anyone actually has.

const USAGE_SNAP_TAIL_BYTES = 512 * 1024
const DISPATCH_LOG_TAIL_BYTES = 256 * 1024
// Bound the dispatch-log scan: only directories' most-recently-modified *.log
// files can possibly hold the newest QUOTA_HDR line, so older logs (which
// accumulate indefinitely under ~/codex_work) are never opened at all.
const DISPATCH_LOG_MAX_AGE_MS = 6 * 60 * 60 * 1000
const DISPATCH_LOG_MAX_FILES_PER_DIR = 15
// Re-scan the log sources at most this often — a dashboard left open and
// polling every few seconds should not re-tail-read every log file each time.
const LOG_SCAN_CACHE_MS = 20_000

// The trailing ` src=` tag is optional: some snapshot lines (e.g. ones the
// usage-API path wrote) end right after `extra=`; their numbers are just as real.
const USAGE_SNAP_LINE_RE = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}) \.claude-team(\w+): 5h=([\d.]+)% 7d=([\d.]+)%.*?reset5h=(\S*) reset7d=(\S*)/
const USAGE_SNAP_RESET_RE = /^(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const QUOTA_HDR_LINE_RE = /QUOTA_HDR stage=\w+ pool=(T\w+) (\{.*\})\s*$/

/** usage_snap.log carries no year — reconstruct it from "now" (BJT, UTC+8). */
function yearedBjtMs(mm, dd, hh, mi, anchorMs, { allowFuture = false } = {}) {
  const anchorBjtYear = new Date(anchorMs + 8 * 3600 * 1000).getUTCFullYear()
  const tryYear = (yr) => Date.parse(`${yr}-${mm}-${dd}T${hh}:${mi}:00+08:00`)
  let ms = tryYear(anchorBjtYear)
  if (!allowFuture && ms - anchorMs > 3 * 86400 * 1000) ms = tryYear(anchorBjtYear - 1)
  if (allowFuture && ms < anchorMs - 3 * 86400 * 1000) ms = tryYear(anchorBjtYear + 1)
  return ms
}

/**
 * One usage_snap.log line → { pool, raw } in the same shape as a cache-dir
 * JSON file (so mapQuotaReading handles it identically), or null if the line
 * doesn't match. `nowMs` anchors the omitted year on the line's own
 * timestamp; `reset*` fields (also year-less) are anchored on that resolved
 * fetched_at instead, since a reset can be up to ~7 days in the future.
 */
export function parseUsageSnapLine(line, nowMs) {
  const m = USAGE_SNAP_LINE_RE.exec(String(line).trim())
  if (!m) return null
  const [, mm, dd, hh, mi, teamNum, u5, u7, r5, r7] = m
  const fetchedMs = yearedBjtMs(mm, dd, hh, mi, nowMs)
  const parseReset = (s) => {
    const rm = USAGE_SNAP_RESET_RE.exec(s || '')
    if (!rm) return null
    const [, rmm, rdd, rhh, rmi] = rm
    return yearedBjtMs(rmm, rdd, rhh, rmi, fetchedMs, { allowFuture: true })
  }
  const r5ms = parseReset(r5)
  const r7ms = parseReset(r7)
  return {
    pool: `T${teamNum}`,
    raw: {
      pool: `T${teamNum}`,
      fetched_at: new Date(fetchedMs).toISOString(),
      util_5h: Number(u5) / 100,
      reset_5h_bjt: r5ms != null ? new Date(r5ms).toISOString() : null,
      util_7d: Number(u7) / 100,
      reset_7d_bjt: r7ms != null ? new Date(r7ms).toISOString() : null,
      status: null,
      overage_status: null,
      error: null,
    },
  }
}

/**
 * One dispatch-log `QUOTA_HDR stage=... pool=T1 {...}` line → { pool, raw }.
 * The embedded JSON is already written in the exact cache-file shape (same
 * producer), so it needs no field mapping — just parsing out and JSON.parse.
 */
export function parseQuotaHdrLine(line) {
  const m = QUOTA_HDR_LINE_RE.exec(String(line).trim())
  if (!m) return null
  let raw
  try { raw = JSON.parse(m[2]) } catch { return null }
  return { pool: m[1], raw }
}

const WINDOWS = [
  { key: '5h', util: 'util_5h', reset: 'reset_5h_bjt' },
  { key: '7d', util: 'util_7d', reset: 'reset_7d_bjt' },
]

// Errors that mean "this pool is logged out", as opposed to "reading failed".
const LOGGED_OUT_RX = /\b401\b|unauthori[sz]ed|not logged in|login required|invalid (api )?key|oauth token (has )?expired/i

/** "2026-11-21 17:20:00+08:00" (or ISO) → epoch ms, or null. */
export function parseReadingTime(v) {
  if (typeof v !== 'string' || !v.trim()) return null
  const ms = Date.parse(v.trim().replace(' ', 'T'))
  return Number.isFinite(ms) ? ms : null
}

function mapWindow(raw, w, nowMs) {
  const resetMs = parseReadingTime(raw?.[w.reset])
  const util = raw?.[w.util]
  const has = typeof util === 'number' && Number.isFinite(util) && util >= 0
  const expired = resetMs != null && nowMs >= resetMs
  return {
    key: w.key,
    // void past the reset time: the old % no longer describes this window
    pct: has && !expired ? Math.round(util * 1000) / 10 : null,
    resetAt: resetMs != null ? new Date(resetMs).toISOString() : null,
    expired,
    missing: !has,
  }
}

/**
 * One reading's JSON → one pool row. `name` = file name (fallback pool id).
 * `source` labels WHERE this particular reading came from — the cache
 * directory (one JSON per pool), usage_snap.log (periodic snapshots), or a
 * dispatch log's `QUOTA_HDR` line — so the per-pool "freshest of three"
 * merge in createQuotaSource can tag its pick honestly instead of always
 * claiming "official_headers".
 */
export function mapQuotaReading(raw, { name, nowMs, staleSec = DEFAULT_QUOTA_STALE_SEC, source = 'official_headers' }) {
  const pool = str(raw?.pool) || name.replace(/\.json$/, '')
  const fetchedMs = parseReadingTime(raw?.fetched_at)
  const ageSec = fetchedMs != null ? Math.max(0, Math.round((nowMs - fetchedMs) / 1000)) : null
  const error = str(raw?.error)
  let loggedIn = null // unknown (no reading at all, or a non-auth error — can't tell)
  if (error && LOGGED_OUT_RX.test(error)) loggedIn = false
  // A clean reading proves the pool is logged in regardless of which source
  // produced it — usage_snap / quota_hdr_dispatch_log readings never carry a
  // `status` field (that's an official_headers-only extra), so requiring it
  // here used to mislabel every non-cache-file reading "login unknown" even
  // when the numbers were fresh and error-free.
  else if (!error && fetchedMs != null) loggedIn = true
  return {
    pool,
    source,
    fetchedAt: fetchedMs != null ? new Date(fetchedMs).toISOString() : null,
    ageSec,
    stale: ageSec == null || ageSec > staleSec,
    loggedIn,
    status: str(raw?.status),
    overage: str(raw?.overage_status),
    error,
    windows: WINDOWS.map((w) => mapWindow(raw, w, nowMs)),
  }
}

function worstPct(p) {
  let m = null
  for (const w of p.windows) if (w.pct != null && (m == null || w.pct > m.pct)) m = { key: w.key, pct: w.pct }
  return m
}

/**
 * Pool rows → { pools (by name), tightest (top 2 by highest live window %) }.
 * Unreadable files stay in the list as error rows.
 */
export function buildQuotaView(pools) {
  const sorted = [...pools].sort((a, b) => a.pool.localeCompare(b.pool))
  const tightest = sorted
    .filter((p) => !p.error)
    .map((p) => ({ pool: p.pool, stale: p.stale, ...worstPct(p) }))
    .filter((t) => t.pct != null)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, TIGHTEST_SHOWN)
  return { pools: sorted, tightest }
}

/**
 * Directory reader: every *.json file is one pool, re-parsed only when its
 * mtime changes. A broken file becomes that pool's error row; an unreadable
 * directory makes the whole block "unreachable + last success" UNLESS the
 * usage_snap/dispatch-log sources (extra.usageSnapLogPath / extra.
 * dispatchLogDirs, both optional) still produce readings for some pools —
 * one source being broken must not blank out ones that are still working.
 *
 * get(dir, staleSec, extra?) — extra = { usageSnapLogPath?, dispatchLogDirs? }.
 */
export function createQuotaSource({ now = () => Date.now() } = {}) {
  const files = new Map() // name -> { mtimeMs, raw | parseError }
  let lastOkAt = null
  let logCache = null // { at, usageSnap: [{pool,raw}], dispatchHdr: [{pool,raw}] }

  async function scanUsageSnap(usageSnapLogPath, nowMs) {
    if (!usageSnapLogPath) return []
    const { lines, ok } = await readTailLines(usageSnapLogPath, USAGE_SNAP_TAIL_BYTES)
    if (!ok) return []
    const out = []
    for (const line of lines) {
      const parsed = parseUsageSnapLine(line, nowMs)
      if (parsed) out.push(parsed)
    }
    return out
  }

  async function scanDispatchLogs(dispatchLogDirs, nowMs) {
    if (!dispatchLogDirs || !dispatchLogDirs.length) return []
    const out = []
    for (const dir of dispatchLogDirs) {
      const names = (await readdirSafe(dir)).filter((n) => n.endsWith('.log'))
      const withMtime = []
      await mapLimit(names, DEFAULT_SCAN_CONCURRENCY, async (n) => {
        const full = join(dir, n)
        const st = await statSafe(full)
        if (st && nowMs - st.mtimeMs <= DISPATCH_LOG_MAX_AGE_MS) withMtime.push({ full, mtimeMs: st.mtimeMs })
      })
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const recent = withMtime.slice(0, DISPATCH_LOG_MAX_FILES_PER_DIR)
      await mapLimit(recent, DEFAULT_SCAN_CONCURRENCY, async ({ full }) => {
        const { lines, ok } = await readTailLines(full, DISPATCH_LOG_TAIL_BYTES)
        if (!ok) return
        for (const line of lines) {
          if (!line.includes('QUOTA_HDR')) continue
          const parsed = parseQuotaHdrLine(line)
          if (parsed) out.push(parsed)
        }
      })
    }
    return out
  }

  return {
    async get(dir, staleSec, extra = {}) {
      const nowMs = now()
      const checkedAt = new Date(nowMs).toISOString()
      const { usageSnapLogPath, dispatchLogDirs } = extra
      if (!dir && !usageSnapLogPath && !(dispatchLogDirs && dispatchLogDirs.length)) {
        return { ok: false, notConnected: true, checkedAt, lastOkAt, error: 'quota.dir not configured', data: null }
      }

      // pool -> best candidate so far: { raw, fetchedMs, source } or
      // { parseError, fetchedMs: -Infinity } (a placeholder any real reading beats).
      const best = new Map()
      const consider = (pool, candidate) => {
        if (!pool) return
        const cur = best.get(pool)
        if (!cur || candidate.fetchedMs > cur.fetchedMs) best.set(pool, candidate)
      }

      let dirError = null
      if (dir) {
        let names = null
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()
        } catch (err) {
          dirError = `quota dir unreadable: ${err.code || err.message}`
        }
        if (names) {
          for (const name of names) {
            try {
              const st = await stat(join(dir, name))
              let f = files.get(name)
              if (!f || f.mtimeMs !== st.mtimeMs) {
                f = { mtimeMs: st.mtimeMs }
                try { f.raw = JSON.parse(await readFile(join(dir, name), 'utf8')) } catch (err) { f.parseError = err.message }
                files.set(name, f)
              }
              if (f.parseError) {
                const pool = name.replace(/\.json$/, '')
                if (!best.has(pool)) best.set(pool, { parseError: f.parseError, fetchedMs: -Infinity })
              } else {
                const pool = str(f.raw?.pool) || name.replace(/\.json$/, '')
                consider(pool, { raw: f.raw, fetchedMs: parseReadingTime(f.raw?.fetched_at) ?? -Infinity, source: 'official_headers' })
              }
            } catch { /* removed between readdir and stat */ }
          }
          for (const k of [...files.keys()]) if (!names.includes(k)) files.delete(k)
        }
      }

      if (!logCache || nowMs - logCache.at > LOG_SCAN_CACHE_MS) {
        const [usageSnap, dispatchHdr] = await Promise.all([
          scanUsageSnap(usageSnapLogPath, nowMs),
          scanDispatchLogs(dispatchLogDirs, nowMs),
        ])
        logCache = { at: nowMs, usageSnap, dispatchHdr }
      }
      for (const c of logCache.usageSnap) {
        consider(c.pool, { raw: c.raw, fetchedMs: parseReadingTime(c.raw.fetched_at) ?? -Infinity, source: 'usage_snap' })
      }
      for (const c of logCache.dispatchHdr) {
        consider(c.pool, { raw: c.raw, fetchedMs: parseReadingTime(c.raw?.fetched_at) ?? -Infinity, source: 'quota_hdr_dispatch_log' })
      }

      const pools = [...best.entries()].map(([pool, c]) => (
        c.parseError
          ? { pool, source: 'official_headers', fetchedAt: null, ageSec: null, stale: true, loggedIn: null, status: null, overage: null, error: `reading file is not valid JSON: ${c.parseError}`, windows: [] }
          : mapQuotaReading(c.raw, { name: `${pool}.json`, nowMs, staleSec, source: c.source })
      ))

      if (!pools.length) {
        return { ok: false, notConnected: false, checkedAt, lastOkAt, error: dirError || 'no quota readings from any source', data: null }
      }
      lastOkAt = checkedAt
      return { ok: true, notConnected: false, checkedAt, lastOkAt, error: null, data: buildQuotaView(pools) }
    },
  }
}

// ─── Snapshot cache for the HTTP route (nanoquota_1340) ────────────────────
//
// createQuotaSource.get() above does real IO against the shared (sshfs) home
// fs every time it's called — correct for the unit tests above (each asserts
// on a fresh scan), but the Command Center route used to call it inline on
// every request, so a stalled mount turned a ~1ms endpoint into 5–30s
// (REPORT_nanoquota_1340.md). createQuotaSnapshotSource wraps it in the same
// single-flight + stale-while-revalidate cache bounded-scan.js already
// provides for session/usage listings (terminal/recent-agents.js,
// terminal/routes.js usageScans): get() always returns the last complete
// snapshot immediately — even past ttlMs, just labelled source.stale-ish via
// its own checkedAt/lastOkAt — while a bounded, non-reentrant background scan
// (single-flight: a hung scan is never started twice) refreshes it. Only
// before the very first scan ever completes does it have nothing to show;
// that case returns a `pending` row instead of waiting.
export const QUOTA_SNAPSHOT_TTL_MS = 10_000
// Deliberately large: createScanCache replaces the cached result with an
// empty one when a scan exceeds scanTimeoutMs (see bounded-scan.js), and a
// quota reading going blank because the mount hung for a while is worse than
// it staying old — the per-pool `stale` flag already tells that story.
export const QUOTA_SNAPSHOT_SCAN_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const QUOTA_SNAPSHOT_POLL_MS = 10_000

export function createQuotaSnapshotSource({
  quotaSource = createQuotaSource(),
  now = () => Date.now(),
  ttlMs = QUOTA_SNAPSHOT_TTL_MS,
  scanTimeoutMs = QUOTA_SNAPSHOT_SCAN_TIMEOUT_MS,
} = {}) {
  let latestArgs = { dir: null, staleSec: DEFAULT_QUOTA_STALE_SEC, extra: {} }
  const cache = createScanCache({
    ttlMs,
    scanTimeoutMs,
    now,
    scan: async (_key, progress) => {
      progress.items.push(await quotaSource.get(latestArgs.dir, latestArgs.staleSec, latestArgs.extra))
    },
  })

  /**
   * Never blocks on disk: resolves to the last snapshot (or a `pending` row
   * before the first scan has ever completed) while bounded-scan.js keeps a
   * single background scan refreshing it.
   */
  async function get(dir, staleSec, extra = {}) {
    latestArgs = { dir, staleSec, extra }
    const r = await cache.get('quota', { deadlineMs: 0 })
    if (!r.items.length) {
      const checkedAt = new Date(now()).toISOString()
      return {
        ok: false, notConnected: false, checkedAt, lastOkAt: null,
        error: r.partialReason ? `quota scan ${r.partialReason}` : 'quota reading in progress', data: null, pending: true,
      }
    }
    return r.items[0]
  }

  return { get }
}
