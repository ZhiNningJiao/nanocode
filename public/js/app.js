import { state } from './state.js'
import { fetchProjects, fetchSettings, updateSetting } from './api.js'
import { initSidebar, renderSidebar } from './sidebar.js'
import {
  initTerminalView,
  switchTerminalProject,
  fitTerminals,
  isInitialized,
  switchProvider,
  updateProviderLabels,
  applyFontSize,
} from './terminal-view.js'
import { showHosts, showProjects, hideLanding } from './landing.js'
import { slugify, hostSlug, projectSlug, projectPath, navigateTo } from './router.js'

let workspaceReady = false

// --- QA notification WebSocket ---

function showNotifyToast(msg, duration = 6000) {
  let el = document.getElementById('notify-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'notify-toast'
    el.style.cssText = 'position:fixed;top:20px;right:20px;background:rgba(20,20,40,0.96);color:#f0f0f0;padding:12px 20px;border-radius:10px;font-size:13px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;backdrop-filter:blur(12px);border:1px solid rgba(100,180,255,0.3);max-width:300px;'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.opacity = '1'
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.style.opacity = '0' }, duration)
}

function initNotifyWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}/ws/notify`)
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'qa_notify') {
        const text = `[QA] ${msg.repo}: ${msg.task}${msg.summary ? ' — ' + msg.summary.slice(0, 60) : ''}`
        showNotifyToast(text)
        console.log('[notify]', text)
      } else if (msg.type === 'done_notify') {
        const text = `[DONE] ${msg.repo}: ${msg.task} (${msg.reviewer})`
        showNotifyToast(text, 8000)
        console.log('[notify]', text)
      } else if (msg.type === 'activity') {
        console.log('[activity]', msg.repo, msg.heading)
      }
    } catch {}
  }
  ws.onclose = () => setTimeout(initNotifyWs, 5000)
  ws.onerror = () => {}
}

// --- Tab bar ---

const tabs = ['terminal', 'settings']

function initTabBar() {
  for (const tab of tabs) {
    const btn = document.getElementById(`tab-${tab}`)
    if (btn) btn.addEventListener('click', () => switchTab(tab))
  }
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return
    const idx = parseInt(event.key, 10) - 1
    if (idx >= 0 && idx < tabs.length) {
      event.preventDefault()
      switchTab(tabs[idx])
    }
  })
}

function switchTab(tab) {
  state.activeTab = tab
  for (const current of tabs) {
    const btn = document.getElementById(`tab-${current}`)
    const content = document.getElementById(`${current}-tab`)
    if (btn) btn.classList.toggle('active', current === tab)
    if (content) content.hidden = current !== tab
  }
  if (tab === 'terminal') {
    if (!isInitialized()) initTerminalView(state.activeProjectId)
    else fitTerminals()
  } else if (tab === 'settings') {
    loadSettings()
  }
}

// --- Settings ---

const cliProviderGroup = document.getElementById('cli-provider-group')
const cliSaveBtn = document.getElementById('cli-save-btn')
const cliStatusEl = document.getElementById('cli-status')

const fontSizeRange = document.getElementById('font-size-range')
const fontSizeValue = document.getElementById('font-size-value')
const fontSizeSaveBtn = document.getElementById('font-size-save-btn')
const fontSizeStatusEl = document.getElementById('font-size-status')

function loadSettings() {
  const radios = cliProviderGroup?.querySelectorAll('input[name="cli-provider"]')
  if (!radios) return
  for (const radio of radios) {
    radio.checked = radio.value === state.cliProvider
  }
  if (fontSizeRange) {
    fontSizeRange.value = state.fontSize
    if (fontSizeValue) fontSizeValue.textContent = state.fontSize + 'px'
  }
}

if (cliSaveBtn) {
  cliSaveBtn.addEventListener('click', async () => {
    const selected = cliProviderGroup?.querySelector('input[name="cli-provider"]:checked')
    if (!selected) return
    try {
      await updateSetting('cli_provider', selected.value)
      state.cliProvider = selected.value
      updateProviderLabels()
      if (isInitialized()) switchProvider()
      cliStatusEl.textContent = 'Saved'
      cliStatusEl.className = 'settings-status success'
      setTimeout(() => { cliStatusEl.textContent = '' }, 3000)
    } catch (err) {
      cliStatusEl.textContent = err.message
      cliStatusEl.className = 'settings-status error'
      setTimeout(() => { cliStatusEl.textContent = '' }, 3000)
    }
  })
}

// Font size range live preview
if (fontSizeRange && fontSizeValue) {
  fontSizeRange.addEventListener('input', () => {
    fontSizeValue.textContent = fontSizeRange.value + 'px'
  })
}

if (fontSizeSaveBtn) {
  fontSizeSaveBtn.addEventListener('click', async () => {
    const size = parseInt(fontSizeRange?.value, 10)
    if (!size || size < 10 || size > 22) return
    try {
      await updateSetting('font_size', size)
      state.fontSize = size
      if (isInitialized()) applyFontSize(size)
      fontSizeStatusEl.textContent = 'Saved'
      fontSizeStatusEl.className = 'settings-status success'
      setTimeout(() => { fontSizeStatusEl.textContent = '' }, 3000)
    } catch (err) {
      fontSizeStatusEl.textContent = err.message
      fontSizeStatusEl.className = 'settings-status error'
      setTimeout(() => { fontSizeStatusEl.textContent = '' }, 3000)
    }
  })
}

// --- Routing ---

function resolveProject(host, proj) {
  const candidates = state.projects.filter((p) => hostSlug(p) === host)
  return candidates.find((p) => projectSlug(p, state.projects) === proj)
    || candidates.find((p) => slugify(p.name) === proj)
    || null
}

function parseHash() {
  const hash = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/'
  if (hash === '/') return { view: 'hosts' }
  const parts = hash.replace(/^\//, '').split('/')
  if (parts.length === 1) return { view: 'projects', host: parts[0] }
  return { view: 'workspace', host: parts[0], project: parts.slice(1).join('/') }
}

async function onHashChange() {
  const route = parseHash()
  if (route.view === 'workspace') {
    const project = resolveProject(route.host, route.project)
    if (!project) { navigateTo(`/${route.host}`); return }
    await enterWorkspace(project.id)
  } else if (route.view === 'projects') {
    await enterProjectPicker(route.host)
  } else {
    await enterHostPicker()
  }
}

async function enterHostPicker() {
  try { state.projects = await fetchProjects() } catch {}
  document.body.classList.remove('workspace-active')
  await showHosts(state.projects, navigateTo)
}

async function enterProjectPicker(host) {
  try { state.projects = await fetchProjects() } catch {}
  document.body.classList.remove('workspace-active')
  await showProjects(host, state.projects, navigateTo)
}

async function enterWorkspace(projectId) {
  hideLanding()
  document.body.classList.add('workspace-active')
  state.activeProjectId = projectId
  localStorage.setItem('activeProjectId', projectId)
  renderSidebar()
  if (!workspaceReady) {
    workspaceReady = true
    await initTerminalView(projectId)
  } else {
    switchTerminalProject(projectId)
  }
}

async function onProjectSwitch(projectId) {
  const project = state.projects.find((p) => p.id === projectId)
  if (project) navigateTo(projectPath(project, state.projects))
}

// --- Init ---

async function init() {
  initNotifyWs()
  try { state.projects = await fetchProjects() } catch { state.projects = [] }
  initSidebar(onProjectSwitch)
  initTabBar()
  try {
    const settings = await fetchSettings()
    if (settings.cli_provider) state.cliProvider = settings.cli_provider
    if (settings.font_size) state.fontSize = settings.font_size
  } catch {}

  const backBtn = document.getElementById('back-to-menu')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const route = parseHash()
      if (route.view === 'workspace') navigateTo(`/${route.host}`)
      else navigateTo('/')
    })
  }

  window.addEventListener('hashchange', onHashChange)
  await onHashChange()
}

init()
