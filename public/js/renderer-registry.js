/**
 * Renderer Registry — the extension point for terminal/agent output renderers.
 *
 * DESIGN DOCTRINE: "core small, plugins own features." Core owns ONLY this
 * registry (the hook). Concrete renderers (ClaudeBlockRenderer,
 * CodexBlockRenderer, TerminalPane) register themselves as default plugins via
 * `default-renderers.js`. A third-party plugin can register a custom renderer
 * through `ui.registerRenderer()` (see `plugin-host.js`).
 *
 * This replaces the previous hardcoded dispatch in `tab-manager.js`:
 *     if (type === 'claude' && ...) new ClaudeBlockRenderer(...)
 *     else if (type === 'codex' && ...) new CodexBlockRenderer(...)
 *     else new TerminalPane(...)
 * with a data-driven registry lookup, so adding/swapping a renderer no longer
 * requires editing core dispatch code.
 *
 * Reference shapes this mirrors:
 *  - webpack `module.rules` — a registry of transformers keyed by a predicate,
 *    resolved per resource (https://webpack.js.org/concepts/loaders/).
 *  - VS Code `CustomEditor` / `registerDocumentContentProvider` — register a
 *    renderer for a resource type; the host picks the best match
 *    (https://code.visualstudio.com/api/extension-capabilities/overview).
 *
 * Selection model. Each registration targets a `sessionType`
 * ('claude' | 'codex' | 'bash' | …) or the catch-all '*' (universal fallback).
 * An optional `gate(settings) => boolean` decides whether the entry is eligible
 * under the current render-mode settings (e.g. Claude's block renderer is only
 * eligible when `renderMode !== 'terminal'`). Among eligible entries the highest
 * `priority` wins. If no typed entry is eligible, the '*' fallback is consulted.
 */

/** @type {Map<string, Array<{name:string, factory:Function, gate:Function|null, priority:number}>>} */
const _entries = new Map()

/**
 * Read the live settings object. Falls back to window.__nanocodeState (the
 * object core stamps onto the page) and then to {} when running in tests.
 * @returns {object}
 */
function _resolveSettings() {
  try {
    if (typeof window !== 'undefined' && window.__nanocodeState) return window.__nanocodeState
  } catch { /* non-browser env */ }
  return {}
}

/**
 * Register a renderer for a session type.
 *
 * @param {string} sessionType  'claude' | 'codex' | 'bash' | …, or '*' for the
 *   universal fallback used when no typed entry is eligible.
 * @param {object} def
 * @param {string} def.name      stable id (used to override/unregister).
 * @param {Function} def.factory `(el, opts) => paneInstance` — must return an
 *   object exposing the TerminalPane-compatible public API.
 * @param {Function} [def.gate]  `(settings) => boolean` eligibility test.
 * @param {number} [def.priority] higher wins; defaults to 0.
 * @returns {string} the registered name (enables unregister).
 */
function register(sessionType, def) {
  if (!sessionType || !def || typeof def.factory !== 'function') {
    throw new Error('rendererRegistry.register: sessionType and factory() required')
  }
  const entry = {
    name: def.name || sessionType,
    factory: def.factory,
    gate: typeof def.gate === 'function' ? def.gate : null,
    priority: typeof def.priority === 'number' ? def.priority : 0,
  }
  const list = _entries.get(sessionType) || []
  // Re-registering the same name replaces it (lets a plugin override a default).
  const idx = list.findIndex((e) => e.name === entry.name)
  if (idx >= 0) list[idx] = entry
  else list.push(entry)
  _entries.set(sessionType, list)
  return entry.name
}

/**
 * Remove a renderer registration. Used by the plugin host to unload a plugin's
 * renderer cleanly (mirrors panel/setting unload).
 * @returns {boolean} true if something was removed.
 */
function unregister(sessionType, name) {
  const list = _entries.get(sessionType)
  if (!list) return false
  const idx = list.findIndex((e) => e.name === name)
  if (idx < 0) return false
  list.splice(idx, 1)
  if (!list.length) _entries.delete(sessionType)
  return true
}

/**
 * Pick the best eligible entry for a session type, consulting the '*' fallback
 * when no typed entry is eligible (or none is registered).
 * @returns {{name,factory,gate,priority}|null}
 */
function getRenderer(sessionType, settings = _resolveSettings()) {
  for (const t of [sessionType, '*']) {
    const list = _entries.get(t)
    if (!list || !list.length) continue
    const eligible = list.filter((e) => !e.gate || e.gate(settings))
    if (!eligible.length) continue
    eligible.sort((a, b) => b.priority - a.priority)
    return eligible[0]
  }
  return null
}

/**
 * Resolve + instantiate the pane for a session type. Returns the pane instance
 * or null if no renderer is registered (caller should keep a defensive default).
 * @param {string} sessionType
 * @param {HTMLElement} el
 * @param {object} opts  passed straight to the factory (projectId, tabId, …)
 * @param {object} [settings]
 */
function createPane(sessionType, el, opts, settings = _resolveSettings()) {
  const entry = getRenderer(sessionType, settings)
  if (!entry) return null
  return entry.factory(el, opts)
}

/** Introspection for UI/debugging: list entries for a type (or all). */
function list(sessionType) {
  if (sessionType) return (_entries.get(sessionType) || []).map(_public)
  const out = []
  for (const [t, list] of _entries) for (const e of list) out.push({ sessionType: t, ..._public(e) })
  return out
}
function _public(e) {
  return { name: e.name, hasGate: !!e.gate, priority: e.priority }
}

/** Test-only: wipe the registry between cases. */
function _reset() {
  _entries.clear()
}

export const rendererRegistry = {
  register,
  unregister,
  getRenderer,
  createPane,
  list,
  _reset,
}
