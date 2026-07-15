/**
 * "Send now" (立刻发送) WS atomic interrupt — race regression tests.
 *
 * Bug: sendNowFlush() fired TWO transports near-simultaneously:
 *   1. WS  claude-input { _sendNow: true }  (dispatchClaudeTurn → queues if busy)
 *   2. HTTP POST /interrupt { force, andFlush }  (kill + _forceFlushQueue)
 *
 * Race outcomes:
 *   - IDLE (main bug): WS starts a fresh turn for the send-now message; the
 *     late HTTP interrupt then KILLS that just-started turn → the user's
 *     message dies silently ("nothing happens").
 *   - BUSY: ordering-dependent; if HTTP wins the queue may be empty at exit.
 *
 * Fix: fold "enqueue + interrupt + flush" into ONE atomic step inside the WS
 * handler. When `_sendNow:true`:
 *   - capture wasBusy = cs.busy && cs.currentProc BEFORE dispatching
 *   - dispatch (queues if busy, runs if idle)
 *   - if wasBusy: interrupt the running turn with andFlush so the queued
 *     message flushes as the next turn. If idle: do nothing (the turn IS the
 *     send-now message; interrupting it would kill it).
 * The frontend stops sending the separate HTTP interrupt entirely.
 *
 * These tests use a mock streaming queryImpl (injected via the test seam in
 * createTerminalRoutes) so the "busy" state is deterministic — the real
 * claude binary completes turns too fast to reproduce a stable busy window.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const tempDirs = []

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitUntil(fn, timeoutMs = 3000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    function check() {
      try {
        const value = fn()
        if (value) return resolve(value)
      } catch (err) {
        return reject(err)
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new Error(`Timed out waiting for ${label}`))
      }
      setTimeout(check, 25)
    }
    check()
  })
}

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

class MockWs extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
}

function emitJson(ws, payload) {
  ws.emit('message', JSON.stringify(payload))
}

// ── Mock streaming query (mirrors claude-sdk-streaming-interrupt.test.js) ────
// ONE long-lived streaming session. The factory is called once at session
// creation; each SDKUserMessage pushed into the prompt stream is one turn.
// Per turn: emit init, then either self-complete (prompt text has COMPLETE) or
// block until q.interrupt() ends the turn with an error_during_execution.
// Events are emitted into a shared buffer that the driver's for-await reads.
function makeMockStreamingQuery() {
  const eventBuffer = []
  const eventWaiters = []
  let closed = false
  let turnResolver = null   // resolve to unblock the current (blocking) turn
  const state = { interruptCalls: 0 }

  function pushEvent(ev) {
    if (closed) return
    if (eventWaiters.length) eventWaiters.shift()({ value: ev, done: false })
    else eventBuffer.push(ev)
  }
  function endStream() {
    closed = true
    while (eventWaiters.length) eventWaiters.shift()({ value: undefined, done: true })
  }

  const factory = ({ prompt }) => {
    // Consume the prompt stream: each message is one turn.
    ;(async () => {
      try {
        for await (const msg of prompt) {
          const text = msg?.message?.content?.[0]?.text || msg?.text || String(msg || '')
          pushEvent({ type: 'system', subtype: 'init', session_id: 'mock-session' })
          if (typeof text === 'string' && text.includes('COMPLETE')) {
            // Self-completing turn: result success after a tick.
            await delay(10)
            pushEvent({ type: 'result', subtype: 'success', session_id: 'mock-session' })
          } else {
            // Block until interrupt() ends this turn.
            await new Promise((resolve) => { turnResolver = resolve })
            turnResolver = null
          }
        }
      } catch { /* stream closed */ }
      endStream()
    })()

    const q = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (eventBuffer.length) return Promise.resolve({ value: eventBuffer.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => eventWaiters.push(resolve))
          },
        }
      },
      interrupt: async () => {
        state.interruptCalls += 1
        if (turnResolver) {
          pushEvent({ type: 'result', subtype: 'error_during_execution', session_id: 'mock-session' })
          const r = turnResolver
          turnResolver = null
          r()
        }
      },
      close: async () => { endStream() },
    }
    return q
  }

  return { factory, state }
}

async function attachClaudeTab(store, projectCwd, label, testQueryImpl) {
  mkdirSync(projectCwd, { recursive: true })
  const project = store.createProject(label, projectCwd)
  const tab = store.createTab(project.id, { type: 'claude', label })
  const { handleTerminalWs } = createTerminalRoutes(store, { testQueryImpl })
  const ws = new MockWs()
  handleTerminalWs(ws)
  emitJson(ws, {
    type: 'attach',
    projectId: project.id,
    sessionType: 'bash',
    tabId: tab.id,
    cols: 120,
    rows: 40,
  })
  return { project, tab, ws }
}

describe('claude "send now" WS atomic interrupt', () => {
  it('BUSY: WS-only _sendNow interrupts the running turn and flushes the queued message (no HTTP needed)', async () => {
    const tempRoot = makeTempDir('nanocode-sendnow-busy-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory, state } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block') // block-bridge path; server default is now 'terminal'
    store.setSetting('auto_flush_queue_on_interrupt', '0') // forceFlush must win regardless
    const { ws } = await attachClaudeTab(store, projectCwd, 'Send Now Busy', factory)

    // Start a long-running turn (BLOCKS until interrupted).
    emitJson(ws, { type: 'claude-input', text: 'FIRST_LONG', _nonce: 'n1' })
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.subtype === 'init'),
      3000, 'first init'
    )
    await delay(50) // ensure the turn is mid-flight (busy)

    // "Send now" via WS ONLY — no HTTP /interrupt. Before the fix the WS handler
    // just queued SECOND with no interrupt, so FIRST_LONG blocked forever and
    // SECOND never ran. After the fix the WS handler atomically interrupts
    // FIRST_LONG + forceFlush → SECOND_COMPLETE runs as the next turn.
    emitJson(ws, { type: 'claude-input', text: 'SECOND_COMPLETE', _sendNow: true, _nonce: 'n2' })

    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'result'),
      4000, 'first result (interrupted turn)'
    )
    const secondResult = await waitUntil(
      () => ws.sent.filter((m) => m.type === 'claude-event' && m.event?.type === 'result').length >= 2,
      4000, 'second result (send-now flushed turn)'
    )

    const resultEvents = ws.sent
      .filter((m) => m.type === 'claude-event' && m.event?.type === 'result')
      .map((m) => m.event)
    assert.ok(resultEvents.length >= 2, `Expected ≥2 result events, got ${resultEvents.length}`)
    // The running turn was interrupted (error_during_execution).
    assert.equal(resultEvents[0].subtype, 'error_during_execution',
      'the long-running turn must be interrupted by the send-now flush')
    // The send-now message (SECOND_COMPLETE) must have actually RUN.
    assert.equal(resultEvents[1].subtype, 'success',
      'send-now flushed turn must complete successfully, not be stranded')
    // The interrupt must have been driven by the WS handler (no HTTP call here).
    assert.ok(state.interruptCalls >= 1, 'WS send-now must interrupt the running turn')

    store.close()
    ws.close()
  })

  it('IDLE: WS-only _sendNow runs the message to completion (never interrupted)', async () => {
    const tempRoot = makeTempDir('nanocode-sendnow-idle-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory, state } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block') // block-bridge path; server default is now 'terminal'
    const { ws } = await attachClaudeTab(store, projectCwd, 'Send Now Idle', factory)

    // Idle: _sendNow on an idle session. The WS handler must NOT interrupt —
    // the turn IS the send-now message, so it must run to completion.
    emitJson(ws, { type: 'claude-input', text: 'SOLE_COMPLETE', _sendNow: true, _nonce: 'n1' })

    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.subtype === 'init'),
      3000, 'init'
    )
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'result'),
      4000, 'result'
    )

    const resultEvents = ws.sent
      .filter((m) => m.type === 'claude-event' && m.event?.type === 'result')
      .map((m) => m.event)
    assert.equal(resultEvents.length, 1, 'idle send-now must produce exactly one result')
    assert.equal(resultEvents[0].subtype, 'success',
      'idle send-now must run to completion, not be interrupted (error_during_execution)')
    assert.equal(state.interruptCalls, 0,
      'idle send-now must NOT interrupt — the turn IS the send-now message')

    store.close()
    ws.close()
  })
})
