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
  // `settings` is optional (需求14 补充: ecosystem field for per-plugin config).
  // If present it must be a plain object — the values are plugin-defined.
  // NOTE (gap, recorded in REPORT): the plugin manager does not yet render a
  // per-plugin settings panel (that's 需求13's scope); declaring it here is the
  // forward-compatible ground for the future settings UI.
  if (m.settings != null) {
    if (typeof m.settings !== 'object' || Array.isArray(m.settings)) {
      errors.push('settings must be a plain object')
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
  {
    // 需求14 — Compare: recent-branches diff. The first "heavy feature plugin"
    // sample for the registry: it replaces the 需求6 built-in Compare placeholder
    // with a dynamically registered Artifacts tab.
    name: 'compare',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'artifacts',
    tab: { id: 'compare', labelKey: 'plugin.compare.label' },
    permissions: ['git.read', 'fs.read'],
    settings: { defaultBranches: 10 },
    descriptionKey: 'plugin.compare.desc',
    builtin: true,
  },
  {
    // 需求10 — Remote machines: address book that launches the user's *local*
    // native RustDesk client via the `rustdesk://` URI scheme. The server only
    // stores the book (core settings); it bundles no RustDesk code, so AGPL is
    // not triggered for internal use. Placed in ops (remote machine = external
    // resource, not the current agent). The heavier web-client-iframe approach
    // (needs a self-hosted hbbs/hbbr relay) is documented in REPORT and deferred.
    name: 'remote',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'ops',
    tab: { id: 'remote', labelKey: 'plugin.remote.label' },
    permissions: ['network'],
    descriptionKey: 'plugin.remote.desc',
    builtin: true,
  },
]

export function builtinPlugin(name) {
  return BUILTIN_PLUGINS.find((p) => p.name === name) || null
}
