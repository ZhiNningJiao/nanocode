/**
 * Core-Renderers plugin — browser side.
 *
 * This is the "default plugin" layer: it imports the three existing pane
 * implementations and registers each with the renderer registry, replacing
 * the old hardcoded `if/else` dispatch that lived inside `tab-manager.js`.
 *
 * This plugin registers directly via `rendererRegistry.register()` rather than
 * `ui.registerRenderer()` so the registrations are NOT tracked for unloading.
 * Core default renderers should persist even if this plugin is toggled off in
 * the UI — disabling it only prevents future re-registration, not the
 * already-registered defaults (which are also ensured by `default-renderers.js`
 * as a module-load safety net).
 *
 * Blueprint reference: NANOCODE_ARCH.md §6 / Phase 4 — "Move default-renderers.js
 * registrations into a plugins/core-renderers/ plugin."
 */

import { rendererRegistry } from '../../js/renderer-registry.js'
import { ClaudeBlockRenderer } from '../../js/claude-block-renderer.js'
import { CodexBlockRenderer } from '../../js/codex-block-renderer.js'
import { TerminalPane } from '../../js/terminal-pane.js'

export function register(_ui) {
  // Claude tabs → rich DOM block renderer, unless the user opts into raw PTY via
  // the global renderMode setting. Priority 10 so a plugin could override at >10.
  rendererRegistry.register('claude', {
    name: 'claude-block',
    factory: (el, opts) => new ClaudeBlockRenderer(el, opts),
    gate: (s) => (s.renderMode || 'block') !== 'terminal',
    priority: 10,
  })

  // Codex tabs → block renderer is experimental; only when codexRenderMode==='block'.
  rendererRegistry.register('codex', {
    name: 'codex-block',
    factory: (el, opts) => new CodexBlockRenderer(el, opts),
    gate: (s) => s.codexRenderMode === 'block',
    priority: 10,
  })

  // Universal fallback: raw xterm PTY pane. Used for bash tabs and for any typed
  // renderer whose gate fails (e.g. claude with renderMode='terminal'). No gate,
  // priority 0 — eligible for every session type, beaten by any eligible typed entry.
  rendererRegistry.register('*', {
    name: 'terminal',
    factory: (el, opts) => new TerminalPane(el, opts),
    priority: 0,
  })
}
