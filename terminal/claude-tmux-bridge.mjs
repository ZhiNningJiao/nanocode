#!/usr/bin/env node
/**
 * claude-tmux-bridge.mjs
 *
 * Long-lived bridge process that runs inside a tmux session and owns one
 * persistent Claude SDK streaming session.  Nanocode connects to this bridge
 * over a Unix domain socket; the bridge survives nanocode restarts / hot-
 * deploys, so the same Claude OS process keeps running across reconnects.
 *
 * Protocol (JSON lines over the Unix socket):
 *   Client -> Bridge:
 *     { type: 'user', text: '...' }     start / queue a turn
 *     { type: 'interrupt', force: bool } interrupt the current turn
 *     { type: 'reset', sessionId? }      tear down session and start fresh
 *     { type: 'ping', id }               keepalive probe
 *
 *   Bridge -> Client:
 *     { type: 'event', event: <SDK event> }  stream all SDK events
 *     { type: 'turn-done', event }            turn completed normally
 *     { type: 'turn-error', error }            turn failed
 *     { type: 'pong', id }                    ping response
 */

import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createClaudeSdkDriver } from './claude-sdk-driver.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--socket') args.socketPath = argv[++i]
    else if (arg === '--session-key') args.sessionKey = argv[++i]
    else if (arg === '--session-id') args.sessionId = argv[++i]
    else if (arg === '--cwd') args.cwd = argv[++i]
    else if (arg === '--turn-count') args.turnCount = parseInt(argv[++i], 10)
    else if (arg === '--explicit-session-id') args.explicitSessionId = true
    else if (arg === '--claude-config-dir') args.claudeConfigDir = argv[++i]
    else if (arg === '--model') args.model = argv[++i]
    else if (arg === '--effort') args.effort = argv[++i]
    else if (arg === '--append-system-prompt') args.appendSystemPrompt = argv[++i]
    else if (arg === '--permission-mode') args.permissionMode = argv[++i]
    else if (arg === '--session-fallback') args.sessionFallback = argv[++i]
    else if (arg === '--executable') args.executableOverride = argv[++i]
    else if (arg === '--tab-label') args.tabLabel = argv[++i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const sessionKey = args.sessionKey || 'unknown'
const cwd = args.cwd || process.cwd()
let sessionId = args.sessionId || randomUUID()
let turnCount = Number.isFinite(args.turnCount) ? args.turnCount : (args.sessionId ? 1 : 0)
// explicitSessionId decides create ({sessionId}) vs resume ({resume}) on the
// first turn. It must reflect ONLY the controller's real intent, passed via the
// --explicit-session-id flag (set from cs.explicitSessionId = store-chosen or
// disk-recovered). The controller ALWAYS passes --session-id (it is the session
// to use, whether creating or resuming), so `|| !!args.sessionId` wrongly forced
// every fresh tab into resume mode → the SDK resumed a brand-new UUID that has
// no conversation → "No conversation found" → the whole tab dead-ended. Trust
// the flag alone, mirroring the controller's own useResumeOnFirstTurn logic.
const explicitSessionId = !!args.explicitSessionId

function writeSessionIdFile() {
  try {
    writeFileSync(`${args.socketPath}.sessionId`, sessionId, { mode: 0o600 })
  } catch {}
}

writeSessionIdFile()

const cs = {
  sessionKey,
  claudeSessionId: sessionId,
  clients: new Set(),
  history: [],
  busy: false,
  turnCount,
  explicitSessionId,
  // 需求1 + 需求5: carry the team config dir forwarded by launchBridge so the
  // SDK driver's wrapSpawnWithTeamEnv injects CLAUDE_CONFIG_DIR into the
  // spawned claude (cross-team resume / Team switch under the tmux driver).
  claudeConfigDir: args.claudeConfigDir || null,
  cwd,
  currentProc: null,
  tabLabel: args.tabLabel || '',
  // 需求8: persona prompt forwarded by launchBridge → bridge SDK driver
  // injects it via appendSystemPrompt each turn (keeps persona active).
  personaPrompt: args.appendSystemPrompt || '',
  queue: [],
  pendingUserDialogs: new Map(),
  _replayUserTextCounts: new Map(),
}

// Model/effort start from the launch args but are MUTABLE: the controller
// forwards the current claude_model / claude_effort setting on every 'user'
// frame, so a /model switch reaches long-lived bridges too (the old behaviour
// froze --model at launch → "Takes effect on next message" was a lie for
// persistent tmux tabs). When they change between turns, the streaming session
// is torn down and rebuilt with --resume on the same session id, so the
// conversation context survives the model swap.
let currentModel = args.model || null
let currentEffort = args.effort || null
// What the LIVE streaming session was built with (null until first build).
let appliedModel = currentModel
let appliedEffort = currentEffort

// Minimal store implementation for the SDK driver running inside the bridge.
// It mirrors the settings the main nanocode process would read; model/effort
// are live-updatable (see above), the rest frozen at bridge launch time so the
// bridge behaves consistently across reconnects.
const store = {
  getSetting(key) {
    if (key === 'claude_model') return currentModel
    if (key === 'claude_effort') return currentEffort
    // The SDK driver resolves global_permission to SDK permissionMode values.
    if (key === 'global_permission') return args.permissionMode || 'full-auto'
    if (key === 'claude_session_fallback') return args.sessionFallback || 'continue'
    if (key === 'auto_flush_queue_on_interrupt') return '1'
    // Legacy setting; intentionally null so global_permission wins.
    if (key === 'claude_permission_mode') return null
    return null
  },
  updateTabMetadata() {},
}

const _clients = new Set()

function broadcast(event) {
  const line = JSON.stringify({ type: 'event', event }) + '\n'
  for (const client of _clients) {
    if (!client.destroyed) {
      try { client.write(line) } catch {}
    }
  }
}

function broadcastSystem(subtype, text, extras = {}) {
  broadcast({ type: 'system', subtype, text, ...extras })
}

// Raw protocol frame (turn-done / turn-error), NOT wrapped in {type:'event'}.
// The controller's runTmuxTurn awaits one of these to settle the turn promise
// and clear cs.busy. Without it the server-side busy flag stayed true forever
// after the first turn, so any later message sent without a force-interrupt
// (the UI's send button masks this) queued into a session that never drains.
function broadcastRaw(obj) {
  const line = JSON.stringify(obj) + '\n'
  for (const client of _clients) {
    if (!client.destroyed) {
      try { client.write(line) } catch {}
    }
  }
}

async function dispatchTurn(text) {
  await driver.runSdkTurn(cs, text, sessionKey, cwd)
}

const driver = createClaudeSdkDriver({
  store,
  home: homedir(),
  claudeBroadcast: (_cs, event) => {
    // Persist any sessionId changes that come from the SDK init event.
    if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id && event.session_id !== sessionId) {
      sessionId = event.session_id
      cs.claudeSessionId = event.session_id
      writeSessionIdFile()
    }
    broadcast(event)
  },
  rerunTurn: (cs, text, sessionKey, cwd) => {
    // The driver asks us to rerun a queued turn.  Dispatch it on the next
    // tick so the current turn's cleanup has finished.
    setImmediate(() => dispatchTurn(text).catch((err) => {
      broadcastSystem('tmux_rerun_error', err?.message || String(err))
      broadcast({ type: 'result', subtype: 'error', session_id: cs.claudeSessionId })
    }))
  },
  runCliFallback: (cs, userText, sessionKey, cwd) => {
    // CLI fallback is intentionally not implemented in tmux mode: the whole
    // point is to keep one persistent SDK session.  Surface the error cleanly.
    broadcastSystem('tmux_no_cli_fallback', 'SDK streaming error; CLI fallback not available in tmux persistent mode')
    broadcast({ type: 'result', subtype: 'error_during_execution', session_id: cs.claudeSessionId })
  },
  onClaudeSpawn: ({ pid }) => {
    broadcastSystem('tmux_claude_spawn', String(pid), { pid })
  },
})

function handleReset(msg) {
  if (cs.currentProc) {
    try { cs.currentProc.kill('SIGKILL') } catch {}
    cs.currentProc = null
  }
  if (cs._streamingSession) {
    try { cs._streamingSession.close() } catch {}
    cs._streamingSession = null
  }
  const oldSessionId = cs.claudeSessionId
  cs.claudeSessionId = msg.sessionId || randomUUID()
  sessionId = cs.claudeSessionId
  writeSessionIdFile()
  cs.turnCount = 0
  cs.busy = false
  cs.queue = []
  broadcastSystem('tmux_reset', `session ${oldSessionId} -> ${cs.claudeSessionId}`, {
    oldSessionId,
    newSessionId: cs.claudeSessionId,
  })
  broadcast({ type: 'result', subtype: 'success' })
}

function handleInterrupt(msg) {
  if (!cs.busy || !cs.currentProc) return
  try {
    cs.currentProc._nanocodeInterrupted = true
    cs.currentProc.kill(msg.force ? 'SIGKILL' : 'SIGINT')
  } catch (err) {
    broadcastSystem('tmux_interrupt_error', err?.message || String(err))
  }
}

async function handleUserMessage(text) {
  try {
    // Apply a pending model/effort switch before starting the turn. Only when
    // idle — tearing down a live streaming session mid-turn would kill the
    // active generation. If we're busy the message queues as usual and the
    // switch applies on the next idle turn.
    if (!cs.busy && (currentModel !== appliedModel || currentEffort !== appliedEffort)) {
      if (cs._streamingSession) {
        try { cs._streamingSession.close() } catch {}
        cs._streamingSession = null
      }
      appliedModel = currentModel
      appliedEffort = currentEffort
      broadcastSystem('tmux_model_switch', `Rebuilding session with model=${currentModel || '(CLI default)'} effort=${currentEffort || '(default)'}`)
    }
    await dispatchTurn(text)
    broadcastRaw({ type: 'turn-done' })
  } catch (err) {
    broadcastSystem('tmux_turn_error', err?.message || String(err))
    broadcast({ type: 'result', subtype: 'error', session_id: cs.claudeSessionId })
    broadcastRaw({ type: 'turn-error', error: err?.message || String(err) })
  }
}

const server = createServer((socket) => {
  _clients.add(socket)
  let buffer = ''

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
        // Live model/effort sync: the controller sends the CURRENT settings on
        // every user frame (older controllers omit them — keep launch values).
        if ('model' in msg) currentModel = msg.model || null
        if ('effort' in msg) currentEffort = msg.effort || null
        handleUserMessage(msg.text.trim())
      } else if (msg.type === 'interrupt') {
        handleInterrupt(msg)
      } else if (msg.type === 'reset') {
        handleReset(msg)
      } else if (msg.type === 'ping') {
        try { socket.write(JSON.stringify({ type: 'pong', id: msg.id }) + '\n') } catch {}
      }
    }
  })

  socket.on('close', () => _clients.delete(socket))
  socket.on('error', () => _clients.delete(socket))
})

server.on('error', (err) => {
  console.error(`[tmux-bridge] ${sessionKey} server error:`, err)
  process.exit(1)
})

// Remove stale socket file before listening.
try { unlinkSync(args.socketPath) } catch {}

server.listen(args.socketPath, () => {
  console.log(`[tmux-bridge] ${sessionKey} listening on ${args.socketPath} (sessionId=${sessionId})`)
})

process.on('SIGTERM', () => {
  console.log(`[tmux-bridge] ${sessionKey} SIGTERM received, exiting`)
  try { server.close() } catch {}
  process.exit(0)
})
