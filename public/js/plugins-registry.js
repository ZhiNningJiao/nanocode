/**
 * Plugin registry — MES-13740 需求6.
 *
 * Ecosystem-aware plugin manifests for the right-side functional area.
 * Each manifest declares: { name, version, apiVersion, group, tab, permissions }.
 *   - group: 'session' | 'ops' | 'artifacts' — which top-level domain mounts the tab.
 *   - apiVersion: must match PLUGIN_API_VERSION. The loader errors explicitly on
 *     mismatch — it never silently drops an incompatible plugin.
 *   - permissions: declared (e.g. 'fs.read', 'network', 'tmux.read'). Shown in the
 *     plugin manager this round; NOT enforced yet (enforcement is a later core
 *     capability — this round is declare + display only).
 *
 * This module is data + validation only (no DOM, no render cores) so it can be
 * unit-tested in node. right-panel.js wires renderers by plugin `name`.
 */

export const PLUGIN_API_VERSION = '1.0'
export const PLUGIN_GROUPS = ['session', 'ops', 'artifacts']

export function validateManifest(m) {
  const errors = []
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['manifest must be a plain object'] }
  }
  if (!m.name || typeof m.name !== 'string') errors.push('name must be a non-empty string')
  if (!m.version || typeof m.version !== 'string') errors.push('version must be a non-empty string')
  if (!m.apiVersion || typeof m.apiVersion !== 'string') {
    errors.push('apiVersion must be a non-empty string')
  } else if (m.apiVersion !== PLUGIN_API_VERSION) {
    errors.push(`apiVersion ${m.apiVersion} is incompatible (core requires ${PLUGIN_API_VERSION})`)
  }
  if (!PLUGIN_GROUPS.includes(m.group)) {
    errors.push(`group must be one of ${PLUGIN_GROUPS.join(', ')} (got ${JSON.stringify(m.group)})`)
  }
  if (!m.tab || typeof m.tab !== 'object' || Array.isArray(m.tab)) {
    errors.push('tab must be a plain object')
  } else {
    if (!m.tab.id || typeof m.tab.id !== 'string') errors.push('tab.id must be a non-empty string')
    if (m.tab.labelKey != null && typeof m.tab.labelKey !== 'string') errors.push('tab.labelKey must be a string')
  }
  if (m.permissions != null) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions must be an array')
    } else {
      for (const p of m.permissions) {
        if (typeof p !== 'string') errors.push(`permission ${JSON.stringify(p)} must be a string`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

// Built-in plugins. `render` is wired by right-panel.js (by name) to keep this
// module DOM-free and unit-testable. All built-ins target apiVersion '1.0'.
export const BUILTIN_PLUGINS = [
  {
    name: 'team-model',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'session',
    tab: { id: 'team-model', labelKey: 'plugin.teammodel.label' },
    permissions: ['fs.read', 'fs.write'],
    descriptionKey: 'plugin.teammodel.desc',
    builtin: true,
  },
  {
    name: 'usage',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'ops',
    tab: { id: 'usage', labelKey: 'plugin.usage.label' },
    permissions: ['fs.read', 'network'],
    descriptionKey: 'plugin.usage.desc',
    builtin: true,
  },
  {
    name: 'memory',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'session',
    tab: { id: 'memory', labelKey: 'plugin.memory.label' },
    permissions: ['fs.read', 'fs.write'],
    descriptionKey: 'plugin.memory.desc',
    builtin: true,
  },
  {
    name: 'persona',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'session',
    tab: { id: 'persona', labelKey: 'plugin.persona.label' },
    permissions: ['fs.read'],
    descriptionKey: 'plugin.persona.desc',
    builtin: true,
  },
]

export function builtinPlugin(name) {
  return BUILTIN_PLUGINS.find((p) => p.name === name) || null
}
