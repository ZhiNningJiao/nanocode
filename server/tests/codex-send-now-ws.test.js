/**
 * Codex "send now" (立刻发送) WS atomic interrupt — parity tests with
 * claude-send-now-ws.test.js.
 *
 * Before the fix, block-mode codex had no "send now" semantics:
 *   - The WS handler (attachCodexSession) only supported a line-buffered
 *     `input` + `\x03` Ctrl+C; there was no `_sendNow` flag, so a message
 *     typed while busy was enqueued but the running turn was NOT interrupted.
 *   - The codex SDK driver's finally block UNCONDITIONALLY discarded the
 *     queue on interrupt (opposite of claude, which auto-flushes + honours
 *     _forceFlushQueue).
 *   - handleInterrupt for codex ignored `andFlush` (unlike opencode/claude).
 *
 * Fix (this file exercises it):
 *   1. codex-sdk-driver.js finally block honours `_forceFlushQueue` + the
 *      `auto_flush_queue_on_interrupt` setting (mirror claude ~L690-704).
 *   2. attachCodexSession WS handler: on `input` with `_sendNow:true` AND busy,
 *      atomically enqueue + set _forceFlushQueue + SIGINT the running turn.
 *   3. handleInterrupt codex branch honours `andFlush` (sets _forceFlushQueue).
 *
 * These tests inject a deterministic mock CodexImpl via the testCodexImpl seam
 * (the real codex binary completes turns too fast for a stable busy window).
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

function makeMockRes() {
  const r = {
    jsonStatus: 200,
    jsonBody: null,
    status(code) { r.jsonStatus = code; return r },
    json(body) { r.jsonBody = body; return r },
  }
  return r
}

// ── Mock CodexImpl (mirrors codex-sdk-driver.test.js createCodexImplFactory) ─
// A prompt containing 'BLOCK' blocks until the abort signal fires (a stable
// busy window); any other prompt self-completes after a short delay.
function makeMockCodexImpl() {
  const state = { threadCalls: [], turnCalls: [], interruptCalls: 0 }

  function makeThread(mode, id, options) {
    state.threadCalls.push({ mode, id, options })
    return {
      async runStreamed(prompt, { signal } = {}) {
        state.turnCalls.push({ prompt })
        async function* events() {
          yield { type: 'thread.started', thread_id: 'mock-codex-thread' }
          if (typeof prompt === 'string' && prompt.includes('BLOCK')) {
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                state.interruptCalls += 1
                reject(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
              }
              if (signal?.aborted) return onAbort()
              signal?.addEventListener('abort', onAbort, { once: true })
            })
          } else {
            await delay(10)
            yield { type: 'turn.completed', usage: {} }
          }
        }
        return { events: events() }
      },
    }
  }

  const CodexImpl = class FakeCodex {
    constructor(_options = {}) {}
    startThread(options = {}) { return makeThread('start', null, options) }
    resumeThread(id, options = {}) { return makeThread('resume', id, options) }
  }
  return { CodexImpl, state }
}

async function attachCodexTab(store, projectCwd, label, testCodexImpl) {
  mkdirSync(projectCwd, { recursive: true })
  const project = store.createProject(label, projectCwd)
  const tab = store.createTab(project.id, { type: 'codex', label })
  store.setSetting('codex_driver', 'sdk')
  const { handleTerminalWs, sessionController } = createTerminalRoutes(store, { testCodexImpl })
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
  return { project, tab, ws, sessionController }
}

describe('codex "send now" WS atomic interrupt + interrupt route andFlush', () => {
  it('BUSY: WS-only _sendNow interrupts the running turn and flushes the queued message (same thread resumed)', async () => {
    const tempRoot = makeTempDir('nanocode-codex-sendnow-busy-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { CodexImpl, state } = makeMockCodexImpl()
    const store = createStore(':memory:')
    store.setSetting('auto_flush_queue_on_interrupt', '0') // forceFlush must win regardless
    const { ws } = await attachCodexTab(store, projectCwd, 'Codex Send Now Busy', CodexImpl)

    // Start a long-running (blocking) turn.
    emitJson(ws, { type: 'input', data: 'BLOCK_FIRST\r' })
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'codex-event' && m.event?.type === 'thread.started'),
      3000, 'first thread.started'
    )
    await delay(50) // ensure the turn is mid-flight (busy, blocked on abort gate)

    // "Send now" via WS ONLY — no HTTP /interrupt. The WS handler must
    // atomically enqueue SECOND_COMPLETE + _forceFlushQueue + SIGINT the
    // running turn, so SECOND_COMPLETE runs as the next turn (same thread).
    emitJson(ws, { type: 'input', data: 'SECOND_COMPLETE\r', _sendNow: true })

    await waitUntil(
      () => ws.sent.find((m) => m.type === 'output' && (m.data || '').includes('[Request interrupted by user]')),
      4000, 'first result (interrupted turn)'
    )
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'codex-event' && m.event?.type === 'turn.completed'),
      4000, 'second turn (send-now flushed) completed'
    )

    assert.ok(state.interruptCalls >= 1, 'WS send-now must abort the running turn')
    assert.equal(state.turnCalls.length, 2, 'both turns must have run')
    assert.equal(state.turnCalls[0].prompt, 'BLOCK_FIRST')
    assert.equal(state.turnCalls[1].prompt, 'SECOND_COMPLETE')
    assert.equal(state.threadCalls[0].mode, 'start', 'first turn starts a new thread')
    assert.equal(state.threadCalls[1].mode, 'resume', 'send-now turn must RESUME the same thread')
    assert.equal(state.threadCalls[1].id, state.threadCalls[0].id || 'mock-codex-thread',
      'thread id must be preserved across the interrupt (conversation continuity)')

    store.close()
    ws.close()
  })

  it('IDLE: WS-only _sendNow runs the message to completion (never interrupted)', async () => {
    const tempRoot = makeTempDir('nanocode-codex-sendnow-idle-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { CodexImpl, state } = makeMockCodexImpl()
    const store = createStore(':memory:')
    const { ws } = await attachCodexTab(store, projectCwd, 'Codex Send Now Idle', CodexImpl)

    // Idle: _sendNow on an idle session. The WS handler must NOT interrupt —
    // the turn IS the send-now message, so it must run to completion.
    emitJson(ws, { type: 'input', data: 'SOLE_COMPLETE\r', _sendNow: true })

    await waitUntil(
      () => ws.sent.find((m) => m.type === 'codex-event' && m.event?.type === 'thread.started'),
      3000, 'thread.started'
    )
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'codex-event' && m.event?.type === 'turn.completed'),
      4000, 'turn.completed'
    )

    assert.equal(state.interruptCalls, 0, 'idle send-now must NOT abort — the turn IS the message')
    assert.equal(state.turnCalls.length, 1, 'idle send-now must run exactly one turn')
    assert.equal(state.turnCalls[0].prompt, 'SOLE_COMPLETE')
    assert.equal(state.threadCalls[0].mode, 'start', 'idle first turn starts a new thread')

    store.close()
    ws.close()
  })

  it('HTTP /interrupt with andFlush sets _forceFlushQueue and drains the queue (same thread resumed)', async () => {
    const tempRoot = makeTempDir('nanocode-codex-interrupt-andflush-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { CodexImpl, state } = makeMockCodexImpl()
    const store = createStore(':memory:')
    store.setSetting('auto_flush_queue_on_interrupt', '0') // andFlush must win regardless
    const { ws, project, tab, sessionController } = await attachCodexTab(
      store, projectCwd, 'Codex Interrupt AndFlush', CodexImpl
    )

    // Start a blocking turn.
    emitJson(ws, { type: 'input', data: 'BLOCK_FIRST\r' })
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'codex-event' && m.event?.type === 'thread.started'),
      3000, 'first thread.started'
    )
    await delay(50)

    // Enqueue a message (no _sendNow) — it must wait in the queue.
    emitJson(ws, { type: 'input', data: 'QUEUED_AFTER\r' })
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'output' && (m.data || '').includes('[queued:')),
      3000, 'queued banner'
    )

    // POST /interrupt with andFlush — mirrors the claude/opencode HTTP path.
    const res = makeMockRes()
    sessionController.handleInterrupt(
      { params: { id: project.id, tabId: tab.id }, body: { andFlush: true }, query: {} },
      res
    )
    assert.equal(res.jsonStatus, 200)
    assert.equal(res.jsonBody?.ok, true)
    assert.equal(res.jsonBody?.andFlush, true, 'handleInterrupt must echo andFlush=true for codex')

    // First turn interrupted; queued message drains as the next turn.
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'output' && (m.data || '').includes('[Request interrupted by user]')),
      4000, 'interrupt broadcast'
    )
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'codex-event' && m.event?.type === 'turn.completed'),
      4000, 'drained turn completed'
    )

    assert.ok(state.interruptCalls >= 1, 'HTTP interrupt must abort the running turn')
    assert.equal(state.turnCalls.length, 2, 'both turns must have run')
    assert.equal(state.turnCalls[1].prompt, 'QUEUED_AFTER')
    assert.equal(state.threadCalls[1].mode, 'resume', 'drained turn must RESUME the same thread')

    store.close()
    ws.close()
  })

  it('HTTP /interrupt without andFlush (auto_flush off) discards the queue (stop-button path)', async () => {
    const tempRoot = makeTempDir('nanocode-codex-interrupt-noflush-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { CodexImpl, state } = makeMockCodexImpl()
    const store = createStore(':memory:')
    store.setSetting('auto_flush_queue_on_interrupt', '0') // opt out of auto-flush
    const { ws, project, tab, sessionController } = await attachCodexTab(
      store, projectCwd, 'Codex Interrupt NoFlush', CodexImpl
    )

    emitJson(ws, { type: 'input', data: 'BLOCK_FIRST\r' })
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'codex-event' && m.event?.type === 'thread.started'),
      3000, 'thread.started'
    )
    await delay(50)
    emitJson(ws, { type: 'input', data: 'QUEUED_AFTER\r' })
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'output' && (m.data || '').includes('[queued:')),
      3000, 'queued banner'
    )

    // Plain stop-button interrupt: no andFlush, auto_flush off → queue discarded.
    const res = makeMockRes()
    sessionController.handleInterrupt(
      { params: { id: project.id, tabId: tab.id }, body: {}, query: {} },
      res
    )
    assert.equal(res.jsonBody?.ok, true)

    await waitUntil(
      () => ws.sent.find((m) => m.type === 'output' && (m.data || '').includes('[Request interrupted by user]')),
      4000, 'interrupt broadcast'
    )
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'output' && (m.data || '').includes('[Queue cleared')),
      4000, 'queue cleared banner'
    )

    assert.equal(state.turnCalls.length, 1, 'queued message must NOT run after a plain interrupt (auto_flush off)')
    assert.ok(state.interruptCalls >= 1)

    store.close()
    ws.close()
  })
})
