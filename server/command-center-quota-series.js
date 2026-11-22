/**
 * Command Center — six-pool available-quota curve (owner 11-22: "六个 team
 * 画成总曲线，重置了就会有那么个尖峰", for judging how hard to dispatch).
 *
 * Source: the same usage_snap.log the per-pool quota block already reads
 * (command-center-quota.js parseUsageSnapLine — one parser, reused here; the
 * log is only ever read). Rules (same as the G4q prototype's
 * tools/build_quota_series.py so prototype and product agree):
 *   - time axis = union of every snapshot time in the last `days` days;
 *   - per pool, a time with no parsable line (error / logged-out rows, gaps)
 *     carries the pool's previous value forward;
 *   - main line = Σ pools' 7-day remaining / 100 ("how many full pools are
 *     left", 0 … pool count); thin line = Σ 5-hour remaining / 100;
 *   - a pool's 7-day used % falling by ≥ dropPp between two of its readings is
 *     one observed weekly reset (the spike);
 *   - upcoming resets = each pool's latest reading's reset5h / reset7d that
 *     fall inside (now, now + days]; the expected gain = what that window has
 *     used now.
 *
 * buildQuotaSeries is pure; createQuotaSeriesSource does the (read-only) IO.
 */
import { stat } from 'node:fs/promises'
import { parseUsageSnapLine, parseReadingTime } from './command-center-quota.js'
import { readTailLines } from '../terminal/bounded-scan.js'

export const QUOTA_SERIES_DAYS = 7
export const RESET_DROP_PP = 15
// ~6 pools × 48 lines/day × 8 days × ~160 B ≈ 370 KB; read a bit more.
const SERIES_TAIL_BYTES = 1024 * 1024
const DAY_MS = 86400_000

function remain(util) {
  return typeof util === 'number' && Number.isFinite(util) ? Math.round((100 - util * 100) * 10) / 10 : null
}

function sumPools(values) {
  const known = values.filter((v) => v != null)
  return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / 100) * 1000) / 1000 : null
}

/**
 * readings: [{ pool, raw }] as parseUsageSnapLine returns them (any order).
 * → { from, to, days, pools, points, resets, upcoming, latest }
 * Times are ISO strings; `points[i].pools[P] = { r7, r5 }` (remaining %).
 */
export function buildQuotaSeries(readings, { nowMs, days = QUOTA_SERIES_DAYS, dropPp = RESET_DROP_PP } = {}) {
  if (!Number.isFinite(nowMs)) throw new Error('buildQuotaSeries: nowMs must be a number')
  const fromMs = nowMs - days * DAY_MS
  const byPool = new Map()
  for (const r of readings || []) {
    if (!r || !r.pool || !r.raw) continue
    const t = parseReadingTime(r.raw.fetched_at)
    if (t == null || t < fromMs || t > nowMs) continue
    if (!byPool.has(r.pool)) byPool.set(r.pool, [])
    byPool.get(r.pool).push({ t, raw: r.raw })
  }
  const pools = [...byPool.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  for (const p of pools) byPool.get(p).sort((a, b) => a.t - b.t)
  const times = [...new Set(pools.flatMap((p) => byPool.get(p).map((x) => x.t)))].sort((a, b) => a - b)

  const cursor = new Map(pools.map((p) => [p, 0]))
  const cur = new Map(pools.map((p) => [p, { r7: null, r5: null }]))
  const resets = []
  const points = times.map((t) => {
    for (const p of pools) {
      const rows = byPool.get(p)
      let i = cursor.get(p)
      while (i < rows.length && rows[i].t <= t) {
        const prev = cur.get(p)
        const r7 = remain(rows[i].raw.util_7d)
        const r5 = remain(rows[i].raw.util_5h)
        // remaining jumps up by ≥ dropPp ⇔ used % fell by ≥ dropPp → weekly reset
        if (prev.r7 != null && r7 != null && r7 - prev.r7 >= dropPp) {
          resets.push({ t: new Date(rows[i].t).toISOString(), pool: p, beforeR7: prev.r7, afterR7: r7 })
        }
        cur.set(p, { r7: r7 ?? prev.r7, r5: r5 ?? prev.r5 })
        i++
      }
      cursor.set(p, i)
    }
    const snap = Object.fromEntries(pools.map((p) => [p, { ...cur.get(p) }]))
    return {
      t: new Date(t).toISOString(),
      total7d: sumPools(pools.map((p) => snap[p].r7)),
      total5h: sumPools(pools.map((p) => snap[p].r5)),
      counted: pools.filter((p) => snap[p].r7 != null).length,
      pools: snap,
    }
  })

  const upcoming = []
  const latest = {}
  for (const p of pools) {
    const rows = byPool.get(p)
    const last = rows[rows.length - 1]
    latest[p] = { fetchedAt: new Date(last.t).toISOString(), r7: remain(last.raw.util_7d), r5: remain(last.raw.util_5h) }
    for (const [kind, resetKey, utilKey] of [['7d', 'reset_7d_bjt', 'util_7d'], ['5h', 'reset_5h_bjt', 'util_5h']]) {
      const at = parseReadingTime(last.raw[resetKey])
      if (at == null || at <= nowMs || at > nowMs + days * DAY_MS) continue
      const used = last.raw[utilKey]
      upcoming.push({ pool: p, kind, at: new Date(at).toISOString(), gainPct: typeof used === 'number' ? Math.round(used * 1000) / 10 : null })
    }
  }
  upcoming.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    days,
    dropPp,
    pools,
    points,
    resets,
    upcoming,
    latest,
  }
}

/**
 * Read-only log reader; re-parses only when the log's mtime changes.
 * get(path) → { ok, checkedAt, error, data }.
 */
export function createQuotaSeriesSource({ now = () => Date.now() } = {}) {
  let cache = null // { path, mtimeMs, readings }
  return {
    async get(path) {
      const nowMs = now()
      const checkedAt = new Date(nowMs).toISOString()
      if (!path) return { ok: false, checkedAt, error: 'quota.usageSnapLogPath not configured', data: null }
      let st
      try { st = await stat(path) } catch (err) {
        return { ok: false, checkedAt, error: `usage snapshot log unreadable: ${err.code || err.message}`, data: null }
      }
      if (!cache || cache.path !== path || cache.mtimeMs !== st.mtimeMs) {
        const { lines, ok } = await readTailLines(path, SERIES_TAIL_BYTES)
        if (!ok) return { ok: false, checkedAt, error: 'usage snapshot log unreadable', data: null }
        const readings = []
        for (const line of lines) {
          const r = parseUsageSnapLine(line, nowMs)
          if (r) readings.push(r)
        }
        cache = { path, mtimeMs: st.mtimeMs, readings }
      }
      const data = buildQuotaSeries(cache.readings, { nowMs })
      if (!data.points.length) return { ok: false, checkedAt, error: `no usage snapshot in the last ${QUOTA_SERIES_DAYS} days`, data: null }
      return { ok: true, checkedAt, error: null, data }
    },
  }
}
