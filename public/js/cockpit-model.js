/**
 * Cockpit (指挥舱主布局) model — DOM-free, unit-tested in node.
 *
 *  - the module registry: each cockpit module IS one existing plugin, so the
 *    plugin's enabled flag is the module's only on/off switch (no second flag);
 *  - the layout setting stored on the server (`cockpit_layout`: order + off),
 *    normalised here (unknown ids dropped, new modules appended, never throws);
 *  - per-device UI memory (main view = cockpit | workspace, cockpit view =
 *    list | gantt | graph) normalisation;
 *  - swimlane rows for the gantt view (one lane per big event, cars folded);
 *  - node-graph coordinates (event = big node with progress ring, cars =
 *    satellites);
 *  - the plain-text "quote into chat" line for an event / a car.
 */

/** Cockpit modules in default order. `area` decides where the cockpit puts it. */
export const COCKPIT_MODULES = [
  { id: 'events', plugin: 'command-center', area: 'main' },
  { id: 'waiting', plugin: 'cc-waiting', area: 'side' },
  { id: 'quota', plugin: 'cc-quota', area: 'side' },
  { id: 'machines', plugin: 'machines', area: 'side' },
  { id: 'chat', plugin: 'cc-chat', area: 'float' },
]
export const COCKPIT_SETTING_KEY = 'cockpit_layout'
export const COCKPIT_VIEWS = ['list', 'gantt', 'graph']
export const MAIN_VIEWS = ['cockpit', 'workspace']
/** Gantt time window choices (hours; 0 = everything in the export). */
export const GANTT_SPANS = [24, 72, 0]
export function normalizeSpan(v) {
  if (v == null || v === '') return 24
  const n = Number(v)
  return GANTT_SPANS.includes(n) ? n : 24
}

/**
 * Gantt window: the rows' own window, cut to the last `spanHours` (0 = no cut).
 * Bars older than the cut are marked offscreen by layoutGantt, not squeezed.
 */
export function spanWindow(win, now, spanHours) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  if (!spanHours) return win
  const from = Math.max(win.from, nowMs - spanHours * 3600_000)
  const to = Math.max(win.to, nowMs)
  return { from, to: to > from ? to : from + 60_000 }
}

const IDS = COCKPIT_MODULES.map((m) => m.id)

export function moduleById(id) { return COCKPIT_MODULES.find((m) => m.id === id) || null }
export function moduleByPlugin(name) { return COCKPIT_MODULES.find((m) => m.plugin === name) || null }

/**
 * Server setting → { order: [all ids, user order first], off: [ids], seeded }.
 * `seeded` is false when nothing was ever saved (first run: every module on).
 */
export function normalizeLayout(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const seen = new Set()
  const order = []
  for (const id of Array.isArray(src.order) ? src.order : []) {
    if (typeof id === 'string' && IDS.includes(id) && !seen.has(id)) { seen.add(id); order.push(id) }
  }
  for (const id of IDS) if (!seen.has(id)) order.push(id)
  const off = [...new Set((Array.isArray(src.off) ? src.off : []).filter((id) => IDS.includes(id)))]
  return { order, off, seeded: src.v === 1 }
}

/** What goes back to the server (always versioned so `seeded` is true next time). */
export function serializeLayout(layout) {
  return { v: 1, order: [...layout.order], off: [...layout.off] }
}

export function isModuleOn(layout, id) { return !layout.off.includes(id) }

export function setModuleOn(layout, id, on) {
  if (!IDS.includes(id)) return layout
  const off = layout.off.filter((x) => x !== id)
  if (!on) off.push(id)
  return { ...layout, off }
}

/** Move a module one step up (delta -1) or down (+1); out-of-range moves are no-ops. */
export function moveModule(layout, id, delta) {
  const i = layout.order.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= layout.order.length) return layout
  const order = [...layout.order]
  ;[order[i], order[j]] = [order[j], order[i]]
  return { ...layout, order }
}

/** Ordered modules of one area that are on. */
export function modulesIn(layout, area) {
  return layout.order.map(moduleById).filter((m) => m && m.area === area && isModuleOn(layout, m.id))
}

export function normalizeView(v) { return COCKPIT_VIEWS.includes(v) ? v : 'list' }
export function normalizeMainView(v) { return MAIN_VIEWS.includes(v) ? v : 'cockpit' }

// ─── big events ─────────────────────────────────────────────────────────────

// 'running' is the expected steady state of a healthy event, not an attention
// state — including it here used to auto-expand almost every event (most big
// events have a car running most of the time), turning the main view into a
// wall of car rows. Only states that actually need a human's eyes start open.
const ATTENTION_STATES = new Set(['waiting_human', 'blocked', 'failed', 'timeout'])

/** PRD §6.1: an event that is all green and nobody waits on starts folded. */
export function startsExpanded(e) {
  return !!(e && (e.waitingCount > 0 || ATTENTION_STATES.has(e.state)))
}

/** Events + the "unassigned" group (only when it has cars or the car source is down). */
export function eventGroups(data) {
  if (!data || !Array.isArray(data.events)) return []
  const out = [...data.events]
  const un = data.unassigned
  if (un && ((un.cars && un.cars.length) || !data.sources?.cars?.ok)) out.push({ ...un, key: '_none', unassigned: true })
  return out
}

/**
 * Gantt swimlanes: one lane per event; its summary bar spans first car start →
 * last car end (open if any car is still open) with every car milestone as a
 * point; the cars are the lane's child rows (shown only when expanded).
 * `expanded(key, event)` decides folding.
 */
export function buildSwimlanes(data, expanded) {
  return eventGroups(data).map((e) => {
    const cars = Array.isArray(e.cars) ? e.cars : []
    let start = null
    let end = null
    let endOpen = false
    let startMs = Infinity
    let endMs = -Infinity
    const points = []
    for (const c of cars) {
      const s = Date.parse(c.start)
      if (Number.isFinite(s) && s < startMs) { startMs = s; start = c.start }
      if (c.endOpen) endOpen = true
      const en = Date.parse(c.end)
      if (Number.isFinite(en) && en > endMs) { endMs = en; end = c.end }
      for (const p of c.points || []) points.push({ ...p, label: `${c.car} · ${p.label || ''}` })
    }
    return {
      key: e.key,
      event: e,
      unassigned: !!e.unassigned,
      summary: { id: e.key, start, end: end || start, endOpen, points },
      cars,
      expanded: !!expanded(e.key, e),
    }
  })
}

/** Flatten lanes into the row list layoutGantt() takes (summary rows + visible car rows). */
export function swimlaneRows(lanes) {
  const rows = []
  for (const lane of lanes) {
    rows.push({ kind: 'lane', lane, ...lane.summary })
    if (!lane.expanded) continue
    for (const c of lane.cars) rows.push({ kind: 'car', lane, car: c, id: c.traceId, start: c.start, end: c.end, endOpen: c.endOpen, points: c.points })
  }
  return rows
}

// ─── node graph ─────────────────────────────────────────────────────────────

const LABEL_ROOM_PX = 34
const CAR_STATE_ORDER = ['waiting_human', 'blocked', 'failed', 'timeout', 'running', 'queued', 'unknown', 'delivered', 'done']

/**
 * Node-graph coordinates. Events sit on a grid of cells; each event is a big
 * node with its cars as satellites on a ring around it (the most urgent
 * states first). At most `maxSatellites` cars are drawn; the rest is counted.
 * Every coordinate is finite and inside [0, width] × [0, height].
 */
export function layoutGraph(groups, { width, cell = 220, maxSatellites = 16 } = {}) {
  if (!Number.isFinite(width) || width <= 0) throw new Error('layoutGraph: width must be a positive number')
  const cols = Math.max(1, Math.floor(width / cell))
  const cw = width / cols
  const ch = cell + LABEL_ROOM_PX // room under the satellite ring for the title line
  const r = Math.max(18, Math.min(cw, cell) * 0.16)
  const ring = Math.min(cw, cell) * 0.34
  const nodes = groups.map((e, i) => {
    const cx = cw * (i % cols) + cw / 2
    const cy = ch * Math.floor(i / cols) + cell / 2
    const cars = [...(Array.isArray(e.cars) ? e.cars : [])]
      .sort((a, b) => rank(a.state) - rank(b.state))
    const shown = cars.slice(0, maxSatellites)
    const sats = shown.map((c, k) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * k) / Math.max(shown.length, 1)
      return { car: c, x: cx + ring * Math.cos(ang), y: cy + ring * Math.sin(ang) }
    })
    const p = e.progress
    const frac = p && p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : null
    return { event: e, x: cx, y: cy, r, ring, progress: frac, satellites: sats, hidden: cars.length - shown.length }
  })
  const rows = Math.max(1, Math.ceil(groups.length / cols))
  return { width, height: rows * ch, nodes }
}

function rank(st) {
  const i = CAR_STATE_ORDER.indexOf(st)
  return i < 0 ? CAR_STATE_ORDER.length : i
}

// ─── quote into chat (PRD P0-6) ─────────────────────────────────────────────

function clip(s, n) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim()
  return v.length > n ? `${v.slice(0, n - 1)}…` : v
}

/**
 * One plain-text line handed to the chat drawer. `words` supplies the
 * localised labels so this stays DOM / i18n free:
 *   { event, car, state(st), cars, last, issue }
 */
export function quoteText(kind, obj, words) {
  if (kind === 'event') {
    const e = obj
    const parts = [`[${words.event}] ${e.unassigned ? words.unassigned : `${e.key} ${clip(e.title, 80)}`}`]
    if (e.state) parts.push(words.state(e.state))
    if (e.carsAvailable) parts.push(`${words.cars} ${e.carCount}`)
    if (e.waitingCount) parts.push(`${words.waiting} ${e.waitingCount}`)
    if (e.lastProgress) parts.push(`${words.last}: ${e.lastProgress.car} ${clip(e.lastProgress.label, 100)}`)
    return parts.join(' · ')
  }
  const c = obj
  const parts = [`[${words.car}] ${c.car} (${c.traceId})`, words.state(c.state)]
  if (c.issue) parts.push(`${words.issue} ${c.issue}`)
  const last = Array.isArray(c.points) && c.points.length ? c.points[c.points.length - 1] : null
  if (last) parts.push(`${words.last}: ${clip(last.label, 100)}`)
  else if (c.title) parts.push(clip(c.title, 100))
  return parts.join(' · ')
}
