/**
 * Cockpit main-area views over one GET /api/command-center response:
 *   - list  (PRD P0-1 / P0-2): one card per big event, cars folded under it;
 *   - gantt (P1-1): one swimlane per big event (summary bar = first car start
 *     → last car end, every car milestone dotted), cars as child rows when
 *     the lane is unfolded; bar = trace (dispatched → accepted / failed);
 *   - graph (P1-2): event = big node with a progress ring, cars = satellites
 *     coloured by state.
 * Pure "data + ui state → HTML"; folding / clicks live in cockpit.js.
 * Coordinates come from command-center-layout.js / cockpit-model.js only.
 */
import { t } from './i18n.js'
import { esc, fmtTime, fmtAgo, downBlock, linkHtml } from './command-center-format.js'
import { stateLabel, eventTitle, trackerBadge, progressText, progressHtml, carDetailHtml, ganttAxisHtml, ganttBarHtml } from './command-center-render.js'
import { layoutGantt, ganttWindow } from './command-center-layout.js'
import { eventGroups, buildSwimlanes, swimlaneRows, layoutGraph, spanWindow, GANTT_SPANS } from './cockpit-model.js'

const GANTT_LABEL_PX = 220
const GRAPH_CELL_PX = 230

/** Source notes shown above any view (each source degrades alone, PRD P0-8). */
export function sourcesHtml(d) {
  const parts = []
  const lin = d.sources?.linear
  if (!lin?.ok) parts.push(downBlock(t('plugin.cc.linearDown'), lin))
  else if (lin.truncated) parts.push(`<div class="cc-note">${esc(t('plugin.cc.truncated'))}</div>`)
  if (!d.sources?.cars?.ok) parts.push(downBlock(t('plugin.cc.carsDown'), d.sources?.cars))
  return parts.join('')
}

function quoteBtn(kind, key) {
  return `<button class="rp-btn-sm ck-quote" data-act="quote" data-kind="${kind}" data-key="${esc(key)}" title="${esc(t('cockpit.quoteTitle'))}">${esc(t('cockpit.quote'))}</button>`
}

function waitBadge(n) {
  return n ? `<span class="cc-wait-badge">${esc(t('plugin.cc.waitingYou'))} ${n}</span>` : ''
}

function carsText(e) {
  return e.carsAvailable ? `${t('plugin.cc.cars')} ${e.carCount}` : t('plugin.cc.carsNoData')
}

// ─── list ───────────────────────────────────────────────────────────────────

export function listViewHtml(d, ui) {
  const groups = eventGroups(d)
  if (!groups.length) return `<div class="rp-empty">${esc(t('plugin.cc.noEvents'))}</div>`
  return `<div class="ck-list">${groups.map((e) => eventCardHtml(e, ui)).join('')}</div>`
}

function eventCardHtml(e, ui) {
  const open = ui.isExpanded(e.key, e)
  const st = e.state || (e.carsAvailable ? 'empty' : 'nodata')
  const last = e.lastProgress
  const key = e.unassigned ? '' : (e.url ? linkHtml(e.url, e.key, 'cc-key') : `<span class="cc-key">${esc(e.key)}</span>`)
  return `
    <div class="ck-ev${open ? ' open' : ''}${e.unassigned ? ' ck-ev-none' : ''}" data-event="${esc(e.key)}">
      <div class="ck-ev-head" data-act="toggle">
        <span class="ck-chev">${open ? '▾' : '▸'}</span>
        <span class="cc-dot cc-st-${esc(st)}" title="${esc(stateLabel(st))}"></span>
        <span class="ck-ev-title">${esc(eventTitle(e, e.unassigned))}</span>
        ${waitBadge(e.waitingCount)}
        <span class="ck-ev-actions">${quoteBtn('event', e.key)}</span>
      </div>
      <div class="ck-ev-meta">${key}${e.unassigned ? '' : trackerBadge(e)}<span>${esc(carsText(e))}</span>${e.state ? `<span>${esc(stateLabel(e.state))}</span>` : ''}${e.updatedAt ? `<span>${esc(t('plugin.cc.updated'))} ${esc(fmtAgo(e.updatedAt))}</span>` : ''}</div>
      ${progressHtml(e.progress)}
      ${last ? `<div class="cc-ei-last" title="${esc(`${fmtTime(last.t)} ${last.label}`)}">${esc(fmtAgo(last.t))} · ${esc(last.car)}：${esc(last.label)}</div>` : ''}
      ${open ? carsListHtml(e, ui) : ''}
    </div>`
}

function carsListHtml(e, ui) {
  if (!e.carsAvailable) return `<div class="ck-cars"><div class="rp-empty">${esc(t('plugin.cc.carsNoData'))}</div></div>`
  if (!e.cars.length) return `<div class="ck-cars"><div class="rp-empty">${esc(t('plugin.cc.noCars'))}</div></div>`
  return `<div class="ck-cars">${e.cars.map((c) => {
    const open = ui.openCar === c.traceId
    const lastPt = c.points[c.points.length - 1]
    return `
      <div class="ck-car${open ? ' open' : ''}" data-act="car" data-car="${esc(c.traceId)}" data-event="${esc(e.key)}">
        <span class="cc-dot cc-st-${esc(c.state)}"></span>
        <span class="ck-car-name">${esc(c.car)}</span>
        <span class="ck-car-state">${esc(stateLabel(c.state))}</span>
        <span class="ck-car-time">${esc(fmtTime(c.start))} → ${c.endOpen ? esc(t('plugin.cc.now')) : esc(fmtTime(c.end))}</span>
        <span class="ck-car-last">${esc(lastPt ? lastPt.label : c.title || '')}</span>
      </div>
      ${open ? carDetailHtml(c, e.key, quoteBtn('car', c.traceId)) : ''}`
  }).join('')}</div>`
}

// ─── swimlane gantt ─────────────────────────────────────────────────────────

/** `width` = the container's client width (px, required by the layout). */
export function ganttViewHtml(d, ui, width) {
  const lanes = buildSwimlanes(d, ui.isExpanded)
  if (!lanes.length) return `<div class="rp-empty">${esc(t('plugin.cc.noEvents'))}</div>`
  if (!d.sources?.cars?.ok) return '' // sourcesHtml already says the car source is down; no bars to draw
  const narrow = width < 640
  const labelPx = narrow ? 120 : GANTT_LABEL_PX
  const plotW = Math.max(60, width - labelPx - 18)
  const rows = swimlaneRows(lanes)
  const now = Date.now()
  // window over every car (folded or not) so unfolding a lane never rescales the axis
  const allCars = lanes.flatMap((l) => l.cars.map((c) => ({ start: c.start, end: c.end, endOpen: c.endOpen })))
  const win = spanWindow(ganttWindow(allCars, now), now, ui.span)
  const lay = layoutGantt(rows, { width: plotW, from: win.from, to: win.to, now })
  const hidden = lanes.flatMap((l) => l.cars).filter((c) => !c.endOpen && Date.parse(c.end) < win.from).length
  const spans = GANTT_SPANS.map((h) => `<button type="button" class="ck-span-btn${h === ui.span ? ' active' : ''}" data-act="span" data-span="${h}">${esc(t(`cockpit.span.${h}`))}</button>`).join('')
  const body = rows.map((row, i) => {
    const r = lay.rows[i]
    if (row.kind === 'lane') {
      const e = row.lane.event
      const st = e.state || (e.carsAvailable ? 'empty' : 'nodata')
      const bar = row.lane.cars.length ? ganttBarHtml(r, st, ' ck-lane-bar') : `<span class="cc-bar-invalid">${esc(t('plugin.cc.noCars'))}</span>`
      return `
        <div class="ck-lane${row.lane.expanded ? ' open' : ''}" data-act="toggle" data-event="${esc(e.key)}">
          <div class="ck-lane-label" style="width:${labelPx}px" title="${esc(eventTitle(e, e.unassigned))}"><span class="ck-chev">${row.lane.expanded ? '▾' : '▸'}</span><span class="cc-dot cc-st-${esc(st)}"></span><span class="ck-lane-name">${esc(eventTitle(e, e.unassigned))}</span>${e.waitingCount ? `<span class="cc-wait-badge">${e.waitingCount}</span>` : ''}<span class="ck-lane-n">${row.lane.cars.length}</span></div>
          <div class="cc-gtrack" style="width:${plotW}px">${bar}</div>
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
    <div class="ck-gantt cc-gantt">${ganttAxisHtml(lay, labelPx, plotW)}${body}</div>
    <div class="cc-sub ck-legend">${esc(t('cockpit.ganttLegend'))}</div>`
}

// ─── node graph ─────────────────────────────────────────────────────────────

export function graphViewHtml(d, ui, width) {
  const groups = eventGroups(d)
  if (!groups.length) return `<div class="rp-empty">${esc(t('plugin.cc.noEvents'))}</div>`
  const g = layoutGraph(groups, { width: Math.max(200, width - 4), cell: Math.min(GRAPH_CELL_PX, Math.max(170, width / 2)) })
  const ringLen = (r) => 2 * Math.PI * (r + 5)
  const nodes = g.nodes.map((n) => {
    const e = n.event
    const st = e.state || (e.carsAvailable ? 'empty' : 'nodata')
    const len = ringLen(n.r)
    const ring = n.progress == null ? '' : `<circle class="ck-g-ring" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${(n.r + 5).toFixed(1)}" stroke-dasharray="${(len * n.progress).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 ${n.x.toFixed(1)} ${n.y.toFixed(1)})"><title>${esc(progressText(e.progress))}</title></circle>`
    const sats = n.satellites.map((s) => `<circle class="ck-g-sat ck-g-${esc(s.car.state)}${ui.openCar === s.car.traceId ? ' sel' : ''}" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="6" data-act="car" data-car="${esc(s.car.traceId)}" data-event="${esc(e.key)}"><title>${esc(`${s.car.car} · ${stateLabel(s.car.state)}`)}</title></circle>`).join('')
    const title = eventTitle(e, e.unassigned)
    const short = title.length > 16 ? `${title.slice(0, 15)}…` : title
    return `
      <g class="ck-g-node" data-act="focus" data-event="${esc(e.key)}">
        ${sats}
        <circle class="ck-g-ev ck-g-${esc(st)}" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}"><title>${esc(`${title} · ${carsText(e)}${e.state ? ` · ${stateLabel(e.state)}` : ''}`)}</title></circle>
        ${ring}
        <text class="ck-g-n" x="${n.x.toFixed(1)}" y="${(n.y + 4).toFixed(1)}">${e.carsAvailable ? e.carCount : '?'}</text>
        <text class="ck-g-label" x="${n.x.toFixed(1)}" y="${(n.y + n.ring + 22).toFixed(1)}">${esc(short)}${e.waitingCount ? ` · ${esc(t('plugin.cc.waitingYou'))} ${e.waitingCount}` : ''}</text>
        ${n.hidden > 0 ? `<text class="ck-g-more" x="${n.x.toFixed(1)}" y="${(n.y + n.ring + 36).toFixed(1)}">${esc(t('cockpit.graphMore', n.hidden))}</text>` : ''}
      </g>`
  }).join('')
  const open = ui.openCar ? findCar(d, ui.openCar) : null
  return `<svg class="ck-graph" width="${g.width}" height="${g.height + 10}" viewBox="0 0 ${g.width} ${g.height + 10}" role="img" aria-label="${esc(t('cockpit.view.graph'))}">${nodes}</svg>
    <div class="cc-sub ck-legend">${esc(t('cockpit.graphLegend'))}</div>
    ${open ? `<div class="ck-graph-detail">${carDetailHtml(open.car, open.event.key, quoteBtn('car', open.car.traceId))}</div>` : ''}`
}

/** { event, car } for a trace id, or null. */
export function findCar(d, traceId) {
  for (const e of eventGroups(d)) {
    const car = (e.cars || []).find((c) => c.traceId === traceId)
    if (car) return { event: e, car }
  }
  return null
}
