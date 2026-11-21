/**
 * Which tab types the "+" menu offers (a per-browser setting). Its own module
 * so the settings page can read / write it without pulling the whole
 * workspace (tab-manager → terminal-pane → xterm) onto the cockpit page.
 */
const DEFAULT_ENABLED_TYPES = ['bash', 'claude', 'codex', 'agent', 'opencode', 'meshy-aigw', 'fable5', 'tmux']
const ENABLED_TYPES_KEY = 'nanocodeEnabledTabTypes'

export function getEnabledTabTypes() {
  try {
    const stored = localStorage.getItem(ENABLED_TYPES_KEY)
    if (!stored) return DEFAULT_ENABLED_TYPES
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_ENABLED_TYPES
    return parsed
  } catch { return DEFAULT_ENABLED_TYPES }
}

export function setEnabledTabTypes(types) {
  try { localStorage.setItem(ENABLED_TYPES_KEY, JSON.stringify(types)) } catch {}
}
