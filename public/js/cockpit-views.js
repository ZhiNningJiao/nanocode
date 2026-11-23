/**
 * Cockpit home views over one GET /api/command-center response:
 *   - the swimlane gantt (the home's main piece): one lane per big event
 *     (summary bar = first car start → last car end, every car milestone
 *     dotted), cars as child rows when the lane is unfolded; bar = car
 *     (dispatched → accepted / failed), dashed tail = expected finish when the
 *     export knows one, a "now" line through every row;
 *   - the 大事记流 (milestone feed) in the second column: every milestone,
 *     newest first, by day → big event; a feed item and its gantt point share
 *     one `pid` (cockpit-model.js), cockpit.js links the two on click;
 *   - the 等你 chips above the gantt (big events somebody waits on).
 * Pure "data + ui state → HTML"; folding / clicks live in cockpit.js.
 * Coordinates come from command-center-layout.js (layoutGantt) and the column
 * widths from cockpit-model.js (ganttColumns) only.
 */
import { t } from './i18n.js'
import { esc, fmtTime, degradeLineHtml } from './command-center-format.js'
import { stateLabel, eventTitle, carDetailHtml, ganttAxisHtml, ganttBarHtml, ganttNowLineHtml, kindLabel } from './command-center-render.js'
import { layoutGantt, ganttWindow } from './command-center-layout.js'
import { eventGroups, buildSwimlanes, swimlaneRows, spanWindow, ganttColumns, waitingEvents, GANTT_SPANS } from './cockpit-model.js'

/** Source notes shown above the gantt (each source degrades alone, PRD P0-8). */
export function sourcesHtml(d) {
  const parts = []
  const lin = d.sources?.linear
  if (!lin?.ok) parts.push(degradeLineHtml(t('plugin.cc.linearDown'), lin))
  else if (lin.truncated) parts.push(`<div class="cc-note">${esc(t('plugin.cc.truncated'))}</div>`)
  if (!d.sources?.cars?.ok) parts.push(degradeLineHtml(t('plugin.cc.carsDown'), d.sources?.cars))
  return parts.join('')
}

function quoteBtn(kind, key) {
  return `<button class="rp-btn-sm ck-quote" data-act="quote" data-kind="${kind}" data-key="${esc(key)}" title="${esc(t('cockpit.quoteTitle'))}">${esc(t('cockpit.quote'))}</button>`
}

// ─── 等你 chips ─────────────────────────────────────────────────────────────

export function waitingChipsHtml(d) {
  const evs = waitingEvents(d)
  if (!evs.length) return ''
  return `<span class="ck-asks-label">${esc(t('plugin.cc.waitingYou'))} · ${evs.reduce((n, e) => n + e.waitingCount, 0)}</span>` +
    evs.map((e) => `<button type="button" class="ck-ask" data-act="ask" data-event="${esc(e.key)}" title="${esc(`${eventTitle(e, e.unassigned)} · ${t('plugin.cc.waitingYou')} ${e.waitingCount}`)}">${esc(eventTitle(e, e.unassigned))}${e.waitingCount > 1 ? ` <b>${e.waitingCount}</b>` : ''}</button>`).join('')
}

// ─── swimlane gantt ─────────────────────────────────────────────────────────

const LANE_POINT_GAP_PX = 14

/**
 * A folded lane carries every car's milestones; on a busy lane (dozens of
 * cars) they would merge into one smear. Keep one point per LANE_POINT_GAP_PX
 * (the newest of a cluster, plus the selected one); the car rows below keep all.
 */
function thinPoints(r, selPid) {
  if (!r.points?.length) return r
  const kept = []
  for (const p of [...r.points].sort((a, b) => b.x - a.x)) {
    if (p.pid === selPid || !kept.length || kept[kept.length - 1].x - p.x >= LANE_POINT_GAP_PX) kept.push(p)
  }
  return { ...r, points: kept.reverse() }
}

/** `width` = the container's client width (px). */
export function ganttViewHtml(d, ui, width) {
  const allLanes = buildSwimlanes(d, ui.isExpanded)
  if (!allLanes.length) return `<div class="rp-empty">${esc(t('plugin.cc.noEvents'))}</div>`
  if (!d.sources?.cars?.ok) return '' // sourcesHtml already says the car source is down; no bars to draw
  const { labelPx, plotW, scroll } = ganttColumns(width)
  const now = ui.now ?? Date.now()
  // window over every car (folded or not) so unfolding a lane never rescales the axis
  const allCars = allLanes.flatMap((l) => l.cars.map((c) => ({ start: c.start, end: c.end, endOpen: c.endOpen, eta: c.eta })))
  const win = spanWindow(ganttWindow(allCars, now), now, ui.span)
  // a lane is drawn when one of its cars reaches into the window (or someone
  // waits on it); the rest are named in one line under the gantt
  const inWindow = (c) => c.endOpen || Date.parse(c.end) >= win.from
  const shown = allLanes.filter((l) => l.event.waitingCount > 0 || l.cars.some(inWindow))
  const idle = allLanes.filter((l) => !shown.includes(l))
  const hidden = shown.flatMap((l) => l.cars).filter((c) => !inWindow(c)).length
  // an unfolded lane lists only the cars that reach into the window (the
  // summary bar still covers all of them; the line above counts the rest)
  const lanes = shown.map((l) => ({ ...l, cars: l.cars.filter(inWindow) }))
  const rows = swimlaneRows(lanes)
  const lay = layoutGantt(rows, { width: plotW, from: win.from, to: win.to, now })
  const spans = GANTT_SPANS.map((h) => `<button type="button" class="ck-span-btn${h === ui.span ? ' active' : ''}" data-act="span" data-span="${h}">${esc(t(`cockpit.span.${h}`))}</button>`).join('')
  const body = rows.map((row, i) => {
    const r = lay.rows[i]
    if (row.kind === 'lane') {
      const e = row.lane.event
      const st = e.state || (e.carsAvailable ? 'empty' : 'nodata')
      const bar = row.lane.cars.length ? ganttBarHtml(thinPoints(r, ui.selPid), st, ' ck-lane-bar') : `<span class="cc-bar-invalid">${esc(t('plugin.cc.noCars'))}</span>`
      return `
        <div class="ck-lane${row.lane.expanded ? ' open' : ''}${e.waitingCount ? ' ck-lane-wait' : ''}" data-act="toggle" data-event="${esc(e.key)}">
          <div class="ck-lane-label" style="width:${labelPx}px" title="${esc(eventTitle(e, e.unassigned))}"><span class="ck-chev">${row.lane.expanded ? '▾' : '▸'}</span><span class="cc-dot cc-st-${esc(st)}"></span><span class="ck-lane-name">${esc(eventTitle(e, e.unassigned))}</span>${e.waitingCount ? `<span class="cc-wait-badge">${esc(t('plugin.cc.waitingYou'))}</span>` : ''}<span class="ck-lane-n">${row.lane.cars.length}</span>${quoteBtn('event', e.key)}</div>
          <div class="cc-gtrack" style="width:${plotW}px">${bar}</div>
        </div>`
    }
    if (row.kind === 'sub') {
      // sub-group header inside an expanded lane: 「category › named issue」, or an unassigned reason
      const g = row.group
      const name = g.label || t(`plugin.cc.unassignedReason.${g.reason}`)
      const st = (g.cars.find((x) => x.endOpen) || g.cars[g.cars.length - 1]).state
      return `
        <div class="ck-lane ck-sub" data-event="${esc(row.lane.key)}">
          <div class="ck-lane-label ck-sub-label" style="width:${labelPx}px" title="${esc(name)}"><span class="cc-dot cc-st-${esc(st)}"></span><span class="ck-lane-name">${esc(name)}</span><span class="ck-lane-n">${g.cars.length}</span></div>
          <div class="cc-gtrack" style="width:${plotW}px">${ganttBarHtml(thinPoints(r, ui.selPid), st, ' ck-lane-bar ck-sub-bar')}</div>
        </div>`
    }
    const c = row.car
    const open = ui.openCar === c.traceId
    return `
      <div class="cc-grow ck-lane-car${open ? ' open' : ''}" data-act="car" data-car="${esc(c.traceId)}" data-event="${esc(row.lane.key)}">
        <div class="cc-glabel" style="width:${labelPx}px" title="${esc(c.title)}"><span class="cc-dot cc-st-${esc(c.state)}"></span><span class="cc-gname">${esc(c.car)}</span></div>
        <div class="cc-gtrack" style="width:${plotW}px">${ganttBarHtml(r, c.state, c.reason === 'superseded' ? ' cc-bar-superseded' : '')}</div>
      </div>
      ${open ? `<div class="ck-lane-detail">${carDetailHtml(c, row.lane.key, quoteBtn('car', c.traceId))}</div>` : ''}`
  }).join('')
  return `<div class="ck-spans">${spans}${hidden ? `<span class="cc-sub">${esc(t('cockpit.spanHidden', hidden))}</span>` : ''}</div>
    <div class="ck-gantt-scroll${scroll ? ' ck-scroll' : ''}"><div class="ck-gantt cc-gantt" style="width:${labelPx + plotW}px">${ganttAxisHtml(lay, labelPx, plotW)}${body}${ganttNowLineHtml(lay, labelPx)}</div></div>
    ${idle.length ? `<div class="cc-sub ck-idle"><span class="ck-idle-label">${esc(t('cockpit.idleEvents', idle.length))}</span>${idle.map((l) => `<button type="button" class="ck-idle-ev" data-act="quote" data-kind="event" data-key="${esc(l.key)}" title="${esc(t('cockpit.quoteTitle'))}">${esc(eventTitle(l.event, l.event.unassigned))}</button>`).join('')}</div>` : ''}`
}

// ─── 大事记流 ───────────────────────────────────────────────────────────────

const DONE_KINDS = new Set(['accepted', 'done', 'delivered'])

function feedMark(item) {
  if (item.kind === 'failed') return 'bad'
  if (item.kind === 'blocked' || item.kind === 'waiting') return 'wait'
  if (DONE_KINDS.has(item.kind)) return 'done'
  return 'step'
}

/** `days` = cockpit-model.js buildFeed(); `selPid` = the highlighted milestone. */
export function feedHtml(days, d, selPid) {
  if (!days.length) return `<div class="rp-empty">${esc(t('cockpit.feedEmpty'))}</div>`
  const byKey = new Map(eventGroups(d).map((e) => [e.key, e]))
  return days.map((day) => `
    <div class="ck-feed-day">${esc(day.day)}</div>
    ${day.events.map((g) => {
      const e = byKey.get(g.key) || g
      const st = e.state || 'nodata'
      return `<div class="ck-feed-ev" data-event="${esc(g.key)}">
        <button type="button" class="ck-feed-evhead" data-act="ask" data-event="${esc(g.key)}"><span class="cc-dot cc-st-${esc(st)}"></span><span>${esc(eventTitle(e, g.unassigned))}</span></button>
        ${g.items.map((it) => `<button type="button" class="ck-fi ck-fi-${feedMark(it)}${it.pid === selPid ? ' sel' : ''}" data-act="pt" data-pid="${esc(it.pid)}" data-event="${esc(g.key)}" title="${esc(`${it.car} · ${kindLabel(it.kind)} · ${stateLabel(it.state)}`)}"><span class="ck-fi-mark"></span><span class="ck-fi-time">${esc(fmtTime(it.t))}</span><span class="ck-fi-label">${esc(it.label || kindLabel(it.kind))}</span><span class="ck-fi-car">${esc(it.car)}</span></button>`).join('')}
      </div>`
    }).join('')}`).join('')
}

/** { event, car } for a trace id, or null. */
export function findCar(d, traceId) {
  for (const e of eventGroups(d)) {
    const car = (e.cars || []).find((c) => c.traceId === traceId)
    if (car) return { event: e, car }
  }
  return null
}
