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

export function createClaudeSessionController({ store, home, recentAgents }) {
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
    'meshy-aigw': () => {
      const keyFile = join(home || process.env.HOME, '.config', 'meshy-aigw.key')
      const keyExists = existsSync(keyFile)
      if (keyExists) {
        // Read key at launch time so the PTY env has it
        return `export MESHY_AIGW_KEY=$(cat ${keyFile}); opencode .; exec bash -l`
      }
      // Fallback: assume MESHY_AIGW_KEY already in env
      return 'opencode .; exec bash -l'
    },
    // fable5: opencode with Claude Fable 5 (litellm/claude-fable-5) via Meshy AIGW.
    // The kimi provider in the global opencode.json already has the AIGW baseURL +
    // apiKey, but only registers GLM/Kimi/gpt-5.5 models — claude-fable-5 is not
    // registered, so opencode rejects it with ProviderModelNotFoundError.
    // OPENCODE_CONFIG_CONTENT is an inline runtime override (merged, not replacing)
    // that adds litellm/claude-fable-5 to the kimi provider, reusing its AIGW baseURL.
    'fable5': () => {
      const keyFile = join(home || process.env.HOME, '.config', 'meshy-aigw.key')
      const cfg = '{"$schema":"https://opencode.ai/config.json","provider":{"kimi":{"models":{"litellm/claude-fable-5":{"name":"Claude Fable 5"}}}}}'
      const launch = `export OPENCODE_CONFIG_CONTENT='${cfg}'; opencode -m kimi/litellm/claude-fable-5 .; exec bash -l`
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
    claudeBroadcast,
    rerunTurn: (...args) => dispatchClaudeTurn(...args),
    runCliFallback: (...args) => runClaudeCliTurn(...args),
    onClaudeSpawn: ({ sessionKey, pid, proxy }) => {
      if (_agentHealthMonitor && sessionKey && Number.isFinite(pid)) {
        try {
          _agentHealthMonitor.registerMainProcess(sessionKey, pid, proxy)
        } catch {}
      }
    },
  })
  const tmuxDriver = createClaudeTmuxDriver({
    store,
    claudeBroadcast,
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

  function buildClaudeChildEnv() {
    const STRIP_KEYS = new Set([
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_TMPDIR',
      'AI_AGENT',
    ])
    const env = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!STRIP_KEYS.has(k)) env[k] = v
    }
    return env
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
    if (tabLabel) launchArgs.push('--name', tabLabel)

    launchArgs.push('--')
    launchArgs.push(userText)

    const escapedArgs = launchArgs.map((a) => sq(a))
    const launchCmd = `exec claude ${escapedArgs.join(' ')}`

    console.log(`[claude:continue-fallback:spawn] sessionKey=${sessionKey}`)
    const proc = spawn('bash', ['-lc', launchCmd], {
      cwd,
      env: buildClaudeChildEnv(),
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
    if (tabLabel) launchArgs.push('--name', tabLabel)

    launchArgs.push(sessionArg)
    launchArgs.push('--')
    launchArgs.push(userText)
    const escapedArgs = launchArgs.map((a) => sq(a))
    const launchCmd = `exec claude ${escapedArgs.join(' ')}`

    console.log(`[claude:spawn] sessionKey=${sessionKey} turn=${cs.turnCount} len=${userText.length}`)
    const proc = spawn('bash', ['-lc', launchCmd], {
      cwd,
      env: buildClaudeChildEnv(),
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

  function attachClaudeSession(ws, { projectId, tabId, project }) {
    const sessionKey = sessionKeyFor(projectId, tabId)
    let cs = claudeSessions.get(sessionKey)

    if (!cs) {
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      // Track whether the sessionId came from store metadata (user-chosen, explicit)
      // vs was generated fresh because the tab had no stored session (implicit/new tab).
      const storedSessionId = tab?.claudeSessionId || null
      const explicitSessionId = storedSessionId !== null
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
        cwd: project.cwd,
        currentProc: null,
        tabLabel: tab?.label || '',
        queue: [],
        pendingUserDialogs: new Map(),
        _replayUserTextCounts: liveSeed?.userTextCounts || seed?.userTextCounts || new Map(),
      }
      replaySeeds.delete(sessionKey)
      claudeSessions.set(sessionKey, cs)
    }

    for (const event of cs.history) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'claude-event', event })) } catch {}
      }
    }

    cs.clients.add(ws)

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
        dispatchClaudeTurn(cs, msg.text, sessionKey, project.cwd)
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

  function handleInterrupt(req, res) {
    const sessionKey = sessionKeyFor(req.params.id, req.params.tabId)
    const cs = claudeSessions.get(sessionKey)
    if (!cs) {
      const codexSessionKey = codexSessionKeyFor(req.params.id, req.params.tabId)
      const codexSession = codexSessions.get(codexSessionKey)
      if (!codexSession) return res.status(404).json({ error: 'no claude or codex session' })
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
    if (andFlush) cs._forceFlushQueue = true
    if (!cs.busy || !cs.currentProc) {
      // Nothing running to interrupt. If a flush was requested and something is
      // queued server-side, there is no turn whose exit will drain it — but the
      // normal not-busy dispatch path will pick it up, so this is a no-op here.
      return res.json({ ok: false, reason: 'not busy', andFlush })
    }
    const force = req.query.force === '1' || req.body?.force === true
    try {
      if (cs.claudeDriver === 'tmux') {
        tmuxDriver.interrupt(cs, force).then(() => {
          res.json({ ok: true, force: !!force, andFlush })
        }).catch((err) => {
          res.status(500).json({ error: err.message })
        })
        return
      }
      cs.currentProc._nanocodeInterrupted = true
      // force → SIGKILL. In SDK streaming mode this is remapped to a guaranteed
      // turn-unlock that keeps the process (and sub-agents) alive; it does NOT
      // kill the claude process. soft → SIGINT (q.interrupt()).
      cs.currentProc.kill(force ? 'SIGKILL' : 'SIGINT')
      res.json({ ok: true, force: !!force, andFlush })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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
        msg.tabType === 'claude' || msg.tabType === 'codex' || msg.tabType === 'bash'
          ? msg.tabType
          : null
      const tabType = tab?.type || clientTabTypeHint || 'bash'
      if (!tab && clientTabTypeHint && clientTabTypeHint !== 'bash') {
        console.warn(`[ws:attach] tabId=${tabId} not found in store; honoring client tabType hint='${clientTabTypeHint}' (would have wrongly defaulted to bash and dropped input)`)
      }
      console.log(`[ws:attach] projectId=${projectId} tabId=${tabId} tabType=${tabType}`)

      if (tabType === 'claude') {
        const renderMode = store.getSetting('renderMode') || 'block'
        if (renderMode === 'terminal') {
          console.log(`[ws:attach] routing claude to PTY raw (renderMode=terminal)`)
        } else {
          console.log(`[ws:attach] routing to claude stream-json bridge`)
          attachClaudeSession(ws, { projectId, tabId, project })
          return
        }
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

  return {
    claudeSessions,
    codexSessions,
    handleInterrupt,
    handleReset,
    handleTerminalWs,
    primeReplayHistory,
    setAgentHealthMonitor,
    setClaudeSessionId,
  }
}
