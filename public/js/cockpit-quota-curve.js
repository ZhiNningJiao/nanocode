/**
 * Six-pool available-quota curve (owner 11-22: one total curve over all pools,
 * a spike where a pool resets — for judging how hard to dispatch). Quota is a
 * resource on the home page, never its main piece: a card in the top-right
 * corner (colour only when it runs low); the 额度 page shows the same curve
 * large with a hover read-out, next to the per-pool detail.
 *
 * Data: GET /api/command-center/quota/series (server/command-center-quota-series.js).
 * layoutQuotaCurve is the ONLY place curve coordinates are computed (pure,
 * unit-tested in node); quotaCurveSvg / quotaCardHtml only print them.
 */
import { t } from './i18n.js'
import { esc, fmtTime } from './command-center-format.js'

const DAY_MS = 86400_000
/** Remaining share of all pools (Σ 7-day remaining / pool count) below which the card turns warn / crit. */
export const QUOTA_WARN_SHARE = 0.25
export const QUOTA_CRIT_SHARE = 0.1

export function quotaLevel(total, poolCount) {
  if (total == null || !poolCount) return 'none'
  const share = total / poolCount
  return share < QUOTA_CRIT_SHARE ? 'crit' : share < QUOTA_WARN_SHARE ? 'warn' : 'ok'
}

function pathOf(pts) {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
}

/**
 * series (endpoint body) → geometry for a width × height plot.
 * x: series.from … series.to + futureDays (now sits where the past ends);
 * y: 0 … pool count ("full pools"), top padding `pad`.
 * → { width, height, poolCount, nowX, totalNow, total5hNow, level, line7, line5,
 *     xs: [x per point], spikes: [{ x, y, pool, t }], future: { path, marks: [{ x, y, pool, kind, at, gainPct }] },
 *     ticks: [{ x, t }] }
 */
export function layoutQuotaCurve(series, { width, height, futureDays = 7, pad = 6 } = {}) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error('layoutQuotaCurve: width/height must be positive numbers')
  const from = Date.parse(series?.from)
  const nowMs = Date.parse(series?.to)
  if (!Number.isFinite(from) || !Number.isFinite(nowMs) || nowMs <= from) throw new Error('layoutQuotaCurve: series.from/to must be valid times')
  const to = nowMs + futureDays * DAY_MS
  const poolCount = Math.max(1, (series.pools || []).length)
  const xOf = (ms) => ((ms - from) / (to - from)) * width
  const yOf = (v) => height - pad - (Math.max(0, Math.min(poolCount, v)) / poolCount) * (height - 2 * pad)
  const points = (series.points || []).filter((p) => Number.isFinite(Date.parse(p.t)))
  const xs = points.map((p) => xOf(Date.parse(p.t)))
  const line = (key) => pathOf(points.map((p, i) => (p[key] == null ? null : { x: xs[i], y: yOf(p[key]) })).filter(Boolean))
  const last = points[points.length - 1] || null
  const totalNow = last ? last.total7d : null
  const total5hNow = last ? last.total5h : null
  const nowX = xOf(nowMs)

  const spikes = (series.resets || []).map((r) => {
    const ms = Date.parse(r.t)
    const i = points.findIndex((p) => Date.parse(p.t) >= ms)
    const v = i >= 0 ? points[i].total7d : totalNow
    return { x: xOf(ms), y: yOf(v ?? 0), pool: r.pool, t: r.t }
  }).filter((s) => s.x >= 0 && s.x <= width)

  // future: the 7-day total stepping up at each pool's next weekly reset by
  // what that pool has used now (consumption until then is not guessed).
  const marks = []
  const steps = totalNow == null ? [] : [{ x: nowX, y: yOf(totalNow) }]
  let level = totalNow ?? 0
  for (const u of series.upcoming || []) {
    const ms = Date.parse(u.at)
    if (!Number.isFinite(ms) || ms <= nowMs || ms > to) continue
    if (u.kind === '7d' && totalNow != null) {
      const x = xOf(ms)
      steps.push({ x, y: yOf(level) })
      level += (u.gainPct ?? 0) / 100
      steps.push({ x, y: yOf(level) })
      marks.push({ x, y: yOf(level), pool: u.pool, kind: u.kind, at: u.at, gainPct: u.gainPct })
    } else if (u.kind === '5h') {
      marks.push({ x: xOf(ms), y: height - pad, pool: u.pool, kind: u.kind, at: u.at, gainPct: u.gainPct })
    }
  }
  if (steps.length) steps.push({ x: width, y: yOf(level) })

  const ticks = []
  const d0 = new Date(from)
  d0.setHours(0, 0, 0, 0)
  for (let ms = d0.getTime() + DAY_MS; ms < to; ms += DAY_MS) ticks.push({ x: xOf(ms), t: new Date(ms).toISOString() })

  return {
    width, height, poolCount, nowX, totalNow, total5hNow,
    level: quotaLevel(totalNow, poolCount),
    line7: line('total7d'), line5: line('total5h'), xs,
    spikes, future: { path: pathOf(steps), marks }, ticks,
  }
}

function fmtPools(v) { return v == null ? '—' : v.toFixed(1) }

function md(iso) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}

/** The curve as SVG. `big` adds day labels, pool-name labels at spikes / next resets, 5h reset ticks and the hover cursor (the card keeps dots + tooltips). */
export function quotaCurveSvg(lay, { big = false } = {}) {
  const { width: w, height: h } = lay
  const ticks = lay.ticks.map((tk) => `<line class="ck-qc-grid" x1="${tk.x.toFixed(1)}" x2="${tk.x.toFixed(1)}" y1="0" y2="${h}"/>${big ? `<text class="ck-qc-day" x="${(tk.x + 3).toFixed(1)}" y="${h - 3}">${esc(md(tk.t))}</text>` : ''}`).join('')
  const spikes = lay.spikes.map((s) => `<g class="ck-qc-spike"><circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${big ? 4 : 3}"><title>${esc(`${fmtTime(s.t)} ${t('cockpit.q.reset', s.pool)}`)}</title></circle>${big ? `<text x="${s.x.toFixed(1)}" y="${Math.max(10, s.y - 6).toFixed(1)}">${esc(t('cockpit.q.reset', s.pool))}</text>` : ''}</g>`).join('')
  const marks = lay.future.marks.filter((m) => big || m.kind === '7d').map((m) => m.kind === '7d'
    ? `<g class="ck-qc-next"><circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${big ? 3.5 : 2.5}"><title>${esc(`${fmtTime(m.at)} ${t('cockpit.q.nextReset', m.pool, m.gainPct)}`)}</title></circle>${big ? `<text x="${m.x.toFixed(1)}" y="${Math.max(10, m.y - 6).toFixed(1)}">${esc(m.pool)}</text>` : ''}</g>`
    : `<line class="ck-qc-5h" x1="${m.x.toFixed(1)}" x2="${m.x.toFixed(1)}" y1="${h - 9}" y2="${h}"><title>${esc(`${fmtTime(m.at)} ${m.pool} ${t('cockpit.q.reset5h')}`)}</title></line>`).join('')
  return `<svg class="ck-qc${big ? ' ck-qc-big' : ''}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(t('cockpit.q.title'))}">
    ${ticks}
    <path class="ck-qc-l5" d="${lay.line5}"/>
    <path class="ck-qc-l7" d="${lay.line7}" pathLength="1"/>
    <path class="ck-qc-fut" d="${lay.future.path}"/>
    ${spikes}${marks}
    <line class="ck-qc-now" x1="${lay.nowX.toFixed(1)}" x2="${lay.nowX.toFixed(1)}" y1="0" y2="${h}"/>
    ${big ? '<line class="ck-qc-cursor" x1="0" x2="0" y1="0" y2="' + h + '" visibility="hidden"/>' : ''}
  </svg>`
}

/** Top-right home card (a button → the 额度 page). `res` = endpoint body. */
export function quotaCardHtml(res, width) {
  const head = `<span class="ck-qcard-title">${esc(t('cockpit.q.title'))}</span>`
  if (!res) return `<div class="ck-qcard-head">${head}<b>…</b></div>`
  if (!res.configured || !res.source?.ok) {
    return `<div class="ck-qcard-head">${head}</div><div class="ck-qcard-down">${esc(t('cockpit.q.down'))}<div class="cc-sub">${esc(res.error || res.source?.error || '')}</div></div>`
  }
  const lay = layoutQuotaCurve(res, { width, height: 58 })
  const next = lay.future.marks.find((m) => m.kind === '7d')
  return `<div class="ck-qcard-head">${head}<b class="ck-qcard-num" data-count="${lay.totalNow ?? ''}">${fmtPools(lay.totalNow)}</b><span class="ck-qcard-unit">/ ${lay.poolCount} ${esc(t('cockpit.q.pools'))}</span></div>
    ${quotaCurveSvg(lay)}
    <div class="ck-qcard-foot"><span>${esc(t('cockpit.q.fiveh'))} ${fmtPools(lay.total5hNow)}</span>${next ? `<span>${esc(t('cockpit.q.next'))} ${esc(next.pool)} ${esc(fmtTime(next.at))} +${next.gainPct ?? '?'}%</span>` : ''}</div>`
}

/** Hover read-out on the big chart: nearest snapshot to x → HTML (T1–T6 remaining). */
export function quotaHoverHtml(res, lay, x) {
  const pts = res.points || []
  if (!pts.length || x > lay.nowX + 4) return null
  let best = 0
  for (let i = 1; i < lay.xs.length; i++) if (Math.abs(lay.xs[i] - x) < Math.abs(lay.xs[best] - x)) best = i
  const p = pts[best]
  const rows = (res.pools || []).map((pool) => {
    const v = p.pools?.[pool] || {}
    return `<tr><td>${esc(pool)}</td><td>${v.r7 == null ? '—' : `${v.r7}%`}</td><td>${v.r5 == null ? '—' : `${v.r5}%`}</td></tr>`
  }).join('')
  return { x: lay.xs[best], html: `<div class="ck-qtip-t">${esc(fmtTime(p.t))} · ${esc(t('cockpit.q.total'))} ${fmtPools(p.total7d)}</div><table><tr><th></th><th>${esc(t('cockpit.q.r7'))}</th><th>${esc(t('cockpit.q.r5'))}</th></tr>${rows}</table>` }
}
