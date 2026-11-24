/**
 * Pool choice for a car — pure (no IO). Inputs are the per-pool quota rows
 * server/command-center-quota.js already produces (mapQuotaReading shape:
 * { pool, ageSec, error, windows: [{ key: '5h'|'7d', pct, resetAt }] }) and
 * how many cars each pool is running right now (from the cars export).
 *
 * Rules (the dispatcher's standing rules, written down once here):
 *   1. A pool with no error-free reading younger than maxReadingAgeSec is
 *      never picked blind.
 *   2. Secretary pools (`secretary: true`) are skipped unless the form asks
 *      for one explicitly and says it may (`allowSecretaryPool`).
 *   3. Capped: 7-day ≥ weeklyCapPct, or 5-hour ≥ fiveHourCapPct → out —
 *      except pools with paid overage (`overage: true`): their cars keep
 *      running past the cap, the cost is accepted.
 *   4. Heavy cars (effort max / xhigh, or `heavy: true`) don't stack: a
 *      non-overage pool whose 5-hour is ≥ heavyFiveHourPct with more than
 *      heavyResetGraceMin minutes to its 5-hour reset is out, and any pool
 *      already running ≥ heavyMaxCars cars is out.
 *   5. Order: the 7-day window that resets soonest first (quota left in a
 *      pool that resets tomorrow is lost tomorrow), then fewer running cars,
 *      then the lower 5-hour reading.
 */

export const DEFAULT_POOL_RULES = Object.freeze({
  weeklyCapPct: 97,
  fiveHourCapPct: 90,
  heavyFiveHourPct: 60,
  heavyResetGraceMin: 15,
  heavyMaxCars: 3,
  // the usage snapshot is written every ~30 min, so the dashboard's 15-min
  // "stale" label is too strict to pick by; older than this = blind
  maxReadingAgeSec: 45 * 60,
})

/** "2026-11-23 17:44" Beijing time. */
export function bjtStamp(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function windowOf(row, key) {
  return (row?.windows || []).find((w) => w.key === key) || null
}

function fmtPct(w) {
  return w?.pct == null ? '?' : `${w.pct}%`
}

/**
 * One pool → { pool, ok, why, sortKey }. `why` is a plain sentence either
 * way (shown in --dry-run as the pick reason / the rejection).
 */
export function judgePool(name, poolCfg, row, { running = 0, heavy = false, nowMs, rules = DEFAULT_POOL_RULES, explicit = false, allowSecretaryPool = false } = {}) {
  const r = { ...DEFAULT_POOL_RULES, ...rules }
  const out = (ok, why) => ({ pool: name, ok, why, running, sortKey: null })
  if (!poolCfg) return out(false, `池 ${name} 不在本地配置的池表里`)
  if (poolCfg.secretary && !(explicit && allowSecretaryPool)) return out(false, `${name} 是秘书自己的池，默认不派`)
  if (!row) return out(false, `${name} 没有额度读数，不盲派`)
  if (row.error) return out(false, `${name} 额度读数出错：${row.error}`)
  if (!(row.ageSec != null && row.ageSec <= r.maxReadingAgeSec)) return out(false, `${name} 额度读数过旧（${row.ageSec ?? '?'} 秒前，上限 ${r.maxReadingAgeSec} 秒），不盲派`)
  const w5 = windowOf(row, '5h')
  const w7 = windowOf(row, '7d')
  const overage = !!poolCfg.overage
  if (w7?.pct != null && w7.pct >= r.weeklyCapPct && !overage) return out(false, `${name} 周额度 ${fmtPct(w7)} 撞顶（≥${r.weeklyCapPct}%）`)
  if (w5?.pct != null && w5.pct >= r.fiveHourCapPct && !overage) return out(false, `${name} 5 小时额度 ${fmtPct(w5)} 撞顶（≥${r.fiveHourCapPct}%）`)
  if (heavy) {
    const resetMin = w5?.resetAt ? (Date.parse(w5.resetAt) - nowMs) / 60000 : Infinity
    if (!overage && w5?.pct != null && w5.pct >= r.heavyFiveHourPct && resetMin > r.heavyResetGraceMin) {
      return out(false, `${name} 5 小时已 ${fmtPct(w5)}、离重置还有 ${Math.round(resetMin)} 分钟，不叠重活`)
    }
    if (running >= r.heavyMaxCars) return out(false, `${name} 已有 ${running} 辆车在跑，不叠重活`)
  }
  const reset7 = w7?.resetAt ? Date.parse(w7.resetAt) : Infinity
  const res = out(true, `${name}：周额度 ${fmtPct(w7)}、${w7?.resetAt ? `${bjtStamp(Date.parse(w7.resetAt))} 重置` : '重置时间未知'}；5 小时 ${fmtPct(w5)}；在跑 ${running} 辆${overage ? '；开着付费超额' : ''}`)
  res.sortKey = [reset7, running, w5?.pct ?? 100]
  return res
}

function cmpKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/**
 * pools       = { T1: { configDir, overage?, secretary?, ... }, ... } (local config)
 * quotaRows   = mapQuotaReading rows
 * runningByPool = { T1: 2, ... }
 * requested   = pool name from the form, or null (auto)
 * → { pool, why, considered: [judgePool results] } or { pool: null, error, considered }.
 */
export function pickPool({ pools, quotaRows, runningByPool = {}, heavy = false, nowMs, rules, requested = null, allowSecretaryPool = false }) {
  const rows = new Map((quotaRows || []).map((r) => [r.pool, r]))
  const judge = (name, explicit) => judgePool(name, pools[name], rows.get(name), {
    running: runningByPool[name] || 0, heavy, nowMs, rules, explicit, allowSecretaryPool,
  })
  if (requested) {
    const j = judge(requested, true)
    return j.ok ? { pool: requested, why: `表里指定 ${j.why}`, considered: [j] } : { pool: null, error: j.why, considered: [j] }
  }
  const considered = Object.keys(pools).sort().map((n) => judge(n, false))
  const ok = considered.filter((j) => j.ok).sort((a, b) => cmpKeys(a.sortKey, b.sortKey))
  if (!ok.length) return { pool: null, error: '没有可派的池（每个池的原因见下）', considered }
  return { pool: ok[0].pool, why: `自动选池（周额度最早重置优先）→ ${ok[0].why}`, considered }
}
