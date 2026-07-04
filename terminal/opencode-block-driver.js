/**
 * opencode block-mode driver (MES-13740 需求11-C)
 *
 * Per-turn subprocess driver for Fable5/opencode tabs in Block render mode.
 * Analogous to the Codex SDK driver (terminal/codex-sdk-driver.js) but uses
 * `opencode run --format json` (streaming JSON lines) instead of an npm SDK,
 * because @opencode-ai/sdk is incomplete in this environment.
 *
 * Architecture (see REPORT 需求11-A):
 *   - History : `opencode export <sessionID>` → exportToEvents() → replay
 *                (handled by the history route, not this driver)
 *   - Turn    : spawn `opencode run --format json --auto -m kimi/<model>
 *               [--session <id>] "<prompt>"` in the project cwd.
 *               Parse stdout line-by-line; each line is
 *                 { type, timestamp, sessionID, part: {…opencode part…} }
 *               Convert part → claude block events via opencode-adapter.js
 *               messageToEvents(); broadcast each as a `claude-event` WS msg.
 *   - Session : capture sessionID from the first JSON line; persist to tab
 *               metadata (opencodeSessionId). Subsequent turns pass
 *               `--session <id>` for multi-tab isolation (not --continue,
 *               which would cross-contaminate tabs sharing a cwd).
 *   - Interrupt: SIGINT to the child process (matches codex driver).
 *
 * The driver is injected with { store, broadcast, rerunTurn, spawnFn } so it
 * is unit-testable with a mocked spawn.
 */

import { spawn as defaultSpawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { messageToEvents } from './opencode-adapter.js'

const DEFAULT_MODEL = 'litellm/claude-fable-5'
const BASH = '/bin/bash'

function resolveModel(store) {
  const aigwModel = store?.getSetting ? store.getSetting('aigw_model') : null
  if (aigwModel && typeof aigwModel === 'string' && aigwModel.trim()) {
    return aigwModel.trim()
  }
  return DEFAULT_MODEL
}

function buildEnv(home, model) {
  const env = { ...process.env }
  // MESHY_AIGW_KEY from ~/.config/meshy-aigw.key
  try {
    const keyFile = join(home, '.config', 'meshy-aigw.key')
    if (existsSync(keyFile)) {
      env.MESHY_AIGW_KEY = readFileSync(keyFile, 'utf8').trim()
    }
  } catch { /* best-effort */ }
  // OPENCODE_CONFIG_CONTENT: register the model under the kimi provider
  // (inline runtime override, merged with the global opencode.json which
  //  already carries the kimi provider baseURL + apiKey).
  const cfg = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { kimi: { models: { [model]: { name: model } } } },
  })
  env.OPENCODE_CONFIG_CONTENT = cfg
  // Suppress color/TTY warnings from polluting the JSON stream
  delete env.FORCE_COLOR
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  return env
}

function buildArgs(cs, model, prompt) {
  const args = ['run', '--format', 'json', '--auto', '-m', `kimi/${model}`]
  if (cs.opencodeSessionId) args.push('--session', cs.opencodeSessionId)
  args.push(prompt)
  return args
}

function makeInterruptHandle(child) {
  const handle = { _nanocodeInterrupted: false }
  handle.kill = (signal = 'SIGINT') => {
    handle._nanocodeInterrupted = true
    try { child.kill(signal) } catch { /* already dead */ }
  }
  return handle
}

export function createOpencodeBlockDriver({
  store,
  broadcast,
  rerunTurn,
  spawnFn = defaultSpawn,
  log = console,
} = {}) {
  async function runOpencodeTurn(cs, prompt, sessionKey, cwd) {
    const trimmed = typeof prompt === 'string' ? prompt.trim() : ''
    if (!trimmed) return

    // Queue if a turn is already running (matches codex/claude driver behaviour)
    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(trimmed)
      broadcast(cs, {
        type: 'system',
        subtype: 'info',
        text: `[Message queued (position ${cs.queue.length}). Will run after current turn.]`,
      })
      return
    }

    cs.busy = true
    cs.currentProc = null
    cs.turnCount = (cs.turnCount || 0) + 1

    const home = process.env.HOME || process.env.HOMEPATH || '/'
    const model = resolveModel(store)
    const args = buildArgs(cs, model, trimmed)
    const env = buildEnv(home, model)

    // Echo the user message immediately (claude does the same at
    // claude-session-controller.js:1039 — the client shows it as a user block).
    broadcast(cs, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: trimmed }] },
    })

    let sawResult = false
    let settled = false
    let lastSessionID = cs.opencodeSessionId || null
    let stdoutBuffer = ''
    let stderrBuf = ''

    const child = spawnFn('opencode', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const handle = makeInterruptHandle(child)
    cs.currentProc = handle

    function finishTurn(resolveFn) {
      if (settled) return
      settled = true
      resolveFn()
    }

    function emitLine(line) {
      if (!line) return
      let obj
      try { obj = JSON.parse(line) } catch { return }
      // Capture sessionID for multi-tab isolation + history fetch.
      if (obj.sessionID && obj.sessionID !== lastSessionID) {
        lastSessionID = obj.sessionID
        if (!cs.opencodeSessionId) {
          cs.opencodeSessionId = obj.sessionID
          try {
            const [projectId, , tabId] = sessionKey.split(':')
            store?.updateTabMetadata?.(projectId, tabId, { opencodeSessionId: obj.sessionID })
          } catch { /* best-effort */ }
        }
      }
      if (!obj.part) return
      const part = obj.part
      const events = messageToEvents({
        info: { role: 'assistant', id: part.messageID },
        parts: [part],
      })
      for (const ev of events) {
        broadcast(cs, ev)
        if (ev.type === 'result') sawResult = true
      }
    }

    return new Promise((resolve) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() || ''
        for (const l of lines) emitLine(l)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk
      })
      child.on('error', (err) => {
        log.error?.(`[opencode:block] spawn error: ${err?.message || err}`)
        if (!sawResult) {
          broadcast(cs, {
            type: 'result',
            subtype: 'error',
            is_error: true,
            error: err?.message || 'spawn failed',
          })
          sawResult = true
        }
        // Spawn errors may not always be followed by 'exit'; resolve the turn
        // so the caller's queue drain logic runs.
        finishTurn(resolve)
      })
      child.on('exit', (code, signal) => {
        // Flush any trailing line left in the buffer
        if (stdoutBuffer) { emitLine(stdoutBuffer); stdoutBuffer = '' }
        cs.busy = false
        cs.currentProc = null

        const wasInterrupted = handle._nanocodeInterrupted === true
        // If the turn ended without a step-finish (crash / interrupt / empty),
        // emit a synthetic result so the client exits its "thinking" state.
        if (!sawResult) {
          if (wasInterrupted) {
            broadcast(cs, { type: 'result', subtype: 'success' })
          } else if (code !== 0) {
            const errText = stderrBuf.trim().slice(0, 500)
            broadcast(cs, {
              type: 'result',
              subtype: 'error',
              is_error: true,
              error: errText || `opencode exited with code ${code}`,
            })
          } else {
            broadcast(cs, { type: 'result', subtype: 'success' })
          }
          sawResult = true
        }

        // Queue drain — mirrors the claude SDK/tmux driver finally-block semantics
        // (需求15 item2 / 需求9 server-owned queue). Two sources, in priority order:
        //   1. cs.queue (in-memory): messages that arrived via WS while a turn was
        //      already running (e.g. "send now" flush, or a second client). On
        //      interrupt these are auto-flushed as the next turn unless the user
        //      disabled auto_flush_queue_on_interrupt — aligned with claude.
        //   2. tab.pendingQueue (persisted to disk): messages the client queued
        //      while busy and persisted immediately via PUT /queue (keepalive) so
        //      they survive a mobile tab suspend/kill. Drained when the cs.queue
        //      path did not fire, exactly like claude-sdk-driver.js / -tmux-driver.
        if (!Array.isArray(cs.queue)) cs.queue = []
        const autoFlushOnInterrupt = store?.getSetting
          ? store.getSetting('auto_flush_queue_on_interrupt') !== '0'
          : true
        const forceFlush = cs._forceFlushQueue === true
        cs._forceFlushQueue = false
        const flushedCsQueue = cs.queue.length > 0 && (forceFlush || !wasInterrupted || autoFlushOnInterrupt)
        if (flushedCsQueue) {
          const allQueued = cs.queue.splice(0)
          const combinedText = allQueued.join('\n\n')
          if (wasInterrupted && !forceFlush) {
            broadcast(cs, { type: 'system', subtype: 'info', text: `Resuming with ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''}…` })
          }
          console.log(`[opencode:block:queue] sessionKey=${sessionKey} flushing ${allQueued.length} in-memory queued message(s) (interrupted=${wasInterrupted}, force=${forceFlush})`)
          setImmediate(() => rerunTurn(cs, combinedText, sessionKey, cwd))
        } else {
          // 需求9/需求15-item2: server-owned queue delivery — drain the persisted
          // tab.pendingQueue so messages queued while busy (and persisted before
          // a mobile tab suspend/kill could lose them) are delivered as the next
          // turn. runOpencodeTurn echoes the user message itself (above), so no
          // separate broadcastUserEcho is needed (unlike claude SDK/tmux drivers).
          try {
            const [pid, , tid] = sessionKey.split(':')
            const tab = store?.getTab ? store.getTab(pid, tid) : null
            if (tab && Array.isArray(tab.pendingQueue) && tab.pendingQueue.length > 0) {
              const allQueued = tab.pendingQueue.slice()
              store?.updateTabMetadata?.(pid, tid, { pendingQueue: [] })
              const combinedText = allQueued.join('\n\n')
              broadcast(cs, { type: 'system', subtype: 'queue-drained', text: `Delivering ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''}…` })
              console.log(`[opencode:block:queue] sessionKey=${sessionKey} draining ${allQueued.length} persisted pendingQueue message(s)`)
              setImmediate(() => rerunTurn(cs, combinedText, sessionKey, cwd))
            }
          } catch (drainErr) {
            log.error?.(`[opencode:block:queue] sessionKey=${sessionKey} pendingQueue drain error: ${drainErr?.message || drainErr}`)
          }
        }
        finishTurn(resolve)
      })
    })
  }

  return { runOpencodeTurn, buildArgs, buildEnv, resolveModel: () => resolveModel(store) }
}

export { DEFAULT_MODEL }
