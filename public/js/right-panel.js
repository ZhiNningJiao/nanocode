/**
 * Right panel — three-domain container (MES-13740 需求6).
 *
 * Top-level domains (按"你在对谁做事"):
 *   - Session  — control the current agent (team/model plugin, resume selector)
 *   - Ops      — all agents & resources (usage plugin, plugin manager)
 *   - Artifacts— outputs (Files, Compare)
 *
 * Each domain has its own second-level tab strip. Built-in tabs (Files, Compare,
 * plugin-manager) live in HTML; plugin tabs (team-model, usage) are mounted/
 * unmounted dynamically by the plugin registry. Enabling a plugin mounts its
 * tab in the plugin's declared `group` domain; disabling removes it.
 *
 * This is the shell only — render cores (plugins-panel.js) and the file explorer
 * (explorer.js) are not rewritten. 壳动芯不动.
 */

import { t } from './i18n.js'
import {
  BUILTIN_PLUGINS,
  builtinPlugin,
  validateManifest,
} from './plugins-registry.js'
import { renderTeamModelPane, renderUsagePane, resetPluginLoadState } from './plugins-panel.js'
import { renderMemoryPane, resetMemoryLoadState } from './memory-panel.js'
import { renderPersonaPane, resetPersonaLoadState } from './persona-panel.js'
import { renderComparePane, resetCompareLoadState } from './compare-panel.js'

const DOMAIN_KEY = 'rightPanel:domain'
const SUBTAB_KEY = (d) => `rightPanel:subtab:${d}`
const ENABLED_KEY = 'rightPanel:plugins:enabled'

const DOMAINS = ['session', 'ops', 'artifacts']
// Built-in HTML tabs and their domain. NOTE: `compare` is now a plugin (需求14),
// not a built-in HTML tab — it mounts/unmounts via the registry. Only `files`
// (the explorer) and `plugin-manager` remain built-in.
const BUILTIN_TAB_DOMAIN = {
  files: 'artifacts',
  'plugin-manager': 'ops',
}
const PLUGIN_RENDERERS = {
  'team-model': renderTeamModelPane,
  usage: renderUsagePane,
  memory: renderMemoryPane,
  persona: renderPersonaPane,
  compare: renderComparePane,
}

let activeDomain = 'artifacts'
let activeSubTab = { session: null, ops: 'plugin-manager', artifacts: 'files' }
let enabledNames = new Set()
let mounted = new Map() // name -> { plugin, btn, pane, rendered }
let initialized = false

export function initRightPanel() {
  if (initialized) return
  const strip = document.getElementById('right-domain-strip')
  if (!strip) return
  initialized = true

  loadPersisted()
  validateBuiltins()

  strip.addEventListener('click', (e) => {
    const btn = e.target.closest('.right-domain-btn')
    if (!btn) return
    setDomain(btn.dataset.domain)
  })

  document.querySelectorAll('.right-sub-tabs').forEach((s) => {
    s.addEventListener('click', (e) => {
      const btn = e.target.closest('.right-sub-tab')
      if (!btn) return
      const domain = btn.closest('.right-domain').dataset.domain
      setSubTab(domain, btn.dataset.rpTab)
    })
  })

  // Mount enabled plugins, then resolve active sub-tabs + apply.
  for (const name of enabledNames) {
    const plugin = builtinPlugin(name)
    if (plugin) mountPlugin(plugin, { silent: true })
  }
  resolveActiveSubTabs()
  renderPluginManager(getPane('plugin-manager'))
  applyDomain()
  for (const d of DOMAINS) applySubTab(d)
}

export function showRightPanelTab(tab) {
  if (!initialized) return
  const domain = tabDomain(tab)
  if (!domain) return
  setDomain(domain)
  setSubTab(domain, tab)
}

function setDomain(d) {
  if (!DOMAINS.includes(d)) return
  activeDomain = d
  try { localStorage.setItem(DOMAIN_KEY, d) } catch {}
  applyDomain()
}

function setSubTab(domain, tabId) {
  if (!DOMAINS.includes(domain)) return
  if (!tabExists(domain, tabId)) return
  activeSubTab[domain] = tabId
  try { localStorage.setItem(SUBTAB_KEY(domain), tabId) } catch {}
  applySubTab(domain)
  document.dispatchEvent(new CustomEvent('nanocode:right-sub-tab', { detail: { domain, tab: tabId } }))
}

// ── plugin mount / unmount ────────────────────────────────────────────────────

function isEnabled(name) { return enabledNames.has(name) }

function setEnabled(name, on) {
  const plugin = builtinPlugin(name)
  if (!plugin) return
  if (on) {
    enabledNames.add(name)
    mountPlugin(plugin)
  } else {
    enabledNames.delete(name)
    unmountPlugin(plugin)
  }
  persistEnabled()
  // Reflect toggle states without losing the manager's scroll.
  renderPluginManager(getPane('plugin-manager'))
}

function mountPlugin(plugin, opts = {}) {
  const v = validateManifest(plugin)
  if (!v.ok) {
    console.error(`[plugins] refusing to mount ${plugin?.name}:`, v.errors.join('; '))
    return
  }
  if (mounted.has(plugin.name)) return
  const tabsEl = getDomainTabsEl(plugin.group)
  const bodyEl = getDomainBodyEl(plugin.group)
  if (!tabsEl || !bodyEl) return

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'right-sub-tab'
  btn.dataset.rpTab = plugin.tab.id
  btn.setAttribute('role', 'tab')
  btn.setAttribute('data-i18n', plugin.tab.labelKey)
  btn.textContent = t(plugin.tab.labelKey)

  const pane = document.createElement('div')
  pane.className = 'right-panel-pane'
  pane.dataset.rpPane = plugin.tab.id

  // Keep the built-in plugin-manager tab last in Ops.
  const managerBtn = tabsEl.querySelector('[data-rp-tab="plugin-manager"]')
  if (managerBtn) tabsEl.insertBefore(btn, managerBtn)
  else tabsEl.appendChild(btn)
  bodyEl.appendChild(pane)

  mounted.set(plugin.name, { plugin, btn, pane, rendered: false })
  hideDomainEmpty(plugin.group)
  if (!opts.silent) {
    resolveActiveSubTabs()
    applySubTab(plugin.group)
  }
}

function unmountPlugin(plugin) {
  const entry = mounted.get(plugin.name)
  if (!entry) return
  const domain = plugin.group
  const wasActive = activeSubTab[domain] === plugin.tab.id
  entry.btn.remove()
  entry.pane.remove()
  mounted.delete(plugin.name)
  resetPluginLoadStateFor(plugin.name)
  if (wasActive) {
    activeSubTab[domain] = firstTabInDomain(domain)
    try { localStorage.setItem(SUBTAB_KEY(domain), activeSubTab[domain] || '') } catch {}
    applySubTab(domain)
  }
  if (countTabsInDomain(domain) === 0) showDomainEmpty(domain)
}

// ── plugin manager (built-in Ops tab) ─────────────────────────────────────────

function renderPluginManager(pane) {
  if (!pane) return
  pane.innerHTML = ''
  const section = document.createElement('div')
  section.className = 'rp-section'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('plugin.manager.title')
  section.appendChild(title)
  const desc = document.createElement('div')
  desc.className = 'rp-section-desc'
  desc.textContent = t('plugin.manager.desc')
  section.appendChild(desc)

  for (const plugin of BUILTIN_PLUGINS) {
    const row = document.createElement('div')
    row.className = 'pm-row'
    const head = document.createElement('div')
    head.className = 'pm-row-head'
    const nameEl = document.createElement('div')
    nameEl.className = 'pm-name'
    nameEl.textContent = t(plugin.tab.labelKey)
    const meta = document.createElement('div')
    meta.className = 'pm-meta'
    meta.textContent = `v${plugin.version} · api ${plugin.apiVersion} · ${plugin.group}`
    head.appendChild(nameEl)
    head.appendChild(meta)

    const perms = document.createElement('div')
    perms.className = 'pm-perms'
    perms.textContent = (plugin.permissions && plugin.permissions.length)
      ? `${t('plugin.manager.permissions')}: ${plugin.permissions.join(', ')}`
      : t('plugin.manager.noperms')

    const toggle = document.createElement('label')
    toggle.className = 'pm-toggle'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = isEnabled(plugin.name)
    cb.addEventListener('change', () => setEnabled(plugin.name, cb.checked))
    const slider = document.createElement('span')
    slider.className = 'pm-slider'
    toggle.appendChild(cb)
    toggle.appendChild(slider)

    row.appendChild(head)
    row.appendChild(perms)
    row.appendChild(toggle)
    section.appendChild(row)
  }

  const note = document.createElement('div')
  note.className = 'rp-hint'
  note.textContent = t('plugin.manager.note')
  section.appendChild(note)
  pane.appendChild(section)
}

// ── apply / resolve ───────────────────────────────────────────────────────────

function applyDomain() {
  document.querySelectorAll('.right-domain-btn').forEach((b) => {
    const on = b.dataset.domain === activeDomain
    b.classList.toggle('active', on)
    b.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  document.querySelectorAll('.right-domain').forEach((d) => {
    d.classList.toggle('active', d.dataset.domain === activeDomain)
  })
}

function applySubTab(domain) {
  const tabsEl = getDomainTabsEl(domain)
  const bodyEl = getDomainBodyEl(domain)
  const tabId = activeSubTab[domain]
  if (tabsEl) {
    tabsEl.querySelectorAll('.right-sub-tab').forEach((b) => {
      const on = b.dataset.rpTab === tabId
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
  }
  if (bodyEl) {
    bodyEl.querySelectorAll('.right-panel-pane').forEach((p) => {
      p.classList.toggle('active', p.dataset.rpPane === tabId)
    })
  }
  if (tabId) {
    const entry = mountedEntryByTab(domain, tabId)
    if (entry && !entry.rendered) {
      const render = PLUGIN_RENDERERS[entry.plugin.name]
      // Pass the plugin manifest as the 2nd arg so renderers can read
      // `plugin.settings` (需求14 compare reads settings.defaultBranches).
      // Existing renderers take (pane) and ignore the extra arg — backward-compatible.
      if (render) render(entry.pane, entry.plugin)
      entry.rendered = true
    }
    if (tabId === 'plugin-manager') {
      renderPluginManager(getPane('plugin-manager'))
    }
  }
  if (countTabsInDomain(domain) === 0) showDomainEmpty(domain)
  else hideDomainEmpty(domain)
}

function resolveActiveSubTabs() {
  for (const d of DOMAINS) {
    if (!tabExists(d, activeSubTab[d])) {
      activeSubTab[d] = firstTabInDomain(d)
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function getDomainEl(d) { return document.querySelector(`.right-domain[data-domain="${d}"]`) }
function getDomainTabsEl(d) { return document.querySelector(`.right-sub-tabs[data-domain-tabs="${d}"]`) }
function getDomainBodyEl(d) { return document.querySelector(`.right-sub-body[data-domain-body="${d}"]`) }
function getPane(tabId) { return document.querySelector(`.right-panel-pane[data-rp-pane="${tabId}"]`) }

function tabDomain(tabId) {
  if (BUILTIN_TAB_DOMAIN[tabId]) return BUILTIN_TAB_DOMAIN[tabId]
  for (const [, entry] of mounted) {
    if (entry.plugin.tab.id === tabId) return entry.plugin.group
  }
  return null
}
function tabExists(domain, tabId) {
  if (!tabId) return false
  const tabsEl = getDomainTabsEl(domain)
  return !!(tabsEl && tabsEl.querySelector(`.right-sub-tab[data-rp-tab="${tabId}"]`))
}
function firstTabInDomain(domain) {
  const tabsEl = getDomainTabsEl(domain)
  const first = tabsEl && tabsEl.querySelector('.right-sub-tab')
  return first ? first.dataset.rpTab : null
}
function countTabsInDomain(domain) {
  const tabsEl = getDomainTabsEl(domain)
  return tabsEl ? tabsEl.querySelectorAll('.right-sub-tab').length : 0
}
function mountedEntryByTab(domain, tabId) {
  for (const [, entry] of mounted) {
    if (entry.plugin.group === domain && entry.plugin.tab.id === tabId) return entry
  }
  return null
}

function ensureEmptyEl(domain) {
  const bodyEl = getDomainBodyEl(domain)
  if (!bodyEl) return null
  let el = bodyEl.querySelector('.right-domain-empty')
  if (!el) {
    el = document.createElement('div')
    el.className = 'right-domain-empty'
    el.textContent = t('domain.empty')
    bodyEl.appendChild(el)
  }
  return el
}
function showDomainEmpty(domain) { const el = ensureEmptyEl(domain); if (el) el.style.display = '' }
function hideDomainEmpty(domain) {
  const bodyEl = getDomainBodyEl(domain)
  const el = bodyEl && bodyEl.querySelector('.right-domain-empty')
  if (el) el.style.display = 'none'
}

function resetPluginLoadStateFor(name) {
  // Cheap reset: clear shared load state so a re-mounted pane re-fetches.
  if (name === 'team-model' || name === 'usage') resetPluginLoadState()
  if (name === 'memory') resetMemoryLoadState()
  if (name === 'persona') resetPersonaLoadState()
  if (name === 'compare') resetCompareLoadState()
}

// ── persistence ───────────────────────────────────────────────────────────────

function loadPersisted() {
  try {
    const d = localStorage.getItem(DOMAIN_KEY)
    if (d && DOMAINS.includes(d)) activeDomain = d
  } catch {}
  for (const d of DOMAINS) {
    try {
      const s = localStorage.getItem(SUBTAB_KEY(d))
      if (s) activeSubTab[d] = s
    } catch {}
  }
  try {
    const raw = localStorage.getItem(ENABLED_KEY)
    const arr = raw ? JSON.parse(raw) : null
    if (Array.isArray(arr)) enabledNames = new Set(arr.filter((n) => builtinPlugin(n)))
    else enabledNames = new Set(BUILTIN_PLUGINS.map((p) => p.name))
  } catch {
    enabledNames = new Set(BUILTIN_PLUGINS.map((p) => p.name))
  }
}

function persistEnabled() {
  try { localStorage.setItem(ENABLED_KEY, JSON.stringify([...enabledNames])) } catch {}
}

function validateBuiltins() {
  for (const p of BUILTIN_PLUGINS) {
    const v = validateManifest(p)
    if (!v.ok) console.error(`[plugins] builtin ${p.name} invalid:`, v.errors.join('; '))
  }
}
