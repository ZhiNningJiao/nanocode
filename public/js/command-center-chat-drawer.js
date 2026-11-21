/**
 * Command Center P0-6 — chat drawer with the secretary on duty.
 *
 * A floating button (global mount while the plugin is enabled) pulls out a
 * drawer that does NOT take part in the main layout. The drawer never starts
 * a session: it attaches a second view to the duty secretary's EXISTING agent
 * tab, the same way another device does —
 *   1. GET /api/duty → { duty: { project, tab, team, since } }
 *      (written by the secretary hand-off script);
 *   2. GET /api/projects/:project/tabs → the tab must exist in the store and be
 *      an agent tab in block mode (otherwise the server would route the attach
 *      elsewhere or, for an unknown tab id, start a fresh session — so we stop
 *      and say why);
 *   3. mount the same renderer the main tab uses (ClaudeBlockRenderer for
 *      claude / fable5 / opencode, CodexBlockRenderer for codex block mode) and
 *      send through its sendInputWithEcho().
 * The duty is re-read every time the drawer opens; closing disposes the view
 * (the session itself is untouched).
 */
import { t } from './i18n.js'
import { ensureCss, esc, downBlock } from './command-center-format.js'

let fab = null
let drawer = null
let view = null // { renderer, tabId }
let lastOkAt = null
let opening = false

export function mountChatDrawer() {
  ensureCss()
  if (fab) return
  fab = document.createElement('button')
  fab.type = 'button'
  fab.className = 'ccc-fab'
  fab.title = t('plugin.ccc.fabTitle')
  fab.setAttribute('aria-label', t('plugin.ccc.fabTitle'))
  fab.textContent = t('plugin.ccc.fab')
  fab.addEventListener('click', () => (drawer && !drawer.hidden ? closeDrawer() : openDrawer()))
  document.body.appendChild(fab)
  document.addEventListener('keydown', onKeydown)
}

export function unmountChatDrawer() {
  closeDrawer()
  fab?.remove()
  fab = null
  drawer?.remove()
  drawer = null
  document.removeEventListener('keydown', onKeydown)
}

function onKeydown(ev) {
  if (ev.key === 'Escape' && drawer && !drawer.hidden) closeDrawer()
}

function ensureDrawer() {
  if (drawer) return drawer
  drawer = document.createElement('div')
  drawer.className = 'ccc-drawer'
  drawer.hidden = true
  drawer.setAttribute('role', 'dialog')
  drawer.innerHTML = `
    <div class="ccc-head"><span class="ccc-title">${esc(t('plugin.ccc.title'))}</span><span class="ccc-who" id="ccc-who"></span><button class="rp-btn-sm" id="ccc-close" title="${esc(t('plugin.ccc.close'))}">✕</button></div>
    <div class="ccc-body" id="ccc-body"></div>
    <div class="ccc-compose" id="ccc-compose" hidden>
      <textarea id="ccc-input" rows="2" placeholder="${esc(t('plugin.ccc.placeholder'))}"></textarea>
      <button class="ccc-send" id="ccc-send">${esc(t('plugin.ccc.send'))}</button>
    </div>`
  drawer.querySelector('#ccc-close').addEventListener('click', closeDrawer)
  drawer.querySelector('#ccc-send').addEventListener('click', send)
  drawer.querySelector('#ccc-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) { ev.preventDefault(); send() }
  })
  document.body.appendChild(drawer)
  return drawer
}

function closeDrawer() {
  if (view) { try { view.renderer.dispose() } catch {} view = null }
  if (drawer) {
    drawer.hidden = true
    drawer.querySelector('#ccc-body').innerHTML = ''
    drawer.querySelector('#ccc-compose').hidden = true
  }
  fab?.classList.remove('ccc-fab-open')
}

function showProblem(html) {
  drawer.querySelector('#ccc-body').innerHTML = `<div class="ccc-msg">${html}</div>`
  drawer.querySelector('#ccc-compose').hidden = true
}

async function getJson(url) {
  const r = await fetch(url)
  let body = null
  try { body = await r.json() } catch {}
  if (!r.ok) throw new Error(body?.error ? `HTTP ${r.status}: ${body.error}` : `HTTP ${r.status}`)
  return body
}

function rendererKind(tab) {
  const st = window.__nanocodeState || {}
  const own = tab.renderMode === 'block' || tab.renderMode === 'terminal' ? tab.renderMode : null
  const mode = (global, dflt) => own || st[global] || dflt
  if (tab.type === 'claude') return mode('renderMode', 'block') === 'block' ? 'claude' : null
  if (tab.type === 'fable5') return mode('fable5RenderMode', 'block') === 'block' ? 'claude' : null
  if (tab.type === 'opencode') return mode('opencodeRenderMode', 'block') === 'block' ? 'claude' : null
  if (tab.type === 'codex') return mode('codexRenderMode', 'terminal') === 'block' ? 'codex' : null
  return null
}

async function openDrawer() {
  if (opening) return
  opening = true
  ensureDrawer()
  drawer.hidden = false
  fab?.classList.add('ccc-fab-open')
  const who = drawer.querySelector('#ccc-who')
  who.textContent = ''
  showProblem(esc(t('plugin.ccc.loading')))
  try {
    let duty
    try {
      const d = await getJson('/api/duty')
      duty = d?.duty
      if (!duty?.tab || !duty?.project) throw new Error(t('plugin.ccc.dutyIncomplete'))
      lastOkAt = new Date().toISOString()
    } catch (err) {
      showProblem(downBlock(t('plugin.ccc.dutyDown'), { lastOkAt, error: String(err.message || err) }))
      return
    }
    who.textContent = [duty.team, duty.since ? t('plugin.ccc.since', duty.since.replace('T', ' ').slice(5, 16)) : ''].filter(Boolean).join(' · ')
    let tab
    try {
      const tabs = await getJson(`/api/projects/${encodeURIComponent(duty.project)}/tabs`)
      tab = Array.isArray(tabs) ? tabs.find((x) => x.id === duty.tab) : null
    } catch (err) {
      showProblem(downBlock(t('plugin.ccc.tabsDown'), { lastOkAt, error: String(err.message || err) }))
      return
    }
    if (!tab) { showProblem(esc(t('plugin.ccc.tabMissing', duty.tab))); return }
    const kind = rendererKind(tab)
    if (!kind) { showProblem(esc(t('plugin.ccc.unsupported', tab.label || tab.id, tab.type || 'bash'))); return }
    who.textContent = [duty.team, tab.label].filter(Boolean).join(' · ')
    const Cls = kind === 'claude'
      ? (await import('./claude-block-renderer.js')).ClaudeBlockRenderer
      : (await import('./codex-block-renderer.js')).CodexBlockRenderer
    if (drawer.hidden) return // closed while loading
    const body = drawer.querySelector('#ccc-body')
    body.innerHTML = ''
    const host = document.createElement('div')
    host.className = 'ccc-pane'
    body.appendChild(host)
    const opts = { projectId: duty.project, tabId: tab.id, onStatusChange: (on) => drawer?.classList.toggle('ccc-offline', !on) }
    view = { renderer: new Cls(host, kind === 'claude' ? { ...opts, tabType: tab.type } : opts), tabId: tab.id }
    drawer.querySelector('#ccc-compose').hidden = false
    drawer.querySelector('#ccc-input').focus()
  } finally {
    opening = false
  }
}

function send() {
  const input = drawer?.querySelector('#ccc-input')
  const text = input?.value.trim()
  if (!text || !view) return
  view.renderer.sendInputWithEcho(text)
  input.value = ''
}
