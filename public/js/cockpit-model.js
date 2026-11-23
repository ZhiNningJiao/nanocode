/**
 * Cockpit (指挥舱主布局) model — DOM-free, unit-tested in node.
 *
 *  - the module registry: each cockpit module IS one existing plugin, so the
 *    plugin's enabled flag is the module's only on/off switch (no second flag);
 *  - the layout setting stored on the server (`cockpit_layout`: order + off),
 *    normalised here (unknown ids dropped, new modules appended, never throws);
 *  - per-device UI memory (main view = cockpit | workspace, cockpit page =
 *    home | quota) normalisation;
 *  - swimlane rows for the home gantt (one lane per big event, cars folded),
 *    the gantt's column widths (label column + plot width — the one place
 *    they are decided, so the axis and every row share one plot width);
 *  - the 大事记流 (milestone feed) next to the gantt: every car milestone,
 *    newest first, grouped by day → big event; feed items and gantt points
 *    share one id (`pid`) so a click on either side finds the other;
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
export const MAIN_VIEWS = ['cockpit', 'workspace']
/** Cockpit pages (icon rail): home = gantt + feed + waiting + machines; quota = the curve large + per-pool detail. */
export const COCKPIT_PAGES = ['home', 'quota']
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

export function normalizePage(v) { return COCKPIT_PAGES.includes(v) ? v : 'home' }
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
    let eta = null
    let startMs = Infinity
    let endMs = -Infinity
    const points = []
    for (const c of cars) {
      const s = Date.parse(c.start)
      if (Number.isFinite(s) && s < startMs) { startMs = s; start = c.start }
      if (c.endOpen) {
        endOpen = true
        if (c.eta && (!eta || Date.parse(c.eta) > Date.parse(eta))) eta = c.eta
      }
      const en = Date.parse(c.end)
      if (Number.isFinite(en) && en > endMs) { endMs = en; end = c.end }
      for (const p of carPoints(c)) points.push({ ...p, label: `${c.car} · ${p.label || ''}` })
    }
    return {
      key: e.key,
      event: e,
      unassigned: !!e.unassigned,
      summary: { id: e.key, start, end: end || start, endOpen, eta, points },
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
    for (const c of lane.cars) rows.push({ kind: 'car', lane, car: c, id: c.traceId, start: c.start, end: c.end, endOpen: c.endOpen, eta: c.eta, points: carPoints(c) })
  }
  return rows
}

/** Stable id of one car milestone — shared by the gantt point and the feed item. */
export function pointId(traceId, index) { return `${traceId}#${index}` }

/** A car's milestones, each carrying its `pid`. */
export function carPoints(c) {
  return (Array.isArray(c?.points) ? c.points : []).map((p, i) => ({ ...p, pid: pointId(c.traceId, i) }))
}

// ─── gantt columns ──────────────────────────────────────────────────────────

export const GANTT_LABEL_PX = 220
export const GANTT_LABEL_NARROW_PX = 128
export const GANTT_GUTTER_PX = 18
export const GANTT_MIN_PLOT_PX = 460
const GANTT_NARROW_BELOW_PX = 640

/**
 * Container width → { labelPx, plotW, scroll }. The axis row and every lane /
 * car row use exactly these two numbers (no flex, no second width), so a time
 * maps to the same x on every row. On narrow screens the plot keeps a minimum
 * width and the gantt scrolls sideways (lane names stay pinned).
 */
export function ganttColumns(width) {
  const w = Number.isFinite(width) && width > 0 ? width : 800
  const labelPx = w < GANTT_NARROW_BELOW_PX ? GANTT_LABEL_NARROW_PX : GANTT_LABEL_PX
  const fit = w - labelPx - GANTT_GUTTER_PX
  const plotW = Math.max(GANTT_MIN_PLOT_PX, fit)
  return { labelPx, plotW, scroll: fit < GANTT_MIN_PLOT_PX }
}

// ─── 大事记流 (milestone feed) ───────────────────────────────────────────────

function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Every car milestone at or after `fromMs`, newest first, grouped by local
 * day, then by big event (in order of each event's newest item that day).
 * At most `limit` items in total (the newest). Items carry the gantt `pid`.
 * → [{ day, events: [{ key, title, unassigned, items: [{ pid, t, kind, label, car, traceId, state }] }] }]
 */
export function buildFeed(data, { fromMs = -Infinity, limit = 120 } = {}) {
  const all = []
  for (const e of eventGroups(data)) {
    for (const c of e.cars || []) {
      for (const p of carPoints(c)) {
        const ms = Date.parse(p.t)
        if (!Number.isFinite(ms) || ms < fromMs) continue
        all.push({ ms, eventKey: e.key, event: e, item: { pid: p.pid, t: p.t, kind: p.kind, label: p.label || '', car: c.car, traceId: c.traceId, state: c.state } })
      }
    }
  }
  all.sort((a, b) => b.ms - a.ms || a.item.pid.localeCompare(b.item.pid))
  const days = []
  for (const x of all.slice(0, limit)) {
    const day = localDay(x.ms)
    let d = days[days.length - 1]
    if (!d || d.day !== day) { d = { day, events: [], byKey: new Map() }; days.push(d) }
    let g = d.byKey.get(x.eventKey)
    if (!g) { g = { key: x.eventKey, title: x.event.title || null, unassigned: !!x.event.unassigned, items: [] }; d.byKey.set(x.eventKey, g); d.events.push(g) }
    g.items.push(x.item)
  }
  return days.map(({ day, events }) => ({ day, events }))
}

// ─── feed ⇄ gantt viewport link ─────────────────────────────────────────────

/**
 * Scrollspy: `items` are `{ key, top }` in top-to-bottom (document) order,
 * `top` = each item's distance (px) from its scroll container's own top edge
 * (negative = scrolled above it). The "active" one is the last item whose
 * top has crossed `line` (the reference line a few px below the container's
 * top) — i.e. the item currently occupying that line, the same rule a
 * scrollspy / table-of-contents highlight uses. Before anything has
 * crossed the line (scrolled to the very start) the first item is active.
 * `null` for an empty list — nothing to link to.
 */
export function scrollSpyActiveKey(items, line) {
  if (!items.length) return null
  let active = items[0].key
  for (const it of items) {
    if (it.top <= line) active = it.key
    else break
  }
  return active
}

/** Big events somebody is waiting on (the 等你 chips above the gantt), most waiting first. */
export function waitingEvents(data) {
  return eventGroups(data).filter((e) => e.waitingCount > 0).sort((a, b) => b.waitingCount - a.waitingCount)
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
