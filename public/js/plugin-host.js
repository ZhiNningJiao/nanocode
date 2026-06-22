/**
 * Browser-side plugin host for NanoCode.
 *
 * Core loads this module once and each enabled plugin's `plugins/<name>/client.js`
 * calls `register(ui)`.  Plugins MUST only use the ui API below; they must not
 * reach into Core internals.
 *
 * Extension points:
 *   - Local events: ui.on(event, cb) / ui.emit(event, payload)
 *   - Settings UI:  ui.registerSetting({ id, render(container) })
 *   - Full panel:   ui.registerPanel(id, { title, render(container) })
 *   - Server messages: ui.onMessage(cb) — receives notify-WS payloads whose
 *     type starts with "plugin:".
 *   - REST settings: ui.fetchSettings() / ui.updateSetting(key, value)
 */

import { fetchSettings, updateSetting } from './api.js'

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

  /** @type {Map<string, { panels: Set<string>, settings: Set<string>, messages: Set<Function> }>} */
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
  function renderSettings(panel) {
    if (!panel) return
    const wantedIds = new Set()
    for (const def of settingSlots) {
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
    const registry = { panels: new Set(), settings: new Set(), messages: new Set() }
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

    return {
      on,
      emit,
      onMessage: wrapOnMessage,
      registerSetting: wrapRegisterSetting,
      registerPanel: wrapRegisterPanel,
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
  async function renderPluginManager(container) {
    container.innerHTML = '<div class="plugin-manager-loading">Loading plugins…</div>'

    let plugins = []
    try {
      const res = await fetch('/api/plugins')
      if (!res.ok) throw new Error((await res.text()) || 'fetch failed')
      const data = await res.json()
      plugins = data.plugins || []
    } catch (err) {
      container.innerHTML = `<div class="plugin-manager-error">Failed to load plugins: ${escapeHtml(String(err?.message || err))}</div>`
      return
    }

    if (plugins.length === 0) {
      container.innerHTML = '<div class="plugin-manager-empty">No plugins found.</div>'
      return
    }

    const list = document.createElement('div')
    list.className = 'plugin-manager-list'

    plugins.forEach((plugin) => {
      const row = document.createElement('div')
      row.className = 'plugin-manager-row'
      row.innerHTML = `
        <div class="plugin-info">
          <div class="plugin-name">${escapeHtml(plugin.name)} <span class="plugin-version">${escapeHtml(plugin.version)}</span></div>
          <div class="plugin-description">${escapeHtml(plugin.description || 'No description')}</div>
        </div>
        <label class="plugin-toggle">
          <input type="checkbox" data-plugin="${escapeHtml(plugin.name)}" ${plugin.enabled ? 'checked' : ''}>
          <span>${plugin.enabled ? 'On' : 'Off'}</span>
        </label>
      `
      list.appendChild(row)
    })

    container.innerHTML = `
      <h3>Plugins</h3>
      <p class="plugin-manager-hint">
        Toggle plugins on or off. UI panels and settings update immediately.
        Server-side routes take effect after the server restarts.
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

        // Re-render settings/panels so the new state is reflected immediately.
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
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
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

  for (const name of enabled) {
    try {
      await ui.loadClientPlugin(name)
      loaded.push(name)
    } catch (err) {
      console.warn(`[plugin-ui] failed to load ${name}:`, err?.message)
    }
  }
  return loaded
}
