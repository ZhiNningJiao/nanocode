/**
 * Browser-side plugin host for NanoCode.
 *
 * Core loads this module once and each enabled plugin's `plugins/<name>/client.js`
 * calls `register(ui)`.  Plugins MUST only use the ui API below; they must not
 * reach into Core internals.
 *
 * Extension points (tiered stability, see NANOCODE_ARCH.md §3):
 *
 *   Tier 1 — Stable Core API (frozen, semver-guaranteed; pre-1.0 not yet frozen):
 *     - Local events: ui.on(event, cb) / ui.emit(event, payload)
 *     - Full panel:   ui.registerPanel(id, { title, render(container) })
 *     - Renderer:      ui.registerRenderer(sessionType, { name, factory, gate, priority })
 *     - Server msgs:   ui.onMessage(cb) — receives notify-WS payloads (type "plugin:*")
 *
 *   Tier 2 — Flexible Extension API (may evolve, versioned):
 *     - Settings UI:  ui.registerSetting({ id, render(container) })
 *     - REST settings: ui.fetchSettings() / ui.updateSetting(key, value)
 *
 *   Tier 3 — Internal API (not for plugin use):
 *     - ui._uiForPlugin / pluginRegistry / settingSlots / panels / panelEls
 */

import { fetchSettings, updateSetting } from './api.js'
import { rendererRegistry } from './renderer-registry.js'

/**
 * Host API version this browser build implements. Pre-1.0 means "not yet
 * frozen" — the contract is advisory: incompatible plugins are warned, not
 * refused. Kept in sync with server/plugin-host.js HOST_API_VERSION.
 */
export const HOST_API_VERSION = '0.9'

/**
 * Browser-side extension points this host actually exposes (the `ui.*`
 * namespace). Used to validate `plugin.json#extensionPoints` declarations so a
 * plugin that claims a non-existent ui method is warned at load time. `host.*`
 * points belong to the server host and are validated server-side.
 */
const CLIENT_HOST_POINTS = new Set([
  'ui.on',
  'ui.emit',
  'ui.registerSetting',
  'ui.registerPanel',
  'ui.registerRenderer',
  'ui.onMessage',
  'ui.fetchSettings',
  'ui.updateSetting',
])

/**
 * Parse a loose semver string into {major,minor,patch}. Returns null for
 * unversioned/legacy values. Mirrors server/plugin-host.js parseSemver.
 */
function parseSemver(v) {
  if (!v || typeof v !== 'string') return null
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0 }
}

/**
 * Decide whether a plugin's declared apiVersion is compatible with the host's
 * HOST_API_VERSION (mirrors the server-side check). Returns
 * { compatible: boolean, reason: string }.
 */
function isApiCompatible(pluginVersion, hostVersion) {
  const p = parseSemver(pluginVersion)
  const h = parseSemver(hostVersion)
  if (!p) return { compatible: false, reason: 'unversioned/legacy manifest (no apiVersion)' }
  if (!h) return { compatible: true, reason: '' }
  if (p.major !== h.major) {
    return { compatible: false, reason: `major mismatch (plugin ${pluginVersion} vs host ${hostVersion})` }
  }
  if (h.major === 0 && p.minor !== h.minor) {
    return { compatible: false, reason: `pre-1.0 minor mismatch (plugin ${pluginVersion} vs host ${hostVersion})` }
  }
  return { compatible: true, reason: '' }
}

/**
 * Validate a plugin manifest against this browser host: apiVersion compatibility
 * and ui.* extensionPoints declarations vs the host's actual exposed methods.
 * Advisory only (pre-1.0) — warns, never refuses the load. Returns void.
 */
function validateClientManifest(name, manifest) {
  const apiVersion = manifest && manifest.apiVersion
  const { compatible, reason } = isApiCompatible(apiVersion, HOST_API_VERSION)
  if (!compatible) {
    console.warn(
      `[plugin-ui] ${name}: API version incompatibility — ${reason}. ` +
        `Host is ${HOST_API_VERSION}. Loading anyway (pre-1.0 advisory).`,
    )
  }
  const points = Array.isArray(manifest && manifest.extensionPoints) ? manifest.extensionPoints : []
  for (const point of points) {
    if (typeof point !== 'string') continue
    if (point.startsWith('ui.')) {
      if (!CLIENT_HOST_POINTS.has(point)) {
        console.warn(
          `[plugin-ui] ${name}: declares unknown extension point "${point}" ` +
            `(not exposed by browser host). Known: ${[...CLIENT_HOST_POINTS].join(', ')}`,
        )
      }
    }
  }
}

/**
 * Create the client plugin host.
 *
 * @param {object} opts
 * @param {WebSocket} [opts.notifyWs]  existing /ws/notify connection
 * @returns {object} ui
 */
export function createPluginUiHost({ notifyWs } = {}) {
  const localEmitter = new EventTarget()
  const messageCallbacks = new Set()
  const settingSlots = new Set()
  const panels = new Map()
  let _notifyWs = notifyWs

  /** @type {Map<string, { panels: Set<string>, settings: Set<string>, messages: Set<Function>, renderers: Set<{sessionType:string,name:string}> }>} */
  const pluginRegistry = new Map()

  /** @type {Map<string, HTMLElement>} id -> panel element */
  const panelEls = new Map()
  /** @type {Map<string, HTMLElement>} id -> tab button */
  const tabEls = new Map()
  let _tabStrip = null
  let _panelContainer = null
  let _terminalLayout = null
  let _renderPanelsOpts = {}
  let _activePanelId = '_terminal'
  let _showPanel = null

  function on(event, cb) {
    const handler = (e) => cb(e.detail)
    localEmitter.addEventListener(event, handler)
    return () => localEmitter.removeEventListener(event, handler)
  }

  function emit(event, payload) {
    localEmitter.dispatchEvent(new CustomEvent(event, { detail: payload }))
  }

  function onMessage(cb) {
    messageCallbacks.add(cb)
    return () => messageCallbacks.delete(cb)
  }

  function _dispatchMessage(msg) {
    for (const cb of messageCallbacks) {
      try { cb(msg) } catch (err) { console.warn('[plugin-ui] message callback error:', err) }
    }
  }

  /**
   * Register a setting definition.  Core persists values; plugins read/write
   * through getSetting/setSetting.
   */
  function registerSetting(def) {
    if (!def || !def.id || typeof def.render !== 'function') {
      throw new Error('registerSetting: id and render() required')
    }
    settingSlots.add(def)
  }

  /**
   * Render all registered settings slots into the given panel element.
   * Core calls this once the settings panel DOM is ready.
   *
   * Incremental: new slots are created, removed slots are cleaned up, existing
   * slots are left in place so plugins don't lose state on re-render.
   */
  /**
   * Whether the plugin manager has taken ownership of rendering plugin-owned
   * setting slots (into per-plugin cards). When true, renderSettings() skips
   * plugin-owned slots so they render exactly once (in the cards, not in the
   * flat #plugin-settings-slots bucket). Set to false on manager fetch failure
   * so settings fall back to the flat bucket (no setting is ever lost).
   */
  let _pluginManagerOwnsSettings = false

  /** @returns {Set<string>} setting ids owned by any tracked (loaded) plugin */
  function _pluginOwnedSettingIds() {
    const ids = new Set()
    for (const reg of pluginRegistry.values()) {
      for (const id of reg.settings) ids.add(id)
    }
    return ids
  }

  function renderSettings(panel) {
    if (!panel) return
    const owned = _pluginManagerOwnsSettings ? _pluginOwnedSettingIds() : new Set()
    const wantedIds = new Set()
    for (const def of settingSlots) {
      // Plugin-owned slots are rendered by the plugin manager (per-plugin cards)
      // when it is active; skip them here to avoid duplicate element IDs.
      if (owned.has(def.id)) continue
      wantedIds.add(def.id)
      let container = panel.querySelector(`[data-plugin-setting="${def.id}"]`)
      if (!container) {
        container = document.createElement('div')
        container.dataset.pluginSetting = def.id
        panel.appendChild(container)
      }
      try { def.render(container) } catch (err) { console.warn('[plugin-ui] render error:', err) }
    }
    // Remove containers for slots that no longer exist (unloaded plugin).
    panel.querySelectorAll('[data-plugin-setting]').forEach((el) => {
      if (!wantedIds.has(el.dataset.pluginSetting)) el.remove()
    })
  }

  /**
   * Render ONLY the settings registered by a single plugin into `container`.
   * Used by the plugin manager to show each plugin's ui.registerSetting slots
   * inside that plugin's card. Incremental: re-renders existing, removes stale.
   */
  function _renderPluginSettings(name, container) {
    if (!container) return
    const reg = pluginRegistry.get(name)
    const ownedIds = reg ? reg.settings : new Set()
    const wantedIds = new Set()
    for (const def of settingSlots) {
      if (!ownedIds.has(def.id)) continue
      wantedIds.add(def.id)
      let sub = container.querySelector(`[data-plugin-setting="${def.id}"]`)
      if (!sub) {
        sub = document.createElement('div')
        sub.dataset.pluginSetting = def.id
        sub.className = 'plugin-card-setting'
        container.appendChild(sub)
      }
      try { def.render(sub) } catch (err) { console.warn(`[plugin-ui] ${name} setting render error:`, err) }
    }
    container.querySelectorAll('[data-plugin-setting]').forEach((el) => {
      if (!wantedIds.has(el.dataset.pluginSetting)) el.remove()
    })
  }

  /**
   * Register a full panel that Core renders as a top-level tab.  The render
   * function receives a container element and populates it; Core owns the tab
   * strip and switching logic so plugins never touch the layout skeleton.
   */
  function registerPanel(id, def) {
    if (!id || !def || typeof def.render !== 'function') {
      throw new Error('registerPanel: id and render() required')
    }
    panels.set(id, { title: def.title || id, render: def.render })
  }

  /**
   * Register a custom output renderer for a session type. Delegates to the
   * renderer registry (core's single rendering extension point). A plugin can
   * override the built-in Claude/Codex/Terminal renderers by registering with a
   * higher priority. Removed on unload so the default renderer is restored.
   * Returns the registered name (for bookkeeping / unregister).
   */
  function registerRenderer(sessionType, def) {
    return rendererRegistry.register(sessionType, def)
  }

  function _setActivePanel(id) {
    _activePanelId = id
    if (_showPanel) _showPanel(id)
  }

  /**
   * Render plugin panels into the tab strip + panel container.
   * A "Terminal" tab is always present; plugin panels are appended after it.
   * `terminalLayout` is hidden when a plugin panel is active, and the panel
   * container is hidden when Terminal is active.
   *
   * This is incremental: calling it again only adds/removes panels that changed,
   * preserving the DOM for panels that are already mounted.
   */
  function renderPanels(tabStrip, panelContainer, terminalLayout, opts = {}) {
    if (!tabStrip || !panelContainer) return
    _tabStrip = tabStrip
    _panelContainer = panelContainer
    _terminalLayout = terminalLayout
    _renderPanelsOpts = opts

    if (panels.size === 0 && tabEls.size === 0) {
      tabStrip.hidden = true
      panelContainer.hidden = true
      if (terminalLayout) terminalLayout.hidden = false
      _showPanel = null
      return
    }

    tabStrip.hidden = false
    panelContainer.hidden = false

    function showPanel(id) {
      if (terminalLayout) terminalLayout.hidden = (id !== '_terminal')
      panelContainer.hidden = (id === '_terminal')
      for (const [pid, el] of panelEls) el.classList.toggle('active', pid === id)
      for (const btn of tabStrip.children) btn.classList.toggle('active', btn.dataset.panel === id)
      if (typeof opts.onShowPanel === 'function') {
        try { opts.onShowPanel(id) } catch (err) { console.warn('[plugin-ui] onShowPanel error:', err) }
      }
      _activePanelId = id
    }
    _showPanel = showPanel

    // Ensure Terminal tab exists.
    if (!tabEls.has('_terminal')) {
      const btn = _makeTab('Terminal', '_terminal')
      tabStrip.appendChild(btn)
      tabEls.set('_terminal', btn)
    }

    // Add or keep plugin tabs/panels.
    for (const [id, panelDef] of panels) {
      if (!tabEls.has(id)) {
        const btn = _makeTab(panelDef.title, id)
        tabStrip.appendChild(btn)
        tabEls.set(id, btn)
      }
      if (!panelEls.has(id)) {
        const el = document.createElement('div')
        el.className = 'plugin-panel'
        el.dataset.panel = id
        panelContainer.appendChild(el)
        try { panelDef.render(el) } catch (err) { console.warn('[plugin-ui] panel render error:', err) }
        panelEls.set(id, el)
      }
    }

    // Remove tabs/panels for plugins that are no longer registered.
    for (const id of tabEls.keys()) {
      if (id === '_terminal') continue
      if (!panels.has(id)) {
        tabEls.get(id)?.remove()
        tabEls.delete(id)
        panelEls.get(id)?.remove()
        panelEls.delete(id)
      }
    }

    // If the active panel was removed, fall back to Terminal.
    if (_activePanelId !== '_terminal' && !panels.has(_activePanelId)) {
      showPanel('_terminal')
    } else {
      showPanel(_activePanelId)
    }
  }

  function _makeTab(label, id) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'panel-tab'
    btn.textContent = label
    btn.dataset.panel = id
    btn.addEventListener('click', () => _setActivePanel(id))
    return btn
  }

  function showPanel(id) {
    _setActivePanel(id)
  }

  function hasPanel(id) {
    return panels.has(id)
  }

  /**
   * Build a per-plugin UI proxy so we know which panels/settings/message
   * handlers belong to which plugin.  This lets us unload a plugin without
   * reloading the page.
   */
  function _uiForPlugin(name) {
    const registry = { panels: new Set(), settings: new Set(), messages: new Set(), renderers: new Set() }
    pluginRegistry.set(name, registry)

    const wrapOnMessage = (cb) => {
      registry.messages.add(cb)
      return onMessage(cb)
    }
    const wrapRegisterPanel = (id, def) => {
      registry.panels.add(id)
      return registerPanel(id, def)
    }
    const wrapRegisterSetting = (def) => {
      registry.settings.add(def.id)
      return registerSetting(def)
    }
    const wrapRegisterRenderer = (sessionType, def) => {
      const rname = registerRenderer(sessionType, def)
      registry.renderers.add({ sessionType, name: rname })
      return rname
    }

    return {
      on,
      emit,
      onMessage: wrapOnMessage,
      registerSetting: wrapRegisterSetting,
      registerPanel: wrapRegisterPanel,
      registerRenderer: wrapRegisterRenderer,
      attachNotifyWs,
      fetchSettings,
      updateSetting,
    }
  }

  /**
   * Load a single client plugin by name.
   */
  async function loadClientPlugin(name) {
    const mod = await import(`/plugins/${name}/client.js`)
    if (typeof mod.register !== 'function') {
      throw new Error(`${name}/client.js has no register() export`)
    }
    mod.register(_uiForPlugin(name))
    console.log(`[plugin-ui] loaded client plugin ${name}`)
  }

  /**
   * Unload a client plugin by name: remove its panels, settings slots, and
   * message handlers.  The tab strip and settings panel are re-rendered
   * incrementally.
   */
  function unloadClientPlugin(name) {
    const registry = pluginRegistry.get(name)
    if (!registry) return false

    for (const id of registry.panels) {
      panels.delete(id)
      const el = panelEls.get(id)
      if (el) {
        el.remove()
        panelEls.delete(id)
      }
      const tab = tabEls.get(id)
      if (tab) {
        tab.remove()
        tabEls.delete(id)
      }
    }
    for (const id of registry.settings) {
      for (const def of settingSlots) {
        if (def.id === id) {
          settingSlots.delete(def)
          break
        }
      }
    }
    for (const cb of registry.messages) messageCallbacks.delete(cb)
    // Unregister any custom renderers the plugin added so the default renderer
    // is restored for the affected session types.
    for (const { sessionType, name: rname } of registry.renderers) {
      rendererRegistry.unregister(sessionType, rname)
    }
    pluginRegistry.delete(name)

    // Re-render so any remaining plugin settings stay in place and the tab
    // strip reflects the removed panel.
    if (_panelContainer) renderPanels(_tabStrip, _panelContainer, _terminalLayout, _renderPanelsOpts)
    return true
  }

  /**
   * Attach to the notify WebSocket so plugin server messages can flow to
   * ui.onMessage callbacks.  Safe to call multiple times; idempotent.
   */
  function attachNotifyWs(ws) {
    if (_notifyWs === ws) return
    _notifyWs = ws
    if (!ws) return
    const originalOnMessage = ws.onmessage
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg && typeof msg.type === 'string' && msg.type.startsWith('plugin:')) {
        _dispatchMessage(msg)
      }
    })
    // If Core already installed an onmessage handler, leave it in place.
    if (originalOnMessage && ws.onmessage !== originalOnMessage) {
      ws.onmessage = originalOnMessage
    }
  }

  /**
   * Render a plugin management UI into `container`.
   * Expects container to be a DOM element.
   */
  /**
   * Render a health badge for a plugin from its reportStatus() snapshot.
   * Returns an HTML string. status shape: { level, message, detail, time }.
   */
  function _healthBadge(status) {
    if (!status || !status.level) {
      return '<span class="plugin-health plugin-health-unknown" title="No status reported">●</span>'
    }
    const lvl = escapeHtml(status.level)
    const msg = escapeHtml(status.message || '')
    const tip = msg ? ` title="${msg}"` : ''
    return `<span class="plugin-health plugin-health-${lvl}"${tip}>${lvl}</span>`
  }

  async function renderPluginManager(container) {
    container.innerHTML = '<div class="plugin-manager-loading">Loading plugins…</div>'

    let plugins = []
    try {
      const res = await fetch('/api/plugins')
      if (!res.ok) throw new Error((await res.text()) || 'fetch failed')
      const data = await res.json()
      plugins = data.plugins || []
    } catch (err) {
      // Fall back to the flat settings bucket so no plugin setting is lost.
      _pluginManagerOwnsSettings = false
      container.innerHTML = `<div class="plugin-manager-error">Failed to load plugins: ${escapeHtml(String(err?.message || err))}</div>`
      return
    }

    // Plugin manager owns per-plugin setting rendering now; renderSettings()
    // will skip plugin-owned slots so each setting renders exactly once (here).
    _pluginManagerOwnsSettings = true

    const list = document.createElement('div')
    list.className = 'plugin-manager-list'

    plugins.forEach((plugin) => {
      const row = document.createElement('div')
      row.className = 'plugin-manager-row'
      row.dataset.plugin = plugin.name
      const apiBadge = plugin.apiVersion
        ? `<span class="plugin-api-version" title="Plugin API version">api ${escapeHtml(plugin.apiVersion)}</span>`
        : ''
      const health = _healthBadge(plugin.status)
      const settingsCount = (plugin.extensionPoints || []).filter((p) => p === 'ui.registerSetting').length
      row.innerHTML = `
        <div class="plugin-info">
          <div class="plugin-name">
            ${escapeHtml(plugin.name)}
            <span class="plugin-version">v${escapeHtml(plugin.version)}</span>
            ${apiBadge}
            ${health}
          </div>
          <div class="plugin-description">${escapeHtml(plugin.description || 'No description')}</div>
        </div>
        <label class="plugin-toggle">
          <input type="checkbox" data-plugin="${escapeHtml(plugin.name)}" ${plugin.enabled ? 'checked' : ''}>
          <span>${plugin.enabled ? 'On' : 'Off'}</span>
        </label>
        <div class="plugin-card-settings" data-plugin-settings="${escapeHtml(plugin.name)}"></div>
      `
      list.appendChild(row)
      // Render this plugin's own ui.registerSetting slots into its card.
      const settingsEl = row.querySelector('.plugin-card-settings')
      if (settingsEl) _renderPluginSettings(plugin.name, settingsEl)
    })

    container.innerHTML = `
      <h3>Plugins</h3>
      <p class="plugin-manager-hint">
        Toggle plugins on or off. UI panels and settings update immediately.
        Server-side routes take effect after the server restarts.
        Health badges reflect the latest <code>reportStatus()</code> snapshot.
      </p>
    `
    container.appendChild(list)

    list.addEventListener('change', async (e) => {
      if (!e.target.matches('input[type="checkbox"]')) return
      const name = e.target.dataset.plugin
      const enabled = e.target.checked
      const span = e.target.parentElement.querySelector('span')
      span.textContent = enabled ? 'On' : 'Off'

      try {
        const res = await fetch('/api/plugins/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, enabled }),
        })
        if (!res.ok) throw new Error((await res.text()) || 'toggle failed')

        if (enabled) {
          await loadClientPlugin(name)
        } else {
          unloadClientPlugin(name)
        }

        // Re-render the toggled plugin's card settings + orphan slots + panels.
        const row = list.querySelector(`.plugin-manager-row[data-plugin="${cssEscape(name)}"]`)
        if (row) {
          const settingsEl = row.querySelector('.plugin-card-settings')
          if (settingsEl) {
            if (enabled) _renderPluginSettings(name, settingsEl)
            else settingsEl.innerHTML = ''
          }
        }
        const settingsContainer = document.getElementById('plugin-settings-slots')
        if (settingsContainer) renderSettings(settingsContainer)
        if (_tabStrip && _panelContainer) {
          renderPanels(_tabStrip, _panelContainer, _terminalLayout, _renderPanelsOpts)
        }

        showToast(`Plugin "${name}" ${enabled ? 'enabled' : 'disabled'}.`)
      } catch (err) {
        showToast(`Failed to toggle ${name}: ${err?.message || err}`)
        e.target.checked = !enabled
        span.textContent = !enabled ? 'On' : 'Off'
      }
    })

    // Dual-team login/switch section (MES-13273).
    renderTeamManagement(container).catch((err) => {
      console.warn('[plugin-ui] team management render failed:', err)
    })
  }

  /**
   * Render the dual-team login/switch section into the plugin manager.
   *
   * Shows Team1 / Team2 status (configured / active) and offers one-click
   * "Switch" (set the active team for new claude sessions) and "Login" (open an
   * interactive xterm modal running `claude` with the team's CLAUDE_CONFIG_DIR).
   *
   * SECURITY: credentials are never displayed. "configured" only reflects the
   * existence of a credentials file; the login modal is the user's own
   * interactive terminal — NanoCode only relays bytes.
   */
  async function renderTeamManagement(container) {
    const section = document.createElement('div')
    section.className = 'team-management'
    section.innerHTML = '<div class="plugin-manager-loading">Loading teams…</div>'
    container.appendChild(section)

    let status
    try {
      const res = await fetch('/api/teams')
      if (!res.ok) throw new Error((await res.text()) || 'fetch failed')
      status = await res.json()
    } catch (err) {
      section.innerHTML = `<div class="plugin-manager-error">Failed to load teams: ${escapeHtml(String(err?.message || err))}</div>`
      return
    }

    function paint() {
      const teams = status.teams || []
      section.innerHTML = `
        <h3 class="team-management-title">Dual-Team Management</h3>
        <p class="plugin-manager-hint">
          Same email, two teams. Switch sets which team new claude sessions use
          (CLAUDE_CONFIG_DIR). Login opens an interactive terminal to
          authenticate that team. Credentials are never shown.
        </p>
        <div class="team-management-list"></div>
      `
      const listEl = section.querySelector('.team-management-list')
      teams.forEach((team) => {
        const row = document.createElement('div')
        row.className = `team-row${team.active ? ' team-row-active' : ''}`
        row.innerHTML = `
          <div class="team-row-info">
            <div class="team-row-name">
              ${escapeHtml(team.name)}
              ${team.active ? '<span class="team-badge team-badge-active">Active</span>' : ''}
              <span class="team-badge team-badge-${team.configured ? 'on' : 'off'}">${team.configured ? 'Logged in' : 'Not logged in'}</span>
            </div>
            <div class="team-row-dir">${escapeHtml(team.configDir || '')}</div>
          </div>
          <div class="team-row-actions">
            <button type="button" class="btn btn-secondary team-btn-switch" data-team="${escapeHtml(team.key)}" ${team.active ? 'disabled' : ''}>Switch</button>
            <button type="button" class="btn btn-primary team-btn-login" data-team="${escapeHtml(team.key)}">Login</button>
          </div>
        `
        listEl.appendChild(row)
      })

      listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-team]')
        if (!btn) return
        const teamKey = btn.dataset.team
        if (btn.classList.contains('team-btn-switch')) {
          await switchTeam(teamKey)
        } else if (btn.classList.contains('team-btn-login')) {
          openTeamLoginTerminal(teamKey)
        }
      })
    }

    async function switchTeam(teamKey) {
      try {
        const res = await fetch('/api/teams/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ team: teamKey }),
        })
        if (!res.ok) throw new Error((await res.text()) || 'switch failed')
        const data = await res.json()
        status = { teams: data.teams, activeTeam: data.activeTeam }
        paint()
        showToast(`Switched active team to ${data.activeTeam}.`)
      } catch (err) {
        showToast(`Failed to switch team: ${err?.message || err}`)
      }
    }

    paint()

    // Live-update when the server pushes a team status change (e.g. another tab
    // switched the team). Routed via the notify WS as plugin:team:update.
    if (!section.dataset.teamListenerAttached) {
      section.dataset.teamListenerAttached = '1'
      onMessage((msg) => {
        if (msg?.type === 'plugin:team:update' && msg.teams) {
          status = { teams: msg.teams, activeTeam: msg.activeTeam }
          if (section.isConnected) paint()
        }
      })
    }
  }

  /**
   * Open a modal containing an xterm terminal connected to /ws/team-login/:team.
   * The server spawns `claude` with the team's CLAUDE_CONFIG_DIR so the user can
   * complete login interactively. NanoCode only relays bytes — it never reads
   * credentials.
   */
  function openTeamLoginTerminal(team) {
    const TerminalCtor = window.Terminal
    const FitAddonCtor = window.FitAddon?.FitAddon || window.FitAddon
    if (typeof TerminalCtor !== 'function') {
      showToast('Terminal library not loaded. Reload the page.')
      return
    }

    // Backdrop + modal
    const overlay = document.createElement('div')
    overlay.className = 'team-login-modal-overlay'
    overlay.innerHTML = `
      <div class="team-login-modal">
        <div class="team-login-modal-header">
          <span class="team-login-modal-title">Login — ${escapeHtml(team)}</span>
          <button type="button" class="btn-icon team-login-modal-close" aria-label="Close">&#10005;</button>
        </div>
        <div class="team-login-terminal"></div>
        <div class="team-login-modal-hint">Interactive claude session for this team. Run /login to authenticate if needed. Close when done.</div>
      </div>
    `
    document.body.appendChild(overlay)

    const termEl = overlay.querySelector('.team-login-terminal')
    const term = new TerminalCtor({
      fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
    })
    const fitAddon = FitAddonCtor ? new FitAddonCtor() : null
    if (fitAddon) term.loadAddon(fitAddon)
    term.open(termEl)
    requestAnimationFrame(() => { try { fitAddon?.fit() } catch {} })

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws/team-login/${encodeURIComponent(team)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon?.fit()
          const dims = term.cols != null ? { type: 'resize', cols: term.cols, rows: term.rows } : null
          if (dims && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(dims))
        } catch {}
      })
    })
    resizeObserver.observe(termEl)

    ws.addEventListener('open', () => {
      if (term.cols != null) {
        try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) } catch {}
      }
    })
    ws.addEventListener('message', (ev) => {
      let data
      if (ev.data instanceof ArrayBuffer) data = new TextDecoder().decode(ev.data)
      else data = ev.data
      try { term.write(data) } catch {}
    })
    ws.addEventListener('close', () => {
      try { term.writeln('\r\n[connection closed]') } catch {}
    })
    ws.addEventListener('error', () => {
      try { term.writeln('\r\n[connection error]') } catch {}
    })

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data) } catch {}
      }
    })

    function close() {
      try { ws.close() } catch {}
      resizeObserver.disconnect()
      try { term.dispose() } catch {}
      overlay.remove()
    }
    overlay.querySelector('.team-login-modal-close').addEventListener('click', close)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
    // ESC to close
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } }
    document.addEventListener('keydown', onKey)

    term.focus()
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** Escape a string for safe use inside a CSS attribute selector. */
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
    return String(s).replace(/["\\]/g, '\\$&')
  }

  function showToast(message) {
    // Prefer the host app's toast if available.
    if (typeof window.showToast === 'function') {
      window.showToast(message)
      return
    }
    const toast = document.createElement('div')
    toast.className = 'plugin-manager-toast'
    toast.textContent = message
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  }

  return {
    on,
    emit,
    onMessage,
    registerSetting,
    renderSettings,
    registerPanel,
    registerRenderer,
    renderPanels,
    showPanel,
    hasPanel,
    loadClientPlugin,
    unloadClientPlugin,
    renderPluginManager,
    attachNotifyWs,
    fetchSettings,
    updateSetting,
  }
}

/**
 * Load enabled browser plugins.
 *
 * Reads `/api/settings` for `plugin_<name>_enabled`, then dynamically imports
 * `plugins/<name>/client.js` and calls register(ui).
 *
 * @param {object} ui
 * @returns {Promise<string[]>} loaded plugin names
 */
export async function loadClientPlugins(ui) {
  const loaded = []
  let settings
  try { settings = await ui.fetchSettings() } catch { return loaded }

  const enabled = Object.entries(settings)
    .filter(([k, v]) => k.startsWith('plugin_') && k.endsWith('_enabled') && v)
    .map(([k]) => k.slice('plugin_'.length, -'_enabled'.length))

  // Fetch manifests (apiVersion + extensionPoints) from the server so we can
  // run the same advisory version/manifest validation the server host does.
  // Fetch failure is non-fatal: we just skip validation and still load.
  let manifestByName = new Map()
  try {
    const res = await fetch('/api/plugins')
    if (res.ok) {
      const data = await res.json()
      for (const p of data.plugins || []) manifestByName.set(p.name, p)
    }
  } catch { /* network error — skip validation */ }

  for (const name of enabled) {
    const manifest = manifestByName.get(name)
    if (manifest) {
      validateClientManifest(name, {
        apiVersion: manifest.apiVersion,
        extensionPoints: manifest.extensionPoints,
      })
    }
    try {
      await ui.loadClientPlugin(name)
      loaded.push(name)
    } catch (err) {
      console.warn(`[plugin-ui] failed to load ${name}:`, err?.message)
    }
  }
  return loaded
}
