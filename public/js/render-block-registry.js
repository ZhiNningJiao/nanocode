/**
 * Render-Block Registry — the extension point for custom block renderers.
 *
 * DESIGN DOCTRINE: "core small, plugins own features." The block renderers
 * (ClaudeBlockRenderer, CodexBlockRenderer) own ONLY the default rendering of
 * each block type (text, tool_use, tool_result, thinking, …). A plugin can
 * register a custom renderer for a specific block type through
 * `ui.registerBlockRenderer()` (see `plugin-host.js`), with a priority + gate
 * to control when it's eligible.
 *
 * This mirrors the renderer-registry selection model (the "core owns the
 * hook, plugins own the features" pattern from NANOCODE_ARCH.md §6):
 *
 *  - Each registration targets a `blockType` ('text' | 'tool_use' |
 *    'tool_result' | 'thinking' | …) or the catch-all '*' (universal).
 *  - An optional `gate(settings) => boolean` decides eligibility under the
 *    current render-mode settings.
 *  - Among eligible entries the highest `priority` wins.
 *  - If no typed entry is eligible, the '*' fallback is consulted.
 *  - The winning handler's `render(block, container)` is called; if it returns
 *    `true` the default rendering is skipped, if `false` or `undefined` the
 *    default proceeds (lets a plugin augment rather than replace).
 *
 * Reference shapes this mirrors:
 *  - VS Code `CodeLensProvider` — register a provider for a document selector;
 *    the host picks the highest-priority matching provider
 *    (https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
 *  - ProseMirror node views — replace or augment the default rendering for a
 *    specific node type (https://prosemirror.net/docs/ref/#view.NodeView)
 */

/** @type {Map<string, Array<{name:string, render:Function, gate:Function|null, priority:number}>>} */
const _entries = new Map()

/**
 * Read the live settings object for gate evaluation. Falls back to
 * window.__nanocodeState and then to {} when running in tests.
 * @returns {object}
 */
function _resolveSettings() {
  try {
    if (typeof window !== 'undefined' && window.__nanocodeState) return window.__nanocodeState
  } catch { /* non-browser env */ }
  return {}
}

/**
 * Register a custom block renderer for a block type.
 *
 * @param {string} blockType  'text' | 'tool_use' | 'tool_result' | 'thinking' | …,
 *   or '*' for the universal fallback.
 * @param {object} def
 * @param {string} def.name      stable id (used to override/unregister).
 * @param {Function} def.render  `(block, container) => boolean | void` — render
 *   the block into `container`. Return `true` to suppress the default
 *   rendering; return `false`/`undefined` to let it proceed (augment mode).
 * @param {Function} [def.gate]  `(settings) => boolean` eligibility test.
 * @param {number} [def.priority] higher wins; defaults to 0.
 * @returns {string} the registered name (enables unregister).
 */
function register(blockType, def) {
  if (!blockType || !def || typeof def.render !== 'function') {
    throw new Error('renderBlockRegistry.register: blockType and render() required')
  }
  const entry = {
    name: def.name || blockType,
    render: def.render,
    gate: typeof def.gate === 'function' ? def.gate : null,
    priority: typeof def.priority === 'number' ? def.priority : 0,
  }
  const list = _entries.get(blockType) || []
  // Re-registering the same name replaces it (lets a plugin update/override).
  const idx = list.findIndex((e) => e.name === entry.name)
  if (idx >= 0) list[idx] = entry
  else list.push(entry)
  _entries.set(blockType, list)
  return entry.name
}

/**
 * Remove a block renderer registration. Used by the plugin host to unload a
 * plugin's custom block renderer cleanly.
 * @returns {boolean} true if something was removed.
 */
function unregister(blockType, name) {
  const list = _entries.get(blockType)
  if (!list) return false
  const idx = list.findIndex((e) => e.name === name)
  if (idx < 0) return false
  list.splice(idx, 1)
  if (!list.length) _entries.delete(blockType)
  return true
}

/**
 * Pick the best eligible handler for a block type, consulting the '*'
 * fallback when no typed entry is eligible (or none is registered).
 * @returns {{name,render,gate,priority}|null}
 */
function getHandler(blockType, settings = _resolveSettings()) {
  for (const t of [blockType, '*']) {
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
 * Try to render a block with a registered custom handler. Returns `true` if a
 * handler rendered it (and the default should be suppressed), `false`
 * otherwise. This is the main call site from the block renderers.
 *
 * @param {string} blockType
 * @param {object} block    the block data (content, name, input, …)
 * @param {HTMLElement} container  the DOM element to render into
 * @param {object} [settings]
 * @returns {boolean}  true if a custom handler rendered the block
 */
function tryRender(blockType, block, container, settings = _resolveSettings()) {
  const entry = getHandler(blockType, settings)
  if (!entry) return false
  try {
    const handled = entry.render(block, container)
    return handled === true
  } catch (err) {
    console.warn(`[render-block] handler "${entry.name}" threw:`, err?.message || err)
    return false
  }
}

/** Introspection for UI/debugging: list entries for a type (or all). */
function list(blockType) {
  if (blockType) return (_entries.get(blockType) || []).map(_public)
  const out = []
  for (const [t, list] of _entries) for (const e of list) out.push({ blockType: t, ..._public(e) })
  return out
}
function _public(e) {
  return { name: e.name, hasGate: !!e.gate, priority: e.priority }
}

/** Test-only: wipe the registry between cases. */
function _reset() {
  _entries.clear()
}

export const renderBlockRegistry = {
  register,
  unregister,
  getHandler,
  tryRender,
  list,
  _reset,
}
