/** Terminal routes — Express Router + WebSocket handler. */

import { Router } from 'express'
import { execFile, spawn } from 'node:child_process'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path, { resolve, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { currentPlatform, listDirectory, listDrives } from './fsbrowse.js'
import * as sessions from './sessions.js'
import { createClaudeHistoryService, resolveSessionJsonl } from './claude-history.js'
import { createClaudeSessionController } from './claude-session-controller.js'
import { createRecentAgentsService } from './recent-agents.js'
import { scanClaudeUsage, scanAllOpencodeUsage, listTeams, listAigwModels, probeAigwCost, effectiveClaudeConfigDir, listMemoryTree, listMemoryFiles, readMemoryFile, searchMemory, saveMemoryFile, buildUsageSummary, fetchAigwBudget } from './usage.js'
import { listPersonas, readPersona, listSkills } from './personas.js'
import { listBranches, diffOverview, fileDiff } from './compare.js'
import { listSessions, previewSession } from './sessions-browser.js'
import { buildCheckpoints, rewindConversation } from './rewind.js'
import { listMachines, addMachine, updateMachine, deleteMachine, buildConnectUri, getMachine, buildSshCommand, mergePersonalMachines } from './remote.js'
import { createRemoteSshHandler, resolveSshpass } from './remote-ssh.js'
import { loadPersonalConfig, projectForPlugin } from './personal-config.js'
import { builtinPlugin } from '../public/js/plugins-registry.js'
import { exportToEvents } from './opencode-adapter.js'
import { listOpencodeSessions } from './opencode-sessions.js'
import { createReposRoutes } from './repos-routes.js'

/**
 * Create terminal routes backed by the given store.
 */
export function createTerminalRoutes(store, opts = {}) {
  const router = Router()
  const home = homedir()
  const recentAgents = createRecentAgentsService({ home })
  const sessionController = createClaudeSessionController({
    store,
    home,
    recentAgents,
    port: opts?.port ?? null,
    // Test seam only: forwarded to createClaudeSdkDriver so send-now race
    // tests can inject a deterministic mock query. Undefined in production.
    testQueryImpl: opts?.testQueryImpl,
  })
  // On server shutdown / test end, tear down all in-process SDK streaming
  // sessions so their child-process handles release and the process can exit.
  // (Reload-survives is preserved: this only fires from store.close(), not from
  // a WS drop.) See controller.disposeClaudeSessions.
  if (typeof store.registerCloseHook === 'function') {
    store.registerCloseHook(() => sessionController.disposeClaudeSessions())
  }
  const historyService = createClaudeHistoryService({
    store,
    home,
    recentAgents,
    sessionController,
  })
  const remoteSsh = createRemoteSshHandler(store)

  /** Parse ~/.ssh/config into an array of host objects. */
  function parseSshConfig(content) {
    const hosts = []
    let current = null
    for (const raw of content.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const match = line.match(/^(\S+)\s+(.+)$/)
      if (!match) continue
      const [, key, value] = match
      const k = key.toLowerCase()
      if (k === 'host') {
        if (value.includes('*')) { current = null; continue }
        current = { name: value, hostname: null, user: null, port: null, identityFile: null }
        hosts.push(current)
      } else if (current) {
        if (k === 'hostname') current.hostname = value
        else if (k === 'user') current.user = value
        else if (k === 'port') current.port = parseInt(value, 10) || null
        else if (k === 'identityfile') current.identityFile = value
      }
    }
    return hosts.filter((h) => h.hostname && h.hostname !== 'github.com')
  }

  router.get('/api/ssh-hosts', (_req, res) => {
    const configPath = join(home, '.ssh', 'config')
    if (!existsSync(configPath)) return res.json([])
    try {
      const content = readFileSync(configPath, 'utf-8')
      res.json(parseSshConfig(content))
    } catch {
      res.json([])
    }
  })

  router.get('/api/projects', (_req, res) => {
    res.json(store.listProjects())
  })

  router.post('/api/projects', (req, res) => {
    const { name, cwd, ssh_host, ssh_user, ssh_port, ssh_key } = req.body || {}
    if (!name || !cwd) {
      return res.status(400).json({ error: 'name and cwd required' })
    }
    const ssh = ssh_host ? { host: ssh_host, user: ssh_user, port: ssh_port, key: ssh_key } : {}
    const project = store.createProject(name, cwd, null, ssh)
    res.status(201).json(project)
  })

  router.delete('/api/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    sessions.destroySessions(req.params.id)
    store.removeProject(req.params.id)
    res.status(204).send()
  })

  router.post('/api/projects/:id/test-ssh', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    if (!project.ssh_host) {
      return res.status(400).json({ error: 'project is not remote' })
    }
    const args = [
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(project.ssh_port || 22),
    ]
    if (project.ssh_key) args.push('-i', project.ssh_key)
    args.push(`${project.ssh_user || 'root'}@${project.ssh_host}`, 'echo ok')
    execFile('ssh', args, { timeout: 10000 }, (err, stdout) => {
      if (err) return res.json({ ok: false, error: err.message })
      res.json({ ok: stdout.trim() === 'ok' })
    })
  })

  router.get('/api/projects/:id/sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    res.json(sessions.listProjectSessions(req.params.id))
  })

  router.delete('/api/projects/:id/sessions/bash/:tabId', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    sessions.destroySession(`${req.params.id}:bash:${req.params.tabId}`)
    res.status(204).send()
  })

  // ── Session inject (localhost-only) ───────────────────────────────────────
  // POST /api/sessions/:id/inject — inject a user message into an ACTIVE
  // session's input channel, the server-side equivalent of the WS
  // 'claude-input' (claude tabs) / 'input' (bash tabs) message. Lets an
  // external crontab watchdog wake a stuck/idle secretary session: nanocode
  // --watch restarts kill every internal listener, so an HTTP inject is the
  // only reliable external wake path.
  //
  // SECURITY: localhost only — rejects any non-127.0.0.1 caller with 403,
  // regardless of token. The route still sits under the global /api token
  // check, so when auth is enabled the caller must ALSO supply the token.
  //
  // :id  — the URL-encoded sessionKey returned by GET /api/sessions
  //        (shaped `${projectId}:claude:${tabId}` / `...:bash:${tabId}` / ...).
  // body — { text: string, sendNow?: boolean }
  //        sendNow=true forces an atomic interrupt+flush if the session is
  //        mid-turn (mirrors the "立刻发送" button; never kills the process or
  //        sub-agents). Default false queues behind a running turn.
  function isLocalhostReq(req) {
    const ip = req.socket?.remoteAddress || ''
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  }

  // GET /api/sessions — list active (live-attached) sessions for the inject
  // workflow. localhost-only so the session registry isn't exposed remotely.
  router.get('/api/sessions', (req, res) => {
    if (!isLocalhostReq(req)) {
      return res.status(403).json({ error: 'forbidden: localhost only' })
    }
    const out = []
    for (const [key, cs] of sessionController.claudeSessions) {
      const parts = key.split(':')
      out.push({
        sessionKey: key,
        type: 'claude',
        projectId: parts[0] || null,
        tabId: parts[2] || null,
        claudeSessionId: cs.claudeSessionId || null,
        busy: !!cs.busy,
        cwd: cs.cwd || null,
        tabLabel: cs.tabLabel || '',
      })
    }
    for (const [key, cs] of sessionController.codexSessions) {
      const parts = key.split(':')
      out.push({
        sessionKey: key,
        type: 'codex',
        projectId: parts[0] || null,
        tabId: parts[2] || null,
        busy: !!cs.busy,
        cwd: cs.cwd || null,
        tabLabel: cs.tabLabel || '',
      })
    }
    for (const key of sessions.listAllSessionKeys()) {
      const parts = key.split(':')
      out.push({ sessionKey: key, type: 'bash', projectId: parts[0] || null, tabId: parts[2] || null })
    }
    res.json({ sessions: out })
  })

  // POST /api/sessions/:id/inject
  router.post('/api/sessions/:id/inject', (req, res) => {
    if (!isLocalhostReq(req)) {
      return res.status(403).json({ error: 'forbidden: localhost only' })
    }
    // Express already URL-decodes path params once, so this works whether the
    // caller sends raw colons (uuid:claude:uuid) or percent-encoded (%3A).
    const sessionKey = req.params.id
    const { text, sendNow } = req.body || {}
    // Claude session (primary use case: secretary wake). Reuses the exact
    // WS 'claude-input' dispatch path via injectClaudeMessage.
    const result = sessionController.injectClaudeMessage(sessionKey, text, {
      sendNow: sendNow === true,
    })
    if (result.ok) return res.json(result)
    // Read-only server (lost the session singleton lock): the session is alive
    // but hosted by another server. Tell the caller clearly so the watchdog can
    // route the wake to the host instead of mistaking this for a missing session.
    if (result.readOnly) {
      return res.status(423).json({
        ok: false,
        error: result.error,
        readOnly: true,
        lockHolderPort: result.lockHolderPort,
      })
    }
    // Not a claude session → try codex (sessionKey shaped `${projectId}:codex:${tabId}`).
    // Same wake/inject contract as claude: default queues behind a running turn,
    // sendNow=true does an atomic interrupt+flush so the message lands immediately.
    if (result.error === 'session not found') {
      const codexResult = sessionController.injectCodexMessage(sessionKey, text, {
        sendNow: sendNow === true,
      })
      if (codexResult.ok) return res.json(codexResult)
      if (codexResult.error === 'empty text') {
        return res.status(400).json({ ok: false, error: 'empty text' })
      }
      // codexResult.error === 'session not found' → fall through to bash below.
    }
    // Fall through to bash PTY session: write raw bytes (equivalent to WS
    // 'input') if such a session exists.
    if (result.error === 'session not found') {
      const sess = sessions.get(sessionKey)
      if (sess && typeof sess.write === 'function') {
        sess.write(typeof text === 'string' ? text : '')
        return res.json({ ok: true, sessionKey, type: 'bash', dispatched: true })
      }
    }
    if (result.error === 'empty text') {
      return res.status(400).json({ ok: false, error: 'empty text' })
    }
    res.status(404).json({ ok: false, error: result.error || 'session not found' })
  })

  // --- Tab registry (per-project, persisted in store) ---
  //
  // Tabs are server-side metadata so that opening the workspace on a second
  // device reattaches to the same PTYs (matches original-nanocode behavior
  // where the project had a single shared bash session). The PTY itself is
  // still in-memory; on server restart the tab metadata survives but bash
  // respawns fresh on next attach.

  /** projectId → Set<WebSocket> for live tab-list broadcasts. */
  const tabSubscribers = new Map()

  function broadcastTabs(projectId) {
    const subs = tabSubscribers.get(projectId)
    if (!subs || !subs.size) return
    const payload = JSON.stringify({
      type: 'tabs:update',
      projectId,
      tabs: store.listTabs(projectId),
    })
    for (const ws of subs) {
      if (ws.readyState === 1) {
        try { ws.send(payload) } catch {}
      }
    }
  }

  router.get('/api/projects/:id/tabs', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    res.json(store.listTabs(req.params.id))
  })

  /**
   * GET /api/projects/:id/most-recent-claude-tab
   *
   * Returns the claude tab whose session jsonl has the most recent mtime, or
   * null if no claude tabs exist / no jsonl files found. Used by the frontend
   * to auto-select the most recently active claude tab when entering a workspace.
   *
   * Response: { tabId: string | null }
   */
  router.get('/api/projects/:id/most-recent-claude-tab', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    res.json({ tabId: historyService.findMostRecentClaudeTab(project) })
  })

  // ── GET /api/projects/:id/recent-conversations ──────────────────────────────
  // Returns up to `limit` (default 5, max 50) recent Claude conversations for the
  // project's cwd, sorted by most-recent mtime desc (最近的优先, byte size desc
  // as secondary tiebreaker) so the Claude Code tab picker (需求3 Auto Resume)
  // offers the "最近的 5 条较长对话" to 继续 / 开启新对话.
  // 需求5.3: `source` switches the project-directory source — 'project' (current
  // project slug, all teams), 'home' (home slug, all teams), or 'all' (both,
  // default) so cross-team sessions can surface without home drowning.
  router.get('/api/projects/:id/recent-conversations', async (req, res) => {
    try {
      const project = store.getProject(req.params.id)
      if (!project) return res.status(404).json({ error: 'project not found' })
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50)
      const source = ['project', 'home', 'all'].includes(req.query.source) ? req.query.source : 'all'
      const conversations = historyService.recentConversations(project.cwd, limit, source)
      res.json({ conversations, source })
    } catch (err) {
      console.error('[/api/recent-conversations]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── GET /api/projects/:id/opencode-sessions ─────────────────────────────────
  // 需求15 item1: lists recent opencode sessions (scoped to the project cwd by
  // the opencode CLI) for the Fable5/opencode AutoResume picker — the opencode
  // analogue of /recent-conversations. Read-only, no quota cost.
  router.get('/api/projects/:id/opencode-sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50)
    listOpencodeSessions(home, project.cwd, limit, (err, data) => {
      if (err) {
        console.warn('[/api/opencode-sessions]', err.message)
        // Degrade to an empty list (picker shows "no sessions") rather than 500
        // — opencode may be absent or the db unreadable on a given host.
        return res.json({ conversations: [], error: err.message })
      }
      res.json(data)
    })
  })

  router.post('/api/projects/:id/tabs', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 40)
      : undefined
    const type = typeof req.body?.type === 'string' ? req.body.type : undefined
    // Optional: pre-set claudeSessionId so history endpoint immediately finds the right jsonl.
    // Used by the Recent Agents resume flow to avoid a create+patch two-step race.
    const claudeSessionId = typeof req.body?.claudeSessionId === 'string' && req.body.claudeSessionId.trim()
      ? req.body.claudeSessionId.trim()
      : undefined
    // 需求5: a cross-team/cross-cwd resume carries the session's owning team
    // (CLAUDE_CONFIG_DIR) and the session's original cwd so the spawned claude
    // reads the right config and finds the jsonl in the right project slug.
    const claudeConfigDir = typeof req.body?.claudeConfigDir === 'string' && req.body.claudeConfigDir.trim()
      ? req.body.claudeConfigDir.trim()
      : undefined
    const claudeSessionCwd = typeof req.body?.claudeSessionCwd === 'string' && req.body.claudeSessionCwd.trim()
      ? req.body.claudeSessionCwd.trim()
      : undefined
    const tmuxTarget = typeof req.body?.tmuxTarget === 'string' && req.body.tmuxTarget.trim()
      ? req.body.tmuxTarget.trim()
      : undefined
    // 需求15 item1: a Fable5/opencode tab opened via the resume picker carries
    // the chosen opencode session id so the driver passes --session <id>
    // (resumes the conversation) and the history route replays it immediately.
    const opencodeSessionId = typeof req.body?.opencodeSessionId === 'string' && req.body.opencodeSessionId.trim()
      ? req.body.opencodeSessionId.trim()
      : undefined
    // 需求3: `fresh: true` marks a Claude tab opened via "开启新对话" — it must
    // NOT auto-resume the newest jsonl. Stored as tab.skipAutoResume and honored
    // by resolveSessionJsonl + the first-turn --session-id decision.
    const skipAutoResume = type === 'claude' && req.body?.fresh === true
    // 需求8: persona id (chosen in the new-session picker) → stored on the tab,
    // resolved to its instruction text at attach time and injected via
    // --append-system-prompt on every turn so the persona stays active.
    // Strict id format (no path traversal / slashes); bad ids are dropped, not
    // stored — resolvePersonaPrompt would no-op anyway, but we keep the tab clean.
    const _personaRaw = typeof req.body?.persona === 'string' ? req.body.persona.trim() : ''
    const persona = _personaRaw && /^[A-Za-z0-9._-]+$/.test(_personaRaw) ? _personaRaw : undefined
    // 需求16: session-group favorites — a tab can be created already favorited
    // and with its model + block renderMode locked (used by the Playwright flow
    // and by any external seeder). All optional; absent = legacy behaviour.
    const favorite = req.body?.favorite === true ? true : undefined
    const favoriteOrder = typeof req.body?.favoriteOrder === 'number' && Number.isFinite(req.body.favoriteOrder)
      ? req.body.favoriteOrder : undefined
    const renderMode = typeof req.body?.renderMode === 'string' && ['block', 'terminal'].includes(req.body.renderMode)
      ? req.body.renderMode : undefined
    const modelOverride = typeof req.body?.modelOverride === 'string' && req.body.modelOverride.trim()
      ? req.body.modelOverride.trim() : undefined
    const effortOverride = typeof req.body?.effortOverride === 'string' && req.body.effortOverride.trim()
      ? req.body.effortOverride.trim() : undefined
    const tab = store.createTab(req.params.id, { label, type, claudeSessionId, claudeConfigDir, claudeSessionCwd, tmuxTarget, skipAutoResume, persona, opencodeSessionId, favorite, favoriteOrder, renderMode, modelOverride, effortOverride })
    broadcastTabs(req.params.id)
    res.status(201).json(tab)
  })

  router.patch('/api/projects/:id/tabs/:tabId', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 40)
      : null
    if (!label) return res.status(400).json({ error: 'label required' })
    const tab = store.renameTab(req.params.id, req.params.tabId, label)
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    broadcastTabs(req.params.id)
    res.json(tab)
  })

  router.delete('/api/projects/:id/tabs/:tabId', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const removed = store.removeTab(req.params.id, req.params.tabId)
    sessions.destroySession(`${req.params.id}:bash:${req.params.tabId}`)
    if (removed) broadcastTabs(req.params.id)
    res.status(removed ? 204 : 404).send()
  })

  /**
   * PATCH /api/projects/:id/tabs/:tabId/session
   * Update a claude tab's claudeSessionId so history replay and --resume target
   * the specified session. Used by the agent-list resume flow.
   * Body: { claudeSessionId: string }
   */
  router.patch('/api/projects/:id/tabs/:tabId/session', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    if (tab.type !== 'claude') return res.status(400).json({ error: 'not a claude tab' })
    const { claudeSessionId } = req.body || {}
    if (!claudeSessionId || typeof claudeSessionId !== 'string') {
      return res.status(400).json({ error: 'claudeSessionId required' })
    }
    const updated = store.updateTabMetadata
      ? store.updateTabMetadata(req.params.id, req.params.tabId, { claudeSessionId })
      : null
    if (!updated) return res.status(404).json({ error: 'update failed' })
    sessionController.setClaudeSessionId(req.params.id, req.params.tabId, claudeSessionId)
    res.json(updated)
  })

  /**
   * PATCH /api/projects/:id/tabs/:tabId/failover
   * Toggle per-session team-failover opt-in (secretary sessions only; default
   * off; inherited by child tabs). Body: { allowTeamFailover: boolean }.
   * When on, a 429 / org spend limit switches team + copies transcript + resumes.
   */
  router.patch('/api/projects/:id/tabs/:tabId/failover', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    if (tab.type !== 'claude') return res.status(400).json({ error: 'not a claude tab' })
    const allow = req.body?.allowTeamFailover === true
    const updated = store.updateTabMetadata
      ? store.updateTabMetadata(req.params.id, req.params.tabId, { allowTeamFailover: allow })
      : null
    if (sessionController.setAllowTeamFailover) {
      sessionController.setAllowTeamFailover(req.params.id, req.params.tabId, allow)
    }
    broadcastTabs(req.params.id)
    res.json(updated || { id: req.params.tabId, allowTeamFailover: allow })
  })

  /**
   * PATCH /api/projects/:id/tabs/:tabId/model
   * Set the per-tab model (and optionally effort) override. Root fix for the
   * cross-tab /model sync bug: the choice is persisted on the TAB (modelOverride
   * / effortOverride) — not the global claude_model/codex_model setting — so
   * sibling tabs keep their own model. Drivers read tab override || global.
   * Body: { modelOverride?: string, effortOverride?: string }
   * ('' or null clears the override → the tab follows the global default.)
   */
  router.patch('/api/projects/:id/tabs/:tabId/model', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    if (tab.type !== 'claude' && tab.type !== 'codex') {
      return res.status(400).json({ error: 'model override only supported on claude/codex tabs' })
    }
    const body = req.body || {}
    const patch = {}
    if (Object.prototype.hasOwnProperty.call(body, 'modelOverride')) {
      const m = typeof body.modelOverride === 'string' ? body.modelOverride.trim() : ''
      patch.modelOverride = m || null
    }
    // effortOverride applies to both claude AND codex: claude drivers read
    // claudeEffortOverride, the codex SDK driver reads codexEffortOverride
    // (codex model picker step 2). Either way the per-tab value wins over the
    // global claude_effort / codex_effort setting; '' or null clears it.
    if (Object.prototype.hasOwnProperty.call(body, 'effortOverride')) {
      const e = typeof body.effortOverride === 'string' ? body.effortOverride.trim() : ''
      patch.effortOverride = e || null
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'modelOverride or effortOverride required' })
    }
    const updated = store.updateTabMetadata
      ? store.updateTabMetadata(req.params.id, req.params.tabId, patch)
      : null
    if (!updated) return res.status(404).json({ error: 'update failed' })
    if (sessionController.setTabModelOverride) {
      sessionController.setTabModelOverride(req.params.id, req.params.tabId, patch)
    }
    broadcastTabs(req.params.id)
    res.json(updated)
  })

  /**
   * PATCH /api/projects/:id/tabs/:tabId/favorite
   * 需求16: toggle a tab's session-group favorite flag. Favorites are pinned
   * to the top of the tab strip on resume/reopen and carry their own model +
   * block renderMode. Body: { favorite: boolean }. favorite=false (or absent)
   * clears the pin; the tab stays in the list, just no longer pinned. The
   * favoriteOrder is (re)assigned when pinning so newly-favorited tabs land
   * after the existing ones; clearing leaves the stale order in place (it is
   * ignored once favorite is false).
   */
  router.patch('/api/projects/:id/tabs/:tabId/favorite', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    const want = req.body?.favorite === true
    const patch = { favorite: want }
    if (want && typeof tab.favoriteOrder !== 'number') {
      // Assign an order past the last currently-pinned tab so the newly
      // pinned one appends to the favorites section instead of jumping to top.
      const tabs = store.listTabs(req.params.id)
      const maxOrder = tabs.reduce((m, t) => {
        return (t.favorite && typeof t.favoriteOrder === 'number' && t.favoriteOrder > m) ? t.favoriteOrder : m
      }, -1)
      patch.favoriteOrder = maxOrder + 1
    }
    const updated = store.updateTabMetadata
      ? store.updateTabMetadata(req.params.id, req.params.tabId, patch)
      : null
    if (!updated) return res.status(404).json({ error: 'update failed' })
    broadcastTabs(req.params.id)
    res.json(updated)
  })

  /**
   * PATCH /api/projects/:id/tabs/:tabId/switch-team
   * Manually move the current conversation to another team NOW (copy transcript
   * + switch CLAUDE_CONFIG_DIR + upgrade model to the target team's default).
   * Body: { targetConfigDir: string }. Next turn resumes on the target org.
   */
  router.patch('/api/projects/:id/tabs/:tabId/switch-team', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const targetConfigDir = typeof req.body?.targetConfigDir === 'string' ? req.body.targetConfigDir.trim() : ''
    if (!targetConfigDir) return res.status(400).json({ error: 'targetConfigDir required' })
    if (!sessionController.switchTeam) return res.status(500).json({ error: 'switchTeam unavailable' })
    const result = sessionController.switchTeam(req.params.id, req.params.tabId, targetConfigDir)
    if (!result.ok) return res.status(400).json(result)
    broadcastTabs(req.params.id)
    res.json(result)
  })

  /**
   * /ws/tabs handler — clients send `{type:'subscribe', projectId}` and
   * receive `{type:'tabs:update', projectId, tabs:[]}` on every mutation
   * (and once immediately as a snapshot).
   */
  function handleTabsWs(ws) {
    let subscribed = null
    const unsubscribe = () => {
      if (!subscribed) return
      const subs = tabSubscribers.get(subscribed)
      if (subs) {
        subs.delete(ws)
        if (subs.size === 0) tabSubscribers.delete(subscribed)
      }
      subscribed = null
    }
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'subscribe' && typeof msg.projectId === 'string') {
        if (subscribed !== msg.projectId) {
          unsubscribe()
          subscribed = msg.projectId
          if (!tabSubscribers.has(subscribed)) tabSubscribers.set(subscribed, new Set())
          tabSubscribers.get(subscribed).add(ws)
        }
        ws.send(JSON.stringify({
          type: 'tabs:update',
          projectId: subscribed,
          tabs: store.listTabs(subscribed),
        }))
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', id: msg.id })) } catch {}
      }
    })
    ws.on('close', unsubscribe)
    ws.on('error', unsubscribe)
  }

  // Folder browser for the Add-project dialog.
  //
  // Accepts any absolute path the server-side user can read — we
  // deliberately do NOT sandbox to $HOME because projects often live
  // under /opt, /srv, /var/www, etc. The filesystem's own permission
  // checks (readdirSync → EACCES) remain the authorization boundary.
  // Relative paths or empty path default to $HOME for convenience.
  //
  // Cross-platform (MES-13804): on Windows, an empty path (or `?drives=1`)
  // returns the list of available drive letters; every response carries a
  // `parent` field (null at a drive root / `/`) so the frontend can disable
  // the "up one level" button. Pure path logic lives in ./fsbrowse.js so the
  // win32 branches are unit-testable on a Linux host.
  router.get('/api/fs', (req, res) => {
    const platform = currentPlatform()
    const pathMod = platform === 'win32' ? path.win32 : path
    const raw = req.query.path
    const input = raw && String(raw).trim() ? String(raw).trim() : null
    const wantsDrives = req.query.drives === '1' || (!input && platform === 'win32')

    try {
      if (wantsDrives) {
        return res.json({ drives: listDrives(platform), platform })
      }
      const base = input
        ? (pathMod.isAbsolute(input) ? pathMod.resolve(input) : pathMod.resolve(home, input))
        : home
      res.json({ ...listDirectory(base, platform), platform })
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      if (err.code === 'ENOTDIR')
        return res.status(400).json({ error: 'not a directory' })
      if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' })
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/projects/:id/tabs/:tabId/history', (req, res) => {
    // 需求11-C: opencode/fable5 block tabs — history via `opencode export`.
    // Read-only, no quota cost. Normalises the export JSON to claude-block
    // events via opencode-adapter.js exportToEvents() so the frontend's
    // ClaudeBlockRenderer can replay it with the same block UI.
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (tab && (tab.type === 'fable5' || tab.type === 'opencode') && tab.opencodeSessionId) {
      handleOpencodeHistory(req, res, project, tab)
      return
    }
    if (tab && (tab.type === 'fable5' || tab.type === 'opencode') && !tab.opencodeSessionId) {
      // No session yet (brand-new tab) — return empty history; the first
      // turn will create a session and persist opencodeSessionId.
      return res.json({ events: [], sessionId: null })
    }
    historyService.handleHistory(req, res)
  })

  // opencode export → claude-block events (history replay for Fable5/opencode tabs)
  function handleOpencodeHistory(req, res, project, tab) {
    const sessionId = tab.opencodeSessionId
    const env = { ...process.env }
    delete env.FORCE_COLOR
    env.NO_COLOR = '1'
    env.TERM = 'dumb'
    // Carry the AIGW key + config so `opencode export` can resolve the session
    // even when the global opencode.json needs the kimi provider registered.
    try {
      const keyFile = join(home, '.config', 'meshy-aigw.key')
      if (existsSync(keyFile)) env.MESHY_AIGW_KEY = readFileSync(keyFile, 'utf8').trim()
    } catch { /* best-effort */ }
    execFile('opencode', ['export', sessionId], { cwd: project.cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.warn(`[history:opencode] export failed for session ${sessionId}: ${err.message}`)
        return res.json({ events: [], sessionId, error: err.message })
      }
      let payload
      try { payload = JSON.parse(stdout) } catch (parseErr) {
        console.warn(`[history:opencode] export JSON parse failed: ${parseErr.message}`)
        return res.json({ events: [], sessionId, error: 'parse failed' })
      }
      const events = exportToEvents(payload)
      console.log(`[history:opencode] tab=${req.params.tabId} session=${sessionId} events=${events.length}`)
      res.json({ events, sessionId })
    })
  }

  // ── GET /api/claude/slash-commands ──────────────────────────────────────────
  //
  // Returns the live list of slash commands supported by the installed claude CLI.
  // Spawns `claude` once with --output-format=stream-json, reads the `init` event
  // which contains a `slash_commands` string[] array, and caches the result for
  // TTL_SLASH_MS (1 hour).  Supports ?refresh=1 to force a cache bust.
  //
  // On first call (cache cold) we do NOT block the response — we return the
  // built-in fallback list immediately and kick off the background fetch.
  // Subsequent calls (cache warm) return immediately.
  //
  // Response: { commands: [{ cmd: string, hint: string }] }
  //
  let _slashCommandsCache = null   // { items: [{cmd,hint}][], ts: number }
  const TTL_SLASH_MS = 60 * 60 * 1000  // 1 hour
  // Fallback list used before the first successful fetch (kept intentionally small
  // — the dynamic fetch will replace it).
  const SLASH_FALLBACK = [
    { cmd: '/clear',    hint: 'Clear conversation history' },
    { cmd: '/compact',  hint: 'Compact context to reduce token usage' },
    { cmd: '/help',     hint: 'Show help and available commands' },
    { cmd: '/exit',     hint: 'Exit Claude Code' },
    { cmd: '/status',   hint: 'Show session status and info' },
    { cmd: '/resume',   hint: 'Resume previous session' },
    { cmd: '/model',    hint: 'Switch Claude model' },
  ]

  let _slashFetchInFlight = false

  // Probe helpers (slash-commands / init-snapshot) spawn `claude --print`, which
  // writes a throwaway transcript to <configDir>/projects/<slug>/<id>.jsonl.
  // Without cleanup these pile up and clutter the resume list. We spawn each probe
  // with a KNOWN --session-id and delete that transcript once the probe exits.
  const _probeProjectsDir = join(
    process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    'projects',
    home.replace(/[/.]/g, '-'),
  )
  function _cleanupProbeSession(sid) {
    if (!sid) return
    try {
      const p = join(_probeProjectsDir, `${sid}.jsonl`)
      if (existsSync(p)) unlinkSync(p)
    } catch {}
  }

  /** Spawn claude once, pull slash_commands from the init event.
   *  Resolves with an array of { cmd, hint } objects, or null on failure. */
  function _fetchSlashCommandsFromClaude() {
    return new Promise((resolve) => {
      if (_slashFetchInFlight) { resolve(null); return }
      _slashFetchInFlight = true

      const initMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'OK' }] },
      })

      const probeSid = randomUUID()
      let proc
      try {
        proc = spawn('claude', [
          '--print',
          '--session-id', probeSid,
          '--output-format=stream-json',
          '--input-format=stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
          cwd: home,
        })
        proc.on('close', () => _cleanupProbeSession(probeSid))
      } catch (err) {
        console.warn('[slash-commands] failed to spawn claude:', err.message)
        _slashFetchInFlight = false
        resolve(null)
        return
      }

      let buf = ''
      let done = false
      const TIMEOUT = 15_000

      const timer = setTimeout(() => {
        if (!done) {
          done = true
          _slashFetchInFlight = false
          try { proc.kill('SIGTERM') } catch {}
          console.warn('[slash-commands] timed out waiting for claude init event')
          resolve(null)
        }
      }, TIMEOUT)

      proc.stdout.on('data', (chunk) => {
        if (done) return
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()   // keep partial last line
        for (const line of lines) {
          if (!line.trim()) continue
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          if (obj.type === 'system' && obj.subtype === 'init' && Array.isArray(obj.slash_commands)) {
            done = true
            clearTimeout(timer)
            _slashFetchInFlight = false
            try { proc.kill('SIGTERM') } catch {}
            const items = obj.slash_commands.map((name) => ({ cmd: `/${name}`, hint: '' }))
            console.log(`[slash-commands] fetched ${items.length} commands from claude init event`)
            resolve(items)
          }
        }
      })

      proc.on('error', (err) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _slashFetchInFlight = false
          console.warn('[slash-commands] claude spawn error:', err.message)
          resolve(null)
        }
      })

      proc.on('close', () => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _slashFetchInFlight = false
          resolve(null)
        }
      })

      // Write user turn and close stdin so claude exits after the first response
      try {
        proc.stdin.write(initMsg + '\n')
        proc.stdin.end()
      } catch {}
    })
  }

  router.get('/api/claude/slash-commands', async (req, res) => {
    const forceRefresh = req.query.refresh === '1'
    const now = Date.now()

    // Return cached result if fresh and no force-refresh
    if (!forceRefresh && _slashCommandsCache && (now - _slashCommandsCache.ts) < TTL_SLASH_MS) {
      return res.json({ commands: _slashCommandsCache.items, cached: true })
    }

    // If cache is stale but still exists, return stale immediately and refresh in background
    if (!forceRefresh && _slashCommandsCache) {
      res.json({ commands: _slashCommandsCache.items, cached: true, stale: true })
      _fetchSlashCommandsFromClaude().then((items) => {
        if (items) _slashCommandsCache = { items, ts: Date.now() }
      })
      return
    }

    // Cache cold (first call) or force refresh: await the fetch but with a 5s cap
    // so the UI isn't blocked. Return fallback if it takes too long.
    const raceResult = await Promise.race([
      _fetchSlashCommandsFromClaude(),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ])

    if (raceResult) {
      _slashCommandsCache = { items: raceResult, ts: Date.now() }
      return res.json({ commands: raceResult, cached: false })
    }

    // Fetch timed out or failed — return fallback
    return res.json({ commands: _slashCommandsCache?.items ?? SLASH_FALLBACK, cached: false, fallback: true })
  })

  // ── GET /api/claude/init-snapshot ────────────────────────────────────────────
  //
  // Spawn claude once and capture the full init event to expose model, tools,
  // plugins, skills, agents, and slash_commands to the settings panel.
  // Cached for 1 hour (same TTL as slash-commands). Returns:
  //   { model, tools[], plugins[], skills[], agents[], slash_commands[], cached }
  //
  let _initSnapshotCache = null  // { data: {...}, ts: number }
  let _initSnapshotInFlight = false
  const TTL_INIT_MS = 60 * 60 * 1000  // 1 hour

  function _fetchInitSnapshot() {
    return new Promise((resolve) => {
      if (_initSnapshotInFlight) { resolve(null); return }
      _initSnapshotInFlight = true

      const initMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'OK' }] },
      })

      const probeSid = randomUUID()
      let proc
      try {
        proc = spawn('claude', [
          '--print',
          '--session-id', probeSid,
          '--output-format=stream-json',
          '--input-format=stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
          cwd: home,
        })
        proc.on('close', () => _cleanupProbeSession(probeSid))
      } catch (err) {
        console.warn('[init-snapshot] failed to spawn claude:', err.message)
        _initSnapshotInFlight = false
        resolve(null)
        return
      }

      let buf = ''
      let done = false
      const TIMEOUT = 15_000

      const timer = setTimeout(() => {
        if (!done) {
          done = true
          _initSnapshotInFlight = false
          try { proc.kill('SIGTERM') } catch {}
          console.warn('[init-snapshot] timed out waiting for claude init event')
          resolve(null)
        }
      }, TIMEOUT)

      proc.stdout.on('data', (chunk) => {
        if (done) return
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          if (obj.type === 'system' && obj.subtype === 'init') {
            done = true
            clearTimeout(timer)
            _initSnapshotInFlight = false
            try { proc.kill('SIGTERM') } catch {}
            const data = {
              model: obj.model || null,
              tools: Array.isArray(obj.tools) ? obj.tools : [],
              plugins: Array.isArray(obj.plugins) ? obj.plugins : [],
              skills: Array.isArray(obj.skills) ? obj.skills : [],
              agents: Array.isArray(obj.agents) ? obj.agents : [],
              slash_commands: Array.isArray(obj.slash_commands) ? obj.slash_commands : [],
              fast_mode_state: obj.fast_mode_state ?? null,
            }
            console.log(`[init-snapshot] fetched model=${data.model} tools=${data.tools.length}`)
            resolve(data)
          }
        }
      })

      proc.on('error', (err) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _initSnapshotInFlight = false
          console.warn('[init-snapshot] claude spawn error:', err.message)
          resolve(null)
        }
      })

      proc.on('close', () => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _initSnapshotInFlight = false
          resolve(null)
        }
      })

      try {
        proc.stdin.write(initMsg + '\n')
        proc.stdin.end()
      } catch {}
    })
  }

  router.get('/api/claude/init-snapshot', async (req, res) => {
    const forceRefresh = req.query.refresh === '1'
    const now = Date.now()

    if (!forceRefresh && _initSnapshotCache && (now - _initSnapshotCache.ts) < TTL_INIT_MS) {
      return res.json({ ...(_initSnapshotCache.data), cached: true })
    }

    if (!forceRefresh && _initSnapshotCache) {
      res.json({ ...(_initSnapshotCache.data), cached: true, stale: true })
      _fetchInitSnapshot().then((data) => {
        if (data) _initSnapshotCache = { data, ts: Date.now() }
      })
      return
    }

    const result = await Promise.race([
      _fetchInitSnapshot(),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ])

    if (result) {
      _initSnapshotCache = { data: result, ts: Date.now() }
      return res.json({ ...result, cached: false })
    }

    return res.json({ model: null, tools: [], plugins: [], skills: [], agents: [], slash_commands: [], cached: false, fallback: true })
  })

  // ── GET /api/codex/config ─────────────────────────────────────────────────
  //
  // Read ~/.codex/config.toml and return the configured model value.
  // Response: { model: string|null }
  // The model field is null when the file doesn't exist or contains no model key.
  //
  router.get('/api/codex/config', (req, res) => {
    const configPath = join(home, '.codex', 'config.toml')
    let model = null
    try {
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, 'utf8')
        // Parse the top-level model = "..." line (before any [section] headers)
        const match = content.match(/^model\s*=\s*"([^"]+)"/m)
        if (match) model = match[1]
      }
    } catch (err) {
      console.warn('[codex/config] failed to read config.toml:', err.message)
    }
    res.json({ model })
  })

  // ── 需求1 plugin routes ────────────────────────────────────────────────────
  //
  // GET  /api/teams            — list Claude "teams" (CLAUDE_CONFIG_DIR dirs)
  // GET  /api/usage/claude     — aggregate message.usage tokens from jsonl
  // GET  /api/aigw/models      — proxy AIGW /v1/models, filter to litellm/*
  // POST /api/aigw/probe-cost  — one AIGW chat call, read x-litellm-response-cost
  //
  // All are wrapped in try/catch (Express 4 does not propagate async rejections)
  // and never throw on missing data — the UI labels unavailable sources honestly.

  router.get('/api/teams', (_req, res) => {
    try {
      res.json(listTeams(home, store))
    } catch (err) {
      console.error('[/api/teams]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/usage/claude', (req, res) => {
    try {
      const configDir = effectiveClaudeConfigDir(store, home)
      const days = parseInt(req.query.days, 10)
      const opts = {}
      if (Number.isFinite(days) && days > 0) opts.days = days
      const result = scanClaudeUsage(configDir, opts)
      res.json(result)
    } catch (err) {
      console.error('[/api/usage/claude]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/usage/opencode — aggregate opencode SQLite session-table tokens/cost.
  // 需求15 item6: gives the Fable5/opencode side the same usage source the claude
  // jsonl aggregation gives the Claude side. Read-only, no subprocess. Honest:
  // AIGW-routed sessions report cost=0 (provider doesn't report per-session cost
  // to opencode); tokens are real. Degrades to { error } when the DB or
  // node:sqlite is unavailable so the UI labels the source honestly.
  router.get('/api/usage/opencode', (_req, res) => {
    try {
      const result = scanAllOpencodeUsage(home)
      res.json(result)
    } catch (err) {
      console.error('[/api/usage/opencode]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/usage/summary — MES-13788 three-source usage+limit summary
  // (CodexBar-style windows + reset + burn + projection). The AI-readable
  // entry point: a secretary/agent fetches this to read Team1/Team2/AIGW usage
  // + limits and decide degradation routing. Returns { generatedAt, schemaVersion,
  // sources:[...], entries:[flat unified-schema windows] }. Each source degrades
  // independently (OAuth → jsonl estimate; AIGW → unavailable) and never throws.
  router.get('/api/usage/summary', async (_req, res) => {
    try {
      const result = await buildUsageSummary({ home, store })
      res.json(result)
    } catch (err) {
      console.error('[/api/usage/summary]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/usage/aigw-budget — MES-13788 延续: AIGW /user/info 月度额度。
  // Returns { available, max_budget, spend, remaining, pct_remaining, days_left,
  // reset_at, tier, advice, user_email } from the gateway (real, not fabricated).
  // The AI-readable /api/usage/summary also carries this as the `aigw-budget`
  // source; this dedicated endpoint lets the UI budget card refresh on demand.
  router.get('/api/usage/aigw-budget', async (_req, res) => {
    try {
      const result = await fetchAigwBudget({})
      res.json(result)
    } catch (err) {
      console.error('[/api/usage/aigw-budget]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/aigw/models', async (req, res) => {
    try {
      const result = await listAigwModels({})
      res.json(result)
    } catch (err) {
      console.error('[/api/aigw/models]', err)
      res.json({ models: [], raw: 0, base: null, keyPresent: false, error: err.message })
    }
  })

  router.post('/api/aigw/probe-cost', async (req, res) => {
    try {
      const model = typeof req.body?.model === 'string' && req.body.model.trim()
        ? req.body.model.trim()
        : 'litellm/SGLang-GLM-latest'
      const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
        ? req.body.prompt.trim().slice(0, 200)
        : 'Reply with the single word: ok'
      const result = await probeAigwCost({ model, prompt })
      // Accumulate probed cost in a store setting so the UI can show a running
      // total of nanocode-initiated AIGW probes (honest: only probes, not
      // opencode session traffic which is not proxied). Count every probe even
      // when the cost header was absent, so the user sees the probe ran.
      try {
        if (result && result.cost != null) {
          const prev = Number(store.getSetting('aigw_probe_cost_total')) || 0
          store.setSetting('aigw_probe_cost_total', Number((prev + result.cost).toFixed(6)))
        }
        const count = Number(store.getSetting('aigw_probe_count')) || 0
        store.setSetting('aigw_probe_count', count + 1)
      } catch {}
      res.json({
        ...result,
        accumulatedCost: Number(store.getSetting('aigw_probe_cost_total')) || 0,
        probeCount: Number(store.getSetting('aigw_probe_count')) || 0,
      })
    } catch (err) {
      console.error('[/api/aigw/probe-cost]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── 需求7 memory viewer plugin routes ─────────────────────────────────────
  //
  // GET  /api/memory/tree                — teams × projects-with-memory (browse)
  // GET  /api/memory/files?team=&project= — list .md files in a memory dir
  // GET  /api/memory/read?team=&project=&file= — read one md file
  // GET  /api/memory/search?team=&project=&q= — keyword search across .md files
  // POST /api/memory/save body{team,project,file,content} — edit with backup
  //
  // `team` must be a known config dir (validated against listTeams) so no
  // arbitrary path can be read. `project`/`file` are validated by strict
  // character classes inside usage.js (no `..` / `/` traversal).

  /** Resolve a team path from the query: default to active team; reject unknown. */
  function resolveMemoryTeam(teamPath) {
    const { teams } = listTeams(home, store)
    if (!teamPath) return effectiveClaudeConfigDir(store, home)
    return teams.find((t) => t.path === teamPath && t.exists) ? teamPath : null
  }

  router.get('/api/memory/tree', (req, res) => {
    try {
      const activePath = effectiveClaudeConfigDir(store, home)
      // Mark the current project's slug so the plugin can default to it.
      // Claude encodes cwd as slug (cwd.replace(/\//g, '-')) — exact, unlike the
      // lossy reverse decode used for display only.
      let currentSlug = ''
      const pid = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : ''
      if (pid) {
        const proj = store.getProject(pid)
        if (proj && proj.cwd) currentSlug = String(proj.cwd).replace(/\//g, '-')
      }
      const teams = listMemoryTree(home, store)
      for (const team of teams) {
        for (const p of team.projects) p.current = p.slug === currentSlug
      }
      res.json({ teams, activePath, currentSlug })
    } catch (err) {
      console.error('[/api/memory/tree]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/memory/files', (req, res) => {
    try {
      const team = resolveMemoryTeam(req.query.team)
      if (!team) return res.status(400).json({ error: 'invalid team' })
      res.json(listMemoryFiles(team, req.query.project))
    } catch (err) {
      console.error('[/api/memory/files]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/memory/read', (req, res) => {
    try {
      const team = resolveMemoryTeam(req.query.team)
      if (!team) return res.status(400).json({ error: 'invalid team' })
      res.json(readMemoryFile(team, req.query.project, req.query.file))
    } catch (err) {
      console.error('[/api/memory/read]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/memory/search', (req, res) => {
    try {
      const team = resolveMemoryTeam(req.query.team)
      if (!team) return res.status(400).json({ error: 'invalid team' })
      res.json(searchMemory(team, req.query.project, req.query.q))
    } catch (err) {
      console.error('[/api/memory/search]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/api/memory/save', (req, res) => {
    try {
      const team = resolveMemoryTeam(req.body?.team)
      if (!team) return res.status(400).json({ error: 'invalid team' })
      const project = typeof req.body?.project === 'string' ? req.body.project : ''
      const file = typeof req.body?.file === 'string' ? req.body.file : ''
      const content = typeof req.body?.content === 'string' ? req.body.content : ''
      res.json(saveMemoryFile(team, project, file, content))
    } catch (err) {
      console.error('[/api/memory/save]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── 需求8 persona library + skills browser routes ──────────────────────────
  //
  // GET  /api/personas        — list bundled + user personas (merged, user wins)
  // GET  /api/personas/:id    — read one persona (name + instruction)
  // GET  /api/skills          — read-only list of Claude-native skills across teams
  //
  // Personas are injected into a new Claude session via --append-system-prompt
  // (CLI) / appendSystemPrompt (SDK) / --append-system-prompt bridge arg (tmux).
  // Skills are browse-only — loading a native skill is Claude's own mechanism.

  router.get('/api/personas', (req, res) => {
    try {
      res.json(listPersonas(home))
    } catch (err) {
      console.error('[/api/personas]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/personas/:id', (req, res) => {
    try {
      const p = readPersona(home, req.params.id)
      if (!p) return res.status(404).json({ error: 'persona not found' })
      res.json(p)
    } catch (err) {
      console.error('[/api/personas/:id]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/skills', (req, res) => {
    try {
      res.json(listSkills(home, store))
    } catch (err) {
      console.error('[/api/skills]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── 需求14 compare plugin routes (read-only git) ───────────────────────────
  //
  // GET  /api/compare/branches?projectId=&limit=  — newest-first branch list
  // GET  /api/compare/diff?projectId=&base=&head= — numstat file list + summary
  // GET  /api/compare/file-diff?projectId=&base=&head=&file= — unified diff
  //
  // All git operations are read-only (no checkout/mutate). base/head are
  // validated against the real branch list (membership); file is validated by
  // a strict path regex (no `..`, no leading `/`). cwd comes from the project
  // record so the user can't diff an arbitrary path.

  function compareCwd(projectId) {
    const proj = projectId ? store.getProject(projectId) : null
    return proj && proj.cwd ? proj.cwd : ''
  }

  router.get('/api/compare/branches', async (req, res) => {
    try {
      const cwd = compareCwd(req.query.projectId)
      if (!cwd) return res.status(400).json({ error: 'project has no cwd' })
      const limit = parseInt(req.query.limit, 10) || 10
      res.json(await listBranches(cwd, limit))
    } catch (err) {
      console.error('[/api/compare/branches]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/compare/diff', async (req, res) => {
    try {
      const cwd = compareCwd(req.query.projectId)
      if (!cwd) return res.status(400).json({ error: 'project has no cwd' })
      const base = typeof req.query.base === 'string' ? req.query.base : ''
      const head = typeof req.query.head === 'string' ? req.query.head : ''
      res.json(await diffOverview(cwd, base, head))
    } catch (err) {
      console.error('[/api/compare/diff]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/compare/file-diff', async (req, res) => {
    try {
      const cwd = compareCwd(req.query.projectId)
      if (!cwd) return res.status(400).json({ error: 'project has no cwd' })
      const base = typeof req.query.base === 'string' ? req.query.base : ''
      const head = typeof req.query.head === 'string' ? req.query.head : ''
      const file = typeof req.query.file === 'string' ? req.query.file : ''
      res.json(await fileDiff(cwd, base, head, file))
    } catch (err) {
      console.error('[/api/compare/file-diff]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── MES-14031 sessions browser plugin routes (抄 codex resume/fork) ──────────
  //
  // GET /api/sessions/list?source=codex|claude&limit=  — newest-first session list
  // GET /api/sessions/preview?source=&id=&file=        — last N turns excerpt
  //
  // Read-only discovery of past Codex (~/.codex/sessions) + Claude Code
  // (~/.claude/projects) sessions so the user can browse, preview, and fork/
  // resume a previous agent session into a new tab — porting `codex resume`
  // (picker) and `codex fork` to the nanocode plugin surface.

  router.get('/api/sessions/list', (req, res) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source : ''
      const limit = parseInt(req.query.limit, 10) || 50
      res.json(listSessions({ source, limit }))
    } catch (err) {
      console.error('[/api/sessions/list]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/api/sessions/preview', (req, res) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source : ''
      const id = typeof req.query.id === 'string' ? req.query.id : ''
      const file = typeof req.query.file === 'string' ? req.query.file : ''
      res.json(previewSession({ source, id, file }))
    } catch (err) {
      console.error('[/api/sessions/preview]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── MES-14031 S2 rewind plugin routes (抄 Claude Code checkpointing/rewind) ─
  //
  // GET  /api/rewind/checkpoints?projectId=&tabId=  — list user-turn checkpoints
  // POST /api/rewind/apply   body: { projectId, tabId, toIndex, dryRun? }
  //   — rewind the conversation jsonl to keep turns 0..toIndex (backup first).
  //   dryRun=true returns the plan without writing (safe smoke-test path).
  //
  // Resolves the tab's jsonl via the same resolveSessionJsonl the history replay
  // uses, so cross-team / cross-cwd tabs locate the right transcript. Read-only
  // listing never mutates; apply backs up before truncating + writes atomically.
  // "Restore code" (file-snapshot rewind) is intentionally NOT faked — see REPORT.
  router.get('/api/rewind/checkpoints', (req, res) => {
    try {
      const project = store.getProject(String(req.query.projectId || ''))
      if (!project) return res.status(404).json({ error: 'project not found' })
      const tab = store.getTab ? store.getTab(project.id, String(req.query.tabId || '')) : null
      if (!tab) return res.status(404).json({ error: 'tab not found' })
      const { resolvedPath } = resolveSessionJsonl({ store, home, project, tab })
      if (!resolvedPath) return res.json({ checkpoints: [], totalLines: 0, totalTurns: 0, sessionId: tab.claudeSessionId || '', error: 'no session file for this tab' })
      res.json(buildCheckpoints(resolvedPath))
    } catch (err) {
      console.error('[/api/rewind/checkpoints]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/api/rewind/apply', (req, res) => {
    try {
      const projectId = String(req.body?.projectId || '')
      const tabId = String(req.body?.tabId || '')
      const toIndex = Number(req.body?.toIndex)
      const dryRun = !!req.body?.dryRun
      const project = store.getProject(projectId)
      if (!project) return res.status(404).json({ error: 'project not found' })
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      if (!tab) return res.status(404).json({ error: 'tab not found' })
      const { resolvedPath } = resolveSessionJsonl({ store, home, project, tab })
      if (!resolvedPath) return res.status(404).json({ error: 'no session file for this tab' })
      res.json(rewindConversation({ jsonlPath: resolvedPath, toIndex, dryRun }))
    } catch (err) {
      console.error('[/api/rewind/apply]', err)
      res.status(500).json({ error: err.message })
    }
  })


  // GET    /api/remote/machines          — list address book (+ personal dev machines)
  // POST   /api/remote/machines          — add a machine { alias, peerId, password?, relay?, note? }
  // POST   /api/remote/machines/:id      — update a machine (same body)
  // DELETE /api/remote/machines/:id      — remove a machine
  //
  // The server only persists the book (core settings store); it bundles no
  // RustDesk code. The browser turns a Connect click into a `rustdesk://` URI
  // that the user's local OS hands to the native RustDesk client. See REPORT
  // for the AGPL + web-client + relay-server research conclusions.
  //
  // MES-13824: read-only personal dev machines from the personal config are
  // merged ahead of the store list (mergePersonalMachines). They have stable
  // ids `personal:<alias>` and are tagged personal:true/readOnly:true; update
  // and delete on them are rejected.

  router.get('/api/remote/machines', (req, res) => {
    try {
      const personal = loadPersonalConfig({ home }).remote.machines || []
      res.json({ machines: mergePersonalMachines(listMachines(store), personal) })
    } catch (err) {
      console.error('[/api/remote/machines]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/api/remote/machines', (req, res) => {
    try {
      const result = addMachine(store, req.body)
      if (result.error) return res.status(400).json({ error: result.error })
      res.json({ machine: result.machine })
    } catch (err) {
      console.error('[POST /api/remote/machines]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/api/remote/machines/:id', (req, res) => {
    try {
      if (String(req.params.id).startsWith('personal:')) {
        return res.status(403).json({ error: 'personal machines are read-only' })
      }
      const result = updateMachine(store, req.params.id, req.body)
      if (result.error) {
        const code = /not found/.test(result.error) ? 404 : 400
        return res.status(code).json({ error: result.error })
      }
      res.json({ machine: result.machine })
    } catch (err) {
      console.error('[POST /api/remote/machines/:id]', err)
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/api/remote/machines/:id', (req, res) => {
    try {
      if (String(req.params.id).startsWith('personal:')) {
        return res.status(403).json({ error: 'personal machines are read-only' })
      }
      // Tear down any live SSH PTY for this machine before the record vanishes,
      // so a dangling terminal Tab reconnects cleanly (gets "machine not found")
      // instead of reattaching to a stale shell pointed at a deleted host.
      sessions.destroySession(`remote:ssh:${req.params.id}`)
      const result = deleteMachine(store, req.params.id)
      if (result.error) {
        const code = /not found/.test(result.error) ? 404 : 400
        return res.status(code).json({ error: result.error })
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[DELETE /api/remote/machines/:id]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── POST /api/remote/machines/:id/connect ─────────────────────────────────
  //
  // Pre-flight check before the browser opens a terminal Tab for an ssh
  // machine: validates the record is an ssh machine, resolves the ssh command
  // (key existence / sshpass presence for password auth), and returns a safe
  // summary (no secrets). The browser uses the failure to show an inline error
  // instead of opening a dead terminal; a WS attach would also reject, but
  // surfacing it via REST gives a cleaner UX (no flash of empty xterm).
  router.post('/api/remote/machines/:id/connect', (req, res) => {
    try {
      const personal = loadPersonalConfig({ home }).remote.machines || []
      const machine = getMachine(store, req.params.id, personal)
      if (!machine) return res.status(404).json({ error: 'machine not found' })
      if (machine.type !== 'ssh') return res.status(400).json({ error: 'not an ssh machine' })
      const built = buildSshCommand(machine, { sshpassPath: machine.sshPassword ? resolveSshpass() : null })
      if (!built.ok) return res.status(400).json({ error: built.error })
      res.json({ ok: true, summary: built.logSummary })
    } catch (err) {
      console.error('[POST /api/remote/machines/:id/connect]', err)
      res.status(500).json({ error: err.message })
    }
  })

  // ── GET /api/recent-agents ────────────────────────────────────────────────
  //
  // Scan ~/.claude/projects/*/*.jsonl by mtime descending.
  // Rule: include all files with mtime within the last 24 h; if the result is
  // fewer than 5 entries, pad up to the 5 most-recent files regardless of age.
  // Returns up to max 50 entries (no pagination needed at current scale).
  //
  // Each entry:
  //   { projectDir, projectName, cwd, sessionId, mtime (ISO), relTime, summary, active }
  //
  // cwd is read directly from the jsonl file (any row that has a 'cwd' field).
  // projectName is the basename of the real cwd (no ambiguous '-' replacement).
  // Fallback: if no cwd field found in jsonl, fall back to dir-name heuristic and log.
  //
  // Perf: cache results for 10 seconds to avoid re-reading all jsonl files on
  // every drawer open (scanning 38+ files totalling 100+ MB takes ~300ms).
  router.get('/api/recent-agents', (req, res) => {
    res.json(recentAgents.getRecentAgentsCached())
  })
  // ── Pending queue persistence ─────────────────────────────────────────────
  //
  // GET  /api/projects/:id/tabs/:tabId/queue  → { queue: string[] }
  // PUT  /api/projects/:id/tabs/:tabId/queue  body: { queue: string[] } → { queue: string[] }
  //
  // The client-side _pendingQueue is persisted here so it survives page
  // refreshes and device switches. Queue is attached to the tab record and
  // saved to data/nanocode.json on every write.

  router.get('/api/projects/:id/tabs/:tabId/queue', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    res.json({ queue: Array.isArray(tab.pendingQueue) ? tab.pendingQueue : [] })
  })

  router.put('/api/projects/:id/tabs/:tabId/queue', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    const rawQueue = req.body?.queue
    if (!Array.isArray(rawQueue)) {
      return res.status(400).json({ error: 'queue must be an array' })
    }
    // Sanitise: keep only non-empty strings, cap at 100 items
    const queue = rawQueue
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 100)
    const updated = store.updateTabMetadata
      ? store.updateTabMetadata(req.params.id, req.params.tabId, { pendingQueue: queue })
      : null
    if (!updated) return res.status(404).json({ error: 'update failed' })
    res.json({ queue: Array.isArray(updated.pendingQueue) ? updated.pendingQueue : [] })
  })

  router.post('/api/projects/:id/tabs/:tabId/interrupt', (req, res) => {
    sessionController.handleInterrupt(req, res)
  })

  router.post('/api/projects/:id/tabs/:tabId/reset', (req, res) => {
    sessionController.handleReset(req, res)
  })

  // ── Repo-scoped compare — works from a top-level (~zhining) launch ─────────
  // Independent of the project system: scans ~/code for git repos/worktrees
  // and diffs two refs in a selected repo. Server is read-only to repos
  // except `git fetch --all --prune` (no checkout/pull/working-tree changes).
  router.use(createReposRoutes({ home }))

  // ── GET /api/plugin/config?plugin=<name> (MES-13824) ────────────────────────
  //
  // Permission-gated personal-config injection for plugins. Looks up the named
  // built-in plugin manifest, projects ONLY the personal-config fields its
  // declared 'personal.*' permissions allow, and returns them MASKED — secrets
  // are replaced by hasKey + a masked form (e.g. lin_…7f3a), never plaintext.
  // This is the frontend-safe path; real secret values are never serialized to
  // the browser (server-side plugin code uses resolvePluginSecrets directly).
  router.get('/api/plugin/config', (req, res) => {
    try {
      const name = String(req.query.plugin || '')
      const manifest = builtinPlugin(name)
      if (!manifest) return res.status(404).json({ error: 'unknown plugin' })
      const cfg = loadPersonalConfig({ home })
      res.json({ plugin: name, config: projectForPlugin(cfg, manifest) })
    } catch (err) {
      console.error('[/api/plugin/config]', err)
      res.status(500).json({ error: err.message })
    }
  })

  return {
    router,
    handleTerminalWs: sessionController.handleTerminalWs,
    handleTabsWs,
    setAgentHealthMonitor: sessionController.setAgentHealthMonitor,
    handleRemoteSshWs: remoteSsh.handleRemoteSshWs,
    sessionController,
  }
}
