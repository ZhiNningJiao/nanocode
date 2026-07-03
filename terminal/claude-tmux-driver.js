/**
 * claude-tmux-driver.js
 *
 * Nanocode driver that forwards Claude block-mode messages to a persistent
 * tmux-backed SDK bridge process.  The bridge is launched once per tab and
 * kept alive across nanocode restarts via a named tmux session.
 *
 * The bridge owns the actual Claude SDK streaming session, so a single Claude
 * OS process survives nanocode reloads / crashes / idle reconnects.
 */

import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveClaudeConfigDir } from './claude-env.js'

const TMUX_BIN = process.env.NANOCODE_TMUX_BIN || '/usr/bin/tmux'
const SOCKET_DIR = `${process.env.HOME}/.nanocode/tmux-sessions`
const BRIDGE_SCRIPT = new URL('./claude-tmux-bridge.mjs', import.meta.url).pathname

// Idle-watchdog backstop for an in-flight turn. The deadline resets on every
// live event from the bridge, so a long but healthy turn is never killed — it
// only fires when the bridge goes completely silent (crash with no socket
// close, hung child, etc.). Generous default because legitimate tool turns can
// idle (e.g. waiting on a long subprocess) between streamed events.
const TURN_IDLE_TIMEOUT_MS = Number(process.env.NANOCODE_TMUX_TURN_IDLE_MS) || 10 * 60 * 1000

function getClaudeCodeExecutableOverride() {
  const value = process.env.NANOCODE_CLAUDE_CODE_EXECUTABLE
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function sanitizeSessionKey(key) {
  return String(key || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)
}

function getTmuxName(sessionKey) {
  return `nanocode-${sanitizeSessionKey(sessionKey)}`
}

function getSocketPath(sessionKey) {
  return `${SOCKET_DIR}/${sanitizeSessionKey(sessionKey)}.sock`
}

function getSessionIdPath(sessionKey) {
  return `${SOCKET_DIR}/${sanitizeSessionKey(sessionKey)}.sessionId`
}

function ensureSocketDir() {
  mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 })
}

function tmuxSessionExists(name) {
  try {
    const r = spawnSync(TMUX_BIN, ['has-session', '-t', name], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

function isTmuxAvailable() {
  try {
    const r = spawnSync(TMUX_BIN, ['-V'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

function writeSessionIdFile(sessionKey, sessionId) {
  try {
    writeFileSync(getSessionIdPath(sessionKey), sessionId, { mode: 0o600 })
  } catch {}
}

function readSessionIdFile(sessionKey) {
  try {
    return readFileSync(getSessionIdPath(sessionKey), 'utf8').trim()
  } catch {
    return null
  }
}

function formatArg(key, value) {
  return [key, String(value)]
}

function resolvePermissionMode(store) {
  const globalPerm = store.getSetting('global_permission')
  if (globalPerm === 'auto-edits') return 'acceptEdits'
  if (globalPerm === 'ask') return 'default'
  if (globalPerm === 'full-auto') return 'bypassPermissions'

  const legacy = store.getSetting('claude_permission_mode')
  if (legacy === 'accept-edits') return 'acceptEdits'
  if (legacy === 'auto') return 'auto'
  if (legacy === 'default' || legacy === 'ask') return 'default'

  return 'bypassPermissions'
}

function launchBridge(sessionKey, opts) {
  const name = getTmuxName(sessionKey)
  const socketPath = getSocketPath(sessionKey)
  ensureSocketDir()

  const args = [
    'new-session',
    '-d',
    '-s', name,
    '-n', 'nanocode-claude',
    'exec', 'node', BRIDGE_SCRIPT,
    ...formatArg('--socket', socketPath),
    ...formatArg('--session-key', sessionKey),
    ...formatArg('--session-id', opts.sessionId || randomUUID()),
    ...formatArg('--cwd', opts.cwd || process.cwd()),
    ...formatArg('--turn-count', String(opts.turnCount ?? 0)),
  ]

  if (opts.explicitSessionId) args.push('--explicit-session-id')
  // 需求1 + 需求5: forward the resolved team config dir to the bridge so the
  // SDK driver inside tmux spawns claude under the right CLAUDE_CONFIG_DIR.
  if (opts.claudeConfigDir) args.push(...formatArg('--claude-config-dir', opts.claudeConfigDir))
  if (opts.model) args.push(...formatArg('--model', opts.model))
  if (opts.effort) args.push(...formatArg('--effort', opts.effort))
  if (opts.permissionMode) args.push(...formatArg('--permission-mode', opts.permissionMode))
  if (opts.sessionFallback) args.push(...formatArg('--session-fallback', opts.sessionFallback))
  if (opts.executableOverride) args.push(...formatArg('--executable', opts.executableOverride))
  if (opts.tabLabel) args.push(...formatArg('--tab-label', opts.tabLabel))

  const res = spawnSync(TMUX_BIN, args, { stdio: 'pipe', encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`tmux new-session failed: ${res.stderr || res.stdout || res.status}`)
  }
  console.log(`[claude:tmux] ${sessionKey}: launched persistent bridge tmux=${name} socket=${socketPath}`)
}

async function waitForSocket(socketPath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return
    await sleep(50)
  }
  throw new Error(`bridge socket did not appear: ${socketPath}`)
}

class TmuxBridgeClient {
  constructor(sessionKey, opts = {}) {
    this.sessionKey = sessionKey
    this.opts = opts
    this.socketPath = getSocketPath(sessionKey)
    this.socket = null
    this.buffer = ''
    this.listeners = []
    this.pingId = 0
    this.pendingPongs = new Map()
    this.connected = false
    // Listeners notified when the socket drops mid-turn (close/error). This is
    // the critical signal that lets an in-flight turn reject instead of hanging
    // forever — without it a dead bridge wedges cs.busy=true and every future
    // user message silently queues and never reaches the agent.
    this.disconnectListeners = []
  }

  _notifyDisconnect(reason) {
    const listeners = this.disconnectListeners.slice()
    for (const fn of listeners) {
      try { fn(reason) } catch {}
    }
  }

  async _connectSocket() {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let settled = false
      socket.on('connect', () => {
        this.socket = socket
        this.connected = true
        this.buffer = ''
        settled = true
        resolve()
      })
      socket.on('data', (chunk) => this._onData(chunk))
      socket.on('close', () => {
        this.connected = false
        this._notifyDisconnect(new Error('tmux bridge socket closed'))
      })
      socket.on('error', (err) => {
        this.connected = false
        // If the error happens before connect resolves, surface it to the
        // ensureConnected() caller; otherwise notify in-flight turns.
        if (!settled) { settled = true; reject(err) }
        else this._notifyDisconnect(err)
      })
      socket.setTimeout(0)
    })
  }

  // Subscribe to socket-drop events. Returns an unsubscribe fn.
  onDisconnect(listener) {
    this.disconnectListeners.push(listener)
    return () => {
      const idx = this.disconnectListeners.indexOf(listener)
      if (idx >= 0) this.disconnectListeners.splice(idx, 1)
    }
  }

  async ensureConnected() {
    if (this.connected && this.socket && !this.socket.destroyed) return

    const name = getTmuxName(this.sessionKey)
    let existed = tmuxSessionExists(name)
    if (!existed) {
      launchBridge(this.sessionKey, this.opts)
      await waitForSocket(this.socketPath)
      await sleep(100)
    } else {
      console.log(`[claude:tmux] ${this.sessionKey}: reusing existing tmux session ${name}`)
    }

    // If reconnecting to an existing bridge, sync cs.claudeSessionId from the
    // bridge's recorded sessionId so nanocode resumes the same conversation.
    if (existed) {
      const bridgeSessionId = readSessionIdFile(this.sessionKey)
      if (bridgeSessionId && this.opts.onSessionId) {
        this.opts.onSessionId(bridgeSessionId)
      }
    }

    try {
      await this._connectSocket()
    } catch (err) {
      // The tmux session exists but we can't connect to the socket: the bridge
      // is likely dead or the socket file is stale. Kill the session and retry
      // once after launching a fresh bridge.
      if (existed) {
        console.warn(`[claude:tmux] ${this.sessionKey}: existing bridge unreachable (${err?.message}), recreating session`)
        try { spawnSync(TMUX_BIN, ['kill-session', '-t', name], { stdio: 'ignore' }) } catch {}
        launchBridge(this.sessionKey, this.opts)
        await waitForSocket(this.socketPath)
        await sleep(100)
        await this._connectSocket()
        return
      }
      throw err
    }
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8')
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'pong' && msg.id !== undefined) {
        const cb = this.pendingPongs.get(msg.id)
        if (cb) {
          this.pendingPongs.delete(msg.id)
          cb()
        }
      }
      for (const listener of this.listeners) {
        try { listener(msg) } catch {}
      }
    }
  }

  send(obj) {
    if (!this.socket || this.socket.destroyed) throw new Error('tmux bridge socket not connected')
    this.socket.write(JSON.stringify(obj) + '\n')
  }

  ping(timeoutMs = 5000) {
    const id = ++this.pingId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPongs.delete(id)
        reject(new Error('tmux bridge ping timeout'))
      }, timeoutMs)
      this.pendingPongs.set(id, () => {
        clearTimeout(timer)
        resolve()
      })
      this.send({ type: 'ping', id })
    })
  }

  onMessage(listener) {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }

  close() {
    if (this.socket) {
      try { this.socket.end() } catch {}
    }
    this.connected = false
  }
}

const bridgeClients = new Map()

function getBridgeClient(sessionKey, opts) {
  let client = bridgeClients.get(sessionKey)
  if (!client) {
    client = new TmuxBridgeClient(sessionKey, opts)
    bridgeClients.set(sessionKey, client)
  }
  return client
}

function buildOptions(cs, cwd, store, home) {
  return {
    sessionId: cs.claudeSessionId,
    turnCount: cs.turnCount,
    explicitSessionId: cs.explicitSessionId,
    cwd,
    // 需求1 + 需求5: resolve the team config dir (per-tab cross-team override
    // → global Team setting → default ~/.claude) and forward it to the bridge
    // so the SDK driver running inside tmux honours CLAUDE_CONFIG_DIR too.
    claudeConfigDir: resolveClaudeConfigDir({ cs, store, home }),
    model: store.getSetting('claude_model') || undefined,
    effort: store.getSetting('claude_effort') || undefined,
    permissionMode: resolvePermissionMode(store),
    sessionFallback: store.getSetting('claude_session_fallback') || undefined,
    executableOverride: getClaudeCodeExecutableOverride() || undefined,
    tabLabel: cs.tabLabel || '',
    onSessionId: (sessionId) => {
      if (sessionId && sessionId !== cs.claudeSessionId) {
        cs.claudeSessionId = sessionId
        if (store.updateTabMetadata) {
          const [projectId, , tabId] = cs.sessionKey.split(':')
          store.updateTabMetadata(projectId, tabId, { claudeSessionId: sessionId })
        }
      }
    },
  }
}

export function createClaudeTmuxDriver({ store, home, claudeBroadcast, rerunTurn }) {
  async function runTmuxTurn(cs, userText, sessionKey, cwd) {
    const quietQueue = cs._quietQueueOnce === true
    cs._quietQueueOnce = false
    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(userText)
      if (!quietQueue) {
        claudeBroadcast(cs, {
          type: 'system',
          subtype: 'queued',
          text: `Message queued (position ${cs.queue.length}). Will run after current turn.`,
        })
      }
      return
    }

    cs.busy = true
    cs.currentProc = null
    cs.turnCount += 1

    const opts = buildOptions(cs, cwd, store, home)
    const client = getBridgeClient(sessionKey, opts)
    await client.ensureConnected()

    // Sync the recorded sessionId back after a fresh launch.
    if (opts.onSessionId && existsSync(getSessionIdPath(sessionKey))) {
      const bridgeSessionId = readSessionIdFile(sessionKey)
      if (bridgeSessionId) opts.onSessionId(bridgeSessionId)
    }

    let sawResult = false
    let finalSubtype = 'success'
    let wasInterrupted = false

    try {
      await new Promise((resolve, reject) => {
        let done = false
        let removeMsg = () => {}
        let removeDisconnect = () => {}
        let watchdog = null
        const cleanup = () => {
          if (done) return
          done = true
          removeMsg()
          removeDisconnect()
          if (watchdog) { clearTimeout(watchdog); watchdog = null }
        }
        const finish = (fn, arg) => { cleanup(); fn(arg) }

        removeMsg = client.onMessage((msg) => {
          if (msg.type === 'event' && msg.event) {
            const event = msg.event
            if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
              if (event.session_id !== cs.claudeSessionId) {
                cs.claudeSessionId = event.session_id
                writeSessionIdFile(sessionKey, event.session_id)
                if (store.updateTabMetadata) {
                  const [projectId, , tabId] = sessionKey.split(':')
                  store.updateTabMetadata(projectId, tabId, { claudeSessionId: event.session_id })
                }
              }
            }
            if (event?.type === 'result') {
              sawResult = true
              finalSubtype = event.subtype || finalSubtype
            }
            // A live event means the bridge is alive and producing output —
            // push the watchdog deadline forward so a long but healthy turn
            // is never killed by the idle backstop.
            if (watchdog) {
              clearTimeout(watchdog)
              watchdog = setTimeout(onWatchdog, TURN_IDLE_TIMEOUT_MS)
            }
            claudeBroadcast(cs, event)
          } else if (msg.type === 'turn-done') {
            finish(resolve, msg.event || { type: 'result', subtype: 'success' })
          } else if (msg.type === 'turn-error') {
            finish(reject, new Error(msg.error || 'tmux bridge turn error'))
          }
        })

        // ── Disconnect guard (root-cause fix) ──────────────────────────────
        // If the bridge socket drops mid-turn (bridge crash, tmux kill, server
        // restart), no turn-done/turn-error will ever arrive. Reject here so the
        // finally block clears cs.busy; otherwise busy wedges true forever and
        // every subsequent user message silently queues and never reaches the
        // agent — the "我发的东西接收不到 / 被迫重发" bug.
        removeDisconnect = client.onDisconnect((reason) => {
          finish(reject, reason instanceof Error ? reason : new Error('tmux bridge disconnected'))
        })

        // ── Idle watchdog (backstop) ───────────────────────────────────────
        // Even with the disconnect guard, guarantee cs.busy can never wedge
        // permanently: if no event/turn-done arrives within the idle window,
        // give up on this turn. Reset on every live event above.
        const onWatchdog = () => {
          finish(reject, new Error('tmux bridge turn timed out (no output)'))
        }
        watchdog = setTimeout(onWatchdog, TURN_IDLE_TIMEOUT_MS)

        // Expose a currentProc proxy so the controller interrupt handler can
        // signal the bridge without knowing it is talking to tmux.
        const procProxy = {
          _nanocodeInterrupted: false,
          kill: (signal) => {
            procProxy._nanocodeInterrupted = true
            try { client.send({ type: 'interrupt', force: signal === 'SIGKILL' }) } catch {}
          },
        }
        cs.currentProc = procProxy

        try {
          client.send({ type: 'user', text: userText })
        } catch (err) {
          // Socket already dead when we tried to dispatch — fail fast instead
          // of waiting for a turn-done that can never come.
          finish(reject, err instanceof Error ? err : new Error('tmux bridge send failed'))
        }
      })
    } catch (err) {
      wasInterrupted = cs.currentProc?._nanocodeInterrupted === true
      const subtype = wasInterrupted ? 'error_during_execution' : 'error'
      if (!sawResult) {
        claudeBroadcast(cs, { type: 'result', subtype })
      }
      console.error(`[claude:tmux] ${sessionKey} turn error:`, err?.message || err)
    } finally {
      cs.busy = false
      cs.currentProc = null

      // Mirror SDK behavior: auto-flush queued messages as a new turn.
      const autoFlushOnInterrupt = store.getSetting('auto_flush_queue_on_interrupt') !== '0'
      const forceFlush = cs._forceFlushQueue === true
      cs._forceFlushQueue = false
      if (cs.queue?.length > 0 && (forceFlush || !wasInterrupted || autoFlushOnInterrupt)) {
        const allQueued = cs.queue.splice(0)
        const combinedText = allQueued.join('\n\n')
        console.log(`[claude:tmux:queue] sessionKey=${sessionKey} flushing ${allQueued.length} queued message(s) (interrupted=${wasInterrupted}, force=${forceFlush})`)
        if (wasInterrupted && !forceFlush) {
          claudeBroadcast(cs, { type: 'system', subtype: 'info', text: `Resuming with ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''}…` })
        }
        setImmediate(() => rerunTurn(cs, combinedText, sessionKey, cwd))
      }
    }
  }

  return {
    name: 'claude_tmux',

    isAvailable() {
      return isTmuxAvailable()
    },

    // Exposed only for unit tests.
    _getBridgeClient: getBridgeClient,
    _TmuxBridgeClient: TmuxBridgeClient,
    _getSocketPath: getSocketPath,
    _getSessionIdPath: getSessionIdPath,
    _getTmuxName: getTmuxName,

    async run(cs, userText, sessionKey, cwd) {
      return runTmuxTurn(cs, userText, sessionKey, cwd)
    },

    async interrupt(cs, force) {
      const client = bridgeClients.get(cs.sessionKey)
      if (!client) return
      await client.ensureConnected().catch(() => {})
      client.send({ type: 'interrupt', force: !!force })
    },

    async reset(cs, newSessionId) {
      const client = bridgeClients.get(cs.sessionKey)
      if (client) {
        await client.ensureConnected().catch(() => {})
        client.send({ type: 'reset', sessionId: newSessionId })
      }
      cs.claudeSessionId = newSessionId
      cs.turnCount = 0
      writeSessionIdFile(cs.sessionKey, newSessionId)
    },

    async destroy(cs) {
      const client = bridgeClients.get(cs.sessionKey)
      if (client) {
        client.close()
        bridgeClients.delete(cs.sessionKey)
      }
      // Do NOT kill the tmux session here; persistence is the point.
    },
  }
}
