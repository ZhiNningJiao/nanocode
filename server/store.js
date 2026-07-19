/**
 * JSON file data layer for projects and settings.
 *
 * Robustness rules (do not weaken these):
 *   - save() uses tmp+rename atomic write — never direct overwrite.
 *   - Corrupt JSON on load is backed up as .bak before falling back to emptyData().
 *   - These two invariants prevent crash-during-write from truncating the only
 *     data file, and prevent silent data loss when a corrupted file is encountered.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs'
import { randomUUID } from 'crypto'

const TAB_TYPES = new Set(['bash', 'claude', 'codex', 'agent', 'opencode', 'meshy-aigw', 'fable5', 'tmux'])

function emptyData() {
  return {
    projects: [],
    settings: {
      // Default Claude cache TTL to 5 minutes. Users can switch to 1h in settings.
      claude_cache_ttl: '5m',
    },
    tabs: {},
  }
}

export function createStore(filePath = ':memory:') {
  const inMemory = filePath === ':memory:'
  let data = emptyData()

  if (!inMemory && existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      // Corrupt file — back it up before falling back to empty state.
      // This preserves forensic evidence and prevents silent data loss on
      // every subsequent load (the .bak retains the raw bytes for recovery).
      try { copyFileSync(filePath, filePath + '.bak') } catch { /* best-effort */ }
      console.error('[store] corrupt JSON in', filePath, '— backed up to .bak, starting empty:', err?.message)
      data = emptyData()
    }
    if (!data.projects) data.projects = []
    if (!data.settings) data.settings = {}
    if (!data.tabs || typeof data.tabs !== 'object') data.tabs = {}
    // Forward-compat: drop deprecated keys silently
    delete data.archivedSessions
    delete data.managedSessions
  }

  function save() {
    if (inMemory) return
    // Atomic write: write to .tmp then rename into place.
    // A crash during writeFileSync leaves the .tmp file (incomplete) and the
    // original filePath intact — the live data is never truncated mid-write.
    // This mirrors worker/data-store.js which already does this correctly.
    const tmp = filePath + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2))
      renameSync(tmp, filePath)
    } catch (err) {
      console.error('[store] save() failed — data NOT persisted:', err?.message)
    }
  }

  // --- Settings ---

  function getSetting(key) {
    return data.settings[key] ?? null
  }

  function setSetting(key, value) {
    data.settings[key] = value
    save()
  }

  function getAllSettings() {
    return { ...data.settings }
  }

  // --- Projects ---

  function createProject(name, cwd, existingId = null, ssh = {}) {
    const id = existingId || randomUUID()
    const project = {
      id,
      name,
      cwd,
      created_at: Date.now(),
      ssh_host: ssh.host || null,
      ssh_user: ssh.user || null,
      ssh_port: ssh.port || null,
      ssh_key: ssh.key || null,
    }
    data.projects.push(project)
    save()
    return { ...project }
  }

  function getProject(id) {
    const p = data.projects.find((p) => p.id === id)
    return p ? { ...p } : undefined
  }

  function listProjects() {
    return data.projects.map((p) => ({ ...p }))
  }

  function removeProject(id) {
    data.projects = data.projects.filter((p) => p.id !== id)
    delete data.tabs[id]
    save()
  }

  // --- Tabs (per-project, persisted; PTYs live in-memory keyed by tabId) ---

  function listTabs(projectId) {
    return (data.tabs[projectId] || []).map((t) => ({ ...t }))
  }

  function createTab(projectId, opts = {}) {
    if (!data.tabs[projectId]) data.tabs[projectId] = []
    const id = opts.id || randomUUID().slice(0, 8)
    const existing = data.tabs[projectId]
    const type = TAB_TYPES.has(opts.type) ? opts.type : 'bash'
    const n = existing.filter((t) => (t.type || 'bash') === type).length + 1
    const tab = {
      id,
      label: opts.label || `${type} ${n}`,
      type,
      createdAt: Date.now(),
    }
    if (type === 'claude') {
      tab.claudeSessionId = opts.claudeSessionId || randomUUID()
      tab.claudeSessionStarted = false
      // 需求3: "开启新对话" sets skipAutoResume so the tab starts a fresh
      // conversation instead of falling back to the newest jsonl in the dir.
      if (opts.skipAutoResume) tab.skipAutoResume = true
      // 需求5: cross-team / cross-cwd resume stores the session's owning team
      // (CLAUDE_CONFIG_DIR) and original cwd so the spawned claude + history
      // lookup use the right team/project-slug dir.
      if (opts.claudeConfigDir) tab.claudeConfigDir = opts.claudeConfigDir
      if (opts.claudeSessionCwd) tab.claudeSessionCwd = opts.claudeSessionCwd
      // team-failover opt-in: when true, this session may auto-switch team on a
      // 429 and resume (secretary sessions only; default off; inherited by
      // child tabs spawned from a flagged session). See memory
      // project_nanocode_team_failover.
      if (opts.allowTeamFailover) tab.allowTeamFailover = true
      // 需求8: persona id chosen at new-session creation. Stored on the tab so
      // every turn (new or resume) re-injects the persona via --append-system-prompt,
      // keeping the persona active across reconnects. Empty/absent = no persona.
      if (opts.persona && typeof opts.persona === 'string' && opts.persona.trim()) {
        tab.persona = opts.persona.trim()
      }
    } else if (type === 'codex') {
      tab.codexThreadId = opts.codexThreadId || null
    } else if (type === 'tmux') {
      tab.tmuxTarget = opts.tmuxTarget || null
    } else if (type === 'fable5' || type === 'opencode') {
      // 需求15 item1: a Fable5/opencode tab opened via the resume picker carries
      // the chosen opencode session id so the block driver passes --session <id>
      // (resumes the conversation) and the history route replays it. null = a
      // brand-new tab; the driver captures the id from the first turn's stdout
      // and persists it via updateTabMetadata (see allow-list below).
      tab.opencodeSessionId = typeof opts.opencodeSessionId === 'string' && opts.opencodeSessionId.trim()
        ? opts.opencodeSessionId.trim()
        : null
      // 需求15 item5: persona id chosen in the new-session picker → stored on
      // the tab so the opencode block driver re-injects it every turn (prepend,
      // since opencode has no --append-system-prompt flag). Mirrors claude's
      // persistence so the 🐱 tab chip + per-turn injection survive reconnects.
      if (opts.persona && typeof opts.persona === 'string' && opts.persona.trim()) {
        tab.persona = opts.persona.trim()
      }
    }
    // 需求16: session-group favorites. A favorite tab carries its own model
    // (modelOverride/effortOverride — the per-tab lock root, reused verbatim
    // from req13's tab-model-override) and its own display mode (renderMode =
    // 'block' | 'terminal', falling back to the global per-type setting when
    // absent). favorite/favoriteOrder persist so the resume strip re-pins the
    // starred tabs to the top on reopen. All four are optional + absent = off,
    // so legacy tabs (no favorite fields) stay exactly as they were.
    if (opts.favorite === true) tab.favorite = true
    if (typeof opts.favoriteOrder === 'number' && Number.isFinite(opts.favoriteOrder)) {
      tab.favoriteOrder = opts.favoriteOrder
    }
    if (typeof opts.renderMode === 'string' && ['block', 'terminal'].includes(opts.renderMode)) {
      tab.renderMode = opts.renderMode
    }
    if (typeof opts.modelOverride === 'string' && opts.modelOverride.trim()) {
      tab.modelOverride = opts.modelOverride.trim()
    }
    if (typeof opts.effortOverride === 'string' && opts.effortOverride.trim()) {
      tab.effortOverride = opts.effortOverride.trim()
    }
    existing.push(tab)
    save()
    return { ...tab }
  }

  function removeTab(projectId, tabId) {
    if (!data.tabs[projectId]) return false
    const before = data.tabs[projectId].length
    data.tabs[projectId] = data.tabs[projectId].filter((t) => t.id !== tabId)
    if (data.tabs[projectId].length < before) {
      save()
      return true
    }
    return false
  }

  function renameTab(projectId, tabId, label) {
    if (!data.tabs[projectId]) return null
    const tab = data.tabs[projectId].find((t) => t.id === tabId)
    if (!tab) return null
    tab.label = label
    save()
    return { ...tab }
  }

  function hasTab(projectId, tabId) {
    if (!data.tabs[projectId]) return false
    return data.tabs[projectId].some((t) => t.id === tabId)
  }

  function getTab(projectId, tabId) {
    if (!data.tabs[projectId]) return null
    const tab = data.tabs[projectId].find((t) => t.id === tabId)
    return tab ? { ...tab } : null
  }

  function updateTabMetadata(projectId, tabId, patch = {}) {
    if (!data.tabs[projectId]) return null
    const tab = data.tabs[projectId].find((t) => t.id === tabId)
    if (!tab) return null
    const allowed = ['claudeSessionId', 'claudeSessionStarted', 'codexThreadId', 'pendingQueue', 'tmuxTarget', 'claudeConfigDir', 'claudeSessionCwd', 'persona', 'opencodeSessionId', 'allowTeamFailover', 'modelOverride', 'effortOverride', 'favorite', 'favoriteOrder', 'renderMode']
    let changed = false
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        if (key === 'pendingQueue') {
          // Always update array — deep-equality check is expensive and not needed
          tab[key] = Array.isArray(patch[key]) ? patch[key] : []
          changed = true
        } else if (tab[key] !== patch[key]) {
          tab[key] = patch[key]
          changed = true
        }
      }
    }
    if (changed) save()
    return { ...tab }
  }

  function migrateProjectsJson(jsonPath) {
    if (!existsSync(jsonPath)) return
    try {
      const projects = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      const existingIds = new Set(data.projects.map((p) => p.id))
      const existingCwds = new Set(data.projects.map((p) => p.cwd))
      for (const project of projects) {
        if (!existingIds.has(project.id) && !existingCwds.has(project.cwd)) {
          data.projects.push({
            id: project.id,
            name: project.name,
            cwd: project.cwd,
            created_at: Date.now(),
            ssh_host: null, ssh_user: null, ssh_port: null, ssh_key: null,
          })
        }
      }
      save()
      renameSync(jsonPath, `${jsonPath}.bak`)
    } catch { /* ignore migration errors */ }
  }

  function ensureStarterProject() {
    // Idempotent: ensure the launch-cwd project exists so a top-level
    // (~zhining, non-repo) launch is a first-class workspace — not stranded
    // on the project picker. Previously this only fired when the store was
    // empty, so a restart at ~zhining with existing projects left ~zhining
    // unregistered and compare / resume unreachable from there. Safe because
    // it is a no-op when a project with this cwd already exists.
    const cwd = process.cwd()
    if (data.projects.some((p) => p.cwd === cwd)) return
    const name = cwd.split('/').filter(Boolean).pop() || 'project'
    createProject(name, cwd)
  }

  // 需求16: seed the master's resident secretary tabs + life assistant into
  // the HOME project (cwd === homeCwd, i.e. os.homedir()) as favorites. This is
  // a one-time, idempotent reconcile — gated by the `secretary_favorites_seeded_v1`
  // settings flag (same one-time-seed pattern as `remote_machines_seeded_v1`).
  //
  // Reconcile-by-label: if a tab with the same {label,type} already exists (the
  // master already created 秘书T1 / 生活小助手 on 9475), it is NOT duplicated —
  // we only set favorite=true + favoriteOrder and, when ABSENT, the model +
  // block renderMode. Existing modelOverride / persona / renderMode choices
  // are never overwritten. Tabs that don't exist are created with the full
  // config. Running this on a fresh 9476 (home project = just bash) creates
  // all four; running it later on 9475 (master restarts themselves) marks the
  // existing secretaries as favorites and creates the missing ones — no dups.
  //
  // The four favorites are NOT given any persona (需求16: no 人设 prompt on
  // these sessions; the life assistant is explicitly a plain session).
  //
  // seedfix: the `secretary_favorites_seeded_v1` flag lives in `data.settings`,
  // i.e. the SAME persistent JSON file as `data.tabs` (same atomic write + .bak
  // fallback as the rest of the store), so a successful seed always leaves both
  // the tabs and the flag durably together. On a store reset / multi-instance
  // re-seed (flag gone) the reconcile branch only backfills the missing
  // favorite / favoriteOrder / modelOverride / renderMode fields and NEVER
  // rewrites an existing tab's session; the create branch creates the tab
  // SESSION-LESS (no claudeSessionId / claudeSessionStarted). This is what
  // stops a re-seed from rebounding favorite tabs onto the active 秘书T1
  // session (daf68aac) — the jsonl-fork root cause.
  function seedSecretaryFavorites(homeCwd) {
    if (getSetting('secretary_favorites_seeded_v1')) return false
    const project = data.projects.find((p) => p.cwd === homeCwd)
    if (!project) return false // home project not registered yet — retry next startup
    const pid = project.id
    if (!data.tabs[pid]) data.tabs[pid] = []
    const tabs = data.tabs[pid]
    const specs = [
      { label: '秘书T1', type: 'claude', modelOverride: 'claude-fable-5', order: 0 },
      { label: '秘书T2', type: 'claude', modelOverride: 'claude-fable-5', order: 1 },
      { label: 'Codex秘书', type: 'codex', modelOverride: 'gpt-5.6', order: 2 },
      { label: '生活小助手', type: 'claude', modelOverride: 'claude-sonnet-4-6', order: 3 },
    ]
    let changed = false
    for (const spec of specs) {
      const existing = tabs.find((t) => (t.type || 'bash') === spec.type && t.label === spec.label)
      if (existing) {
        // Reconcile: pin as favorite + lock model/block only where absent.
        // seedfix: NEVER touch the session fields (claudeSessionId /
        // claudeSessionStarted / codexThreadId) on an existing tab — only
        // favorite / favoriteOrder / modelOverride / renderMode are backfilled.
        // Overwriting session here is what rebound favorite tabs onto the
        // active 秘书T1 session on a re-seed.
        if (!existing.favorite) { existing.favorite = true; changed = true }
        if (typeof existing.favoriteOrder !== 'number') { existing.favoriteOrder = spec.order; changed = true }
        if (!existing.modelOverride) { existing.modelOverride = spec.modelOverride; changed = true }
        if (!existing.renderMode) { existing.renderMode = 'block'; changed = true }
        continue
      }
      // Create the favorite tab in-place. seedfix: a seeded favorite tab is
      // born SESSION-LESS — we do NOT pre-write claudeSessionId (nor
      // claudeSessionStarted). A pre-assigned random UUID is a phantom with no
      // jsonl behind it; on the first click resolveSessionJsonl's newest-jsonl
      // fallback would resume the active 秘书T1 session (daf68aac) and persist
      // it back here, so two tabs owned one jsonl → the fork accident. Instead
      // the tab stays session-less until the claude session controller assigns
      // a fresh id on the first turn and persists it via updateTabMetadata.
      // `spec.claudeSessionId` is honored ONLY when explicitly provided (and
      // never inferred from the running active session).
      const tab = {
        id: randomUUID().slice(0, 8),
        label: spec.label,
        type: spec.type,
        createdAt: Date.now(),
        favorite: true,
        favoriteOrder: spec.order,
        renderMode: 'block',
        modelOverride: spec.modelOverride,
      }
      if (spec.type === 'claude') {
        if (typeof spec.claudeSessionId === 'string' && spec.claudeSessionId.trim()) {
          tab.claudeSessionId = spec.claudeSessionId.trim()
        }
        // deliberately no claudeSessionId / claudeSessionStarted otherwise.
      } else if (spec.type === 'codex') {
        tab.codexThreadId = null
      }
      tabs.push(tab)
      changed = true
    }
    setSetting('secretary_favorites_seeded_v1', '1')
    if (changed) save()
    return changed
  }

  // Shutdown hooks: modules that hold live resources (e.g. the claude session
  // controller's in-process SDK streaming sessions → child-process handles)
  // register a teardown here. close() runs them so the process can exit. This
  // fires ONLY on real server shutdown / test end — never on a WS reload — so
  // reload-survives behaviour is preserved (the controller's ws.on('close')
  // does not tear sessions down).
  const _closeHooks = []
  function registerCloseHook(fn) {
    if (typeof fn === 'function') _closeHooks.push(fn)
  }

  function close() {
    while (_closeHooks.length) {
      const fn = _closeHooks.shift()
      try { fn() } catch (err) {
        console.warn('[store] close hook failed:', err?.message || err)
      }
    }
  }

  return {
    getSetting, setSetting, getAllSettings,
    createProject, getProject, listProjects, removeProject,
    migrateProjectsJson, ensureStarterProject, seedSecretaryFavorites,
    listTabs, createTab, removeTab, renameTab, hasTab, getTab, updateTabMetadata,
    registerCloseHook,
    close,
  }
}

let _instance = null

export function getStore(filePath = 'data/nanocode.json') {
  if (!_instance) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    if (dir) mkdirSync(dir, { recursive: true })
    _instance = createStore(filePath)
  }
  return _instance
}
