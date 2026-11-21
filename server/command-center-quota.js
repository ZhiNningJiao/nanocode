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
 * mapQuotaReading / buildQuotaView are pure; createQuotaSource does the IO.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { str } from './command-center-fields.js'

export const DEFAULT_QUOTA_STALE_SEC = 15 * 60
const TIGHTEST_SHOWN = 2

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

/** One cache file's JSON → one pool row. `name` = file name (fallback pool id). */
export function mapQuotaReading(raw, { name, nowMs, staleSec = DEFAULT_QUOTA_STALE_SEC }) {
  const pool = str(raw?.pool) || name.replace(/\.json$/, '')
  const fetchedMs = parseReadingTime(raw?.fetched_at)
  const ageSec = fetchedMs != null ? Math.max(0, Math.round((nowMs - fetchedMs) / 1000)) : null
  const error = str(raw?.error)
  let loggedIn = null // unknown
  if (error && LOGGED_OUT_RX.test(error)) loggedIn = false
  else if (!error && fetchedMs != null && str(raw?.status)) loggedIn = true
  return {
    pool,
    source: 'official_headers',
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
 * directory makes the whole block "unreachable + last success".
 */
export function createQuotaSource({ now = () => Date.now() } = {}) {
  const files = new Map() // name -> { mtimeMs, raw | parseError }
  let lastOkAt = null
  return {
    async get(dir, staleSec) {
      const nowMs = now()
      const checkedAt = new Date(nowMs).toISOString()
      if (!dir) return { ok: false, notConnected: true, checkedAt, lastOkAt, error: 'quota.dir not configured', data: null }
      let names
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()
      } catch (err) {
        return { ok: false, notConnected: false, checkedAt, lastOkAt, error: `quota dir unreadable: ${err.code || err.message}`, data: null }
      }
      const pools = []
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
            pools.push({ pool: name.replace(/\.json$/, ''), source: 'official_headers', fetchedAt: null, ageSec: null, stale: true, loggedIn: null, status: null, overage: null, error: `reading file is not valid JSON: ${f.parseError}`, windows: [] })
          } else {
            pools.push(mapQuotaReading(f.raw, { name, nowMs, staleSec }))
          }
        } catch { /* removed between readdir and stat */ }
      }
      for (const k of [...files.keys()]) if (!names.includes(k)) files.delete(k)
      lastOkAt = checkedAt
      return { ok: true, notConnected: false, checkedAt, lastOkAt, error: null, data: buildQuotaView(pools) }
    },
  }
}
