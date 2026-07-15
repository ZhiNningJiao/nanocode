/**
 * Right panel — dual-domain container (MES-13740 R2 B-2).
 *
 * Top-level groups (按"监视 AI 放一起 / Claude Code 相关放一起", 主人 2026-07-04):
 *   - Work     — operate the current Claude agent + its outputs
 *                (team-model, memory, persona, files, compare)
 *   - Monitor  — watch all agents & resources
 *                (usage, remote, services, plugin-manager; notify/tts settings)
 *
 * R2 B-2 collapsed the previous session/ops/artifacts tri-domain into this
 * dual-group partition. Each group has its own second-level tab strip. Built-in
 * tabs (Files, plugin-manager) live in HTML; plugin tabs (team-model, usage)
 * are mounted/unmounted dynamically by the plugin registry. Enabling a plugin
 * mounts its tab in the plugin's declared `group` domain; disabling removes it.
 * B-1: enabling a plugin auto-activates its tab so the user sees what they turned on.
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

// 块A: 插件 pane 模块懒加载。
// 之前顶部 eager import 全部 8 个 pane 模块（~30KB / 8 个 HTTP 请求），在页面加载时
// 全部 fetch+parse+eval，即使用户从不打开右侧面板的插件 tab。现在改为首次使用时
// 才 dynamic import()，import 后缓存到 _modCache，后续激活瞬间返回。
// 效果：opencode/fable5 tab 打开时减少 8 个模块的加载开销（见 REPORT 块A 验证）。
const _modCache = new Map() // cacheKey -> Promise<module>
function _loadMod(cacheKey, importer) {
  if (!_modCache.has(cacheKey)) {
    _modCache.set(cacheKey, importer().catch((e) => { _modCache.delete(cacheKey); throw e }))
  }
  return _modCache.get(cacheKey)
}
function _isModLoaded(cacheKey) { return _modCache.has(cacheKey) }

// 每个插件名 → { key, imp, render?, settingsRender?, reset? }
//   key  : _modCache 的缓存键（同一模块文件共享一个键，如 team-model/usage 共享 plugins-panel）
//   imp  : () => import('./xxx-panel.js')  首次调用时触发模块加载
//   render(m, pane, plugin)        : 渲染 pane（插件 tab 激活时调用）
//   settingsRender(m, body)        : 渲染设置面板（plugin manager 展开时调用）
//   reset(m)                       : 清空加载状态（插件卸载时调用，仅模块已缓存时执行）
const LAZY_PLUGINS = {
  'team-model': {
    key: 'plugins-panel', imp: () => import('./plugins-panel.js'),
    render: (m, pane) => m.renderTeamModelPane(pane),
    reset: (m) => m.resetPluginLoadState(),
  },
  usage: {
    key: 'plugins-panel', imp: () => import('./plugins-panel.js'),
    render: (m, pane) => m.renderUsagePane(pane),
    reset: (m) => m.resetPluginLoadState(),
  },
  memory: {
    key: 'memory-panel', imp: () => import('./memory-panel.js'),
    render: (m, pane) => m.renderMemoryPane(pane),
    reset: (m) => m.resetMemoryLoadState(),
  },
  persona: {
    key: 'persona-panel', imp: () => import('./persona-panel.js'),
    render: (m, pane) => m.renderPersonaPane(pane),
    reset: (m) => m.resetPersonaLoadState(),
  },
  compare: {
    key: 'compare-panel', imp: () => import('./compare-panel.js'),
    render: (m, pane, plugin) => m.renderComparePane(pane, plugin),
    reset: (m) => m.resetCompareLoadState(),
  },
  remote: {
    key: 'remote-panel', imp: () => import('./remote-panel.js'),
    render: (m, pane) => m.renderRemotePane(pane),
    reset: (m) => m.resetRemoteLoadState(),
  },
  notify: {
    key: 'notify-panel', imp: () => import('./notify-panel.js'),
    settingsRender: (m, body) => m.renderNotifySettings(body),
  },
  tts: {
    key: 'tts-panel', imp: () => import('./tts-panel.js'),
    settingsRender: (m, body) => m.renderTtsSettings(body),
  },
  services: {
    key: 'services-panel', imp: () => import('./services-panel.js'),
    render: (m, pane) => m.renderServicesPane(pane),
    reset: (m) => m.resetServicesLoadState(),
  },
  akari: {
    key: 'akari-panel', imp: () => import('./akari-panel.js'),
    render: (m, pane) => m.renderAkariPane(pane),
    reset: (m) => m.resetAkariLoadState(),
  },
}

const DOMAIN_KEY = 'rightPanel:domain'
const SUBTAB_KEY = (d) => `rightPanel:subtab:${d}`
const ENABLED_KEY = 'rightPanel:plugins:enabled'

const DOMAINS = ['work', 'monitor']
// Built-in HTML tabs and their group. NOTE: `compare` is a plugin (需求14),
// not a built-in HTML tab — it mounts/unmounts via the registry. Only `files`
// (the explorer) and `plugin-manager` remain built-in. R2 B-2: files moved
// from the old `artifacts` domain into `work` (it's a Claude Code output).
const BUILTIN_TAB_DOMAIN = {
  files: 'work',
  'plugin-manager': 'monitor',
}
// 块A: PLUGIN_RENDERERS / PLUGIN_SETTINGS_RENDERERS 已移除，改为 LAZY_PLUGINS 懒加载
// （见文件顶部）。调用点 showRightPanelTab / renderPluginManager / resetPluginLoadStateFor
// 改为通过 LAZY_PLUGINS[name] 异步 import() 后调用。

let activeDomain = 'work'
let activeSubTab = { work: 'files', monitor: 'plugin-manager' }
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
  // B-1: when a plugin is enabled via the toggle, jump to its tab so the
  // user immediately sees what they just turned on. Settings-only plugins
  // (no tab) have nothing to jump to.
  if (on && plugin.tab) {
    setDomain(plugin.group)
    setSubTab(plugin.group, plugin.tab.id)
  }
}

function mountPlugin(plugin, opts = {}) {
  const v = validateManifest(plugin)
  if (!v.ok) {
    console.error(`[plugins] refusing to mount ${plugin?.name}:`, v.errors.join('; '))
    return
  }
  if (mounted.has(plugin.name)) return
  // Settings-only plugins (no `tab`) mount no tab — they only surface a settings
  // panel in the plugin manager. Nothing to mount here.
  if (!plugin.tab) return
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

  // Keep the built-in plugin-manager tab last in Monitor.
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
  if (!plugin.tab) return // settings-only plugin mounts no tab
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

// ── plugin manager (built-in Monitor tab) ────────────────────────────────────

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
    row.dataset.plugin = plugin.name
    const head = document.createElement('div')
    head.className = 'pm-row-head'
    const nameEl = document.createElement('div')
    nameEl.className = 'pm-name'
    nameEl.textContent = t(plugin.tab?.labelKey || plugin.labelKey || plugin.name)
    const meta = document.createElement('div')
    meta.className = 'pm-meta'
    meta.textContent = plugin.tab
      ? `v${plugin.version} · api ${plugin.apiVersion} · ${plugin.group}`
      : `v${plugin.version} · api ${plugin.apiVersion} · ${plugin.group} · settings`
    head.appendChild(nameEl)
    head.appendChild(meta)

    const perms = document.createElement('div')
    perms.className = 'pm-perms'
    perms.textContent = (plugin.permissions && plugin.permissions.length)
      ? `${t('plugin.manager.permissions')}: ${plugin.permissions.join(', ')}`
      : t('plugin.manager.noperms')

    row.appendChild(head)
    row.appendChild(perms)

    // Plugins that mount a tab get an enable toggle. Settings-only plugins
    // (no tab) have nothing to toggle — their settings panel always shows.
    if (plugin.tab) {
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
      row.appendChild(toggle)
    }

    // 需求13: per-plugin expandable settings panel.
    // 块A: 设置渲染器懒加载 — 展开时才 import() 模块（notify/tts 设置专属）。
    const lazy = LAZY_PLUGINS[plugin.name]
    if (lazy && lazy.settingsRender) {
      const disc = document.createElement('details')
      disc.className = 'pm-settings'
      const sum = document.createElement('summary')
      sum.className = 'pm-settings-summary'
      sum.textContent = t('plugin.manager.settings')
      disc.appendChild(sum)
      const body = document.createElement('div')
      body.className = 'pm-settings-body'
      disc.appendChild(body)
      disc.addEventListener('toggle', () => {
        if (disc.open && !body.dataset.rendered) {
          body.dataset.rendered = '1'
          _loadMod(lazy.key, lazy.imp).then((m) => lazy.settingsRender(m, body))
        }
      })
      row.appendChild(disc)
    }

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
    if (entry && (!entry.rendered || entry.plugin.refreshOnActivate)) {
      // 块A: 懒加载 — 首次激活插件 tab 时才 import() pane 模块，然后渲染。
      // 先标记 rendered=true 防止快速切换重复触发；import 完成后异步渲染。
      // Plugins that opt into `refreshOnActivate` (e.g. usage — 主人要求每次
      // 切到该 tab 都刷新) re-render on EVERY activation so data stays fresh
      // without a manual click (renderer replaces content in place, no flash).
      const lazy = LAZY_PLUGINS[entry.plugin.name]
      // Pass the plugin manifest as the 2nd arg so renderers can read
      // `plugin.settings` (需求14 compare reads settings.defaultBranches).
      // Existing renderers take (pane) and ignore the extra arg — backward-compatible.
      if (lazy && lazy.render) {
        entry.rendered = true
        _loadMod(lazy.key, lazy.imp).then((m) => lazy.render(m, entry.pane, entry.plugin))
      } else {
        entry.rendered = true
      }
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
  // 块A: 仅当模块已缓存时才 reset（模块未加载 → 状态本就是初始值，无需 import 来 reset）。
  const lazy = LAZY_PLUGINS[name]
  if (lazy && lazy.reset && _isModLoaded(lazy.key)) {
    _loadMod(lazy.key, lazy.imp).then((m) => lazy.reset(m))
  }
}

// ── persistence ───────────────────────────────────────────────────────────────

function loadPersisted() {
  try {
    const d = localStorage.getItem(DOMAIN_KEY)
    // R2 B-2 migration: old tri-domain (session/ops/artifacts) → dual-group.
    // session/artifacts were "operate the agent + outputs" → work; ops → monitor.
    const migrated = d === 'session' || d === 'artifacts' ? 'work'
      : d === 'ops' ? 'monitor' : d
    if (migrated && DOMAINS.includes(migrated)) activeDomain = migrated
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
