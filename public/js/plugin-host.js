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
   * Register a settings UI slot.  The plugin returns a render function that
   * receives a container element and populates it.
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
   */
  function renderSettings(panel) {
    if (!panel) return
    for (const def of settingSlots) {
      let container = panel.querySelector(`[data-plugin-setting="${def.id}"]`)
      if (!container) {
        container = document.createElement('div')
        container.dataset.pluginSetting = def.id
        panel.appendChild(container)
      }
      try { def.render(container) } catch (err) { console.warn('[plugin-ui] render error:', err) }
    }
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
   * Render all registered panels into the given tab strip + panel container.
   * A "Terminal" tab is always present; plugin panels are appended after it.
   * `terminalLayout` is hidden when a plugin panel is active.
   */
  function renderPanels(tabStrip, panelContainer, terminalLayout) {
    if (!tabStrip || !panelContainer) return
    tabStrip.innerHTML = ''
    panelContainer.innerHTML = ''

    if (panels.size === 0) {
      tabStrip.hidden = true
      panelContainer.hidden = true
      if (terminalLayout) terminalLayout.hidden = false
      return
    }

    const panelEls = new Map()

    function showPanel(id) {
      if (terminalLayout) terminalLayout.hidden = (id !== '_terminal')
      for (const [pid, el] of panelEls) el.classList.toggle('active', pid === id)
      for (const btn of tabStrip.children) {
        btn.classList.toggle('active', btn.dataset.panel === id)
      }
    }

    function makeTab(label, id) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'panel-tab'
      btn.textContent = label
      btn.dataset.panel = id
      btn.addEventListener('click', () => showPanel(id))
      return btn
    }

    tabStrip.appendChild(makeTab('Terminal', '_terminal'))

    for (const [id, panelDef] of panels) {
      tabStrip.appendChild(makeTab(panelDef.title, id))
      const el = document.createElement('div')
      el.className = 'plugin-panel'
      el.dataset.panel = id
      panelContainer.appendChild(el)
      try { panelDef.render(el) } catch (err) { console.warn('[plugin-ui] panel render error:', err) }
      panelEls.set(id, el)
    }

    tabStrip.hidden = false
    panelContainer.hidden = false
    showPanel('_terminal')
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

  return {
    on,
    emit,
    onMessage,
    registerSetting,
    renderSettings,
    registerPanel,
    renderPanels,
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
      const mod = await import(`/plugins/${name}/client.js`)
      if (typeof mod.register === 'function') {
        mod.register(ui)
        loaded.push(name)
        console.log(`[plugin-ui] loaded client plugin ${name}`)
      }
    } catch (err) {
      console.warn(`[plugin-ui] failed to load ${name}:`, err?.message)
    }
  }
  return loaded
}
