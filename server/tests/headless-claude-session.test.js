/**
 * POST /api/projects/:id/tabs/:tabId/claude-session — headless claude session
 * start. Helpers copied from session-inject.test.js.
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


function setup(label, { home } = {}) {
  const tempRoot = makeTempDir('nanocode-headless-')
  const projectCwd = path.join(tempRoot, 'workspace')
  mkdirSync(projectCwd, { recursive: true })
  const { factory } = makeMockStreamingQuery()
  const store = createStore(':memory:')
  store.setSetting('renderMode', 'block')
  const project = store.createProject(label, projectCwd)
  const tab = store.createTab(project.id, { type: 'claude', label })
  const { router, handleTerminalWs } = createTerminalRoutes(store, { testQueryImpl: factory, home: home || path.join(tempRoot, 'home') })
  return { store, project, tab, router, handleTerminalWs, url: `/api/projects/${project.id}/tabs/${tab.id}/claude-session` }
}

function attachWs(handleTerminalWs, project, tab) {
  const ws = new MockWs()
  handleTerminalWs(ws)
  emitJson(ws, { type: 'attach', projectId: project.id, sessionType: 'bash', tabId: tab.id, cols: 120, rows: 40 })
  return ws
}

describe('headless claude session (POST /api/projects/:id/tabs/:tabId/claude-session)', () => {
  it('starts a session with no browser: listed in /api/sessions and injectable', async () => {
    const { store, project, tab, router, url } = setup('Headless Start')
    const before = await invokeRoute(router, 'GET', '/api/sessions')
    assert.equal(before.payload.sessions.filter((s) => s.tabId === tab.id).length, 0, 'not listed before')

    const res = await invokeRoute(router, 'POST', url)
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.ok, true)
    assert.equal(res.payload.created, true)
    assert.equal(res.payload.readOnly, false)
    const sessionKey = `${project.id}:claude:${tab.id}`
    assert.equal(res.payload.sessionKey, sessionKey)

    const list = await invokeRoute(router, 'GET', '/api/sessions')
    assert.equal(list.payload.sessions.filter((s) => s.sessionKey === sessionKey).length, 1)

    const inj = await invokeRoute(router, 'POST', `/api/sessions/${sessionKey}/inject`, { body: { text: 'HEADLESS_COMPLETE', sendNow: true } })
    assert.equal(inj.statusCode, 200)
    assert.equal(inj.payload.ok, true)
    assert.equal(inj.payload.dispatched, true)
    store.close()
  })

  it('is idempotent: a second call reports the live session, same claudeSessionId', async () => {
    const { store, router, url } = setup('Headless Idem')
    const a = await invokeRoute(router, 'POST', url)
    const b = await invokeRoute(router, 'POST', url)
    assert.equal(a.payload.created, true)
    assert.equal(b.statusCode, 200)
    assert.equal(b.payload.created, false)
    assert.equal(b.payload.claudeSessionId, a.payload.claudeSessionId)
    store.close()
  })

  it('a later browser attach joins the headless session (one cs, sees the injected turn)', async () => {
    const { store, project, tab, router, handleTerminalWs, url } = setup('Headless Join')
    const a = await invokeRoute(router, 'POST', url)
    const sessionKey = `${project.id}:claude:${tab.id}`
    assert.equal(a.payload.created, true)
    await invokeRoute(router, 'POST', `/api/sessions/${sessionKey}/inject`, { body: { text: 'BEFORE_BROWSER_COMPLETE' } })
    await delay(100) // let the mock turn finish (its init event renames the session to mock-session)
    const before = (await invokeRoute(router, 'GET', '/api/sessions')).payload.sessions.filter((s) => s.tabId === tab.id)
    assert.equal(before.length, 1)
    const ws = attachWs(handleTerminalWs, project, tab)
    await waitUntil(() => ws.sent.find((m) => m.type === 'busy-state'), 3000, 'attach finished')
    const echo = ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'user' &&
      m.event?.message?.content?.[0]?.text === 'BEFORE_BROWSER_COMPLETE')
    assert.ok(echo, 'browser replays the turn injected before it attached')
    const list = await invokeRoute(router, 'GET', '/api/sessions')
    const rows = list.payload.sessions.filter((s) => s.tabId === tab.id)
    assert.equal(rows.length, 1, 'still exactly one session for the tab')
    assert.equal(rows[0].claudeSessionId, before[0].claudeSessionId, 'attach reused the headless cs (no new session id)')
    store.close()
    ws.close()
  })

  it('guards: non-localhost 403, unknown project/tab 404, non-claude tab 400, renderMode=terminal 409', async () => {
    const { store, project, router, url } = setup('Headless Guards')
    assert.equal((await invokeRoute(router, 'POST', url, { remoteAddress: '10.1.2.3' })).statusCode, 403)
    assert.equal((await invokeRoute(router, 'POST', `/api/projects/nope/tabs/x/claude-session`)).statusCode, 404)
    assert.equal((await invokeRoute(router, 'POST', `/api/projects/${project.id}/tabs/nope/claude-session`)).statusCode, 404)
    const bash = store.createTab(project.id, { type: 'bash', label: 'b' })
    assert.equal((await invokeRoute(router, 'POST', `/api/projects/${project.id}/tabs/${bash.id}/claude-session`)).statusCode, 400)
    const list0 = await invokeRoute(router, 'GET', '/api/sessions')
    assert.equal(list0.payload.sessions.filter((s) => s.type === 'claude').length, 0, 'no session created by rejected calls')
    store.setSetting('renderMode', 'terminal')
    const t = await invokeRoute(router, 'POST', url)
    assert.equal(t.statusCode, 409)
    assert.match(t.payload.error, /renderMode=terminal/)
    store.close()
  })
})
