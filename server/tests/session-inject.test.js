/**
 * POST /api/sessions/:id/inject + GET /api/sessions — session inject endpoint
 * (localhost-only) tests.
 *
 * Inject writes a user message into an ACTIVE session's input channel — the
 * server-side equivalent of the WS 'claude-input' message. It lets an external
 * crontab watchdog wake a stuck/idle secretary session (nanocode --watch
 * restarts kill all internal listeners, so an HTTP inject is the only reliable
 * external wake path). SECURITY: the endpoint must reject any non-localhost
 * caller. These tests verify the localhost guard, the session-list, and that
 * inject reuses the exact claude dispatch path (incl. sendNow atomic interrupt).
 *
 * Like claude-send-now-ws.test.js, these use a mock streaming queryImpl (injected
 * via the createTerminalRoutes test seam) so turn timing is deterministic.
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

// ── Mock streaming query (mirrors claude-send-now-ws.test.js) ────────────────
// ONE long-lived streaming session. Per turn: emit init, then either
// self-complete (prompt text includes COMPLETE) or block until q.interrupt()
// ends the turn with error_during_execution.
function makeMockStreamingQuery() {
  const eventBuffer = []
  const eventWaiters = []
  let closed = false
  let turnResolver = null
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
    ;(async () => {
      try {
        for await (const msg of prompt) {
          const text = msg?.message?.content?.[0]?.text || msg?.text || String(msg || '')
          pushEvent({ type: 'system', subtype: 'init', session_id: 'mock-session' })
          if (typeof text === 'string' && text.includes('COMPLETE')) {
            await delay(10)
            pushEvent({ type: 'result', subtype: 'success', session_id: 'mock-session' })
          } else {
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

// Invoke a router route with a body and a synthetic remote address (so the
// localhost guard can be exercised from both sides).
function invokeRoute(router, method, url, { body, remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      body: body || {},
      query: {},
      headers: {},
      socket: { remoteAddress },
    }
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this },
      json(payload) { resolve({ statusCode: this.statusCode, payload }) },
      send(payload) { resolve({ statusCode: this.statusCode, payload }) },
      end(payload) { resolve({ statusCode: this.statusCode, payload }) },
    }
    router.handle(req, res, (err) => {
      if (err) reject(err)
      else resolve({ statusCode: res.statusCode, payload: undefined })
    })
  })
}

async function attachClaudeTab(store, projectCwd, label, testQueryImpl) {
  mkdirSync(projectCwd, { recursive: true })
  const project = store.createProject(label, projectCwd)
  const tab = store.createTab(project.id, { type: 'claude', label })
  const { router, handleTerminalWs } = createTerminalRoutes(store, { testQueryImpl })
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
  return { project, tab, ws, router }
}

describe('session inject endpoint (POST /api/sessions/:id/inject)', () => {
  it('GET /api/sessions lists the active claude session from localhost', async () => {
    const tempRoot = makeTempDir('nanocode-inject-list-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block') // block-bridge → attachClaudeSession
    const { project, tab, ws, router } = await attachClaudeTab(store, projectCwd, 'Inject List', factory)

    const res = await invokeRoute(router, 'GET', '/api/sessions', { remoteAddress: '127.0.0.1' })
    assert.equal(res.statusCode, 200)
    const sessions = res.payload.sessions
    assert.ok(Array.isArray(sessions), 'sessions must be an array')
    const expectedKey = `${project.id}:claude:${tab.id}`
    const found = sessions.find((s) => s.sessionKey === expectedKey)
    assert.ok(found, `list must contain the claude session ${expectedKey}`)
    assert.equal(found.type, 'claude')
    assert.equal(found.projectId, project.id)
    assert.equal(found.tabId, tab.id)

    store.close()
    ws.close()
  })

  it('GET /api/sessions rejects non-localhost callers with 403', async () => {
    const tempRoot = makeTempDir('nanocode-inject-nonlocal-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block')
    const { ws, router } = await attachClaudeTab(store, projectCwd, 'Inject NonLocal', factory)

    const res = await invokeRoute(router, 'GET', '/api/sessions', { remoteAddress: '10.1.2.3' })
    assert.equal(res.statusCode, 403)
    assert.match(res.payload.error, /localhost/i)

    store.close()
    ws.close()
  })

  it('POST inject (localhost) dispatches a user turn to the claude session (reuses claude-input path)', async () => {
    const tempRoot = makeTempDir('nanocode-inject-ok-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block')
    const { project, tab, ws, router } = await attachClaudeTab(store, projectCwd, 'Inject OK', factory)
    const sessionKey = `${project.id}:claude:${tab.id}`

    const res = await invokeRoute(router, 'POST', `/api/sessions/${sessionKey}/inject`, {
      body: { text: 'INJECT_COMPLETE' },
      remoteAddress: '127.0.0.1',
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.ok, true)
    assert.equal(res.payload.type, 'claude')
    assert.equal(res.payload.dispatched, true)

    // The user-echo event must have been broadcast (proves the claude-input path
    // was reused, not a separate code path).
    const userEcho = ws.sent.find(
      (m) => m.type === 'claude-event' && m.event?.type === 'user' &&
        m.event?.message?.content?.[0]?.text === 'INJECT_COMPLETE'
    )
    assert.ok(userEcho, 'inject must broadcast a user-echo event with the injected text')

    // The turn must actually run to completion (COMPLETE → success).
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'result'),
      3000, 'inject turn result'
    )
    const resultEvents = ws.sent
      .filter((m) => m.type === 'claude-event' && m.event?.type === 'result')
      .map((m) => m.event)
    assert.ok(resultEvents.length >= 1, 'inject must dispatch a real turn')
    assert.equal(resultEvents[0].subtype, 'success')

    store.close()
    ws.close()
  })

  it('POST inject rejects non-localhost callers with 403 (even for a real session)', async () => {
    const tempRoot = makeTempDir('nanocode-inject-nonlocal-post-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block')
    const { project, tab, ws, router } = await attachClaudeTab(store, projectCwd, 'Inject NonLocal Post', factory)
    const sessionKey = `${project.id}:claude:${tab.id}`

    const res = await invokeRoute(router, 'POST', `/api/sessions/${sessionKey}/inject`, {
      body: { text: 'SHOULD_NOT_DISPATCH' },
      remoteAddress: '10.1.2.3',
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.payload.error, /localhost/i)

    // Nothing should have been dispatched to the session.
    const userEcho = ws.sent.find(
      (m) => m.type === 'claude-event' && m.event?.type === 'user' &&
        m.event?.message?.content?.[0]?.text === 'SHOULD_NOT_DISPATCH'
    )
    assert.equal(userEcho, undefined, 'non-localhost inject must not dispatch')

    store.close()
    ws.close()
  })

  it('POST inject returns 404 for a non-existent session', async () => {
    const tempRoot = makeTempDir('nanocode-inject-notfound-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block')
    const { ws, router } = await attachClaudeTab(store, projectCwd, 'Inject NotFound', factory)

    const res = await invokeRoute(router, 'POST', '/api/sessions/no-such-project:claude:nope/inject', {
      body: { text: 'hello' },
      remoteAddress: '127.0.0.1',
    })
    assert.equal(res.statusCode, 404)
    assert.equal(res.payload.ok, false)
    assert.equal(res.payload.error, 'session not found')

    store.close()
    ws.close()
  })

  it('POST inject returns 400 for empty text', async () => {
    const tempRoot = makeTempDir('nanocode-inject-empty-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block')
    const { project, tab, ws, router } = await attachClaudeTab(store, projectCwd, 'Inject Empty', factory)
    const sessionKey = `${project.id}:claude:${tab.id}`

    const res = await invokeRoute(router, 'POST', `/api/sessions/${sessionKey}/inject`, {
      body: { text: '   ' },
      remoteAddress: '127.0.0.1',
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.payload.ok, false)
    assert.equal(res.payload.error, 'empty text')

    store.close()
    ws.close()
  })

  it('POST inject sendNow=true atomically interrupts a busy turn and flushes the injected message', async () => {
    const tempRoot = makeTempDir('nanocode-inject-sendnow-')
    const projectCwd = path.join(tempRoot, 'workspace')
    const { factory, state } = makeMockStreamingQuery()
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block')
    store.setSetting('auto_flush_queue_on_interrupt', '0') // forceFlush must win regardless
    const { project, tab, ws, router } = await attachClaudeTab(store, projectCwd, 'Inject SendNow', factory)
    const sessionKey = `${project.id}:claude:${tab.id}`

    // Start a long-running (blocking) turn.
    emitJson(ws, { type: 'claude-input', text: 'BLOCK_ME', _nonce: 'n1' })
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.subtype === 'init'),
      3000, 'blocking turn init'
    )
    await delay(50) // ensure the turn is mid-flight (busy)

    // Inject with sendNow from localhost — must interrupt + flush.
    const res = await invokeRoute(router, 'POST', `/api/sessions/${sessionKey}/inject`, {
      body: { text: 'FLUSH_COMPLETE', sendNow: true },
      remoteAddress: '127.0.0.1',
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.ok, true)

    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'result'),
      4000, 'first result (interrupted turn)'
    )
    await waitUntil(
      () => ws.sent.filter((m) => m.type === 'claude-event' && m.event?.type === 'result').length >= 2,
      4000, 'second result (injected flushed turn)'
    )

    const resultEvents = ws.sent
      .filter((m) => m.type === 'claude-event' && m.event?.type === 'result')
      .map((m) => m.event)
    assert.ok(resultEvents.length >= 2, 'sendNow inject must produce ≥2 results (interrupt + flush)')
    assert.equal(resultEvents[0].subtype, 'error_during_execution',
      'the busy turn must be interrupted by the sendNow inject')
    assert.equal(resultEvents[1].subtype, 'success',
      'the injected FLUSH_COMPLETE must run as the flushed next turn')
    assert.ok(state.interruptCalls >= 1, 'sendNow inject must drive q.interrupt()')

    store.close()
    ws.close()
  })
})
