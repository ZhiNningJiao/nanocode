/**
 * Command Center plugin (指挥舱 phase 1) — big events with cars folded under
 * them, plus a per-car gantt timeline.
 *
 * Layout ("hybrid" prototype): left = event list (title, tracker state,
 * progress, car count, latest progress, "waiting on you"); right = the
 * selected event's milestone timeline + gantt (one bar per car trace; click a
 * bar for its task line, last 3 milestones, documents / PR links, trace id).
 * Narrow containers (<640px, e.g. a 390px phone) switch to one column:
 * list → detail with a back button.
 *
 * All state words, group rollups and "waiting" counts come from the server
 * (server/command-center.js holds the one status vocabulary); this file only
 * renders. Each source degrades on its own: a dead source shows
 * "unreachable + last success" in its block, never blanks the others.
 */
import { t } from './i18n.js'
import { layoutGantt, ganttWindow } from './command-center-layout.js'
import { ensureCss, esc, pad2, fmtTime, fmtAgo, downBlock, linkHtml } from './command-center-format.js'

const POLL_MS = 60_000
const SELECTED_KEY = 'commandCenter:selected'
const LABEL_COL_PX = 128
const CAR_MILESTONES_SHOWN = 3
const TICK_EDGE_PX = 18 // a centred tick label closer than this to an edge would be clipped

let activePane = null
let rootEl = null
let pollTimer = null
let pollInFlight = false
let lastData = null
let selectedKey = null
let openCar = null
let resizeObs = null

export async function renderCommandCenterPane(pane) {
  if (!pane) return
  ensureCss()
  activePane = pane
  try { selectedKey = localStorage.getItem(SELECTED_KEY) } catch { selectedKey = null }
  renderShell(pane)
  await pollOnce()
  startPolling()
}

export function resetCommandCenterLoadState() {
  if (rootEl?.classList.contains('cc-fullscreen')) rootEl.remove()
  document.removeEventListener('keydown', onKeydown)
  rootEl = null
  activePane = null
  lastData = null
  openCar = null
  stopPolling()
  pollInFlight = false
  if (resizeObs) { resizeObs.disconnect(); resizeObs = null }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => { if (activePane) pollOnce() }, POLL_MS)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function pollOnce() {
  if (pollInFlight) return
  pollInFlight = true
  try {
    const r = await fetch('/api/command-center')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    if (activePane) { lastData = data; renderAll() }
  } catch (err) {
    if (activePane) renderFatal(String(err.message || err))
  } finally {
    pollInFlight = false
  }
}

// ─── shell ──────────────────────────────────────────────────────────────────

function renderShell(pane) {
  if (rootEl && rootEl.parentNode !== pane) rootEl.remove() // a full-screen root left under <body>
  pane.innerHTML = `
    <div class="cc-root" id="cc-root">
      <div class="cc-top">
        <div class="cc-top-title">${esc(t('plugin.cc.title'))}</div>
        <div class="cc-summary" id="cc-summary"></div>
        <div class="cc-sources" id="cc-sources"></div>
        <div class="cc-top-actions">
          <button class="rp-btn-sm cc-refresh" id="cc-refresh" title="${esc(t('plugin.cc.refresh'))}">↻</button>
          <button class="rp-btn-sm cc-full" id="cc-full" title="${esc(t('plugin.cc.fullscreen'))}">⤢</button>
        </div>
      </div>
      <div class="cc-body" id="cc-body">
        <div class="cc-list" id="cc-list"></div>
        <div class="cc-detail" id="cc-detail"></div>
      </div>
      <div class="cc-doc" id="cc-doc" hidden>
        <div class="cc-doc-head"><span id="cc-doc-title"></span><button class="rp-btn-sm" id="cc-doc-close">✕</button></div>
        <pre class="cc-doc-body" id="cc-doc-body"></pre>
      </div>
    </div>`
  const root = pane.querySelector('#cc-root')
  rootEl = root
  root.querySelector('#cc-refresh').addEventListener('click', () => pollOnce())
  root.querySelector('#cc-full').addEventListener('click', () => setFullscreen(!root.classList.contains('cc-fullscreen')))
  document.removeEventListener('keydown', onKeydown)
  document.addEventListener('keydown', onKeydown)
  root.querySelector('#cc-doc-close').addEventListener('click', () => { root.querySelector('#cc-doc').hidden = true })
  root.querySelector('#cc-list').addEventListener('click', onListClick)
  root.querySelector('#cc-detail').addEventListener('click', onDetailClick)
  if (resizeObs) resizeObs.disconnect()
  if (typeof ResizeObserver === 'function') {
    let lastW = 0
    resizeObs = new ResizeObserver(() => {
      const w = root.clientWidth
      if (Math.abs(w - lastW) < 4) return
      lastW = w
      applyNarrow()
      renderGantt()
    })
    resizeObs.observe(root)
  }
}

function q(sel) { return rootEl?.querySelector(sel) }

// Full screen: an ancestor of the pane creates a stacking context, so a fixed
// overlay can't rise above the app header from inside it — move the root
// under <body> while full screen and back into the pane on exit.
function setFullscreen(on) {
  if (!rootEl || !activePane) return
  rootEl.classList.toggle('cc-fullscreen', on)
  if (on) document.body.appendChild(rootEl)
  else activePane.appendChild(rootEl)
  applyNarrow()
  renderGantt()
}

function onKeydown(ev) {
  if (ev.key !== 'Escape' || !rootEl?.classList.contains('cc-fullscreen')) return
  if (!q('#cc-doc').hidden) { q('#cc-doc').hidden = true; return }
  setFullscreen(false)
}

function applyNarrow() {
  const root = rootEl
  if (!root) return
  root.classList.toggle('cc-narrow', root.clientWidth < 640)
}

function renderFatal(msg) {
  const list = q('#cc-list')
  if (!list) return
  list.innerHTML = `<div class="rp-hint rp-error">${esc(msg)}</div>`
}

function renderAll() {
  applyNarrow()
  const d = lastData
  if (!d) return
  if (!d.configured) {
    q('#cc-summary').innerHTML = ''
    q('#cc-sources').innerHTML = ''
    q('#cc-list').innerHTML = `<div class="cc-block-down">${esc(t('plugin.cc.notConfigured'))}<div class="cc-sub">${esc(d.error || '')}</div></div>`
    q('#cc-detail').innerHTML = ''
    return
  }
  renderSummary(d)
  renderSources(d)
  renderList(d)
  renderDetail()
}

// ─── header ─────────────────────────────────────────────────────────────────

function renderSummary(d) {
  const s = d.summary || {}
  const chips = [
    `${esc(t('plugin.cc.sumEvents'))} <b>${s.events ?? 0}</b>`,
    `${esc(t('plugin.cc.sumCars'))} <b>${s.cars ?? '—'}</b>`,
  ]
  if (s.waiting) chips.unshift(`<span class="cc-wait-badge">${esc(t('plugin.cc.waitingYou'))} ${s.waiting}</span>`)
  q('#cc-summary').innerHTML = chips.map((c) => `<span class="cc-chip">${c}</span>`).join('')
}

function renderSources(d) {
  const src = d.sources || {}
  const one = (name, s) => {
    if (s?.ok) return `<span class="cc-src cc-src-ok" title="${esc(fmtTime(s.checkedAt))}"><span class="service-dot up"></span>${esc(name)}</span>`
    return `<span class="cc-src cc-src-down" title="${esc(s?.error || '')}"><span class="service-dot down"></span>${esc(name)} ${esc(t('plugin.cc.unreachable'))}</span>`
  }
  q('#cc-sources').innerHTML = one(t('plugin.cc.srcLinear'), src.linear) + one(t('plugin.cc.srcCars'), src.cars)
}

// ─── left: event list ───────────────────────────────────────────────────────

function renderList(d) {
  const list = q('#cc-list')
  const parts = []
  const lin = d.sources?.linear
  if (!lin?.ok) parts.push(downBlock(t('plugin.cc.linearDown'), lin))
  else if (lin.truncated) parts.push(`<div class="cc-note">${esc(t('plugin.cc.truncated'))}</div>`)
  if (!d.events.length && lin?.ok) parts.push(`<div class="rp-empty">${esc(t('plugin.cc.noEvents'))}</div>`)
  if (!selectedKey || (selectedKey !== '_none' && !d.events.some((e) => e.key === selectedKey))) {
    selectedKey = d.events[0]?.key || (d.unassigned?.cars?.length ? '_none' : null)
  }
  for (const e of d.events) parts.push(eventItem(e))
  if (d.unassigned && (d.unassigned.cars.length || !d.sources?.cars?.ok)) parts.push(eventItem(d.unassigned, true))
  list.innerHTML = parts.join('')
}

function eventTitle(e, isUnassigned) {
  if (isUnassigned) return t('plugin.cc.unassigned')
  return e.title || `${e.key} · ${t('plugin.cc.titleUnknown')}`
}

function eventItem(e, isUnassigned = false) {
  const active = e.key === selectedKey ? ' active' : ''
  const st = e.state || (e.carsAvailable ? 'empty' : 'nodata')
  const carsTxt = e.carsAvailable ? `${t('plugin.cc.cars')} ${e.carCount}` : t('plugin.cc.carsNoData')
  const wait = e.waitingCount ? `<span class="cc-wait-badge">${esc(t('plugin.cc.waitingYou'))} ${e.waitingCount}</span>` : ''
  const last = e.lastProgress
  const lastHtml = last
    ? `<div class="cc-ei-last" title="${esc(`${fmtTime(last.t)} ${last.label}`)}">${esc(fmtAgo(last.t))} · ${esc(last.car)}：${esc(last.label)}</div>`
    : ''
  return `
    <div class="cc-ei${active}${isUnassigned ? ' cc-ei-none' : ''}" data-event="${esc(e.key)}">
      <div class="cc-ei-top"><span class="cc-dot cc-st-${esc(st)}" title="${esc(stateLabel(st))}"></span><span class="cc-ei-title">${esc(eventTitle(e, isUnassigned))}</span>${wait}</div>
      <div class="cc-ei-meta">${isUnassigned ? '' : `<span class="cc-key">${esc(e.key)}</span>${trackerBadge(e)}`}<span>${esc(carsTxt)}</span>${e.updatedAt ? `<span>${esc(t('plugin.cc.updated'))} ${esc(fmtAgo(e.updatedAt))}</span>` : ''}</div>
      ${progressHtml(e.progress)}
      ${lastHtml}
    </div>`
}

// Tracker (Linear) state of the event; "unknown" when the tracker is down.
function trackerBadge(e) {
  if (!e.trackerState) return `<span class="cc-lin cc-lin-unknown">${esc(t('plugin.cc.trackerUnknown'))}</span>`
  return `<span class="cc-lin cc-lin-${esc(e.trackerState?.type || 'unknown')}">${esc(e.trackerState?.name || '?')}</span>`
}

function progressHtml(p) {
  if (!p || !p.total) return ''
  const pct = Math.round((p.done / p.total) * 100)
  const basis = p.basis === 'subissues' ? t('plugin.cc.progressSub', p.done, p.total) : t('plugin.cc.progressCars', p.done, p.total)
  return `<div class="cc-prog" title="${esc(basis)}"><div class="cc-prog-bar"><div class="cc-prog-fill" style="width:${pct}%"></div></div><span class="cc-prog-txt">${esc(basis)}</span></div>`
}

function onListClick(ev) {
  const item = ev.target.closest('.cc-ei')
  if (!item) return
  selectedKey = item.dataset.event
  openCar = null
  try { localStorage.setItem(SELECTED_KEY, selectedKey) } catch {}
  rootEl?.classList.add('cc-show-detail')
  rootEl.querySelectorAll('.cc-ei').forEach((el) => el.classList.toggle('active', el.dataset.event === selectedKey))
  renderDetail()
}

// ─── right: event detail ────────────────────────────────────────────────────

function selectedEvent() {
  const d = lastData
  if (!d || !selectedKey) return null
  if (selectedKey === '_none') return d.unassigned
  return d.events.find((e) => e.key === selectedKey) || null
}

function renderDetail() {
  const box = q('#cc-detail')
  if (!box) return
  const e = selectedEvent()
  if (!e) { box.innerHTML = `<div class="rp-empty">${esc(t('plugin.cc.pickEvent'))}</div>`; return }
  const isNone = e.key === '_none'
  const head = `
    <button class="rp-btn-sm cc-back" data-act="back">← ${esc(t('plugin.cc.back'))}</button>
    <div class="cc-ed-head">
      <h3>${esc(eventTitle(e, isNone))}</h3>
      ${!isNone ? (e.url ? linkHtml(e.url, e.key, 'cc-key') : `<span class="cc-key">${esc(e.key)}</span>`) : ''}
      ${!isNone ? trackerBadge(e) : ''}
    </div>
    <div class="cc-ed-meta">
      ${e.state ? `<span class="cc-chip"><span class="cc-dot cc-st-${esc(e.state)}"></span>${esc(stateLabel(e.state))}</span>` : ''}
      ${e.progress ? `<span class="cc-chip">${esc(e.progress.basis === 'subissues' ? t('plugin.cc.progressSub', e.progress.done, e.progress.total) : t('plugin.cc.progressCars', e.progress.done, e.progress.total))}</span>` : ''}
      ${e.carsAvailable ? `<span class="cc-chip">${esc(t('plugin.cc.cars'))} ${e.carCount}</span>` : ''}
      ${e.startedAt ? `<span class="cc-chip">${esc(t('plugin.cc.started'))} ${esc(fmtTime(e.startedAt))}</span>` : ''}
      ${e.updatedAt ? `<span class="cc-chip">${esc(t('plugin.cc.updated'))} ${esc(fmtAgo(e.updatedAt))}</span>` : ''}
    </div>`
  const carsSrc = lastData.sources?.cars
  let body
  if (!carsSrc?.ok) {
    body = downBlock(t('plugin.cc.carsDown'), carsSrc)
  } else {
    body = `
      <div class="cc-sec-title">${esc(t('plugin.cc.gantt'))}</div>
      ${e.cars.length ? `<div class="cc-gantt" id="cc-gantt"></div>` : `<div class="rp-empty">${esc(t('plugin.cc.noCars'))}</div>`}
      <div class="cc-sec-title">${esc(t('plugin.cc.milestones'))}</div>
      ${milestonesHtml(e.milestones)}`
  }
  box.innerHTML = head + body
  renderGantt()
}

function milestonesHtml(ms) {
  if (!ms || !ms.length) return `<div class="rp-empty">${esc(t('plugin.cc.noMilestones'))}</div>`
  return `<ul class="cc-ms">${ms.map((m) => `
    <li class="cc-ms-${esc(m.kind)}"><span class="cc-ms-time">${esc(fmtTime(m.t))}</span><span class="cc-ms-car">${esc(m.car)}</span><span class="cc-ms-kind">${esc(kindLabel(m.kind))}</span><span class="cc-ms-label">${esc(m.label)}</span></li>`).join('')}</ul>`
}

// ─── gantt ──────────────────────────────────────────────────────────────────

function renderGantt() {
  const host = q('#cc-gantt')
  const e = selectedEvent()
  if (!host || !e) return
  const total = host.clientWidth
  if (!total) return
  const plotW = Math.max(40, total - LABEL_COL_PX - 14) // room for padding + edge point markers
  const now = Date.now()
  const rows = e.cars.map((c) => ({ id: c.traceId, start: c.start, end: c.end, endOpen: c.endOpen, points: c.points }))
  const win = ganttWindow(rows, now)
  const lay = layoutGantt(rows, { width: plotW, from: win.from, to: win.to, now })
  const ticks = lay.ticks.filter((tk) => tk.x >= TICK_EDGE_PX && tk.x <= plotW - TICK_EDGE_PX).map((tk) => `<span class="cc-tick" style="left:${tk.x.toFixed(1)}px">${esc(fmtTick(tk.t, lay.stepMin))}</span>`).join('')
  const nowLine = lay.nowX != null ? `<span class="cc-now" style="left:${lay.nowX.toFixed(1)}px" title="${esc(t('plugin.cc.now'))}"></span>` : ''
  const rowsHtml = e.cars.map((c, i) => {
    const r = lay.rows[i]
    const open = openCar === c.traceId
    const bar = r.invalid
      ? `<span class="cc-bar-invalid">${esc(t('plugin.cc.noStart'))}</span>`
      : `<span class="cc-bar cc-st-${esc(c.state)}${r.open ? ' cc-bar-open' : ''}${c.reason === 'superseded' ? ' cc-bar-superseded' : ''}" style="left:${r.x.toFixed(1)}px;width:${r.w.toFixed(1)}px"></span>` +
        r.points.map((p) => `<span class="cc-pt cc-pt-${esc(p.kind)}" style="left:${p.x.toFixed(1)}px" title="${esc(`${fmtTime(p.t)} ${kindLabel(p.kind)} ${p.label}`)}"></span>`).join('')
    return `
      <div class="cc-grow${open ? ' open' : ''}" data-car="${esc(c.traceId)}">
        <div class="cc-glabel" style="width:${LABEL_COL_PX}px" title="${esc(c.title)}"><span class="cc-dot cc-st-${esc(c.state)}"></span><span class="cc-gname">${esc(c.car)}</span></div>
        <div class="cc-gtrack" style="width:${plotW}px">${bar}</div>
      </div>
      ${open ? carDetailHtml(c) : ''}`
  }).join('')
  host.innerHTML = `
    <div class="cc-gaxis"><div style="width:${LABEL_COL_PX}px"></div><div class="cc-gticks" style="width:${plotW}px">${ticks}${nowLine}</div></div>
    ${rowsHtml}`
}

function carDetailHtml(c) {
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
      ${c.issue && c.issue !== selectedKey ? `<div class="cc-car-meta">${esc(t('plugin.cc.issue'))} ${esc(c.issue)}${c.issueInferred ? ` (${esc(t('plugin.cc.inferred'))})` : ''}</div>` : ''}
      ${c.plain ? `<div class="cc-car-plain">${esc(c.plain)}</div>` : ''}
      <div class="cc-car-sub">${esc(t('plugin.cc.lastMilestones'))}</div>
      ${ms.length ? `<ul class="cc-ms cc-ms-compact">${ms.map((m) => `<li><span class="cc-ms-time">${esc(fmtTime(m.t))}</span><span class="cc-ms-kind">${esc(kindLabel(m.kind))}</span><span class="cc-ms-label">${esc(m.label)}</span></li>`).join('')}</ul>` : `<div class="rp-empty">${esc(t('plugin.cc.noMilestones'))}</div>`}
      ${docs || prs || boards ? `<div class="cc-car-links">${docs}${prs}${boards}</div>` : ''}
      <div class="cc-car-trace">${esc(t('plugin.cc.traceId'))} <code>${esc(c.traceId)}</code>${c.parent ? ` · ${esc(t('plugin.cc.parent'))} <code>${esc(c.parent)}</code>${c.parentInferred ? ` (${esc(t('plugin.cc.inferred'))})` : ''}` : ''}${c.traceCmd ? ` · <code>${esc(c.traceCmd)}</code>` : ''}${c.sessions.length ? ` · ${esc(t('plugin.cc.sessions', c.sessions.length))}` : ''}</div>
    </div>`
}

function onDetailClick(ev) {
  const act = ev.target.closest('[data-act]')
  if (act?.dataset.act === 'back') {
    rootEl?.classList.remove('cc-show-detail')
    return
  }
  if (act?.dataset.act === 'doc') { openDoc(act.dataset.trace, act.dataset.kind); return }
  if (ev.target.closest('a')) return
  const row = ev.target.closest('.cc-grow')
  if (!row) return
  openCar = openCar === row.dataset.car ? null : row.dataset.car
  renderGantt()
}

async function openDoc(trace, kind) {
  const box = q('#cc-doc')
  if (!box) return
  q('#cc-doc-title').textContent = `${trace} · ${t(`plugin.cc.doc.${kind}`)}`
  q('#cc-doc-body').textContent = '…'
  box.hidden = false
  try {
    const r = await fetch(`/api/command-center/doc?trace=${encodeURIComponent(trace)}&kind=${encodeURIComponent(kind)}`)
    const txt = await r.text()
    q('#cc-doc-body').textContent = r.ok ? txt : `${t('plugin.cc.docError')}: ${txt}`
  } catch (err) {
    q('#cc-doc-body').textContent = `${t('plugin.cc.docError')}: ${err.message || err}`
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function stateLabel(st) { return t(`plugin.cc.state.${st}`) }

function kindLabel(k) {
  const key = `plugin.cc.kind.${k}`
  const v = t(key)
  return v === key ? k : v
}

function prNum(u) {
  const m = String(u).match(/\/pull\/(\d+)/)
  return m ? `#${m[1]}` : ''
}

function fmtTick(ms, stepMin) {
  const d = new Date(ms)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (stepMin >= 1440 || (d.getHours() === 0 && d.getMinutes() === 0)) return `${d.getMonth() + 1}-${pad2(d.getDate())}`
  return hm
}
