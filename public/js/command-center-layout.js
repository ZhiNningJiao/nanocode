/**
 * Command Center gantt layout — the ONLY place bar / point / tick coordinates
 * are computed. DOM-free so it is unit-tested in node.
 *
 * Design constraints borrowed from langfuse's timeline `layout()`
 * (web/src/features/traces/fns/timeline/layout.ts, MIT) — idea only, no code
 * copied:
 *   1. the plot width is an explicit input (no hidden default width);
 *   2. zero-length bars and open-ended bars still get finite coordinates,
 *      never NaN / Infinity;
 *   3. everything is clamped into [0, width]; a bar entirely outside the
 *      window is marked `offscreen` instead of forcing horizontal scroll.
 */

const MIN_BAR_PX = 3
const MIN_TICK_GAP_PX = 64
const TICK_STEPS_MIN = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880]

function ms(iso) {
  if (iso == null) return NaN
  const v = typeof iso === 'number' ? iso : Date.parse(iso)
  return Number.isFinite(v) ? v : NaN
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

/**
 * Smallest time window covering the given rows (start → latest end / now),
 * padded 2% each side; falls back to the last hour when nothing is datable.
 */
export function ganttWindow(rows, now) {
  const nowMs = ms(now)
  let lo = Infinity
  let hi = -Infinity
  for (const r of rows) {
    const s = ms(r.start)
    if (!Number.isFinite(s)) continue
    const e = r.endOpen ? nowMs : ms(r.end)
    lo = Math.min(lo, s)
    hi = Math.max(hi, Number.isFinite(e) ? e : s)
  }
  if (!Number.isFinite(lo)) return { from: nowMs - 3600_000, to: nowMs }
  if (hi - lo < 60_000) hi = lo + 60_000
  const pad = (hi - lo) * 0.02
  return { from: lo - pad, to: hi + pad }
}

/**
 * rows: [{ id, start, end, endOpen, points: [{ t, kind }] }]
 * opts: { width (px, required), from, to (ms or ISO), now (ms or ISO) }
 * → { width, from, to, nowX, ticks: [{ x, t }], rows: [{ id, invalid, offscreen, x, w, open, points: [{ x, t, kind, label }] }] }
 */
export function layoutGantt(rows, { width, from, to, now } = {}) {
  if (!Number.isFinite(width) || width <= 0) throw new Error('layoutGantt: width must be a positive number')
  const f = ms(from)
  let tt = ms(to)
  const nowMs = ms(now)
  if (!Number.isFinite(f) || !Number.isFinite(tt)) throw new Error('layoutGantt: from/to must be valid times')
  if (tt <= f) tt = f + 60_000
  const span = tt - f
  const xOf = (t) => ((t - f) / span) * width

  const outRows = rows.map((r) => {
    const s = ms(r.start)
    if (!Number.isFinite(s)) return { id: r.id, invalid: true, offscreen: false, x: 0, w: 0, open: false, points: [] }
    let e = r.endOpen ? nowMs : ms(r.end)
    if (!Number.isFinite(e) || e < s) e = s
    const rawX0 = xOf(s)
    const rawX1 = xOf(e)
    const offscreen = rawX1 < 0 || rawX0 > width
    const x0 = clamp(rawX0, 0, width)
    const x1 = clamp(rawX1, 0, width)
    let w = Math.max(x1 - x0, MIN_BAR_PX)
    const x = Math.min(x0, width - w < 0 ? 0 : width - w)
    if (x + w > width) w = Math.max(0, width - x)
    const points = (r.points || [])
      .map((p) => ({ t: p.t, kind: p.kind, label: p.label, raw: ms(p.t) }))
      .filter((p) => Number.isFinite(p.raw) && p.raw >= f && p.raw <= tt)
      .map((p) => ({ x: clamp(xOf(p.raw), 0, width), t: p.t, kind: p.kind, label: p.label }))
    return { id: r.id, invalid: false, offscreen, x, w, open: !!r.endOpen, points }
  })

  const maxTicks = Math.max(1, Math.floor(width / MIN_TICK_GAP_PX))
  const stepMin = TICK_STEPS_MIN.find((m) => span / (m * 60_000) <= maxTicks) || TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1]
  const stepMs = stepMin * 60_000
  // Align ticks to local wall-clock multiples of the step.
  const tzOffsetMs = new Date(f).getTimezoneOffset() * 60_000
  let t0 = Math.ceil((f - tzOffsetMs) / stepMs) * stepMs + tzOffsetMs
  const ticks = []
  for (; t0 <= tt && ticks.length <= maxTicks + 1; t0 += stepMs) ticks.push({ x: xOf(t0), t: t0 })

  const nowX = Number.isFinite(nowMs) && nowMs >= f && nowMs <= tt ? xOf(nowMs) : null
  return { width, from: f, to: tt, nowX, stepMin, ticks, rows: outRows }
}
