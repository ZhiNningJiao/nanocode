/**
 * Cockpit (指挥舱) — the main layout Nanocode opens on.
 *
 * Page:  app header (shared with the workspace: 等你 / 额度 / 机器 chips,
 *        "工作区" switch, settings) · main area = big events (views: list /
 *        swimlane gantt / node graph) · side column = 今日待批, 等你, 额度,
 *        机器 · chat drawer from the floating button (cc-chat plugin).
 *
 * The old workspace (tabs / terminals / files) is never torn down: switching
 * only flips body.cockpit-active, which hides the workspace layer (visibility,
 * so sizes and WebSocket sessions stay as they are) and shows this one. The
 * workspace is first initialised the first time the user switches to it, so
 * the cockpit's first screen never touches the session / history endpoints.
 *
 * Settings: each module IS a plugin (cockpit-model.js COCKPIT_MODULES), so its
 * on/off is that plugin's enabled flag (right-panel.js) — one switch; order +
 * on/off are saved on the server (`cockpit_layout`). Which page (cockpit /
 * workspace) and which view (list / gantt / graph) are per-device memory
 * (localStorage), restored on reload.
 */
import { t } from './i18n.js'
import { updateSetting } from './api.js'
import { ensureCss, esc, fmtTime, fmtAgo } from './command-center-format.js'
import { initPluginState, isPluginEnabled, setPluginEnabled } from './right-panel.js'
import {
  COCKPIT_MODULES, COCKPIT_SETTING_KEY, COCKPIT_VIEWS, normalizeLayout, serializeLayout, isModuleOn,
  setModuleOn, moveModule, modulesIn, moduleById, moduleByPlugin, normalizeView, normalizeMainView,
  startsExpanded, quoteText, normalizeSpan,
} from './cockpit-model.js'
import { sourcesHtml, listViewHtml, ganttViewHtml, graphViewHtml, findCar } from './cockpit-views.js'
import { stateLabel } from './command-center-render.js'

const POLL_MS = 60_000
const MAIN_VIEW_KEY = 'cockpit:mainView'
const VIEW_KEY = 'cockpit:view'
const SPAN_KEY = 'cockpit:ganttSpan'
const FOLD_KEY = 'cockpit:fold' // { [eventKey]: true (open) | false (folded) } — only explicit user choices

// plugin module loaders: the same module files the right panel lazy-loads
// (one ES module instance → one poll + one data cache for tab and cockpit)
const SIDE_LOADERS = {
  waiting: () => import('./command-center-waiting-panel.js'),
  quota: () => import('./command-center-quota-panel.js'),
  machines: () => import('./machines-panel.js'),
}
const CHAT_LOADER = () => import('./command-center-chat-drawer.js')

let layout = normalizeLayout(null)
let mainView = 'cockpit'
let view = 'list'
let span = 24
let fold = {}
let openCar = null
let data = null
let dataError = null
let lastOkAt = null
let pollTimer = null
let inFlight = false
let root = null
let onEnterWorkspace = null
let resizeObs = null
let sideMounted = [] // [{ id, el, reset }]
let sideGen = 0 // bumps on every side re-render; a stale async render stops
let saveState = { at: null, error: null }
let enterNext = true // next main render is an "entry" (page / view just shown), not a poll
let prevSig = new Map() // event key → signature at the previous render (data-change hook)

const ui = {
  isExpanded: (key, e) => (key in fold ? fold[key] : startsExpanded(e)),
  get openCar() { return openCar },
  get span() { return span },
}

// ─── init / page switch ─────────────────────────────────────────────────────

/**
 * Called once by app.js after GET /api/settings. `enterWorkspace()` runs the
 * old routing the first time the workspace is shown (and on later hash changes).
 */
export function initCockpit({ serverSettings, enterWorkspace }) {
  onEnterWorkspace = enterWorkspace
  // The server keeps index.html in memory from its start while JS comes fresh
  // from disk: a server that was not restarted after an install serves the old
  // page (no cockpit layer, no page switch). Then behave exactly like before —
  // old workspace, no plugin / layout changes — until the restart.
  if (!document.getElementById('cockpit') || !document.getElementById('main-view-toggle')) {
    mainView = 'workspace'
    document.documentElement.classList.remove('cockpit-boot')
    return enterWorkspace({ initial: true })
  }
  try { mainView = normalizeMainView(localStorage.getItem(MAIN_VIEW_KEY)) } catch { mainView = 'cockpit' }
  try { view = normalizeView(localStorage.getItem(VIEW_KEY)) } catch { view = 'list' }
  try { span = normalizeSpan(localStorage.getItem(SPAN_KEY)) } catch { span = 24 }
  try { fold = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {} } catch { fold = {} }
  initPluginState(serverSettings)
  applyServerLayout(serverSettings?.[COCKPIT_SETTING_KEY])
  document.addEventListener('nanocode:plugin-toggled', onPluginToggled)
  document.addEventListener('nanocode:cockpit-focus', (ev) => focusModule(ev.detail?.plugin))
  wireHeaderSwitch()
  return setMainView(mainView, { initial: true })
}

export function isCockpitActive() { return mainView === 'cockpit' }

/** Switch page from outside (app.js routing). */
export function showMainView(v) { return setMainView(v) }

async function setMainView(v, { initial = false } = {}) {
  mainView = normalizeMainView(v)
  try { localStorage.setItem(MAIN_VIEW_KEY, mainView) } catch {}
  document.body.classList.toggle('cockpit-active', mainView === 'cockpit')
  document.documentElement.classList.remove('cockpit-boot')
  updateHeaderSwitch()
  if (mainView === 'cockpit') {
    ensureRoot()
    enterNext = true
    root.hidden = false
    renderSide()
    renderMain()
    startPolling()
    await pollOnce()
  } else {
    if (root) root.hidden = true
    stopPolling()
    unmountSide()
    if (onEnterWorkspace) await onEnterWorkspace({ initial })
  }
}

function wireHeaderSwitch() {
  const btn = document.getElementById('main-view-toggle')
  if (!btn || btn.dataset.wired) return
  btn.dataset.wired = '1'
  btn.addEventListener('click', () => setMainView(mainView === 'cockpit' ? 'workspace' : 'cockpit'))
}

function updateHeaderSwitch() {
  const btn = document.getElementById('main-view-toggle')
  if (!btn) return
  const toWorkspace = mainView === 'cockpit'
  btn.textContent = toWorkspace ? t('cockpit.toWorkspace') : t('cockpit.toCockpit')
  btn.title = toWorkspace ? t('cockpit.toWorkspaceTitle') : t('cockpit.toCockpitTitle')
  btn.classList.toggle('active', !toWorkspace)
}

// ─── layout setting (server) ────────────────────────────────────────────────

function applyServerLayout(raw) {
  layout = normalizeLayout(raw)
  if (!layout.seeded) {
    // first run: modules follow the plugin switch (kernel plugins are on by
    // default; the machine board is an optional plugin and starts off)
    layout = { ...layout, off: COCKPIT_MODULES.filter((m) => !isPluginEnabled(m.plugin)).map((m) => m.id) }
    saveLayout()
    return
  }
  for (const m of COCKPIT_MODULES) setPluginEnabled(m.plugin, isModuleOn(layout, m.id))
}

async function saveLayout() {
  try {
    await updateSetting(COCKPIT_SETTING_KEY, serializeLayout(layout))
    layout = { ...layout, seeded: true }
    saveState = { at: new Date().toISOString(), error: null }
  } catch (err) {
    saveState = { at: saveState.at, error: String(err.message || err) }
  }
  renderSettingsStatus()
}

function onPluginToggled(ev) {
  const m = moduleByPlugin(ev.detail?.name)
  if (!m) return
  const on = !!ev.detail.on
  if (isModuleOn(layout, m.id) !== on) {
    layout = setModuleOn(layout, m.id, on)
    saveLayout()
  }
  if (mainView === 'cockpit' && root) { renderSide(); renderMain() }
  renderSettingsList()
}

// ─── DOM ────────────────────────────────────────────────────────────────────

function ensureRoot() {
  if (root) return
  ensureCss()
  root = document.getElementById('cockpit')
  if (!root) {
    root = document.createElement('div')
    root.id = 'cockpit'
    document.body.appendChild(root)
  }
  root.className = 'cockpit'
  root.innerHTML = `
    <div class="ck-grid">
      <section class="ck-main" data-module="events">
        <div class="ck-main-head">
          <span class="ck-h-title">${esc(t('cockpit.events'))}</span>
          <span class="ck-summary"></span>
          <span class="ck-views" role="tablist">${COCKPIT_VIEWS.map((v) => `<button type="button" class="ck-view-btn" data-view="${v}" role="tab">${esc(t(`cockpit.view.${v}`))}</button>`).join('')}</span>
          <button type="button" class="rp-btn-sm ck-refresh" title="${esc(t('plugin.cc.refresh'))}">↻</button>
        </div>
        <div class="ck-main-body"></div>
      </section>
      <aside class="ck-side"></aside>
    </div>
    <div class="cc-doc ck-doc" hidden>
      <div class="cc-doc-head"><span class="ck-doc-title"></span><button class="rp-btn-sm ck-doc-close">✕</button></div>
      <pre class="cc-doc-body ck-doc-body"></pre>
    </div>`
  root.querySelector('.ck-views').addEventListener('click', (ev) => {
    const b = ev.target.closest('.ck-view-btn')
    if (b) setView(b.dataset.view)
  })
  root.querySelector('.ck-refresh').addEventListener('click', () => pollOnce())
  root.querySelector('.ck-main-body').addEventListener('click', onMainClick)
  root.querySelector('.ck-doc-close').addEventListener('click', () => { root.querySelector('.ck-doc').hidden = true })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && root && !root.querySelector('.ck-doc').hidden) root.querySelector('.ck-doc').hidden = true
  })
  if (typeof ResizeObserver === 'function') {
    let lastW = 0
    resizeObs = new ResizeObserver(() => {
      const w = mainBody()?.clientWidth || 0
      if (Math.abs(w - lastW) < 4) return
      lastW = w
      if (view !== 'list') renderMain()
    })
    resizeObs.observe(root.querySelector('.ck-main-body'))
  }
}

function mainBody() { return root?.querySelector('.ck-main-body') }

function setView(v) {
  enterNext = true
  view = normalizeView(v)
  try { localStorage.setItem(VIEW_KEY, view) } catch {}
  renderMain()
}

// ─── data ───────────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => { if (mainView === 'cockpit' && isModuleOn(layout, 'events')) pollOnce() }, POLL_MS)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function pollOnce() {
  if (inFlight || !isModuleOn(layout, 'events')) return
  inFlight = true
  try {
    const r = await fetch('/api/command-center')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    data = await r.json()
    dataError = null
    lastOkAt = new Date().toISOString()
  } catch (err) {
    dataError = String(err.message || err)
  } finally {
    inFlight = false
  }
  if (mainView === 'cockpit') renderMain()
}

// ─── main area ──────────────────────────────────────────────────────────────

function renderMain() {
  if (!root) return
  const body = mainBody()
  const head = root.querySelector('.ck-main-head')
  root.querySelectorAll('.ck-view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  root.classList.toggle('ck-no-events', !isModuleOn(layout, 'events'))
  if (!isModuleOn(layout, 'events')) {
    head.querySelector('.ck-summary').innerHTML = ''
    body.innerHTML = `<div class="cc-note">${esc(t('cockpit.eventsOff'))}</div>`
    return
  }
  const summary = head.querySelector('.ck-summary')
  if (dataError) {
    // the whole endpoint is down: say so with the last success; keep any old view visibly marked
    summary.innerHTML = ''
    const last = lastOkAt ? `${fmtTime(lastOkAt)}（${fmtAgo(lastOkAt)}）` : t('plugin.cc.never')
    body.innerHTML = `<div class="cc-block-down"><span class="service-dot down"></span> ${esc(t('cockpit.eventsDown'))}<div class="cc-sub">${esc(t('plugin.cc.lastSuccess'))}: ${esc(last)}</div><div class="cc-sub cc-err">${esc(dataError)}</div></div>`
    return
  }
  if (!data) { body.innerHTML = `<div class="rp-empty">…</div>`; return }
  if (!data.configured) {
    summary.innerHTML = ''
    body.innerHTML = `<div class="cc-block-down">${esc(t('plugin.cc.notConfigured'))}<div class="cc-sub">${esc(data.error || '')}</div></div>`
    return
  }
  const s = data.summary || {}
  summary.innerHTML = [
    s.waiting ? `<span class="cc-wait-badge">${esc(t('plugin.cc.waitingYou'))} ${s.waiting}</span>` : '',
    `<span class="cc-chip">${esc(t('plugin.cc.sumEvents'))} <b>${s.events ?? 0}</b></span>`,
    `<span class="cc-chip">${esc(t('plugin.cc.sumCars'))} <b>${s.cars ?? '—'}</b></span>`,
  ].join('')
  const width = body.clientWidth || 800
  const html = view === 'gantt' ? ganttViewHtml(data, ui, width)
    : view === 'graph' ? graphViewHtml(data, ui, width)
    : listViewHtml(data, ui)
  body.innerHTML = sourcesHtml(data) + html
  markChanges(body)
  if (enterNext) {
    enterNext = false
    body.classList.add('ck-enter')
    setTimeout(() => body.classList.remove('ck-enter'), 1500)
  }
}

// Skin hook: [data-changed] on cards / lanes whose numbers moved since the last
// render (skins.css decides whether that shows; the classic skin ignores it).
function eventSig(e) {
  return [e.state, e.carCount, e.waitingCount, e.progress?.done, e.progress?.total, e.lastProgress?.t].join('|')
}

function markChanges(body) {
  const next = new Map()
  for (const e of [...(data.events || []), { ...(data.unassigned || {}), key: '_none' }]) next.set(e.key, eventSig(e))
  if (prevSig.size) {
    body.querySelectorAll('.ck-ev[data-event], .ck-lane[data-event]').forEach((el) => {
      const k = el.dataset.event
      if (prevSig.has(k) && prevSig.get(k) !== next.get(k)) el.setAttribute('data-changed', '')
    })
  }
  prevSig = next
}

function onMainClick(ev) {
  const act = ev.target.closest('[data-act]')
  if (!act || ev.target.closest('a')) return
  const kind = act.dataset.act
  if (kind === 'quote') { ev.stopPropagation(); quote(act.dataset.kind, act.dataset.key); return }
  if (kind === 'doc') { openDoc(act.dataset.trace, act.dataset.kind); return }
  if (kind === 'span') {
    span = normalizeSpan(act.dataset.span)
    try { localStorage.setItem(SPAN_KEY, String(span)) } catch {}
    renderMain()
    return
  }
  if (kind === 'toggle') {
    const key = act.dataset.event || act.closest('[data-event]')?.dataset.event
    const e = data && [...(data.events || []), { ...(data.unassigned || {}), key: '_none' }].find((x) => x.key === key)
    fold[key] = !ui.isExpanded(key, e)
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(fold)) } catch {}
    renderMain()
    return
  }
  if (kind === 'car') {
    if (ev.target.closest('.cc-car')) return // clicks inside the open card (text selection, buttons)
    openCar = openCar === act.dataset.car ? null : act.dataset.car
    renderMain()
    return
  }
  if (kind === 'focus') {
    // node graph → the same event, unfolded, in the list
    const key = act.dataset.event
    fold[key] = true
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(fold)) } catch {}
    setView('list')
    root.querySelector(`.ck-ev[data-event="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
}

async function openDoc(trace, kind) {
  const box = root.querySelector('.ck-doc')
  root.querySelector('.ck-doc-title').textContent = `${trace} · ${t(`plugin.cc.doc.${kind}`)}`
  const body = root.querySelector('.ck-doc-body')
  body.textContent = '…'
  box.hidden = false
  try {
    const r = await fetch(`/api/command-center/doc?trace=${encodeURIComponent(trace)}&kind=${encodeURIComponent(kind)}`)
    const txt = await r.text()
    body.textContent = r.ok ? txt : `${t('plugin.cc.docError')}: ${txt}`
  } catch (err) {
    body.textContent = `${t('plugin.cc.docError')}: ${err.message || err}`
  }
}

// ─── quote into chat (PRD P0-6) ─────────────────────────────────────────────

const QUOTE_WORDS = {
  get event() { return t('cockpit.q.event') },
  get car() { return t('cockpit.q.car') },
  get cars() { return t('plugin.cc.cars') },
  get waiting() { return t('plugin.cc.waitingYou') },
  get last() { return t('cockpit.q.last') },
  get issue() { return t('plugin.cc.issue') },
  get unassigned() { return t('plugin.cc.unassigned') },
  state: (st) => stateLabel(st),
}

async function quote(kind, key) {
  if (!data) return
  let text = null
  if (kind === 'event') {
    const e = key === '_none' ? { ...data.unassigned, key: '_none', unassigned: true } : (data.events || []).find((x) => x.key === key)
    if (e) text = quoteText('event', e, QUOTE_WORDS)
  } else {
    const hit = findCar(data, key)
    if (hit) text = quoteText('car', hit.car, QUOTE_WORDS)
  }
  if (!text) return
  if (!isModuleOn(layout, 'chat')) { flash(t('cockpit.chatOff')); return }
  const m = await CHAT_LOADER()
  if (!m.quoteIntoChat(text)) flash(t('cockpit.chatOff'))
}

function flash(msg) {
  let el = document.querySelector('.ck-toast')
  if (!el) {
    el = document.createElement('div')
    el.className = 'ck-toast'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.hidden = false
  clearTimeout(flash._t)
  flash._t = setTimeout(() => { el.hidden = true }, 3500)
}

// ─── side column ────────────────────────────────────────────────────────────

function unmountSide() {
  sideGen++
  for (const s of sideMounted) s.reset?.(s.el)
  sideMounted = []
  root?.querySelector('.ck-side')?.replaceChildren()
}

async function renderSide() {
  if (!root) return
  unmountSide()
  const gen = ++sideGen
  const side = root.querySelector('.ck-side')
  const mods = modulesIn(layout, 'side')
  root.classList.toggle('ck-no-side', !mods.length)
  // phone: the side column comes first (等你 → 额度 → 大事件, PRD P0-9) — CSS order
  for (const m of mods) {
    const blocks = m.id === 'waiting'
      ? [{ only: 'owner', title: t('cockpit.pending') }, { only: 'cars', title: t('cockpit.waitingCars') }]
      : [{}]
    for (const b of blocks) {
      const el = document.createElement('div')
      el.className = `ck-block ck-block-${m.id}${b.only ? `-${b.only}` : ''}`
      el.dataset.module = m.id
      if (m.id === 'machines') el.innerHTML = `<div class="cc-mod-head"><span class="cc-top-title">${esc(t('plugin.machines.label'))}</span></div><div class="ck-block-body"></div>`
      side.appendChild(el)
      const mod = await SIDE_LOADERS[m.id]()
      if (gen !== sideGen || mainView !== 'cockpit' || !el.isConnected) return // switched away / re-rendered while loading
      if (m.id === 'waiting') { mod.renderWaitingPane(el, b); sideMounted.push({ id: m.id, el, reset: mod.resetWaitingLoadState }) }
      if (m.id === 'quota') { mod.renderQuotaPane(el); sideMounted.push({ id: m.id, el, reset: mod.resetQuotaLoadState }) }
      if (m.id === 'machines') {
        const target = el.querySelector('.ck-block-body')
        mod.renderMachinesPane(target)
        sideMounted.push({ id: m.id, el: target, reset: mod.resetMachinesLoadState })
      }
    }
  }
}

function focusModule(plugin) {
  const m = moduleByPlugin(plugin)
  if (!m || !root) return
  const el = root.querySelector(`[data-module="${m.id}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  el.classList.add('ck-flash')
  setTimeout(() => el.classList.remove('ck-flash'), 1200)
}

// ─── settings section (settings panel → 指挥舱) ─────────────────────────────

let settingsEl = null

/** Render the module list (on/off + order) into the settings panel section. */
export function renderCockpitSettings(container) {
  if (!container) return
  settingsEl = container
  if (!container.dataset.wired) {
    container.dataset.wired = '1'
    container.addEventListener('click', onSettingsClick)
    container.addEventListener('change', onSettingsChange)
  }
  renderSettingsList()
}

function renderSettingsList() {
  if (!settingsEl) return
  const rows = layout.order.map((id, i) => {
    const m = moduleById(id)
    const on = isPluginEnabled(m.plugin)
    return `
      <div class="ck-set-row" data-module="${id}">
        <label class="toggle-label"><input type="checkbox" class="ck-set-on" ${on ? 'checked' : ''} /> <span>${esc(t(`cockpit.mod.${id}`))}</span></label>
        <span class="ck-set-desc">${esc(t(`cockpit.modDesc.${id}`))}</span>
        <span class="ck-set-move">
          <button type="button" class="rp-btn-sm" data-move="-1" ${i === 0 ? 'disabled' : ''} title="${esc(t('cockpit.up'))}">↑</button>
          <button type="button" class="rp-btn-sm" data-move="1" ${i === layout.order.length - 1 ? 'disabled' : ''} title="${esc(t('cockpit.down'))}">↓</button>
        </span>
      </div>`
  }).join('')
  settingsEl.innerHTML = `<div class="ck-set-list">${rows}</div><div class="settings-status ck-set-status"></div>`
  renderSettingsStatus()
}

function renderSettingsStatus() {
  const el = settingsEl?.querySelector('.ck-set-status')
  if (!el) return
  el.classList.toggle('ck-set-err', !!saveState.error)
  el.textContent = saveState.error ? t('cockpit.saveFailed', saveState.error)
    : saveState.at ? t('cockpit.saved', fmtTime(saveState.at)) : t('cockpit.savedHint')
}

function onSettingsClick(ev) {
  const b = ev.target.closest('[data-move]')
  if (!b) return
  const id = b.closest('[data-module]').dataset.module
  layout = moveModule(layout, id, Number(b.dataset.move))
  saveLayout()
  renderSettingsList()
  if (mainView === 'cockpit' && root) renderSide()
}

function onSettingsChange(ev) {
  const box = ev.target.closest('.ck-set-on')
  if (!box) return
  const id = box.closest('[data-module]').dataset.module
  // the plugin flag is the switch; onPluginToggled saves + re-renders
  setPluginEnabled(moduleById(id).plugin, box.checked)
}
