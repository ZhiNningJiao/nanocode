/**
 * Plugin registry — MES-13740 需求6.
 *
 * Ecosystem-aware plugin manifests for the right-side functional area.
 * Each manifest declares: { name, version, apiVersion, group, tab, permissions }.
 *   - group: 'work' | 'monitor' — which top-level domain mounts the tab (R2 B-2:
 *     collapsed old session/ops/artifacts into dual-group per主人 "监视AI放一起 /
 *     Claude Code 相关放一起": work = operate current agent + outputs; monitor = watch all).
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
export const PLUGIN_GROUPS = ['work', 'monitor']

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
  // `tab` is optional (需求13): a settings-only plugin (e.g. tts / notify) has
  // no tab — it only surfaces a per-plugin settings panel in the plugin manager.
  // When present, it must be a plain object with a non-empty id.
  if (m.tab != null) {
    if (typeof m.tab !== 'object' || Array.isArray(m.tab)) {
      errors.push('tab must be a plain object')
    } else {
      if (!m.tab.id || typeof m.tab.id !== 'string') errors.push('tab.id must be a non-empty string')
      if (m.tab.labelKey != null && typeof m.tab.labelKey !== 'string') errors.push('tab.labelKey must be a string')
    }
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
  // `settings` is optional (需求14 补充: ecosystem field for per-plugin config;
  // 需求13 surfaces it as a per-plugin settings panel in the plugin manager).
  // If present it must be a plain object — the values are plugin-defined.
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
    group: 'work',
    tab: { id: 'team-model', labelKey: 'plugin.teammodel.label' },
    permissions: ['fs.read', 'fs.write'],
    descriptionKey: 'plugin.teammodel.desc',
    builtin: true,
  },
  {
    name: 'usage',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'monitor',
    tab: { id: 'usage', labelKey: 'plugin.usage.label' },
    permissions: ['fs.read', 'network', 'personal.aigw'],
    descriptionKey: 'plugin.usage.desc',
    // MES-13788 延续: re-fetch usage sources every time the tab becomes active
    // (主人要求: 每次拉开/切换到这个 tab 都刷新). The renderer is idempotent and
    // degrades to honest unavailable states, so re-invoking on each activation is
    // safe and keeps the budget/usage numbers fresh without a manual click.
    refreshOnActivate: true,
    builtin: true,
  },
  {
    name: 'memory',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'work',
    tab: { id: 'memory', labelKey: 'plugin.memory.label' },
    permissions: ['fs.read', 'fs.write'],
    descriptionKey: 'plugin.memory.desc',
    builtin: true,
  },
  {
    name: 'persona',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'work',
    tab: { id: 'persona', labelKey: 'plugin.persona.label' },
    permissions: ['fs.read'],
    descriptionKey: 'plugin.persona.desc',
    builtin: true,
  },
  {
    // 需求14 — Compare: recent-branches diff. The first "heavy feature plugin"
    // sample for the registry: it replaces the 需求6 built-in Compare placeholder
    // with a dynamically registered tab. R2 B-2: moved to the `work` group (Claude
    // Code outputs are operated alongside the agent that produced them).
    name: 'compare',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'work',
    tab: { id: 'compare', labelKey: 'plugin.compare.label' },
    permissions: ['git.read', 'fs.read'],
    settings: { defaultBranches: 10 },
    descriptionKey: 'plugin.compare.desc',
    builtin: true,
  },
  {
    // MES-14031 — Sessions: browse / preview / fork-resume past agent sessions.
    // Ports Codex CLI's `codex resume` (picker) + `codex fork` to the nanocode
    // plugin surface. Lists Codex (~/.codex/sessions) + Claude Code
    // (~/.claude/projects) sessions newest-first, shows a tail excerpt, and
    // lets the user fork a previous session into a new tab. Read-only.
    name: 'sessions',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'work',
    tab: { id: 'sessions', labelKey: 'plugin.sessions.label' },
    permissions: ['fs.read'],
    settings: { defaultLimit: 50 },
    descriptionKey: 'plugin.sessions.desc',
    refreshOnActivate: true,
    builtin: true,
  },
  {
    // MES-14031 S2 — Rewind: Claude Code desktop's checkpointing/rewind, ported
    // to nanocode. Every user prompt is a checkpoint; the user can rewind the
    // conversation to a prior turn, discarding the tail — the recovery path when
    // an agent goes off track (vs /clear which loses all context). This prototype
    // delivers CONVERSATION rewind (backup + truncate the jsonl at a turn
    // boundary); "restore code" (per-turn file snapshots) is the documented next
    // step, not faked here. Placed in `work` (operates the current agent's
    // transcript) alongside sessions/compare. fs.write because apply mutates the
    // jsonl (after a backup); no personal.* secrets needed.
    name: 'rewind',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'work',
    tab: { id: 'rewind', labelKey: 'plugin.rewind.label' },
    permissions: ['fs.read', 'fs.write'],
    descriptionKey: 'plugin.rewind.desc',
    refreshOnActivate: true,
    builtin: true,
  },
  {
    // MES-14031 S5 — Tasks: live agent TODO list. Both Claude Code (TodoWrite
    // tool) and Codex (todo_list structured events) emit task lists during
    // agent turns. This panel surfaces them as a dedicated right-side tab so
    // the user can see what the agent is working on at a glance — instead of
    // scrolling through terminal output to find the latest todo list.
    // Purely client-side: the block renderers dispatch nanocode:todo-update
    // CustomEvents; this panel listens and re-renders. No backend route.
    // Placed in `work` (operates the current agent's task state) alongside
    // sessions/rewind. No permissions needed — reads only from in-process
    // events, no fs or network access.
    name: 'tasks',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'work',
    tab: { id: 'tasks', labelKey: 'plugin.tasks.label' },
    permissions: [],
    descriptionKey: 'plugin.tasks.desc',
    builtin: true,
  },
  {
    // 需求10 — Remote machines: address book that launches the user's *local*
    // native RustDesk client via the `rustdesk://` URI scheme. The server only
    // stores the book (core settings); it bundles no RustDesk code, so AGPL is
    // not triggered for internal use. Placed in monitor (remote machine = external
    // resource, not the current agent). The heavier web-client-iframe approach
    // (needs a self-hosted hbbs/hbbr relay) is documented in REPORT and deferred.
    name: 'remote',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'monitor',
    tab: { id: 'remote', labelKey: 'plugin.remote.label' },
    permissions: ['network', 'personal.remote'],
    descriptionKey: 'plugin.remote.desc',
    builtin: true,
  },
  {
    // 需求13 — Notify: side-channel notification settings migrated out of the
    // Settings page (ntfy push + notification sounds + turn-complete alert).
    // Settings-only plugin (no tab): it surfaces a per-plugin settings panel in
    // the plugin manager. Storage keys are unchanged from the old Settings UI
    // (ntfy_url/ntfy_topic server-side; notifySoundPrefs / nanocodeTurnNotify
    // in localStorage) so existing configs carry over with no migration step.
    name: 'notify',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'monitor',
    permissions: ['network'],
    labelKey: 'plugin.notify.label',
    descriptionKey: 'plugin.notify.desc',
    builtin: true,
  },
  {
    // 需13 — TTS: GPT-SoVITS voice settings migrated out of the Settings page
    // (enable / streaming / reference audio / prompt text). Settings-only plugin
    // (no tab): per-plugin settings panel in the plugin manager. Storage keys
    // unchanged (ttsEnabled / ttsStreaming localStorage; /api/tts/voice server).
    name: 'tts',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'monitor',
    permissions: ['network'],
    labelKey: 'plugin.tts.label',
    descriptionKey: 'plugin.tts.desc',
    builtin: true,
  },
  {
    // 需求13 — Services: port-health monitor migrated out of the Settings page.
    // Tab plugin (monitor): the live services grid + add/edit/delete form live in
    // the tab pane. The server-side checker (runServiceChecks) keeps polling
    // independently; the pane just displays + listens for service_status.
    name: 'services',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'monitor',
    tab: { id: 'services', labelKey: 'plugin.services.label' },
    permissions: ['network'],
    descriptionKey: 'plugin.services.desc',
    builtin: true,
  },
  {
    // Historian — full-sweep task monitor + waker status panel.
    // Polls /api/historian/briefing for running tasks, stalled alerts, signal
    // flags, tmux sessions, and port health. Companion to the native waker
    // (POST /api/waker/tick). Per HISTORIAN_WAKER.md v4.
    name: 'historian',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'monitor',
    tab: { id: 'historian', labelKey: 'plugin.historian.label' },
    permissions: ['fs.read', 'tmux.read', 'network'],
    descriptionKey: 'plugin.historian.desc',
    refreshOnActivate: true,
    builtin: true,
  },
  {
    // MES-14049 — akari 检察: a dedicated monitor tab for the self-hosted akari
    // dispatch server. Polls the nanocode same-origin proxy (/api/akari/state)
    // every ≥10s and renders health summary (version/build/dispatch_caps),
    // concurrency (in-flight/permits), the live workers table, and the lane
    // fleet status. A one-click button jumps to the akari lens dashboard. The
    // akari server URL is personal-config driven (personal.akari.*); when akari
    // is down the panel degrades to a calm "unreachable" state — no error spam.
    // The Port Health grid also shows a managed `akari` row (up/down via
    // /api/health) — see services-panel.js + runServiceChecks.
    name: 'akari',
    version: '1.0.0',
    apiVersion: '1.0',
    group: 'monitor',
    tab: { id: 'akari', labelKey: 'plugin.akari.label' },
    permissions: ['network', 'personal.akari'],
    descriptionKey: 'plugin.akari.desc',
    refreshOnActivate: true,
    builtin: true,
  },
]

export function builtinPlugin(name) {
  return BUILTIN_PLUGINS.find((p) => p.name === name) || null
}
