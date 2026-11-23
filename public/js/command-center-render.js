/**
 * Command Center HTML pieces shared by the right-panel events plugin
 * (command-center-panel.js) and the full-page cockpit views (cockpit-views.js):
 * state / milestone-kind words, tracker badge, progress bar, car detail card,
 * milestone list and the gantt axis + bar markup. One copy; both import.
 * Coordinates come from command-center-layout.js — nothing here computes them.
 */
import { t } from './i18n.js'
import { esc, pad2, fmtTime, linkHtml } from './command-center-format.js'

const TICK_EDGE_PX = 18 // a centred tick label closer than this to an edge would be clipped
const NOW_BADGE_HALF_PX = 30 // a tick label this close to the "now" badge would sit under it
const CAR_MILESTONES_SHOWN = 3

export function stateLabel(st) { return t(`plugin.cc.state.${st}`) }

export function kindLabel(k) {
  const key = `plugin.cc.kind.${k}`
  const v = t(key)
  return v === key ? k : v
}

export function eventTitle(e, isUnassigned) {
  if (isUnassigned) return t('plugin.cc.unassigned')
  return e.title || `${e.key} · ${t('plugin.cc.titleUnknown')}`
}

// Tracker (Linear) state of the event; "unknown" when the tracker is down.
export function trackerBadge(e) {
  if (!e.trackerState) return `<span class="cc-lin cc-lin-unknown">${esc(t('plugin.cc.trackerUnknown'))}</span>`
  return `<span class="cc-lin cc-lin-${esc(e.trackerState?.type || 'unknown')}">${esc(e.trackerState?.name || '?')}</span>`
}

export function progressText(p) {
  return p.basis === 'subissues' ? t('plugin.cc.progressSub', p.done, p.total) : t('plugin.cc.progressCars', p.done, p.total)
}

export function progressHtml(p) {
  if (!p || !p.total) return ''
  const pct = Math.round((p.done / p.total) * 100)
  const basis = progressText(p)
  return `<div class="cc-prog" title="${esc(basis)}"><div class="cc-prog-bar"><div class="cc-prog-fill" style="width:${pct}%"></div></div><span class="cc-prog-txt">${esc(basis)}</span></div>`
}

export function milestonesHtml(ms) {
  if (!ms || !ms.length) return `<div class="rp-empty">${esc(t('plugin.cc.noMilestones'))}</div>`
  return `<ul class="cc-ms">${ms.map((m) => `
    <li class="cc-ms-${esc(m.kind)}"><span class="cc-ms-time">${esc(fmtTime(m.t))}</span><span class="cc-ms-car">${esc(m.car)}</span><span class="cc-ms-kind">${esc(kindLabel(m.kind))}</span><span class="cc-ms-label">${esc(m.label)}</span></li>`).join('')}</ul>`
}

function prNum(u) {
  const m = String(u).match(/\/pull\/(\d+)/)
  return m ? `#${m[1]}` : ''
}

/** Car card (task line, last milestones, docs / PR links, trace id). `eventKey` = the event it is shown under. */
export function carDetailHtml(c, eventKey, extraActions = '') {
  const ms = c.points.slice(-CAR_MILESTONES_SHOWN).reverse()
  const docs = ['task', 'step', 'report'].filter((k) => c.docs[k])
    .map((k) => `<button class="rp-btn-sm" data-act="doc" data-kind="${k}" data-trace="${esc(c.traceId)}">${esc(t(`plugin.cc.doc.${k}`))}</button>`).join('')
  // the server already drops non-http(s) links; linkHtml re-checks (plain text if not)
  const prs = c.prs.map((u) => linkHtml(u, `PR ${prNum(u)}`)).join('')
  const boards = c.boards.map((u, i) => linkHtml(u, `${t('plugin.cc.board')} ${i + 1}`)).join('')
  const reason = c.reason ? ` · ${t(`plugin.cc.reason.${c.reason}`)}` : ''
  const meta = [c.effort || c.model, c.pool, c.verdict].filter(Boolean).map(esc).join(' · ')
  return `
    <div class="cc-car">
      <div class="cc-car-title">${esc(c.title || c.car)}</div>
      <div class="cc-car-meta"><span class="cc-dot cc-st-${esc(c.state)}"></span>${esc(stateLabel(c.state) + reason)} · ${esc(fmtTime(c.start))} → ${c.endOpen ? esc(t('plugin.cc.now')) : esc(fmtTime(c.end))}${meta ? ` · ${meta}` : ''}</div>
      ${c.issue && c.issue !== eventKey ? `<div class="cc-car-meta">${esc(t('plugin.cc.issue'))} ${esc(c.issue)}${c.issueInferred ? ` (${esc(t('plugin.cc.inferred'))})` : ''}</div>` : ''}
      ${c.unassignedReason ? `<div class="cc-car-meta cc-car-unassigned">${esc(t('plugin.cc.unassignedWhy'))}: ${esc(t(`plugin.cc.unassignedReason.${c.unassignedReason}`))}${c.unassignedNote ? ` — ${esc(c.unassignedNote)}` : ''}</div>` : ''}
      ${Array.isArray(c.issuePath) && c.issuePath.length > 1 ? `<div class="cc-car-meta">${esc(t('plugin.cc.issuePath'))} ${esc(c.issuePath.join(' → '))}</div>` : ''}
      ${c.plain ? `<div class="cc-car-plain">${esc(c.plain)}</div>` : ''}
      <div class="cc-car-sub">${esc(t('plugin.cc.lastMilestones'))}</div>
      ${ms.length ? `<ul class="cc-ms cc-ms-compact">${ms.map((m) => `<li><span class="cc-ms-time">${esc(fmtTime(m.t))}</span><span class="cc-ms-kind">${esc(kindLabel(m.kind))}</span><span class="cc-ms-label">${esc(m.label)}</span></li>`).join('')}</ul>` : `<div class="rp-empty">${esc(t('plugin.cc.noMilestones'))}</div>`}
      ${docs || prs || boards || extraActions ? `<div class="cc-car-links">${docs}${prs}${boards}${extraActions}</div>` : ''}
      <div class="cc-car-trace">${esc(t('plugin.cc.traceId'))} <code>${esc(c.traceId)}</code>${c.parent ? ` · ${esc(t('plugin.cc.parent'))} <code>${esc(c.parent)}</code>${c.parentInferred ? ` (${esc(t('plugin.cc.inferred'))})` : ''}` : ''}${c.traceCmd ? ` · <code>${esc(c.traceCmd)}</code>` : ''}${c.sessions.length ? ` · ${esc(t('plugin.cc.sessions', c.sessions.length))}` : ''}</div>
    </div>`
}

function fmtTick(ms, stepMin) {
  const d = new Date(ms)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (stepMin >= 1440 || (d.getHours() === 0 && d.getMinutes() === 0)) return `${d.getMonth() + 1}-${pad2(d.getDate())}`
  return hm
}

/**
 * Time axis row for a layoutGantt() result: tick labels + the "now" label.
 * The "now" line through the rows is ganttNowLineHtml (same lay.nowX).
 */
export function ganttAxisHtml(lay, labelColPx, plotW) {
  const ticks = lay.ticks.filter((tk) => tk.x >= TICK_EDGE_PX && tk.x <= plotW - TICK_EDGE_PX && (lay.nowX == null || Math.abs(tk.x - lay.nowX) >= NOW_BADGE_HALF_PX)).map((tk) => `<span class="cc-tick" style="left:${tk.x.toFixed(1)}px">${esc(fmtTick(tk.t, lay.stepMin))}</span>`).join('')
  const now = lay.nowX != null ? `<span class="cc-now" style="left:${lay.nowX.toFixed(1)}px">${esc(t('plugin.cc.now'))}</span>` : ''
  return `<div class="cc-gaxis"><div class="cc-gaxis-pad" style="width:${labelColPx}px"></div><div class="cc-gticks" style="width:${plotW}px">${ticks}${now}</div></div>`
}

/** Full-height "now" line over the plot (offset by the label column; same lay.nowX as the axis). */
export function ganttNowLineHtml(lay, labelColPx) {
  return lay.nowX != null ? `<span class="cc-now-line" style="left:${(labelColPx + lay.nowX).toFixed(1)}px" aria-hidden="true"></span>` : ''
}

/** One bar + its milestone points (+ dashed tail to the expected finish). `r` = a layoutGantt() row; `state` colours the bar. */
export function ganttBarHtml(r, state, extraCls = '') {
  if (r.invalid) return `<span class="cc-bar-invalid">${esc(t('plugin.cc.noStart'))}</span>`
  if (r.offscreen) return `<span class="cc-bar-invalid">${esc(t('plugin.cc.offscreen'))}</span>` // outside the chosen window
  const end = r.x + r.w
  const eta = r.etaX != null && r.etaX > end
    ? `<span class="cc-eta" style="left:${end.toFixed(1)}px;width:${(r.etaX - end).toFixed(1)}px"></span><span class="cc-eta-pt" style="left:${r.etaX.toFixed(1)}px" title="${esc(`${t('cockpit.eta')} ${fmtTime(r.eta)}`)}"></span>`
    : ''
  return `<span class="cc-bar cc-st-${esc(state)}${r.open ? ' cc-bar-open' : ''}${extraCls}" style="left:${r.x.toFixed(1)}px;width:${r.w.toFixed(1)}px"></span>${eta}` +
    r.points.map((p) => `<span class="cc-pt cc-pt-${esc(p.kind)}" style="left:${p.x.toFixed(1)}px"${p.pid ? ` data-act="pt" data-pid="${esc(p.pid)}"` : ''} title="${esc(`${fmtTime(p.t)} ${kindLabel(p.kind)} ${p.label || ''}`)}"></span>`).join('')
}
