/**
 * Server half of the one plugin switch.
 *
 * The browser owns the plugin list and its defaults (plugins-registry.js
 * `defaultOn`) and writes the full enabled list to the `plugins_enabled`
 * setting (right-panel.js). The server only reads that setting to decide
 * whether an optional plugin's BACKGROUND work runs (machine-board SSH poll,
 * Linear → ntfy notifier). Unset / unreadable = nothing optional runs.
 */
import { PLUGINS_SETTING_KEY } from '../public/js/plugins-registry.js'

export { PLUGINS_SETTING_KEY }

export function enabledPlugins(store) {
  let v = store?.getSetting?.(PLUGINS_SETTING_KEY)
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { v = null }
  }
  return new Set(Array.isArray(v) ? v.filter((n) => typeof n === 'string') : [])
}

export function isPluginEnabled(store, name) {
  return enabledPlugins(store).has(name)
}
