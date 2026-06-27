/**
 * Default renderer registrations.
 *
 * This is the "default plugin" layer: it imports the three existing pane
 * implementations and registers each with the renderer registry, replacing the
 * old hardcoded `if/else` dispatch that lived inside `tab-manager.js`.
 *
 * Core (tab-manager) now imports this module for its side effect (registration)
 * and talks only to `rendererRegistry`. Moving the renderer source files into
 * `plugins/` proper is a later, larger step documented in NANOCODE_ARCH.md §6;
 * this file is the safe first cut that keeps every renderer file untouched
 * while making the selection data-driven and overridable.
 */
import { rendererRegistry } from './renderer-registry.js'
import { ClaudeBlockRenderer } from './claude-block-renderer.js'
import { CodexBlockRenderer } from './codex-block-renderer.js'
import { TerminalPane } from './terminal-pane.js'

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

export const RENDERER_DEFAULTS_REGISTERED = true
