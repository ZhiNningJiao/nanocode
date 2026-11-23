/**
 * Cockpit (指挥舱) — the main layout Nanocode opens on (G4 design, owner 11-22).
 *
 * Page (under the shared app header, which keeps 工作区 ⇄ / theme / settings):
 *   - narrow icon rail: 首页 · 额度 · 机器 · 工作区 · 设置 (phone: bottom tab bar);
 *   - second column = 大事记流: every car milestone, newest first, by day →
 *     big event; clicking an item highlights its point on the gantt and back
 *     (one `pid` per milestone, cockpit-model.js);
 *   - home = the swimlane gantt (main piece: lane = big event, bar = car,
 *     dots = milestones, "now" line, dashed tail = expected finish), the 等你
 *     chips above it, 今日待批 / 等你的车 (with 批准 → secretary chat) and the
 *     machine board below; the six-pool available-quota curve is a small card
 *     in the top-right corner (a resource, not the main piece);
 *   - 额度 page = the same curve large (hover read-out per pool) + the
 *     per-pool detail (command-center-quota-panel.js — one quota panel);
 *   - chat drawer from the floating button (cc-chat plugin).
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
 * workspace, home / 额度) is per-device memory (localStorage).
 */
import { t } from './i18n.js'
import { updateSetting } from './api.js'
import { ensureCss, esc, fmtTime, degradeLineHtml } from './command-center-format.js'
import { initPluginState, isPluginEnabled, setPluginEnabled } from './right-panel.js'
import {
  COCKPIT_MODULES, COCKPIT_SETTING_KEY, normalizeLayout, serializeLayout, isModuleOn,
  setModuleOn, moveModule, modulesIn, moduleById, moduleByPlugin, normalizePage, normalizeMainView,
  startsExpanded, quoteText, normalizeSpan, buildFeed,
} from './cockpit-model.js'
import { sourcesHtml, ganttViewHtml, feedHtml, waitingChipsHtml, findCar } from './cockpit-views.js'
import { stateLabel } from './command-center-render.js'
import { quotaCardHtml, layoutQuotaCurve, quotaCurveSvg, quotaHoverHtml } from './cockpit-quota-curve.js'

const POLL_MS = 60_000
const MAIN_VIEW_KEY = 'cockpit:mainView'
const PAGE_KEY = 'cockpit:page'
const SPAN_KEY = 'cockpit:ganttSpan'
const FOLD_KEY = 'cockpit:fold' // { [eventKey]: true (open) | false (folded) } — only explicit user choices
const FEED_LIMIT = 150
const QCARD_PLOT_PX = 288
const NARROW_PX = 760

// plugin module loaders: the same module files the right panel lazy-loads
// (one ES module instance → one poll + one data cache for tab and cockpit)
const SIDE_LOADERS = {
  waiting: () => import('./command-center-waiting-panel.js'),
  quota: () => import('./command-center-quota-panel.js'),
  machines: () => import('./machines-panel.js'),
}
const CHAT_LOADER = () => import('./command-center-chat-drawer.js')

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  quota: '<svg viewBox="0 0 24 24"><polyline points="3 17 8 11 12 14 17 6 21 9"/><line x1="3" y1="21" x2="21" y2="21"/></svg>',
  machines: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/></svg>',
  workspace: '<svg viewBox="0 0 24 24"><polyline points="5 8 9 12 5 16"/><line x1="12" y1="16" x2="19" y2="16"/><rect x="2" y="3" width="20" height="18" rx="2"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  feed: '<svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
}

let layout = normalizeLayout(null)
let mainView = 'cockpit'
let page = 'home'
let span = 24
let fold = {}
let openCar = null
let selPid = null
let data = null
let dataError = null
let lastOkAt = null
let series = null // GET /api/command-center/quota/series body
let seriesError = null
let pollTimer = null
let inFlight = false
let root = null
let onEnterWorkspace = null
let resizeObs = null
let sideMounted = [] // [{ id, el, reset }]
let sideGen = 0 // bumps on every block re-render; a stale async render stops
let quotaDetail = null // { el, reset } while the 额度 page's per-pool panel is mounted
let saveState = { at: null, error: null }
let enterNext = true // next main render is an "entry" (page just shown), not a poll
let prevSig = new Map() // event key → signature at the previous render (data-change hook)
let countedUp = false

const ui = {
  isExpanded: (key, e) => (key in fold ? fold[key] : startsExpanded(e)),
  get openCar() { return openCar },
  get span() { return span },
  get selPid() { return selPid },
  now: null,
}
let ganttScrollLeft = null // narrow screens: the user's sideways scroll; null = follow "now"

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

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
  try { page = normalizePage(localStorage.getItem(PAGE_KEY)) } catch { page = 'home' }
  try { span = normalizeSpan(localStorage.getItem(SPAN_KEY)) } catch { span = 24 }
  try { fold = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {} } catch { fold = {} }
  initPluginState(serverSettings)
  applyServerLayout(serverSettings?.[COCKPIT_SETTING_KEY])
  document.addEventListener('nanocode:plugin-toggled', onPluginToggled)
  document.addEventListener('nanocode:cockpit-focus', (ev) => focusModule(ev.detail?.plugin))
  document.addEventListener('nanocode:cockpit-quote', (ev) => quoteTextIntoChat(ev.detail?.text))
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
    countedUp = false
    root.hidden = false
    renderBlocks()
    showPage(page)
    startPolling()
    await pollOnce()
  } else {
    if (root) root.hidden = true
    stopPolling()
    unmountBlocks()
    unmountQuotaDetail()
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
  if (mainView === 'cockpit' && root) { renderBlocks(); renderMain(); renderQuota(); if (page === 'quota') showPage('quota') }
  renderSettingsList()
}

// ─── DOM ────────────────────────────────────────────────────────────────────

function railBtn(id, label, attrs) {
  return `<button type="button" class="ck-rail-btn" ${attrs} title="${esc(label)}" aria-label="${esc(label)}">${ICONS[id]}<span class="ck-rail-txt">${esc(label)}</span></button>`
}

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
    <div class="ck-shell">
      <nav class="ck-rail" aria-label="${esc(t('cockpit.nav'))}">
        ${railBtn('home', t('cockpit.page.home'), 'data-page="home"')}
        ${railBtn('quota', t('cockpit.page.quota'), 'data-page="quota" data-module="quota"')}
        ${railBtn('machines', t('cockpit.mod.machines'), 'data-goto="machines" data-module="machines"')}
        <span class="ck-rail-sp"></span>
        ${railBtn('workspace', t('cockpit.toWorkspaceShort'), 'data-rail="workspace"')}
        ${railBtn('settings', t('settings.title'), 'data-rail="settings"')}
      </nav>
      <aside class="ck-feed" data-module="events" aria-label="${esc(t('cockpit.feed'))}">
        <div class="ck-feed-head"><span class="ck-feed-title">${esc(t('cockpit.feed'))}</span><span class="ck-feed-sub"></span><button type="button" class="rp-btn-sm ck-feed-close" aria-label="✕">✕</button></div>
        <div class="ck-feed-body"></div>
      </aside>
      <div class="ck-feed-backdrop"></div>
      <main class="ck-stage">
        <section class="ck-page" data-page="home">
          <div class="ck-hero">
            <div class="ck-hero-text">
              <h1 class="ck-hero-title">${esc(t('cockpit.title'))}</h1>
              <div class="ck-summary"></div>
            </div>
            <button type="button" class="ck-qcard" data-act="quota-page" data-module="quota" title="${esc(t('cockpit.q.open'))}"></button>
          </div>
          <div class="ck-asks"></div>
          <section class="ck-card ck-gantt-card" data-module="events">
            <div class="ck-card-head">
              <span class="ck-h-title">${esc(t('cockpit.gantt'))}</span>
              <button type="button" class="rp-btn-sm ck-feed-open">${ICONS.feed}${esc(t('cockpit.feed'))}</button>
              <span class="ck-legend">
                <span><i class="ck-lg cc-st-done"></i>${esc(t('cockpit.lg.done'))}</span>
                <span><i class="ck-lg cc-st-running"></i>${esc(t('cockpit.lg.run'))}</span>
                <span><i class="ck-lg cc-st-waiting_human"></i>${esc(t('cockpit.lg.wait'))}</span>
                <span><i class="ck-lg cc-dot cc-st-unknown"></i>${esc(t('cockpit.lg.pt'))}</span>
                <span><i class="ck-lg ck-lg-eta"></i>${esc(t('cockpit.eta'))}</span>
                <span><i class="ck-lg ck-lg-now"></i>${esc(t('plugin.cc.now'))}</span>
              </span>
              <button type="button" class="rp-btn-sm ck-refresh" title="${esc(t('plugin.cc.refresh'))}">↻</button>
            </div>
            <div class="ck-main-body"></div>
          </section>
          <div class="ck-blocks"></div>
        </section>
        <section class="ck-page" data-page="quota" hidden>
          <section class="ck-card ck-qbig-card">
            <div class="ck-card-head"><span class="ck-h-title">${esc(t('cockpit.q.bigTitle'))}</span><span class="cc-sub ck-qbig-sub"></span></div>
            <div class="ck-qbig"></div>
            <div class="ck-qtip" hidden></div>
            <div class="cc-sub ck-qbig-legend">${esc(t('cockpit.q.legend'))}</div>
          </section>
          <section class="ck-card ck-qdetail"></section>
        </section>
      </main>
    </div>
    <div class="cc-doc ck-doc" hidden>
      <div class="cc-doc-head"><span class="ck-doc-title"></span><button class="rp-btn-sm ck-doc-close">✕</button></div>
      <pre class="cc-doc-body ck-doc-body"></pre>
    </div>`
  root.querySelector('.ck-rail').addEventListener('click', onRailClick)
  root.querySelector('.ck-refresh').addEventListener('click', () => pollOnce())
  root.querySelector('.ck-stage').addEventListener('click', onMainClick)
  root.querySelector('.ck-feed-body').addEventListener('click', onMainClick)
  root.querySelector('.ck-feed-open').addEventListener('click', () => root.classList.add('ck-feed-shown'))
  root.querySelector('.ck-feed-close').addEventListener('click', () => root.classList.remove('ck-feed-shown'))
  root.querySelector('.ck-feed-backdrop').addEventListener('click', () => root.classList.remove('ck-feed-shown'))
  root.querySelector('.ck-doc-close').addEventListener('click', () => { root.querySelector('.ck-doc').hidden = true })
  const big = root.querySelector('.ck-qbig')
  big.addEventListener('pointermove', onQuotaHover)
  big.addEventListener('pointerleave', () => { root.querySelector('.ck-qtip').hidden = true; big.querySelector('.ck-qc-cursor')?.setAttribute('visibility', 'hidden') })
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !root) return
    if (!root.querySelector('.ck-doc').hidden) root.querySelector('.ck-doc').hidden = true
    root.classList.remove('ck-feed-shown')
  })
  if (typeof ResizeObserver === 'function') {
    let lastW = 0
    resizeObs = new ResizeObserver(() => {
      const w = mainBody()?.clientWidth || 0
      if (Math.abs(w - lastW) < 4) return
      lastW = w
      renderMain()
      if (page === 'quota') renderQuotaBig()
    })
    resizeObs.observe(root.querySelector('.ck-stage'))
  }
}

function mainBody() { return root?.querySelector('.ck-main-body') }

function onRailClick(ev) {
  const b = ev.target.closest('.ck-rail-btn')
  if (!b) return
  if (b.dataset.page) { showPage(b.dataset.page); return }
  if (b.dataset.goto) { showPage('home'); focusModule(moduleById(b.dataset.goto)?.plugin); return }
  if (b.dataset.rail === 'workspace') { setMainView('workspace'); return }
  if (b.dataset.rail === 'settings') document.getElementById('settings-toggle-btn')?.click()
}

function showPage(p) {
  page = normalizePage(p)
  if (page === 'quota' && !isModuleOn(layout, 'quota')) page = 'home'
  try { localStorage.setItem(PAGE_KEY, page) } catch {}
  if (!root) return
  root.querySelectorAll('.ck-page').forEach((el) => { el.hidden = el.dataset.page !== page })
  root.querySelectorAll('.ck-rail-btn[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page))
  root.querySelector('.ck-stage').scrollTop = 0
  if (page === 'quota') { renderQuotaBig(); mountQuotaDetail() } else unmountQuotaDetail()
  renderMain()
}

// ─── data ───────────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => { if (mainView === 'cockpit') pollOnce() }, POLL_MS)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function pollOnce() {
  if (inFlight) return
  inFlight = true
  const wantEvents = isModuleOn(layout, 'events')
  const wantQuota = isModuleOn(layout, 'quota')
  try {
    await Promise.all([
      wantEvents ? fetchJson('/api/command-center').then((d) => { data = d; dataError = null; lastOkAt = new Date().toISOString() }, (err) => { dataError = String(err.message || err) }) : null,
      wantQuota ? fetchJson('/api/command-center/quota/series').then((d) => { series = d; seriesError = null }, (err) => { seriesError = String(err.message || err) }) : null,
    ])
  } finally {
    inFlight = false
  }
  if (mainView === 'cockpit') { renderMain(); renderQuota() }
}

async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ─── home: hero, 等你 chips, gantt, feed ─────────────────────────────────────

function renderMain() {
  if (!root) return
  const now = Date.now() // one clock for the hero time, the gantt "now" line and the feed window
  ui.now = now
  const body = mainBody()
  const eventsOn = isModuleOn(layout, 'events')
  root.classList.toggle('ck-no-events', !eventsOn)
  const summary = root.querySelector('.ck-summary')
  const asks = root.querySelector('.ck-asks')
  const nowTxt = `<span class="ck-now-txt">${esc(t('plugin.cc.now'))} ${esc(fmtTime(new Date(now).toISOString()))}</span>`
  if (!eventsOn) {
    summary.innerHTML = nowTxt
    asks.innerHTML = ''
    body.innerHTML = `<div class="cc-note">${esc(t('cockpit.eventsOff'))}</div>`
    renderFeed()
    return
  }
  if (dataError) {
    // the whole endpoint is down: say so with the last success
    summary.innerHTML = nowTxt
    asks.innerHTML = ''
    body.innerHTML = degradeLineHtml(t('cockpit.eventsDown'), { lastOkAt, error: dataError })
    renderFeed()
    return
  }
  if (!data) { summary.innerHTML = nowTxt; body.innerHTML = '<div class="rp-empty">…</div>'; return }
  if (!data.configured) {
    summary.innerHTML = nowTxt
    asks.innerHTML = ''
    body.innerHTML = `<div class="cc-block-down">${esc(t('plugin.cc.notConfigured'))}<div class="cc-sub">${esc(data.error || '')}</div></div>`
    renderFeed()
    return
  }
  const s = data.summary || {}
  summary.innerHTML = [
    nowTxt,
    `<span>${esc(t('plugin.cc.sumEvents'))} <b>${s.events ?? 0}</b></span>`,
    `<span>${esc(t('plugin.cc.sumCars'))} <b>${s.cars ?? '—'}</b></span>`,
  ].join('<span class="ck-sep">·</span>')
  asks.innerHTML = waitingChipsHtml(data)
  if (page === 'home') {
    const width = body.clientWidth || 800
    body.innerHTML = sourcesHtml(data) + ganttViewHtml(data, ui, width)
    keepGanttScroll(body)
    markChanges(body)
    if (enterNext) {
      enterNext = false
      body.classList.add('ck-enter')
      setTimeout(() => body.classList.remove('ck-enter'), 1500)
    }
  }
  renderFeed()
  applySel()
}

// A sideways-scrolling gantt (phone) opens at "now" and keeps the user's own
// scroll across the 60 s re-renders.
function keepGanttScroll(body) {
  const sc = body.querySelector('.ck-gantt-scroll.ck-scroll')
  if (!sc) return
  const line = sc.querySelector('.cc-now-line')
  const target = ganttScrollLeft ?? (line ? parseFloat(line.style.left) - sc.clientWidth * 0.75 : sc.scrollWidth)
  sc.scrollLeft = Math.max(0, target)
  sc.addEventListener('scroll', () => { ganttScrollLeft = sc.scrollLeft }, { passive: true })
}

function renderFeed() {
  const el = root?.querySelector('.ck-feed-body')
  if (!el) return
  if (!isModuleOn(layout, 'events') || !data?.configured || dataError) {
    el.innerHTML = `<div class="rp-empty">${esc(dataError ? t('cockpit.eventsDown') : t('cockpit.feedEmpty'))}</div>`
    return
  }
  const fromMs = span ? (ui.now ?? Date.now()) - span * 3600_000 : -Infinity
  const days = buildFeed(data, { fromMs, limit: FEED_LIMIT })
  root.querySelector('.ck-feed-sub').textContent = t(`cockpit.span.${span}`)
  el.innerHTML = feedHtml(days, data, selPid)
}

// Skin hook: [data-changed] on lanes whose numbers moved since the last
// render (skins.css decides whether that shows; the classic skin ignores it).
function eventSig(e) {
  return [e.state, e.carCount, e.waitingCount, e.progress?.done, e.progress?.total, e.lastProgress?.t].join('|')
}

function markChanges(body) {
  const next = new Map()
  for (const e of [...(data.events || []), { ...(data.unassigned || {}), key: '_none' }]) next.set(e.key, eventSig(e))
  if (prevSig.size) {
    body.querySelectorAll('.ck-lane[data-event]').forEach((el) => {
      const k = el.dataset.event
      if (prevSig.has(k) && prevSig.get(k) !== next.get(k)) el.setAttribute('data-changed', '')
    })
  }
  prevSig = next
}

/** Highlight the selected milestone on both sides (survives re-renders). */
function applySel() {
  if (!root) return
  root.querySelectorAll('.cc-pt.sel, .ck-fi.sel').forEach((el) => el.classList.remove('sel'))
  if (!selPid) return
  root.querySelectorAll(`[data-pid="${CSS.escape(selPid)}"]`).forEach((el) => el.classList.add('sel'))
}

function selectPoint(pid, fromFeed, eventKey) {
  selPid = selPid === pid ? null : pid
  if (fromFeed && selPid && page === 'home') renderMain() // a thinned lane re-draws the selected point
  applySel()
  if (!selPid) return
  if (fromFeed) {
    let pt = mainBody()?.querySelector(`.cc-pt[data-pid="${CSS.escape(pid)}"]`)
    if (!pt && eventKey && !(eventKey in fold && fold[eventKey])) {
      // not drawn on the folded lane: unfold it so the car row shows the point
      fold[eventKey] = true
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(fold)) } catch {}
      renderMain()
      pt = mainBody()?.querySelector(`.cc-pt[data-pid="${CSS.escape(pid)}"]`)
    }
    if (pt) {
      pt.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
      flashEl(pt.closest('.ck-lane, .cc-grow'))
    } else flash(t('cockpit.ptOffscreen'))
    if (root.classList.contains('ck-feed-shown') && window.innerWidth < NARROW_PX) root.classList.remove('ck-feed-shown')
  } else {
    const fi = root.querySelector(`.ck-fi[data-pid="${CSS.escape(pid)}"]`)
    if (fi) fi.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }
}

function flashEl(el) {
  if (!el) return
  el.classList.add('ck-flash')
  setTimeout(() => el.classList.remove('ck-flash'), 1200)
}

function openLane(key) {
  if (!key) return
  if (page !== 'home') showPage('home')
  fold[key] = true
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(fold)) } catch {}
  renderMain()
  const lane = mainBody()?.querySelector(`.ck-lane[data-event="${CSS.escape(key)}"]`)
  if (lane) { lane.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); flashEl(lane) }
  root.classList.remove('ck-feed-shown')
}

function onMainClick(ev) {
  const act = ev.target.closest('[data-act]')
  if (!act || ev.target.closest('a')) return
  const kind = act.dataset.act
  if (kind === 'quote') { ev.stopPropagation(); quote(act.dataset.kind, act.dataset.key); return }
  if (kind === 'doc') { openDoc(act.dataset.trace, act.dataset.kind); return }
  if (kind === 'quota-page') { showPage('quota'); return }
  if (kind === 'pt') { ev.stopPropagation(); selectPoint(act.dataset.pid, !!act.closest('.ck-feed'), act.dataset.event); return }
  if (kind === 'ask') { openLane(act.dataset.event); return }
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

// ─── quota: home card + 额度 page ───────────────────────────────────────────

function seriesRes() {
  if (seriesError && !series) return { configured: true, source: { ok: false, error: seriesError } }
  return series
}

function renderQuota() {
  const card = root?.querySelector('.ck-qcard')
  if (!card) return
  const on = isModuleOn(layout, 'quota')
  card.hidden = !on
  root.querySelector('.ck-rail-btn[data-page="quota"]').hidden = !on
  if (!on) return
  const res = seriesRes()
  const lay = res?.configured && res.source?.ok ? layoutQuotaCurve(res, { width: QCARD_PLOT_PX, height: 58 }) : null
  card.className = `ck-qcard ck-q-${lay ? lay.level : 'none'}`
  card.innerHTML = quotaCardHtml(res, QCARD_PLOT_PX)
  countUp(card.querySelector('.ck-qcard-num'))
  if (page === 'quota') renderQuotaBig()
}

// cheap motion: the number rolls up once per cockpit entry (off with reduced motion)
function countUp(el) {
  const target = Number(el?.dataset.count)
  if (!el || !Number.isFinite(target) || countedUp || reducedMotion() || typeof requestAnimationFrame !== 'function') return
  countedUp = true
  const t0 = performance.now()
  const step = (ts) => {
    const k = Math.min(1, (ts - t0) / 700)
    el.textContent = (target * (1 - (1 - k) ** 3)).toFixed(1)
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

let bigLay = null
function renderQuotaBig() {
  const box = root?.querySelector('.ck-qbig')
  if (!box) return
  const res = seriesRes()
  const sub = root.querySelector('.ck-qbig-sub')
  if (!res) { box.innerHTML = '<div class="rp-empty">…</div>'; return }
  if (!res.configured || !res.source?.ok) {
    bigLay = null
    sub.textContent = ''
    box.innerHTML = `<div class="cc-block-down">${esc(t('cockpit.q.down'))}<div class="cc-sub">${esc(res.error || res.source?.error || '')}</div></div>`
    return
  }
  const width = Math.max(300, box.clientWidth || 800)
  bigLay = layoutQuotaCurve(res, { width, height: width < 600 ? 200 : 260, pad: 16 })
  sub.textContent = t('cockpit.q.bigSub', bigLay.totalNow == null ? '—' : bigLay.totalNow.toFixed(1), bigLay.poolCount, res.resets.length)
  box.innerHTML = quotaCurveSvg(bigLay, { big: true })
}

function onQuotaHover(ev) {
  const svg = root.querySelector('.ck-qbig svg')
  const res = seriesRes()
  if (!svg || !bigLay || !res?.points) return
  const rect = svg.getBoundingClientRect()
  const x = ((ev.clientX - rect.left) / rect.width) * bigLay.width
  const hit = quotaHoverHtml(res, bigLay, x)
  const tip = root.querySelector('.ck-qtip')
  const cursor = svg.querySelector('.ck-qc-cursor')
  if (!hit) { tip.hidden = true; cursor?.setAttribute('visibility', 'hidden'); return }
  cursor?.setAttribute('x1', hit.x.toFixed(1))
  cursor?.setAttribute('x2', hit.x.toFixed(1))
  cursor?.setAttribute('visibility', 'visible')
  tip.innerHTML = hit.html
  tip.hidden = false
  const px = (hit.x / bigLay.width) * rect.width
  tip.style.left = `${Math.min(Math.max(0, px + 12), rect.width - tip.offsetWidth)}px`
}

async function mountQuotaDetail() {
  const el = root?.querySelector('.ck-qdetail')
  if (!el || quotaDetail) return
  quotaDetail = { el, reset: null }
  const mod = await SIDE_LOADERS.quota()
  if (!quotaDetail || page !== 'quota' || mainView !== 'cockpit') return
  mod.renderQuotaPane(el)
  quotaDetail.reset = mod.resetQuotaLoadState
}

function unmountQuotaDetail() {
  if (!quotaDetail) return
  quotaDetail.reset?.(quotaDetail.el)
  quotaDetail.el.replaceChildren()
  quotaDetail = null
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
  await quoteTextIntoChat(text)
}

/** One line into the secretary chat (quote buttons, 批准). Never sends by itself. */
async function quoteTextIntoChat(text) {
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

// ─── home blocks: 今日待批 / 等你的车 / 机器 (module order from settings) ─────

function unmountBlocks() {
  sideGen++
  for (const s of sideMounted) s.reset?.(s.el)
  sideMounted = []
  root?.querySelector('.ck-blocks')?.replaceChildren()
}

async function renderBlocks() {
  if (!root) return
  unmountBlocks()
  const gen = ++sideGen
  const wrap = root.querySelector('.ck-blocks')
  // the quota module is the top-right card + the 额度 page, not a block here
  const mods = modulesIn(layout, 'side').filter((m) => m.id !== 'quota')
  root.querySelector('.ck-rail-btn[data-goto="machines"]').hidden = !mods.some((m) => m.id === 'machines')
  for (const m of mods) {
    const blocks = m.id === 'waiting'
      ? [{ only: 'owner', title: t('cockpit.pending') }, { only: 'cars', title: t('cockpit.waitingCars') }]
      : [{}]
    for (const b of blocks) {
      const el = document.createElement('section')
      el.className = `ck-card ck-block ck-block-${m.id}${b.only ? `-${b.only}` : ''}`
      el.dataset.module = m.id
      if (m.id === 'machines') el.innerHTML = `<div class="ck-card-head"><span class="ck-h-title">${esc(t('cockpit.machinesTitle'))}</span><span class="cc-sub">${esc(t('cockpit.machinesSub'))}</span></div><div class="ck-block-body"></div>`
      wrap.appendChild(el)
      const mod = await SIDE_LOADERS[m.id]()
      if (gen !== sideGen || mainView !== 'cockpit' || !el.isConnected) return // switched away / re-rendered while loading
      if (m.id === 'waiting') { mod.renderWaitingPane(el, b); sideMounted.push({ id: m.id, el, reset: mod.resetWaitingLoadState }) }
      if (m.id === 'machines') {
        const target = el.querySelector('.ck-block-body')
        mod.renderMachinesPane(target)
        sideMounted.push({ id: m.id, el: target, reset: mod.resetMachinesLoadState })
        // compact cards on the home page; a click opens one card's full detail
        target.addEventListener('click', (ev) => ev.target.closest('.mach-card')?.classList.toggle('mach-card-open'))
      }
    }
  }
}

function focusModule(plugin) {
  const m = moduleByPlugin(plugin)
  if (!m || !root) return
  if (m.id === 'quota') { showPage('quota'); return }
  const el = root.querySelector(`.ck-stage [data-module="${m.id}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
  flashEl(el)
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
  if (mainView === 'cockpit' && root) renderBlocks()
}

function onSettingsChange(ev) {
  const box = ev.target.closest('.ck-set-on')
  if (!box) return
  const id = box.closest('[data-module]').dataset.module
  // the plugin flag is the switch; onPluginToggled saves + re-renders
  setPluginEnabled(moduleById(id).plugin, box.checked)
}
