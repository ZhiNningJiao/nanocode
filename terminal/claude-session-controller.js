import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import * as sessions from './sessions.js'
import { buildReplaySeed, buildUserReplayId, resolveSessionJsonl, parseJsonlHistoryTail } from './claude-history.js'
import { createClaudeSdkDriver } from './claude-sdk-driver.js'
import { createClaudeTmuxDriver } from './claude-tmux-driver.js'
import { createCodexSdkDriver } from './codex-sdk-driver.js'
import { createOpencodeBlockDriver } from './opencode-block-driver.js'
import { resolveClaudeConfigDir, buildClaudeSpawnEnv } from './claude-env.js'
import { resolvePersonaPrompt, framePersonaPrompt } from './personas.js'
import { copyTranscriptToTeam, teamModelDefaults } from './team-failover.js'
import { loadPersonalConfig } from './personal-config.js'
import { acquireSessionLock, releaseSessionLock } from './session-lock.js'

export function createClaudeSessionController({ store, home, recentAgents, testQueryImpl, port }) {
  const IS_WIN = platform() === 'win32'
  const SHELL = IS_WIN
    ? (process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe')
    : 'bash'
  const SSH = IS_WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh'

  // Map: sessionKey -> { claudeSessionId, clients, history, busy }
  const claudeSessions = new Map()
  const codexSessions = new Map()
  const replaySeeds = new Map()

  const TAB_LAUNCHERS = {
    bash: () => 'exec bash -l',
    claude: () => {
      const autoResume = store.getSetting('claude_autoresume')
      const enabled = autoResume !== '0'
      if (!enabled) {
        return 'claude --dangerously-skip-permissions; exec bash -l'
      }
      return [
        'set +H;',
        '_cbr_first=1;',
        '_cbr_continue() {',
        '  while true; do',
        '    if [ "$_cbr_first" = "1" ]; then',
        '      _cbr_first=0;',
        '      claude --dangerously-skip-permissions;',
        '    else',
        '      _cbr_start=$SECONDS;',
        '      claude --continue --dangerously-skip-permissions;',
        '      _cbr_elapsed=$(( SECONDS - _cbr_start ));',
        '      if [ "$_cbr_elapsed" -lt 2 ]; then',
        '        echo "[nanocode] claude --continue failed quickly (no session?), dropping to bash";',
        '        break;',
        '      fi;',
        '    fi;',
        '    echo "";',
        '    echo "[nanocode] Claude exited. Press any key within 3s to stay in bash, or wait to auto-resume...";',
        '    _cbr_key="";',
        '    read -r -s -n 1 -t 3 _cbr_key;',
        '    if [ -n "$_cbr_key" ]; then',
        '      echo "[nanocode] Dropping to bash (key pressed).";',
        '      break;',
        '    fi;',
        '    echo "[nanocode] Auto-resuming...";',
        '  done;',
        '};',
        '_cbr_continue;',
        'exec bash -l',
      ].join(' ')
    },
    codex: () => {
      const globalPerm = store.getSetting('global_permission') || 'full-auto'
      if (globalPerm === 'auto-edits') {
        // workspace-write sandbox, ask on request
        return 'codex -s workspace-write -a on-request; exec bash -l'
      } else if (globalPerm === 'ask') {
        // read-only sandbox, ask every time (untrusted mode)
        return 'codex -s read-only -a untrusted; exec bash -l'
      }
      // full-auto (default): bypass all confirmations and sandbox
      return 'codex --dangerously-bypass-approvals-and-sandbox; exec bash -l'
    },
    agent: () => 'agent --force --approve-mcps; exec bash -l',
    opencode: () => 'opencode .; exec bash -l',
    // meshy-aigw: opencode with Kimi K2.7 Code via Meshy AIGW proxy
    // Config lives in ~/.config/opencode/opencode.json (kimi provider, model kimi/litellm/SGLang-Kimi-K2.7-Code)
    // MESHY_AIGW_KEY is injected from ~/.config/meshy-aigw.key at launch time so the child shell
    // picks it up without permanently polluting the nanocode server environment.
    // 需求1: if the user picked an AIGW model in the Plugins tab (aigw_model
    // setting), use it via -m kimi/<model> + an inline config override that
    // registers the model under the kimi provider (same mechanism as fable5).
    'meshy-aigw': () => {
      const keyFile = join(home || process.env.HOME, '.config', 'meshy-aigw.key')
      const aigwModel = store.getSetting('aigw_model')
      const parts = []
      if (existsSync(keyFile)) {
        parts.push(`export MESHY_AIGW_KEY=$(cat ${keyFile})`)
      }
      if (aigwModel && typeof aigwModel === 'string' && aigwModel.trim()) {
        const m = aigwModel.trim()
        const cfg = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { kimi: { models: { [m]: { name: m } } } } })
        parts.push(`export OPENCODE_CONFIG_CONTENT='${cfg}'`)
        parts.push(`opencode -m kimi/${m} .`)
      } else {
        parts.push('opencode .')
      }
      parts.push('exec bash -l')
      return parts.join('; ')
    },
    // fable5: opencode with Claude Fable 5 (litellm/claude-fable-5) via Meshy AIGW.
    // The kimi provider in the global opencode.json already has the AIGW baseURL +
    // apiKey, but only registers GLM/Kimi/gpt-5.5 models — claude-fable-5 is not
    // registered, so opencode rejects it with ProviderModelNotFoundError.
    // OPENCODE_CONFIG_CONTENT is an inline runtime override (merged, not replacing)
    // that adds litellm/claude-fable-5 to the kimi provider, reusing its AIGW baseURL.
    // 需求1: aigw_model setting overrides the hardcoded fable-5 model.
    'fable5': () => {
      const keyFile = join(home || process.env.HOME, '.config', 'meshy-aigw.key')
      const aigwModel = store.getSetting('aigw_model')
      const model = (aigwModel && typeof aigwModel === 'string' && aigwModel.trim())
        ? aigwModel.trim()
        : 'litellm/claude-fable-5'
      const cfg = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { kimi: { models: { [model]: { name: model } } } } })
      const launch = `export OPENCODE_CONFIG_CONTENT='${cfg}'; opencode -m kimi/${model} .; exec bash -l`
      if (existsSync(keyFile)) {
        return `export MESHY_AIGW_KEY=$(cat ${keyFile}); ${launch}`
      }
      return launch
    },
  }

  function sessionKeyFor(projectId, tabId) {
    return `${projectId}:claude:${tabId}`
  }

  function codexSessionKeyFor(projectId, tabId) {
    return `${projectId}:codex:${tabId}`
  }

  function setClaudeSessionId(projectId, tabId, claudeSessionId, { resetTurnCount = false } = {}) {
    const cs = claudeSessions.get(sessionKeyFor(projectId, tabId))
    if (!cs) return
    cs.claudeSessionId = claudeSessionId
    if (resetTurnCount) cs.turnCount = 0
    if (resetTurnCount) cs._replayUserTextCounts = new Map()
  }

  // team-failover opt-in toggle for a live session (secretary sessions). Applies
  // immediately to the running cs so the next turn honours it.
  function setAllowTeamFailover(projectId, tabId, allow) {
    const cs = claudeSessions.get(sessionKeyFor(projectId, tabId))
    if (cs) cs.allowTeamFailover = !!allow
  }

  // Manually move the current conversation to another team NOW: copy the
  // transcript into the target team's projects dir, switch the tab + live cs to
  // that team's CLAUDE_CONFIG_DIR, and upgrade the model to that team's default
  // (Team1→fable/high, other→opus/high). The next turn resumes on the target
  // org's quota. Reuses the failover machinery; also clears any auto-failover
  // state so the manual choice sticks.
  function switchTeam(projectId, tabId, targetConfigDir) {
    const tab = store.getTab ? store.getTab(projectId, tabId) : null
    if (!tab || tab.type !== 'claude') return { ok: false, error: 'not a claude tab' }
    if (!targetConfigDir || !existsSync(targetConfigDir)) return { ok: false, error: 'target team not found' }
    const cs = claudeSessions.get(sessionKeyFor(projectId, tabId))
    const project = store.getProject ? store.getProject(projectId) : null
    const fromDir = cs ? resolveClaudeConfigDir({ cs, store, home }) : (tab.claudeConfigDir || join(home, '.claude'))
    if (fromDir === targetConfigDir) return { ok: false, error: 'already on that team' }
    const cwd = (cs && cs.cwd) || tab.claudeSessionCwd || project?.cwd || home
    const sid = (cs && cs.claudeSessionId) || tab.claudeSessionId
    const copied = copyTranscriptToTeam(sid, cwd, fromDir, targetConfigDir)
    const md = teamModelDefaults(targetConfigDir, { home, personalTeams: loadPersonalConfig({ home })?.claude?.teams || [] })
    store.updateTabMetadata(projectId, tabId, { claudeConfigDir: targetConfigDir })
    if (cs) {
      cs.claudeConfigDir = targetConfigDir
      cs.claudeModelOverride = md.model
      cs.claudeEffortOverride = md.effort
      cs.explicitSessionId = true
      cs._failedOver = false
      cs._originalConfigDir = null
    }
    console.log(`[team-switch] ${projectId}:${tabId} ${fromDir} → ${targetConfigDir} (${md.model}) copied=${copied}`)
    return { ok: true, team: targetConfigDir, model: md.model, copied }
  }

  function primeReplayHistory(projectId, tabId, events) {
    const sessionKey = sessionKeyFor(projectId, tabId)
    const seed = buildReplaySeed(events)
    const cs = claudeSessions.get(sessionKey)
    if (cs) return
    replaySeeds.set(sessionKey, seed)
  }

  /** Build SSH args for a remote project. */
  function buildSshArgs(project, remoteCmd) {
    const args = [
      '-tt',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-p', String(project.ssh_port || 22),
    ]
    if (project.ssh_key) args.push('-i', project.ssh_key)
    args.push(`${project.ssh_user || 'root'}@${project.ssh_host}`)
    args.push(`bash -lc ${sq(remoteCmd)}`)
    return args
  }

  /** Shell-escape a string for use inside single quotes. */
  function sq(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  // ── Agent health monitor hook ────────────────────────────────────────────────
  let _agentHealthMonitor = null

  function setAgentHealthMonitor(monitor) {
    _agentHealthMonitor = monitor || null
  }

  function trackClaudeMainProcess(sessionKey, proc) {
    if (_agentHealthMonitor && sessionKey && proc?.pid) {
      try {
        _agentHealthMonitor.registerMainProcess(sessionKey, proc.pid, proc)
      } catch {}
    }
  }

  function claudeBroadcast(cs, event) {
    cs.history.push(event)
    if (cs.history.length > 500) cs.history.shift()
    const msg = JSON.stringify({ type: 'claude-event', event })
    for (const client of cs.clients) {
      if (client.readyState === 1) try { client.send(msg) } catch {}
    }
    // Feed event into health monitor if registered
    if (_agentHealthMonitor && cs.sessionKey) {
      try {
        const [projectId, , tabId] = cs.sessionKey.split(':')
        _agentHealthMonitor.recordClaudeEvent({
          sessionKey: cs.sessionKey,
          projectId,
          tabId,
          tabType: 'claude',
          provider: 'claude',
          source: 'claude-sdk',
          sessionId: cs.claudeSessionId,
        }, event)
      } catch {}
    }
  }

  // 需求9: server-owned queue delivery. When the server drains tab.pendingQueue
  // (queued while busy + persisted immediately) it starts a new turn directly —
  // bypassing the WS 'claude-input' handler that normally broadcasts the 'user'
  // echo event. Connected clients (page still open) would never see the user
  // message render. This helper builds + broadcasts the same 'user' event the WS
  // handler emits (line ~1001) so all connected clients render the delivered
  // queued message live. On reconnect, history replay renders it again (no
  // nonce → no dedup), exactly like the normal send flow.
  function broadcastUserEcho(cs, text) {
    if (!cs || typeof text !== 'string' || !text.trim()) return
    if (!cs._replayUserTextCounts) cs._replayUserTextCounts = new Map()
    const userEvent = {
      type: 'user',
      uuid: randomUUID(),
      replay_id: buildUserReplayId(text, cs._replayUserTextCounts),
      message: { role: 'user', content: [{ type: 'text', text }] },
      _nonce: null,
    }
    claudeBroadcast(cs, userEvent)
  }

  function getClaudeDriver() {
    const driver = store.getSetting('claude_driver')
    if (driver === 'cli') return 'cli'
    if (driver === 'sdk') return 'sdk'
    if (driver === 'tmux' || process.env.NANOCODE_CLAUDE_TMUX === '1') return 'tmux'

    // Default to the persistent tmux-backed driver in production. This keeps
    // one Claude OS process per tab across nanocode restarts/reconnects instead
    // of spawning a new SDK streaming session (and therefore a new OS process)
    // on every resume or crash recovery. See claude-tmux-driver.js.
    //
    // In the Node test runner we keep SDK as the default so unit tests that use
    // a real store but a mocked/fake Claude binary continue to work without
    // requiring tmux sessions. NODE_TEST_CONTEXT is set by the test runner for
    // every test file it spawns.
    if (process.env.NODE_TEST_CONTEXT) return 'sdk'
    return 'tmux'
  }

  function appendCodexScrollback(cs, text) {
    if (!text) return
    cs.scrollback += text
    if (cs.scrollback.length > 250_000) {
      cs.scrollback = cs.scrollback.slice(-250_000)
    }
  }

  function codexBroadcast(cs, text, { historyOnly = false } = {}) {
    appendCodexScrollback(cs, text)
    if (historyOnly) return
    const msg = JSON.stringify({ type: 'output', data: text })
    for (const client of cs.clients) {
      if (client.readyState === 1) try { client.send(msg) } catch {}
    }
  }

  function codexBroadcastEvent(cs, event) {
    cs.eventHistory.push(event)
    if (cs.eventHistory.length > 500) cs.eventHistory.shift()
    const msg = JSON.stringify({ type: 'codex-event', event })
    for (const client of cs.clients) {
      if (client.readyState === 1) try { client.send(msg) } catch {}
    }
    // Feed event into health monitor if registered
    if (_agentHealthMonitor && cs.sessionKey) {
      try {
        const [projectId, , tabId] = cs.sessionKey.split(':')
        _agentHealthMonitor.recordCodexEvent({
          sessionKey: cs.sessionKey,
          projectId,
          tabId,
          tabType: 'codex',
          provider: 'codex',
          source: 'codex-sdk',
          threadId: cs.codexThreadId,
        }, event)
      } catch {}
    }
  }

  function codexBroadcastStreamText(cs, { itemId, textDelta }) {
    if (!textDelta) return
    const msg = JSON.stringify({ type: 'codex-stream-text', itemId, textDelta })
    for (const client of cs.clients) {
      if (client.readyState === 1) try { client.send(msg) } catch {}
    }
  }

  function getCodexDriver() {
    return store.getSetting('codex_driver') === 'sdk' ? 'sdk' : 'pty'
  }

  let dispatchClaudeTurn = null
  const sdkDriver = createClaudeSdkDriver({
    store,
    home,
    claudeBroadcast,
    broadcastUserEcho,
    rerunTurn: (...args) => dispatchClaudeTurn(...args),
    runCliFallback: (...args) => runClaudeCliTurn(...args),
    onClaudeSpawn: ({ sessionKey, pid, proxy }) => {
      if (_agentHealthMonitor && sessionKey && Number.isFinite(pid)) {
        try {
          _agentHealthMonitor.registerMainProcess(sessionKey, pid, proxy)
        } catch {}
      }
    },
    // Test seam: inject a mock queryImpl to make the streaming SDK path
    // deterministic (the real claude binary completes turns too fast to
    // reproduce a stable "busy" state for the send-now race tests).
    ...(testQueryImpl ? { queryImpl: testQueryImpl, forceStreaming: true } : {}),
  })
  const tmuxDriver = createClaudeTmuxDriver({
    store,
    home,
    claudeBroadcast,
    broadcastUserEcho,
    rerunTurn: (...args) => dispatchClaudeTurn(...args),
  })
  let dispatchCodexTurn = null
  const codexSdkDriver = createCodexSdkDriver({
    store,
    codexBroadcast,
    codexBroadcastEvent,
    codexBroadcastStreamText,
    rerunTurn: (...args) => dispatchCodexTurn(...args),
  })

  // ── opencode block-mode (Fable5 / opencode tabs, Block render mode) ──────────
  // 需求11-C: per-turn 'opencode run --format json' subprocess driver. Reuses
  // claudeBroadcast (sends claude-event WS msgs) so the frontend's
  // ClaudeBlockRenderer renders opencode turns with the same block UI.
  const opencodeBlockSessions = new Map()
  let dispatchOpencodeBlockTurn = null
  const opencodeBlockDriver = createOpencodeBlockDriver({
    store,
    broadcast: claudeBroadcast,
    rerunTurn: (...args) => dispatchOpencodeBlockTurn(...args),
  })

  let _lastGcMs = 0
  function gcClaudeSessions() {
    const now = Date.now()
    if (now - _lastGcMs < 60_000) return
    _lastGcMs = now
    try {
      const sessDir = join(home, '.claude', 'sessions')
      if (!existsSync(sessDir)) return
      const files = readdirSync(sessDir)
      for (const f of files) {
        if (!/^\d+\.json$/.test(f)) continue
        const pid = parseInt(f, 10)
        try {
          process.kill(pid, 0)
        } catch {
          try {
            unlinkSync(join(sessDir, f))
            console.log(`[gc:sessions] removed stale lock for PID ${pid}`)
          } catch {}
        }
      }
    } catch {}
  }

  function buildClaudeChildEnv(cs) {
    // 需求1 Team switch + 需求5 cross-team resume: honour a per-tab configDir
    // (cs.claudeConfigDir, set when resuming a session from another team) over
    // the global store setting, and strip nanocode-self identifiers. The same
    // shared helper is used by the SDK driver so every driver honours the team
    // config dir consistently.
    const configDir = resolveClaudeConfigDir({ cs, store, home })
    return buildClaudeSpawnEnv(process.env, { configDir })
  }

  // ── Layer 2: --continue fallback ─────────────────────────────────────────────
  // Called when --resume <sid> fails with "No conversation found". Spawns claude
  // with --continue (picks the most recent jsonl in cwd) and updates cs.claudeSessionId
  // from the init event. If --continue also fails (no jsonl), falls back to new session.
  function _runClaudeCliContinueFallback(cs, userText, sessionKey, cwd) {
    cs.busy = true
    cs.currentProc = null

    const claudeModel = store.getSetting('claude_model') || ''
    const claudeEffort = store.getSetting('claude_effort') || ''
    const cacheTtl = store.getSetting('claude_cache_ttl') || ''
    const globalPerm = store.getSetting('global_permission') || 'full-auto'
    const tabLabel = cs.tabLabel || ''

    const launchArgs = [
      '--print',
      '--output-format=stream-json',
      '--verbose',
      '--include-partial-messages',
      '--continue',
    ]

    if (globalPerm === 'auto-edits') {
      launchArgs.push('--permission-mode', 'acceptEdits')
    } else if (globalPerm === 'ask') {
      launchArgs.push('--permission-mode', 'default')
    } else {
      // full-auto (default)
      launchArgs.push('--dangerously-skip-permissions')
    }

    if (claudeModel) launchArgs.push('--model', claudeModel)
    if (claudeEffort) launchArgs.push('--effort', claudeEffort)
    if (cacheTtl === '1h') launchArgs.push('--betas', 'extended-cache-ttl-2025-04-11')
    if (tabLabel) launchArgs.push('--name', tabLabel)
    // 需求8: persona injection (CLI flag). Re-applied every turn so the persona
    // survives resume/reconnect. Empty prompt = no flag (no-op).
    if (cs.personaPrompt) launchArgs.push('--append-system-prompt', cs.personaPrompt)

    launchArgs.push('--')
    launchArgs.push(userText)

    const escapedArgs = launchArgs.map((a) => sq(a))
    const launchCmd = `exec claude ${escapedArgs.join(' ')}`

    console.log(`[claude:continue-fallback:spawn] sessionKey=${sessionKey}`)
    const proc = spawn('bash', ['-lc', launchCmd], {
      cwd,
      env: buildClaudeChildEnv(cs),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    trackClaudeMainProcess(sessionKey, proc)
    proc._nanocodeInterrupted = false
    cs.currentProc = proc
    cs.turnCount++  // count this as turn 1

    let lineBuffer = ''
    let _continueAlsoFailed = false
    // Track whether CLI already emitted a result event via stdout (to avoid double-broadcast)
    let _sawResultFromStdout = false

    proc.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8')
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop()
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event
        try { event = JSON.parse(trimmed) } catch { continue }
        // Capture the new sessionId from the init event
        if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
          if (event.session_id !== cs.claudeSessionId) {
            console.log(`[claude:continue-fallback] ${sessionKey}: updated sessionId ${cs.claudeSessionId} -> ${event.session_id}`)
            cs.claudeSessionId = event.session_id
            if (store.updateTabMetadata) {
              const [projectId, , tabId] = sessionKey.split(':')
              store.updateTabMetadata(projectId, tabId, { claudeSessionId: event.session_id })
            }
          }
        }
        if (event?.type === 'result') _sawResultFromStdout = true
        claudeBroadcast(cs, event)
      }
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      if (text.includes('No conversation found') || text.includes('no conversation') ||
          text.includes('no session') || text.includes('Session not found')) {
        _continueAlsoFailed = true
        console.warn(`[claude:continue-fallback] ${sessionKey}: --continue also failed, will open new session`)
        return
      }
      console.warn(`[claude:continue-fallback:stderr] ${sessionKey}: ${text.slice(0, 120)}`)
    })

    proc.on('exit', (code, signal) => {
      cs.busy = false
      cs.currentProc = null

      if (_continueAlsoFailed) {
        // Layer 3: open new session
        const newSessionId = randomUUID()
        cs.claudeSessionId = newSessionId
        cs.turnCount = 0
        cs.explicitSessionId = false
        if (store.updateTabMetadata) {
          const [projectId, , tabId] = sessionKey.split(':')
          store.updateTabMetadata(projectId, tabId, { claudeSessionId: newSessionId })
        }
        claudeBroadcast(cs, {
          type: 'system', subtype: 'continue_fallback',
          text: `[--continue also failed — starting fresh new session]`,
        })
        setImmediate(() => dispatchClaudeTurn(cs, userText, sessionKey, cwd))
        return
      }

      const wasInterrupted = signal === 'SIGINT' || proc._nanocodeInterrupted === true
      // CLI already emitted result/error_during_execution via stdout when interrupted.
      // Only broadcast a result here if CLI did NOT emit one.
      if (!_sawResultFromStdout) {
        const doneEvent = { type: 'result', subtype: wasInterrupted ? 'error_during_execution' : 'success' }
        claudeBroadcast(cs, doneEvent)
      }
      if (code !== 0 && code != null && !wasInterrupted && !_continueAlsoFailed) {
        claudeBroadcast(cs, { type: 'system', subtype: 'stderr', text: `claude exited with code ${code}` })
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      // On interrupt: auto-flush queued messages unless setting disabled.
      const autoFlushOnInterrupt = store.getSetting('auto_flush_queue_on_interrupt') !== '0'
      const forceFlush = cs._forceFlushQueue === true
      cs._forceFlushQueue = false
      if (cs.queue.length > 0) {
        if (forceFlush || !wasInterrupted || autoFlushOnInterrupt) {
          const allQueued = cs.queue.splice(0)
          const combinedText = allQueued.join('\n\n')
          if (wasInterrupted && !forceFlush) {
            claudeBroadcast(cs, { type: 'system', subtype: 'info', text: `Resuming with ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''}…` })
          }
          setImmediate(() => dispatchClaudeTurn(cs, combinedText, sessionKey, cwd))
        }
      }
    })

    proc.on('error', (err) => {
      cs.busy = false
      cs.currentProc = null
      claudeBroadcast(cs, { type: 'result', subtype: 'error' })
      claudeBroadcast(cs, { type: 'system', subtype: 'spawn_error', text: err.message })
    })
  }

  function runClaudeCliTurn(cs, userText, sessionKey, cwd) {
    const quietQueue = cs._quietQueueOnce === true
    cs._quietQueueOnce = false
    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(userText)
      if (!quietQueue) {
        const queuedEvent = {
          type: 'system', subtype: 'queued',
          text: `Message queued (position ${cs.queue.length}). Will run after current turn.`,
        }
        claudeBroadcast(cs, queuedEvent)
      }
      return
    }
    cs.busy = true
    cs.currentProc = null

    const isFirstTurn = cs.turnCount === 0
    if (isFirstTurn) gcClaudeSessions()
    // ── Three-layer session fallback ─────────────────────────────────────────
    // Layer 1: has history or was resumed before → --resume <sid>
    // Layer 2: first-turn with explicit stored sessionId → also --resume <sid>
    //          (fallback: if "No conversation found" → retry with --continue)
    // Layer 3: truly new session → --session-id <new-uuid>
    //
    // Previously: isFirstTurn → always --session-id which opened a NEW claude session.
    // This broke reconnect-after-sleep: cs was rebuilt (server restart or first-WS-msg
    // before history-fetch primed the seed), turnCount reset to 0, and we opened a brand
    // new conversation instead of resuming the stored one.
    const sessionFallback = store.getSetting('claude_session_fallback') || 'continue'
    const useResumeOnFirstTurn = !isFirstTurn || (cs.explicitSessionId && !cs.skipAutoResume)
    let sessionArg
    if (useResumeOnFirstTurn) {
      sessionArg = `--resume=${cs.claudeSessionId}`
    } else {
      sessionArg = `--session-id=${cs.claudeSessionId}`
    }
    cs.turnCount++

    const claudeModel = store.getSetting('claude_model') || ''
    const claudeEffort = store.getSetting('claude_effort') || ''
    const cacheTtl = store.getSetting('claude_cache_ttl') || ''
    const globalPerm = store.getSetting('global_permission') || 'full-auto'
    const tabLabel = cs.tabLabel || ''

    const launchArgs = [
      '--print',
      '--output-format=stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (globalPerm === 'auto-edits') {
      launchArgs.push('--permission-mode', 'acceptEdits')
    } else if (globalPerm === 'ask') {
      launchArgs.push('--permission-mode', 'default')
    } else {
      // full-auto (default)
      launchArgs.push('--dangerously-skip-permissions')
    }

    if (claudeModel) launchArgs.push('--model', claudeModel)
    if (claudeEffort) launchArgs.push('--effort', claudeEffort)
    if (cacheTtl === '1h') launchArgs.push('--betas', 'extended-cache-ttl-2025-04-11')
    if (tabLabel) launchArgs.push('--name', tabLabel)
    // 需求8: persona injection (CLI flag). Re-applied every turn so the persona
    // survives resume/reconnect. Empty prompt = no flag (no-op).
    if (cs.personaPrompt) launchArgs.push('--append-system-prompt', cs.personaPrompt)

    launchArgs.push(sessionArg)
    launchArgs.push('--')
    launchArgs.push(userText)
    const escapedArgs = launchArgs.map((a) => sq(a))
    const launchCmd = `exec claude ${escapedArgs.join(' ')}`

    const _spawnEnv = buildClaudeChildEnv(cs)
    console.log(`[claude:spawn] sessionKey=${sessionKey} turn=${cs.turnCount} len=${userText.length} cfgDir=${cs.claudeConfigDir || '(default)'} env.CLAUDE_CONFIG_DIR=${_spawnEnv.CLAUDE_CONFIG_DIR || '(unset)'} persona=${cs.persona || '(none)'} personaPromptLen=${(cs.personaPrompt || '').length} cmd=${launchCmd.slice(0, 200)}`)
    const proc = spawn('bash', ['-lc', launchCmd], {
      cwd,
      env: _spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    trackClaudeMainProcess(sessionKey, proc)
    proc._nanocodeInterrupted = false
    cs.currentProc = proc

    let lineBuffer = ''
    let _sessionConflict = false
    // Detect "No conversation found" so we can fallback to --continue
    let _noConversationFound = false
    // Track whether any JSON events came through (if not + exit non-0, likely a resume failure)
    let _sawAnyEvent = false
    // Track whether CLI already emitted a result event via stdout (to avoid double-broadcast)
    let _sawResultFromStdout = false

    proc.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8')
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop()
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event
        try { event = JSON.parse(trimmed) } catch { continue }
        _sawAnyEvent = true
        if (event?.type === 'result') _sawResultFromStdout = true
        claudeBroadcast(cs, event)
      }
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      if (!_sessionConflict && text.includes('is already in use')) {
        _sessionConflict = true
        console.warn(`[claude:session-conflict] ${sessionKey}: session still locked, will retry`)
        return
      }
      // Detect resume failure: "No conversation found" means --resume <sid> failed because
      // the claude session doesn't exist (purged or never written). We will retry with
      // --continue (or new session if fallback=strict).
      if (!_noConversationFound && (
        text.includes('No conversation found') ||
        text.includes('no conversation') ||
        text.includes('Session not found') ||
        text.includes('session not found')
      )) {
        _noConversationFound = true
        console.warn(`[claude:resume-miss] ${sessionKey}: session ${cs.claudeSessionId} not found, will fallback`)
        return
      }
      console.warn(`[claude:stderr] ${sessionKey}: ${text.slice(0, 120)}`)
      const event = { type: 'system', subtype: 'stderr', text }
      claudeBroadcast(cs, event)
    })

    proc.on('exit', (code, signal) => {
      cs.busy = false
      cs.currentProc = null

      if (_sessionConflict) {
        const attempt = (cs._conflictRetries || 0) + 1
        if (attempt <= 2) {
          cs._conflictRetries = attempt
          cs.turnCount--
          console.warn(`[claude:session-conflict] ${sessionKey}: retry #${attempt} in 1s`)
          setTimeout(() => {
            runClaudeCliTurn(cs, userText, sessionKey, cwd)
          }, 1000)
          return
        }
        cs._conflictRetries = 0
        const newSessionId = randomUUID()
        console.warn(`[claude:session-conflict] ${sessionKey}: exhausted retries, abandoning locked session ${cs.claudeSessionId} -> new ${newSessionId}`)
        cs.claudeSessionId = newSessionId
        cs.turnCount = 0
        if (store.updateTabMetadata) {
          const [projectId, , tabId] = sessionKey.split(':')
          store.updateTabMetadata(projectId, tabId, { claudeSessionId: newSessionId })
        }
      }

      // ── Continue-fallback: --resume failed with "No conversation found" ──────
      // Layer 2: retry with --continue (picks up the most recent jsonl in cwd).
      // Layer 3: if sessionFallback=strict, skip --continue and open a new session.
      if (_noConversationFound && !_sawAnyEvent && code !== 0) {
        cs.turnCount--  // undo the increment so retry uses the same turn slot
        cs.explicitSessionId = false  // clear so next retry doesn't loop
        if (sessionFallback !== 'strict') {
          console.warn(`[claude:continue-fallback] ${sessionKey}: --resume missed, retrying with --continue`)
          claudeBroadcast(cs, {
            type: 'system', subtype: 'continue_fallback',
            text: `[Session not found — falling back to --continue to pick up most recent context]`,
          })
          setImmediate(() => _runClaudeCliContinueFallback(cs, userText, sessionKey, cwd))
        } else {
          console.warn(`[claude:continue-fallback] ${sessionKey}: --resume missed, fallback=strict → new session`)
          const newSessionId = randomUUID()
          cs.claudeSessionId = newSessionId
          cs.turnCount = 0
          if (store.updateTabMetadata) {
            const [projectId, , tabId] = sessionKey.split(':')
            store.updateTabMetadata(projectId, tabId, { claudeSessionId: newSessionId })
          }
          claudeBroadcast(cs, {
            type: 'system', subtype: 'continue_fallback',
            text: `[Session not found — starting new session (fallback=strict)]`,
          })
          setImmediate(() => dispatchClaudeTurn(cs, userText, sessionKey, cwd))
        }
        return
      }

      const wasInterrupted = signal === 'SIGINT' || proc._nanocodeInterrupted === true
      // CLI already emitted result/error_during_execution via stdout when interrupted.
      // Only broadcast a result here if CLI did NOT emit one (e.g. clean success exit).
      if (!_sawResultFromStdout) {
        const doneEvent = { type: 'result', subtype: wasInterrupted ? 'error_during_execution' : 'success' }
        claudeBroadcast(cs, doneEvent)
      }
      if (code !== 0 && code != null && !wasInterrupted) {
        const event = { type: 'system', subtype: 'stderr', text: `claude exited with code ${code}` }
        claudeBroadcast(cs, event)
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      // On interrupt: auto-flush queued messages as a new turn unless setting disabled.
      // default true — matches user expectation: interrupt clears the run, queued msgs fire next.
      const autoFlushOnInterrupt = store.getSetting('auto_flush_queue_on_interrupt') !== '0'
      const forceFlush = cs._forceFlushQueue === true
      cs._forceFlushQueue = false
      if (cs.queue.length > 0) {
        if (forceFlush || !wasInterrupted || autoFlushOnInterrupt) {
          const allQueued = cs.queue.splice(0)
          const combinedText = allQueued.join('\n\n')
          console.log(`[claude:queue] sessionKey=${sessionKey} flushing ${allQueued.length} queued message(s) as one turn (interrupted=${wasInterrupted}, force=${forceFlush})`)
          if (wasInterrupted && !forceFlush) {
            claudeBroadcast(cs, { type: 'system', subtype: 'info', text: `Resuming with ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''}…` })
          }
          setImmediate(() => dispatchClaudeTurn(cs, combinedText, sessionKey, cwd))
        }
      }
    })

    proc.on('error', (err) => {
      cs.busy = false
      cs.currentProc = null
      const doneEvent = { type: 'result', subtype: 'error' }
      claudeBroadcast(cs, doneEvent)
      const event = { type: 'system', subtype: 'spawn_error', text: err.message }
      claudeBroadcast(cs, event)
      if (cs.queue.length > 0) {
        const allQueued = cs.queue.splice(0)
        const combinedText = allQueued.join('\n\n')
        console.log(`[claude:queue] sessionKey=${sessionKey} flushing ${allQueued.length} queued message(s) after spawn error`)
        setImmediate(() => dispatchClaudeTurn(cs, combinedText, sessionKey, cwd))
      }
    })
  }

  dispatchClaudeTurn = (cs, userText, sessionKey, cwd) => {
    const driver = getClaudeDriver()
    if (driver === 'tmux') {
      if (tmuxDriver.isAvailable()) {
        cs.claudeDriver = 'tmux'
        return tmuxDriver.run(cs, userText, sessionKey, cwd).catch((err) => {
          console.error(`[claude:tmux] ${sessionKey} failed, falling back to SDK:`, err?.message || err)
          cs.claudeDriver = 'sdk'
          // ── WEDGE FIX ──────────────────────────────────────────────────────
          // runTmuxTurn sets cs.busy=true and turnCount++ BEFORE its try/finally,
          // but the failure that lands here (ensureConnected / tmux new-session)
          // throws outside that try — so the finally that clears busy never runs.
          // Without this reset the SDK fallback below sees cs.busy===true and
          // QUEUES the message ("Message queued: position 1") into a dead session
          // that never drains, while cs.currentProc stays null. That is the exact
          // wedge: every message queues (busy stuck true) and /interrupt returns
          // "not busy" (currentProc null) — the user can neither send nor stop.
          // Reset the leaked bookkeeping so the fallback actually RUNS this turn.
          cs.busy = false
          cs.currentProc = null
          if (cs.turnCount > 0) cs.turnCount -= 1
          return sdkDriver.runSdkTurn(cs, userText, sessionKey, cwd)
        })
      }
      console.warn(`[claude:driver] ${sessionKey}: tmux requested but unavailable, falling back to SDK`)
    }
    cs.claudeDriver = driver === 'tmux' ? 'sdk' : driver
    if (cs.claudeDriver === 'sdk') {
      return sdkDriver.runSdkTurn(cs, userText, sessionKey, cwd)
    }
    return runClaudeCliTurn(cs, userText, sessionKey, cwd)
  }

  dispatchCodexTurn = (cs, userText, sessionKey, cwd) => (
    codexSdkDriver.runCodexTurn(cs, userText, sessionKey, cwd)
  )

  // External inject: write a user message into an ACTIVE claude session's input
  // channel — the server-side equivalent of the WS 'claude-input' message. Used
  // by POST /api/sessions/:id/inject (localhost-only) so an external crontab
  // watchdog can wake a stuck/idle secretary session (nanocode --watch restarts
  // kill all internal listeners, so an HTTP inject is the only reliable external
  // wake path). Reuses the EXACT same dispatch path as a real user message —
  // broadcast the user-echo event, then dispatchClaudeTurn — so there is no
  // separate code path and no task special-case (red line).
  //
  // sendNow mirrors the "立刻发送" WS path: when true AND the session is mid-turn,
  // atomically interrupt+flush so the injected message lands immediately (force,
  // but the SDK remaps force to q.interrupt() — never kills the process or
  // sub-agents, red line). When false (default), a busy session queues the
  // message behind the running turn like a normal typed message. A watchdog
  // firing on a stuck secretary should pass sendNow=true.
  function injectClaudeMessage(sessionKey, text, { sendNow = false } = {}) {
    const cs = claudeSessions.get(sessionKey)
    if (!cs) return { ok: false, error: 'session not found' }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty text' }
    const userEvent = {
      type: 'user',
      uuid: randomUUID(),
      replay_id: buildUserReplayId(text, cs._replayUserTextCounts),
      message: { role: 'user', content: [{ type: 'text', text }] },
      _nonce: null,
    }
    claudeBroadcast(cs, userEvent)
    const wasBusy = sendNow === true && cs.busy && !!cs.currentProc
    dispatchClaudeTurn(cs, text, sessionKey, cs.cwd)
    if (wasBusy) {
      try {
        Promise.resolve(_interruptRunningClaudeTurn(cs, { force: true, andFlush: true })).catch((err) => {
          console.error(`[claude:inject] ${sessionKey}: atomic interrupt failed:`, err?.message || err)
        })
      } catch (err) {
        console.error(`[claude:inject] ${sessionKey}: atomic interrupt failed:`, err?.message || err)
      }
    }
    return {
      ok: true,
      sessionKey,
      type: 'claude',
      claudeSessionId: cs.claudeSessionId || null,
      busy: !!cs.busy,
      dispatched: true,
    }
  }

  function attachClaudeSession(ws, { projectId, tabId, project }) {
    const sessionKey = sessionKeyFor(projectId, tabId)
    let cs = claudeSessions.get(sessionKey)

    if (!cs) {
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      // Track whether the sessionId came from store metadata (user-chosen, explicit)
      // vs was generated fresh because the tab had no stored session (implicit/new tab).
      const storedSessionId = tab?.claudeSessionId || null
      // createTab pre-assigns a random claudeSessionId with claudeSessionStarted=false
      // (store.js createTab): that UUID has no conversation behind it yet, so it must
      // NOT count as user-chosen. Treating it as explicit made every fresh tab
      // --resume a nonexistent session ("No conversation found") on its first turn.
      // Tabs persisted before the flag existed lack claudeSessionStarted entirely
      // (undefined !== false), so they keep the resume behaviour; tabs with real
      // history are also covered by the disk-recovery path below (diskRecovered).
      const explicitSessionId = storedSessionId !== null && tab?.claudeSessionStarted !== false
      let claudeSessionId = storedSessionId || randomUUID()

      const mainSessionId = process.env.CLAUDE_CODE_SESSION_ID
      let _activeSessionOverride = false
      if (mainSessionId && claudeSessionId === mainSessionId && !explicitSessionId) {
        // Only apply the active-session guard when the sessionId was NOT explicitly
        // chosen by the user (i.e., it came from a newest-jsonl fallback on an
        // implicit/new tab). Without this guard, an implicit tab would silently
        // --resume the running main nanocode session, causing lock conflicts.
        //
        // When the sessionId IS explicit (user picked it via Recent Agents or it
        // was persisted in store metadata), we trust the user's intent and let
        // them resume — even if it's the currently active session. The history
        // endpoint already skips the guard for explicit sessionIds (commit 0117376).
        console.warn(
          `[claude:session] Tab ${tabId} implicit sessionId collides with the running ` +
          `main session (${mainSessionId}). Generating a fresh UUID to avoid conflict.`
        )
        claudeSessionId = randomUUID()
        _activeSessionOverride = true
        // NOTE: do NOT call store.updateTabMetadata here. Persisting the fresh UUID
        // would break subsequent history fetches: the history endpoint reads the stored
        // claudeSessionId to find the jsonl, so if we overwrite it with the fresh UUID
        // (which has no jsonl) the tab loses its history display after the next reconnect.
        // The fresh UUID only needs to live in-memory (cs.claudeSessionId) for routing
        // new turns. The stored sessionId stays as the original (e.g. 987c2f1c) so the
        // history endpoint can always find the correct jsonl file.
      }

      // ── Cross-instance session auto-recovery ──────────────────────────────────
      // Block-mode history replay already reads Claude's jsonl from disk, but the
      // server-side cs.history used to fall back to pure memory. After a server
      // restart (or any time the in-memory cs is gone) the first WS attach would
      // create an empty cs and start a brand new session, even though the directory
      // still contained the persisted conversation. Hydrate cs.history directly
      // from the same directory-resolved jsonl source so the backend never relies
      // solely on in-memory history across instances.
      let recoveredEvents = []
      let recoveredFallback = false
      let recoveredSkipped = false
      if (!_activeSessionOverride && tab) {
        try {
          const resolution = resolveSessionJsonl({ store, home, project, tab })
          if (resolution.resolvedPath) {
            claudeSessionId = resolution.resolvedSessionId
            recoveredEvents = parseJsonlHistoryTail(resolution.resolvedPath)
            recoveredFallback = resolution.fallback
            if (resolution.fallback && resolution.resolvedSessionId !== storedSessionId) {
              if (store.updateTabMetadata) {
                store.updateTabMetadata(projectId, tabId, { claudeSessionId: resolution.resolvedSessionId })
              }
              console.log(
                `[claude:session] Tab ${tabId} auto-recovered fallback session ${resolution.resolvedSessionId} from ${resolution.resolvedPath}`
              )
            }
          } else if (resolution.skipped) {
            claudeSessionId = resolution.resolvedSessionId
            recoveredSkipped = true
            if (store.updateTabMetadata) {
              store.updateTabMetadata(projectId, tabId, { claudeSessionId: resolution.resolvedSessionId })
            }
            console.log(
              `[claude:session] Tab ${tabId} active-session guard skipped auto-recovery, assigned fresh ${resolution.resolvedSessionId}`
            )
          }
        } catch (err) {
          // Best-effort recovery: never let a disk-read failure block attach.
          console.warn(`[claude:session] Tab ${tabId} auto-recovery failed: ${err?.message}`)
        }
      }

      const seed = replaySeeds.get(sessionKey)
      // Prefer the seed built from recovered disk events over the stale
      // in-memory replaySeeds, so cross-instance recovery sets turnCount=1.
      const liveSeed = recoveredEvents.length > 0
        ? buildReplaySeed(recoveredEvents)
        : seed
      // If history was loaded from jsonl (hasHistory=true), treat the first user
      // turn as a resume rather than a new session start. This makes runClaudeTurn
      // use `--resume <sessionId>` instead of `--session-id <sessionId>` so
      // Claude continues the existing conversation context.
      //
      // Exception: if the active-session guard just assigned a fresh UUID (the tab
      // was pointing at the currently running nanocode session via an implicit
      // fallback), do NOT inherit hasHistory=true — the fresh UUID has no prior
      // history so --resume would fail. Start fresh with turnCount=0.
      //
      // Explicit sessionId path: skip _activeSessionOverride entirely (it won't
      // be set for explicit sessions), so hasHistory wins and turnCount starts at 1.
      const initialTurnCount = (!_activeSessionOverride && !recoveredSkipped && liveSeed?.hasHistory) ? 1 : 0
      // explicitSessionId=true means the first user turn should use --resume instead of
      // --session-id. This is true when the sessionId came from store metadata (the user
      // explicitly chose a prior session) and also when we successfully auto-recovered
      // history from disk — in both cases we want Claude to continue the existing
      // conversation rather than start a new one. The flag is consumed by the fallback
      // paths, which clear it when --resume fails so the retry does not loop.
      const diskRecovered = recoveredEvents.length > 0 && !_activeSessionOverride && !recoveredSkipped
      const resolvedExplicit = explicitSessionId && claudeSessionId === storedSessionId && !_activeSessionOverride && !recoveredSkipped
      cs = {
        sessionKey,
        claudeSessionId,
        clients: new Set(),
        history: recoveredEvents.slice(-500),
        busy: false,
        turnCount: initialTurnCount,
        // Carries the "try --resume on first turn" flag (store-chosen or disk-recovered).
        // Reset to false by fallback paths once --resume has been attempted.
        explicitSessionId: resolvedExplicit || diskRecovered,
        // 需求3: tab opened via "开启新对话" — forces a truly-new --session-id first
        // turn (Layer 3) instead of --resume on the not-yet-existing jsonl.
        skipAutoResume: !!tab?.skipAutoResume,
        // 需求5: cross-team resume stores the session's owning team (CLAUDE_CONFIG_DIR)
        // on the tab; carry it on cs so buildClaudeChildEnv spawns claude under that
        // team. cwd follows the session's original cwd (tab.claudeSessionCwd) so
        // claude --resume finds the jsonl in the matching project-slug dir and keeps
        // the conversation's file context — falling back to the project cwd.
        claudeConfigDir: tab?.claudeConfigDir || null,
        // team-failover opt-in (secretary sessions only; default off; inherited by
        // child tabs). When true, a 429 triggers switch-team + copy transcript +
        // resume on the other org's quota. See terminal/team-failover.js.
        allowTeamFailover: !!tab?.allowTeamFailover,
        cwd: (tab?.claudeSessionCwd && typeof tab.claudeSessionCwd === 'string' && tab.claudeSessionCwd.trim()) ? tab.claudeSessionCwd.trim() : project.cwd,
        currentProc: null,
        tabLabel: tab?.label || '',
        // 需求8: persona chosen at new-session creation. Resolved to its
        // instruction text once at attach, FRAMED so it can override a strong
        // CLAUDE.md personality (e.g. catgirl), and carried on cs so every driver
        // injects it via --append-system-prompt / appendSystemPrompt each turn
        // (keeps the persona active across reconnects/resumes).
        persona: tab?.persona || null,
        personaPrompt: tab?.persona ? framePersonaPrompt(resolvePersonaPrompt(home, tab.persona)) : '',
        queue: [],
        pendingUserDialogs: new Map(),
        _replayUserTextCounts: liveSeed?.userTextCounts || seed?.userTextCounts || new Map(),
      }
      replaySeeds.delete(sessionKey)
      claudeSessions.set(sessionKey, cs)
    }

    // ── Session singleton lock ──────────────────────────────────────────────
    // Prevent two nanocode servers from simultaneously owning the same Claude
    // conversation. The first to acquire the lock becomes the host; the other
    // enters read-only follow mode (can see output, cannot send input).
    // The lock is released when the last client on this server disconnects,
    // so a read-only server can promote on its next attach.
    if (!cs._lockHeld) {
      const lockOpts = { pid: process.pid, port }
      const result = acquireSessionLock(cs.claudeSessionId, lockOpts, home)
      if (result.acquired) {
        cs._lockHeld = true
        if (cs.readOnly) {
          cs.readOnly = false
          cs.lockHolder = null
          cs._justPromoted = true
          console.log(`[claude:lock] ${sessionKey}: promoted to host for session ${cs.claudeSessionId}`)
        }
      } else {
        cs.readOnly = true
        cs.lockHolder = result.holder
        cs._lockHeld = false
        console.warn(
          `[claude:lock] ${sessionKey}: session ${cs.claudeSessionId} is hosted by ` +
          `:${result.holder?.port} (pid ${result.holder?.pid}). Read-only mode.`
        )
      }
    }

    for (const event of cs.history) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'claude-event', event })) } catch {}
      }
    }

    // Send the authoritative busy state so newly-attached (or re-attached) clients
    // can correct their local thinking-state flag. Without this, a client that
    // reconnects after a turn completed while it was offline has no way to learn
    // that the session is idle — its isClaudeThinking stays stuck at true and the
    // input box is permanently locked (the "desktop can't send" bug).
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'busy-state', busy: !!cs.busy })) } catch {}
    }

    // Read-only banner: if another server owns this session, tell the client.
    if (cs.readOnly && ws.readyState === 1) {
      const holderPort = cs.lockHolder?.port
      const bannerEvent = {
        type: 'system',
        subtype: 'info',
        text: `会话由 :${holderPort} 托管（只读模式）`,
        _readonly: true,
        _lockHolderPort: holderPort,
      }
      try { ws.send(JSON.stringify({ type: 'claude-event', event: bannerEvent })) } catch {}
    }

    cs.clients.add(ws)

    // If we just promoted from read-only to host, tell all clients to clear
    // the read-only banner. (Not pushed to history — ephemeral UI state.)
    if (cs._justPromoted) {
      cs._justPromoted = false
      const promoteEvent = {
        type: 'system',
        subtype: 'info',
        text: '会话已恢复为可编辑模式',
        _readonly: false,
      }
      const promoteMsg = JSON.stringify({ type: 'claude-event', event: promoteEvent })
      for (const client of cs.clients) {
        if (client.readyState === 1) try { client.send(promoteMsg) } catch {}
      }
    }

    const onMsg = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'claude-dialog-response' && typeof msg.dialogId === 'string') {
        const dialog = cs.pendingUserDialogs?.get(msg.dialogId)
        if (!dialog) return
        const response = {
          behavior: msg.behavior || 'completed',
          result: msg.result || null,
        }
        let accepted = false
        try {
          accepted = dialog.finish(response) !== false
        } catch (err) {
          console.warn(`[claude:dialog] failed to resolve dialog ${msg.dialogId}: ${err?.message}`)
          return
        }
        if (accepted) {
          cs.pendingUserDialogs.delete(msg.dialogId)
          claudeBroadcast(cs, {
            type: 'system',
            subtype: 'ask_user_question_answered',
            dialog_id: msg.dialogId,
            result: msg.result || null,
          })
        }
        return
      }
      if (msg.type === 'claude-input' && typeof msg.text === 'string' && msg.text.trim()) {
        // ── Read-only mode: block input when another server hosts the session ──
        if (cs.readOnly) {
          try { ws.send(JSON.stringify({ type: 'claude-event', event: { type: 'result', subtype: 'success' } })) } catch {}
          try {
            ws.send(JSON.stringify({
              type: 'claude-event',
              event: {
                type: 'system',
                subtype: 'info',
                text: `会话由 :${cs.lockHolder?.port} 托管，无法发送消息（只读模式）`,
                _readonly: true,
              },
            }))
          } catch {}
          return
        }
        // ── /resume interception ─────────────────────────────────────────────
        // claude --print (non-interactive) blocks /resume with "isn't available
        // in this environment". Intercept here and route to nanocode's own
        // session-resume mechanism instead.
        // ── /model interception ──────────────────────────────────────────────
        // claude --print (non-interactive) ignores /model. Intercept here and
        // update the claude_model setting directly so the next turn picks it up.
        if (msg.text.trim().startsWith('/model')) {
          const parts = msg.text.trim().split(/\s+/)
          const doneEvent = { type: 'result', subtype: 'success' }
          try { ws.send(JSON.stringify({ type: 'claude-event', event: doneEvent })) } catch {}
          if (parts.length >= 2) {
            const newModel = parts[1]
            store.setSetting('claude_model', newModel)
            const infoEvent = {
              type: 'system',
              subtype: 'info',
              text: `Model switched to ${newModel}. Takes effect on next message.`,
            }
            try { ws.send(JSON.stringify({ type: 'claude-event', event: infoEvent })) } catch {}
          } else {
            const currentModel = store.getSetting('claude_model') || '(CLI default)'
            const infoEvent = {
              type: 'system',
              subtype: 'info',
              text: `Current model: ${currentModel}\nUsage: /model <model-name>  (e.g. /model claude-fable-5)`,
            }
            try { ws.send(JSON.stringify({ type: 'claude-event', event: infoEvent })) } catch {}
          }
          return
        }
        if (msg.text.trim() === '/resume') {
          // Always send a result event first so the client exits thinking state
          // (sendInputWithEcho set thinking=true; without result the UI stays
          // frozen waiting for a turn that never comes).
          const doneEvent = { type: 'result', subtype: 'success' }
          try { ws.send(JSON.stringify({ type: 'claude-event', event: doneEvent })) } catch {}

          // Use getRecentAgentsCached() (not getCachedEntries()) to guarantee a
          // fresh scan even if primeRecentAgentsCache() hasn't run yet (e.g. the
          // user typed /resume before the history API call completed).
          let cache
          try { cache = recentAgents.getRecentAgentsCached() } catch { cache = [] }
          // Prefer entries matching the current project cwd, fall back to global most-recent
          const projectEntries = cache.filter(e => e.cwd === project.cwd)
          const candidates = projectEntries.length ? projectEntries : cache
          // Skip the session already loaded in this tab so we go "back" to the previous one
          const entry = candidates.find(e => e.sessionId !== cs.claudeSessionId) || candidates[0]
          if (entry && entry.sessionId) {
            // Tell the client to trigger the resume flow (same as clicking in Recent Agents)
            const resumeEvent = {
              type: 'system',
              subtype: 'resume-trigger',
              projectId,
              sessionId: entry.sessionId,
              projectName: entry.projectName || '',
              cwd: entry.cwd || project.cwd,
            }
            try { ws.send(JSON.stringify({ type: 'claude-event', event: resumeEvent })) } catch {}
          } else {
            // No previous session found — show an info message
            const infoEvent = {
              type: 'system',
              subtype: 'info',
              text: 'No previous session found. Start a new conversation to create one.',
            }
            try { ws.send(JSON.stringify({ type: 'claude-event', event: infoEvent })) } catch {}
          }
          return
        }
        const userEvent = {
          type: 'user',
          uuid: randomUUID(),
          replay_id: buildUserReplayId(msg.text, cs._replayUserTextCounts),
          message: { role: 'user', content: [{ type: 'text', text: msg.text }] },
          _nonce: msg._nonce || null,
        }
        claudeBroadcast(cs, userEvent)
        // "send now": suppress the "Message queued" banner if this lands while a
        // turn is still winding down — it's about to be flushed by the interrupt.
        if (msg._sendNow === true) cs._quietQueueOnce = true
        // ── Atomic "send now" (立刻发送) ──────────────────────────────────────
        // Fold "enqueue + interrupt + flush" into ONE atomic step here so the
        // backend never depends on a separate HTTP /interrupt from the client
        // (which raced the WS dispatch and could kill the just-started turn on
        // idle, losing the message). Capture the busy state BEFORE dispatching:
        //   busy → dispatch queues synchronously, then interrupt the running
        //          turn with andFlush so the queued message flushes as the next
        //          turn (force, but SDK remaps to q.interrupt() — never kills the
        //          process or sub-agents, red line).
        //   idle → dispatch starts the send-now message itself; do NOT interrupt
        //          (interrupting would kill the user's message).
        const wasBusy = msg._sendNow === true && cs.busy && !!cs.currentProc
        dispatchClaudeTurn(cs, msg.text, sessionKey, project.cwd)
        if (wasBusy) {
          try {
            Promise.resolve(_interruptRunningClaudeTurn(cs, { force: true, andFlush: true })).catch((err) => {
              console.error(`[claude:send-now] ${sessionKey}: atomic interrupt failed:`, err?.message || err)
            })
          } catch (err) {
            console.error(`[claude:send-now] ${sessionKey}: atomic interrupt failed:`, err?.message || err)
          }
        }
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', id: msg.id })) } catch {}
      }
    }

    ws.on('message', onMsg)
    ws.on('close', () => {
      ws.removeListener('message', onMsg)
      cs.clients.delete(ws)
      // Release the session singleton lock when the last client disconnects,
      // so another server can promote from read-only to host.
      if (cs.clients.size === 0 && cs._lockHeld) {
        releaseSessionLock(cs.claudeSessionId, { pid: process.pid, port }, home)
        cs._lockHeld = false
      }
    })
  }

  function attachCodexSession(ws, { projectId, tabId, project }) {
    const sessionKey = codexSessionKeyFor(projectId, tabId)
    let cs = codexSessions.get(sessionKey)

    if (!cs) {
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      cs = {
        sessionKey,
        codexThreadId: tab?.codexThreadId || null,
        clients: new Set(),
        scrollback: '',
        eventHistory: [],
        busy: false,
        turnCount: 0,
        cwd: project.cwd,
        currentProc: null,
        queue: [],
        inputBuffer: '',
      }
      codexSessions.set(sessionKey, cs)
    }

    if (cs.scrollback && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'history', data: cs.scrollback })) } catch {}
    }
    for (const event of cs.eventHistory) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'codex-event', event })) } catch {}
      }
    }

    cs.clients.add(ws)

    const flushCodexInput = (buffer) => {
      const text = buffer.trim()
      if (!text) return
      appendCodexScrollback(cs, `› ${text}\n`)
      dispatchCodexTurn(cs, text, sessionKey, project.cwd)
    }

    const onMsg = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.type === 'input' && typeof msg.data === 'string') {
        const data = msg.data
        if (data === '\x03') {
          if (cs.busy && cs.currentProc) {
            try {
              cs.currentProc._nanocodeInterrupted = true
              cs.currentProc.kill('SIGINT')
            } catch {}
          }
          return
        }
        if (data === '\x0c') {
          cs.scrollback = ''
          codexBroadcast(cs, '\x1b[2J\x1b[H')
          return
        }

        cs.inputBuffer += data
        const segments = cs.inputBuffer.split('\r')
        cs.inputBuffer = segments.pop() || ''
        for (const segment of segments) {
          flushCodexInput(segment)
        }
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', id: msg.id })) } catch {}
      }
    }

    ws.on('message', onMsg)
    ws.on('close', () => {
      ws.removeListener('message', onMsg)
      cs.clients.delete(ws)
    })
  }

  // ── opencode block-mode attach (Fable5/opencode tabs, Block render) ─────────
  // 需求11-C: mirrors attachCodexSession but uses claudeBroadcast (claude-event
  // WS msgs) so the frontend ClaudeBlockRenderer renders opencode turns. The
  // per-turn subprocess is driven by opencodeBlockDriver.runOpencodeTurn.
  function opencodeBlockSessionKeyFor(projectId, tabId) {
    return `${projectId}:opencode-block:${tabId}`
  }

  function attachOpencodeBlockSession(ws, { projectId, tabId, project }) {
    const sessionKey = opencodeBlockSessionKeyFor(projectId, tabId)
    let cs = opencodeBlockSessions.get(sessionKey)
    if (!cs) {
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      cs = {
        sessionKey,
        opencodeSessionId: tab?.opencodeSessionId || null,
        clients: new Set(),
        history: [],
        busy: false,
        turnCount: 0,
        cwd: project.cwd,
        currentProc: null,
        queue: [],
        // 需求15 item5: persona chosen at new-session creation (需求8), resolved
        // + framed once at attach with the SAME helper as claude. The opencode
        // block driver has no --append-system-prompt flag, so it prepends this
        // framed instruction to the user prompt every turn — keeping the persona
        // active across reconnects/resumes (mirrors claude's per-turn re-inject).
        persona: tab?.persona || null,
        personaPrompt: tab?.persona ? framePersonaPrompt(resolvePersonaPrompt(home, tab.persona)) : '',
      }
      opencodeBlockSessions.set(sessionKey, cs)
    }

    // Replay history to the newly-attached client (claude-event WS msgs).
    for (const event of cs.history) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'claude-event', event })) } catch {}
      }
    }

    // Busy-state sync (same fix as claude sessions — prevents stuck input on reconnect)
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'busy-state', busy: !!cs.busy })) } catch {}
    }

    cs.clients.add(ws)

    const onMsg = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'claude-input' && typeof msg.text === 'string' && msg.text.trim()) {
        // 块B修复 (r2-settings-ia): 不在 controller 侧 echo user 消息 — 原先
        // claudeBroadcast(userEvent) 与 driver echo 双重 echo + 丢 nonce → live 渲染 3 份。
        // 只保留 driver echo 并透传 nonce，客户端 nonce 去重 = 1 份。
        // + queuefix: 原子 "send now" (立刻发送)。dispatch 前捕获 busy 状态：
        //   busy → dispatch 入队，随即 interrupt 当前回合 + _forceFlushQueue 让排队消息作为下一回合发出；
        //   idle → dispatch 直接起该消息，不 interrupt（否则会杀掉用户自己的消息）。
        //   消除 WS-vs-HTTP race，客户端不再单发 interrupt。
        const wasBusy = msg._sendNow === true && cs.busy && !!cs.currentProc
        dispatchOpencodeBlockTurn(cs, msg.text, sessionKey, project.cwd, { nonce: msg._nonce || null })
        if (wasBusy) {
          try {
            cs._forceFlushQueue = true
            cs.currentProc._nanocodeInterrupted = true
            cs.currentProc.kill('SIGINT')
          } catch (err) {
            console.error(`[opencode:block:send-now] ${sessionKey}: atomic interrupt failed:`, err?.message || err)
          }
        }
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', id: msg.id })) } catch {}
      }
    }
    ws.on('message', onMsg)
    ws.on('close', () => {
      ws.removeListener('message', onMsg)
      cs.clients.delete(ws)
    })
  }

  dispatchOpencodeBlockTurn = function dispatchOpencodeBlockTurn(cs, text, sessionKey, cwd, opts) {
    opencodeBlockDriver.runOpencodeTurn(cs, text, sessionKey, cwd, opts)
  }

  // Interrupt the running claude turn for session `cs`. Pure helper (no HTTP)
  // shared by the HTTP /interrupt route and the WS "send now" atomic flush.
  // On andFlush, sets cs._forceFlushQueue so the driver's finally block drains
  // the queue as the next turn regardless of auto_flush_queue_on_interrupt.
  // Force on the SDK streaming path is remapped to q.interrupt() + watchdog
  // (never kills the claude process or sub-agents — red line). Returns a result
  // object; the tmux path returns a Promise resolving to the same shape.
  // Preserves the wedge-unwind (busy=true, currentProc=null) defense-in-depth.
  function _interruptRunningClaudeTurn(cs, { force = false, andFlush = false } = {}) {
    const sessionKey = cs?.sessionKey || ''
    if (andFlush) cs._forceFlushQueue = true
    if (!cs.busy || !cs.currentProc) {
      if (force && cs.busy) {
        console.warn(`[claude:interrupt] ${sessionKey}: force-unwedge (busy=true, currentProc=null); settling turn locally, process untouched`)
        cs.busy = false
        cs.currentProc = null
        // The archived p1p5-plugin-host line emitted a plugin agent:stop event
        // here via _emitAgentStop; that helper does not exist on this lineage
        // (merge 66867e5 strategy=ours) and the orphan call broke this unwedge
        // path with a ReferenceError. Re-add only together with a pluginHost.
        claudeBroadcast(cs, { type: 'result', subtype: 'error_during_execution' })
        if (!Array.isArray(cs.queue)) cs.queue = []
        const drained = cs.queue.splice(0)
        cs._forceFlushQueue = false
        if (drained.length > 0) {
          const combinedText = drained.join('\n\n')
          console.log(`[claude:interrupt] ${sessionKey}: draining ${drained.length} stranded queued message(s) as a fresh turn`)
          setImmediate(() => dispatchClaudeTurn(cs, combinedText, sessionKey, cs.cwd))
        }
        return { ok: true, force: true, unwedged: true, andFlush }
      }
      return { ok: false, reason: 'not busy', andFlush }
    }
    if (cs.claudeDriver === 'tmux') {
      return tmuxDriver.interrupt(cs, force)
        .then(() => ({ ok: true, force: !!force, andFlush }))
        .catch((err) => { throw err })
    }
    try {
      cs.currentProc._nanocodeInterrupted = true
      // force → SIGKILL. In SDK streaming mode this is remapped to a guaranteed
      // turn-unlock that keeps the process (and sub-agents) alive; it does NOT
      // kill the claude process. soft → SIGINT (q.interrupt()).
      cs.currentProc.kill(force ? 'SIGKILL' : 'SIGINT')
      return { ok: true, force: !!force, andFlush }
    } catch (err) {
      throw err
    }
  }

  function handleInterrupt(req, res) {
    const sessionKey = sessionKeyFor(req.params.id, req.params.tabId)
    const cs = claudeSessions.get(sessionKey)
    if (!cs) {
      // 需求15 keystone (item3): opencode block-mode (Fable5/opencode Block tabs).
      // The opencode block driver runs each turn as a subprocess with a
      // makeInterruptHandle() on cs.currentProc (.kill(SIGINT) + _nanocodeInterrupted
      // flag). Key format is distinct from claude/codex so there is no collision.
      const openKey = opencodeBlockSessionKeyFor(req.params.id, req.params.tabId)
      const openCs = opencodeBlockSessions.get(openKey)
      if (openCs) {
        if (!openCs.busy || !openCs.currentProc) return res.json({ ok: false, reason: 'not busy' })
        try {
          // 需求15 item2: honour andFlush (set by the client "send now" flush) so
          // the opencode driver's exit handler force-flushes the in-memory queue
          // as the next turn regardless of the auto_flush_queue_on_interrupt setting
          // — mirrors the claude path (cs._forceFlushQueue, controller line ~1274).
          const andFlush = req.query.flush === '1' || req.body?.andFlush === true
          if (andFlush) openCs._forceFlushQueue = true
          openCs.currentProc._nanocodeInterrupted = true
          openCs.currentProc.kill('SIGINT')
          return res.json({ ok: true, force: false, andFlush })
        } catch (err) {
          return res.status(500).json({ error: err.message })
        }
      }
      const codexSessionKey = codexSessionKeyFor(req.params.id, req.params.tabId)
      const codexSession = codexSessions.get(codexSessionKey)
      if (!codexSession) return res.status(404).json({ error: 'no claude, opencode, or codex session' })
      if (!codexSession.busy || !codexSession.currentProc) return res.json({ ok: false, reason: 'not busy' })
      try {
        codexSession.currentProc._nanocodeInterrupted = true
        codexSession.currentProc.kill('SIGINT')
        return res.json({ ok: true, force: false })
      } catch (err) {
        return res.status(500).json({ error: err.message })
      }
    }
    // andFlush=true (set by "send now"): guarantee any queued message flushes
    // after this interrupt, regardless of the auto_flush_queue_on_interrupt
    // setting, so the user's message is never silently dropped.
    const andFlush = req.query.flush === '1' || req.body?.andFlush === true
    const force = req.query.force === '1' || req.body?.force === true
    Promise.resolve(_interruptRunningClaudeTurn(cs, { force, andFlush })).then(
      (result) => res.json(result),
      (err) => res.status(500).json({ error: err.message })
    )
  }

  function handleReset(req, res) {
    const sessionKey = sessionKeyFor(req.params.id, req.params.tabId)
    const cs = claudeSessions.get(sessionKey)
    if (!cs) return res.status(404).json({ error: 'no claude session' })

    if (cs.currentProc) {
      try { cs.currentProc.kill('SIGKILL') } catch {}
      cs.currentProc = null
    }

    if (cs.claudeDriver === 'tmux') {
      const oldSessionId = cs.claudeSessionId
      const newSessionId = randomUUID()
      const discarded = (cs.queue || []).length
      cs.busy = false
      cs.queue = []
      cs._conflictRetries = 0
      cs._forceFlushQueue = false
      cs._quietQueueOnce = false
      cs.claudeSessionId = newSessionId
      cs.turnCount = 0
      tmuxDriver.reset(cs, newSessionId).catch((err) => {
        console.error(`[claude:reset:tmux] ${sessionKey} error:`, err?.message || err)
      })
      if (store.updateTabMetadata) {
        store.updateTabMetadata(req.params.id, req.params.tabId, { claudeSessionId: newSessionId })
      }
      const doneEvent = { type: 'result', subtype: 'success' }
      claudeBroadcast(cs, doneEvent)
      const infoEvent = {
        type: 'system', subtype: 'info',
        text: `Session reset. ${discarded} queued message${discarded !== 1 ? 's' : ''} discarded. New session started.`,
      }
      claudeBroadcast(cs, infoEvent)
      console.log(`[claude:reset:tmux] ${sessionKey}: busy cleared, ${discarded} queued msgs discarded, session ${oldSessionId} -> ${newSessionId}`)
      return res.json({ ok: true, discarded, oldSessionId, newSessionId })
    }

    // Reset means "new session" — fully tear down the persistent streaming
    // session so the next turn rebuilds with the fresh sessionId/context.
    // (A plain interrupt never does this; reset is the deliberate destructive
    // action, so closing the claude process here is expected.)
    if (cs._streamingSession) {
      try { cs._streamingSession.close() } catch {}
      cs._streamingSession = null
    }

    const discarded = (cs.queue || []).length
    cs.busy = false
    cs.queue = []
    cs._conflictRetries = 0
    cs._forceFlushQueue = false
    cs._quietQueueOnce = false

    const oldSessionId = cs.claudeSessionId
    const newSessionId = randomUUID()
    cs.claudeSessionId = newSessionId
    cs.turnCount = 0
    if (store.updateTabMetadata) {
      store.updateTabMetadata(req.params.id, req.params.tabId, { claudeSessionId: newSessionId })
    }

    const doneEvent = { type: 'result', subtype: 'success' }
    claudeBroadcast(cs, doneEvent)
    const infoEvent = {
      type: 'system', subtype: 'info',
      text: `Session reset. ${discarded} queued message${discarded !== 1 ? 's' : ''} discarded. New session started.`,
    }
    claudeBroadcast(cs, infoEvent)

    console.log(`[claude:reset] ${sessionKey}: busy cleared, ${discarded} queued msgs discarded, session ${oldSessionId} -> ${newSessionId}`)
    res.json({ ok: true, discarded, oldSessionId, newSessionId })
  }

  function handleTerminalWs(ws) {
    const once = (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type !== 'attach') return

      const { projectId, sessionType, cols, rows } = msg
      const tabId = msg.tabId || randomUUID().slice(0, 8)
      if (!projectId || sessionType !== 'bash') return

      const project = store.getProject(projectId)
      if (!project) {
        ws.send(JSON.stringify({ type: 'error', error: 'project not found' }))
        return
      }

      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      // Resolve the tab type. Normally the stored tab metadata wins. But when the
      // stored tab is MISSING (e.g. it was deleted/renamed/deduped while the
      // browser still has it open, or store/UI drifted), `tab?.type` is undefined
      // and we used to silently fall back to 'bash'. That routed an open claude/
      // codex tab to a raw bash PTY which ignores `claude-input`/`codex-input`
      // messages entirely → the user types in the box and the agent never sees it.
      // To survive that drift, honor the client-provided `tabType` hint (the
      // ClaudeBlockRenderer / CodexBlockRenderer know their own kind) when there is
      // no stored tab. Stored metadata still takes precedence when present.
      const clientTabTypeHint =
        msg.tabType === 'claude' || msg.tabType === 'codex' || msg.tabType === 'bash' ||
        msg.tabType === 'fable5' || msg.tabType === 'opencode'
          ? msg.tabType
          : null
      const tabType = tab?.type || clientTabTypeHint || 'bash'
      if (!tab && clientTabTypeHint && clientTabTypeHint !== 'bash') {
        console.warn(`[ws:attach] tabId=${tabId} not found in store; honoring client tabType hint='${clientTabTypeHint}' (would have wrongly defaulted to bash and dropped input)`)
      }
      console.log(`[ws:attach] projectId=${projectId} tabId=${tabId} tabType=${tabType}`)

      if (tabType === 'claude') {
        // Server default MUST match the client default (state.js: 'block').
        // If they diverge, the browser opens a TerminalPane (PTY-protocol JSON
        // frames) but the server routes the WS to attachClaudeSession (stream-json
        // events) — protocol mismatch → tab looks "stuck" with both ends alive.
        const renderMode = store.getSetting('renderMode') || 'block'
        if (renderMode === 'terminal') {
          console.log(`[ws:attach] routing claude to PTY raw (renderMode=terminal)`)
        } else {
          console.log(`[ws:attach] routing to claude stream-json bridge`)
          attachClaudeSession(ws, { projectId, tabId, project })
          return
        }
      }

      // 需求11-C: Fable5 / opencode tabs — Block render mode (default) uses the
      // opencode block driver (rich blocks via ClaudeBlockRenderer). TUI mode
      // (fable5RenderMode/opencodeRenderMode='terminal') falls through to the
      // PTY launcher below, preserving the original raw-opencode TUI behaviour.
      if (tabType === 'fable5' || tabType === 'opencode') {
        const ocRenderMode = store.getSetting(tabType === 'fable5' ? 'fable5RenderMode' : 'opencodeRenderMode') || 'block'
        if (ocRenderMode === 'block') {
          console.log(`[ws:attach] routing ${tabType} to opencode block bridge (renderMode=block)`)
          attachOpencodeBlockSession(ws, { projectId, tabId, project })
          return
        }
        console.log(`[ws:attach] routing ${tabType} to PTY raw (renderMode=terminal)`)
      }

      if (tabType === 'codex' && !project.ssh_host && getCodexDriver() === 'sdk') {
        console.log('[ws:attach] routing codex to sdk bridge')
        attachCodexSession(ws, { projectId, tabId, project })
        return
      }

      const sessionKey = `${projectId}:bash:${tabId}`
      const isRemote = !!project.ssh_host
      let command
      let args
      let cwd

      if (tabType === 'tmux') {
        const tmuxTarget = tab?.tmuxTarget
        if (!tmuxTarget) {
          ws.send(JSON.stringify({ type: 'error', error: 'tmux tab has no tmuxTarget' }))
          return
        }
        command = 'bash'
        args = ['-lc', `tmux attach-session -t ${sq(tmuxTarget)} 2>/dev/null || tmux new-session -t ${sq(tmuxTarget)} 2>/dev/null; exec bash -l`]
        cwd = home
      } else {
        const launcherFn = TAB_LAUNCHERS[tabType] || TAB_LAUNCHERS.bash
        const launchCmd = launcherFn()

        if (isRemote) {
          command = SSH
          args = buildSshArgs(project, `cd ${sq(project.cwd)} && ${launchCmd}`)
          cwd = home
        } else if (tabType === 'bash') {
          command = SHELL
          args = IS_WIN ? [] : ['--login']
          cwd = project.cwd
        } else {
          command = 'bash'
          args = ['-lc', launchCmd]
          cwd = project.cwd
        }
      }

      const scrollbackDir = process.env.NANOCODE_SCROLLBACK_DIR
        || (process.env.HOME ? `${process.env.HOME}/.nanocode/scrollback` : null)
      const scrollbackPath = scrollbackDir
        ? `${scrollbackDir}/${projectId}__${tabId}.bin`
        : undefined

      const existingSession = sessions.get(sessionKey)
      const session = sessions.getOrCreate(
        sessionKey,
        command,
        args,
        Math.max(1, cols || 80),
        Math.max(1, rows || 24),
        cwd,
        scrollbackPath
      )
      if (tabType === 'codex') {
        session.enableCodexAutoSkip()
      }
      // Host-side stuck detection: feed PTY-based agent tabs (claude/codex/agent/
      // opencode/meshy-aigw) into the agent-health monitor so idle/stuck states
      // are detected and broadcast as agent_health events even when running in
      // PTY/terminal mode instead of the SDK bridge.
      if (!existingSession && tabType !== 'bash' && _agentHealthMonitor) {
        const healthMeta = {
          sessionKey,
          projectId,
          tabId,
          tabType,
          provider: tabType,
          source: 'pty',
        }
        _agentHealthMonitor.startTracking(healthMeta)
        session.onOutput((text) => {
          try { _agentHealthMonitor.recordOutput(healthMeta, text) } catch {}
        })
        session.onExit(() => {
          try {
            _agentHealthMonitor.finishTracking(sessionKey, { state: 'stopped', reason: 'shell_exited' })
          } catch {}
        })
        session.onDestroy(() => {
          try {
            _agentHealthMonitor.finishTracking(sessionKey, { state: 'stopped', reason: 'session_destroyed' })
          } catch {}
        })
      }
      session.attach(ws, Math.max(1, cols || 80), Math.max(1, rows || 24))
    }

    ws.once('message', once)
  }

  // Server-shutdown teardown: kill every in-process SDK streaming session so
  // their child-process handles release and the process can exit. This is the
  // ONLY safe place to call teardownStreamingSession for a live tab — ws.close
  // deliberately does NOT do this so a browser reload (WS drop + reconnect)
  // keeps the session alive (reload-survives). The tmux bridge is a separate
  // process by design and is unaffected (tmux-routed cs have no _streamingSession).
  function disposeClaudeSessions() {
    for (const cs of claudeSessions.values()) {
      try { sdkDriver.teardownStreamingSession(cs) } catch {}
      // Release the session singleton lock on shutdown.
      if (cs._lockHeld) {
        try { releaseSessionLock(cs.claudeSessionId, { pid: process.pid, port }, home) } catch {}
      }
    }
    claudeSessions.clear()
  }

  return {
    setAllowTeamFailover,
    switchTeam,
    claudeSessions,
    codexSessions,
    handleInterrupt,
    handleReset,
    handleTerminalWs,
    primeReplayHistory,
    setAgentHealthMonitor,
    setClaudeSessionId,
    disposeClaudeSessions,
    injectClaudeMessage,
  }
}
