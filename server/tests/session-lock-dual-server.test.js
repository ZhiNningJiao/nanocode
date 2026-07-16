/**
 * Dual-server integration test for the session singleton lock.
 *
 * Simulates the 9475/9476 conflict scenario: two nanocode server instances
 * (ports 9477/9478 for test isolation) both attach WS clients to the SAME
 * Claude conversation. Asserts:
 *
 *  1. Only one server acquires the lock (host); the other enters read-only.
 *  2. The read-only server's client receives a "会话由 :<port> 托管" banner.
 *  3. Input from the read-only server is blocked (no consumer spawned).
 *  4. When the host's last client disconnects, the lock is released.
 *  5. The read-only server promotes on its next attach (clears banner, can send).
 *
 * Uses the same MockWs + mock streaming query pattern as claude-send-now-ws.
 * Both controller instances share a temp HOME so the lock files collide
 * (mirrors the real shared-NFS-home deployment that caused the 9475/9476 bug).
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const tempDirs = []
const savedHome = process.env.HOME

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitUntil(fn, timeoutMs = 5000, label = 'condition') {
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
    try { rmSync(tempDirs.pop(), { recursive: true, force: true }) } catch {}
  }
  process.env.HOME = savedHome
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

// ── Mock streaming query (same shape as claude-send-now-ws.test.js) ──────────
function makeMockStreamingQuery() {
  const eventBuffer = []
  const eventWaiters = []
  let closed = false
  let turnResolver = null
  const state = { interruptCalls: 0, turns: 0 }

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
    state.turns++
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

// ── Helper: set up one "server" (store + routes + mock query) ─────────────────
function makeServer(port, sharedHome, projectId, tabId, claudeSessionId) {
  process.env.HOME = sharedHome
  const store = createStore(':memory:')
  store.setSetting('renderMode', 'block')
  const projectCwd = path.join(sharedHome, 'workspace', `port-${port}`)
  mkdirSync(projectCwd, { recursive: true })
  const project = store.createProject(`srv-${port}`, projectCwd, projectId)
  const tab = store.createTab(project.id, {
    id: tabId,
    type: 'claude',
    label: `srv-${port}`,
    claudeSessionId,
  })
  const { factory, state } = makeMockStreamingQuery()
  const { router, handleTerminalWs } = createTerminalRoutes(store, {
    port,
    testQueryImpl: factory,
  })
  return { store, project, tab, handleTerminalWs, router, state, port }
}

function attachClaude(handleTerminalWs, projectId, tabId) {
  const ws = new MockWs()
  handleTerminalWs(ws)
  emitJson(ws, {
    type: 'attach',
    projectId,
    sessionType: 'bash',
    tabType: 'claude',
    tabId,
    cols: 120,
    rows: 40,
  })
  return ws
}

// Invoke an Express router route in-process (no HTTP server). Mirrors the
// invokeRoute helper in session-inject.test.js so we can exercise the
// POST /api/sessions/:id/inject endpoint directly.
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

describe('session singleton lock — dual-server', () => {
  it('first server acquires lock (host); second server enters read-only mode', async () => {
    const sharedHome = makeTempDir('nanocode-dualsrv-')
    const projectId = 'test-proj-dual'
    const tabId = 'test-tab-dual'
    const claudeSessionId = '93cead89-test-session-singleton'

    // Both "servers" share the same HOME → same ~/.nanocode/session-locks/ dir.
    const serverA = makeServer(9477, sharedHome, projectId, tabId, claudeSessionId)
    const serverB = makeServer(9478, sharedHome, projectId, tabId, claudeSessionId)

    // Server A attaches first → should become host.
    const wsA = attachClaude(serverA.handleTerminalWs, projectId, tabId)
    await waitUntil(
      () => wsA.sent.find((m) => m.type === 'busy-state'),
      3000, 'server A busy-state'
    )

    // Verify the lock file exists and is held by server A (pid=process.pid, port=9477).
    const lockFile = path.join(sharedHome, '.nanocode', 'session-locks', `${claudeSessionId}.lock`)
    assert.ok(existsSync(lockFile), 'lock file should exist after server A attaches')
    const lockContent = JSON.parse(readFileSync(lockFile, 'utf8'))
    assert.equal(lockContent.port, 9477, 'lock should be held by port 9477')

    // Server B attaches → should enter read-only mode.
    const wsB = attachClaude(serverB.handleTerminalWs, projectId, tabId)
    await waitUntil(
      () => wsB.sent.find((m) =>
        m.type === 'claude-event' &&
        m.event?.subtype === 'info' &&
        m.event?._readonly === true
      ),
      3000, 'server B read-only banner'
    )

    // Assert: server B received a read-only banner mentioning :9477.
    const readonlyBanner = wsB.sent.find((m) =>
      m.type === 'claude-event' &&
      m.event?.subtype === 'info' &&
      m.event?._readonly === true
    )
    assert.ok(readonlyBanner, 'server B must receive a read-only banner')
    assert.equal(readonlyBanner.event._lockHolderPort, 9477,
      'banner must identify port 9477 as the host')

    // Assert: server A did NOT receive any read-only banner.
    const aReadonly = wsA.sent.find((m) =>
      m.type === 'claude-event' && m.event?._readonly === true
    )
    assert.ok(!aReadonly, 'server A (host) must NOT receive a read-only banner')

    serverA.store.close()
    serverB.store.close()
    wsA.close()
    wsB.close()
  })

  it('read-only server blocks input (no consumer spawned)', async () => {
    const sharedHome = makeTempDir('nanocode-dualsrv-ro-')
    const projectId = 'test-proj-ro'
    const tabId = 'test-tab-ro'
    const claudeSessionId = '93cead89-ro-session'

    const serverA = makeServer(9477, sharedHome, projectId, tabId, claudeSessionId)
    const serverB = makeServer(9478, sharedHome, projectId, tabId, claudeSessionId)

    // Server A → host.
    const wsA = attachClaude(serverA.handleTerminalWs, projectId, tabId)
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')

    // Server B → read-only.
    const wsB = attachClaude(serverB.handleTerminalWs, projectId, tabId)
    await waitUntil(
      () => wsB.sent.find((m) => m.event?._readonly === true),
      3000, 'B read-only'
    )

    // Server B tries to send input — must be blocked.
    const turnsBefore = serverB.state.turns
    emitJson(wsB, { type: 'claude-input', text: 'hello from read-only server', _nonce: 'ro1' })

    // Give the server a moment to process (or reject) the input.
    await delay(200)

    // Assert: NO streaming session was created (turns counter unchanged).
    assert.equal(serverB.state.turns, turnsBefore,
      'read-only server must NOT spawn a consumer (turns unchanged)')

    // Assert: server B's client received a "blocked" info message.
    const blockedMsg = wsB.sent.find((m) =>
      m.type === 'claude-event' &&
      m.event?.subtype === 'info' &&
      typeof m.event?.text === 'string' &&
      m.event.text.includes('只读模式')
    )
    assert.ok(blockedMsg, 'read-only server must tell the client input was blocked')

    // Assert: server B's client received a result event (to exit thinking state).
    const resultEvent = wsB.sent.find((m) =>
      m.type === 'claude-event' && m.event?.type === 'result'
    )
    assert.ok(resultEvent, 'read-only server must send a result to unfreeze the UI')

    serverA.store.close()
    serverB.store.close()
    wsA.close()
    wsB.close()
  })

  it('read-only server promotes after host disconnects (lock release → acquire)', async () => {
    const sharedHome = makeTempDir('nanocode-dualsrv-promo-')
    const projectId = 'test-proj-promo'
    const tabId = 'test-tab-promo'
    const claudeSessionId = '93cead89-promo-session'

    const serverA = makeServer(9477, sharedHome, projectId, tabId, claudeSessionId)
    const serverB = makeServer(9478, sharedHome, projectId, tabId, claudeSessionId)

    // Server A → host.
    const wsA = attachClaude(serverA.handleTerminalWs, projectId, tabId)
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')

    // Server B → read-only.
    const wsB = attachClaude(serverB.handleTerminalWs, projectId, tabId)
    await waitUntil(
      () => wsB.sent.find((m) => m.event?._readonly === true),
      3000, 'B read-only'
    )

    // Host (server A) disconnects → lock released.
    wsA.close()
    await delay(100)

    // Verify the lock file is gone (or about to be stale).
    // The lock is released synchronously on the last client disconnect.
    const lockFile = path.join(sharedHome, '.nanocode', 'session-locks', `${claudeSessionId}.lock`)
    assert.ok(!existsSync(lockFile),
      'lock file must be removed when the host\'s last client disconnects')

    // Server B attaches a NEW client → should promote to host.
    const wsB2 = attachClaude(serverB.handleTerminalWs, projectId, tabId)
    await waitUntil(
      () => wsB2.sent.find((m) =>
        m.type === 'claude-event' &&
        m.event?.subtype === 'info' &&
        m.event?._readonly === false
      ),
      3000, 'server B promotion event'
    )

    // Assert: server B2 received a promotion event ("会话已恢复为可编辑模式").
    const promoEvent = wsB2.sent.find((m) =>
      m.type === 'claude-event' &&
      m.event?.subtype === 'info' &&
      m.event?._readonly === false
    )
    assert.ok(promoEvent, 'server B must receive a promotion event after host disconnects')

    // Assert: server B can now send input (consumer spawned).
    const turnsBefore = serverB.state.turns
    emitJson(wsB2, { type: 'claude-input', text: 'hello after promotion COMPLETE', _nonce: 'promo1' })
    await waitUntil(
      () => serverB.state.turns > turnsBefore,
      3000, 'server B consumer spawned after promotion'
    )
    assert.ok(serverB.state.turns > turnsBefore,
      'promoted server must be able to spawn a consumer')

    // Verify the lock is now held by server B (port 9478).
    const lockContent2 = JSON.parse(readFileSync(lockFile, 'utf8'))
    assert.equal(lockContent2.port, 9478, 'lock must now be held by port 9478')

    serverA.store.close()
    serverB.store.close()
    wsB.close()
    wsB2.close()
  })

  it('two servers with different sessions do not conflict', async () => {
    const sharedHome = makeTempDir('nanocode-dualsrv-indep-')
    const projectId = 'test-proj-indep'
    const tabIdA = 'test-tab-a'
    const tabIdB = 'test-tab-b'
    const sessionIdA = '93cead89-session-a'
    const sessionIdB = '93cead89-session-b'

    const serverA = makeServer(9477, sharedHome, projectId, tabIdA, sessionIdA)
    const serverB = makeServer(9478, sharedHome, projectId, tabIdB, sessionIdB)

    // Both attach different sessions → both should be hosts (no read-only).
    const wsA = attachClaude(serverA.handleTerminalWs, projectId, tabIdA)
    const wsB = attachClaude(serverB.handleTerminalWs, projectId, tabIdB)

    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')
    await waitUntil(() => wsB.sent.find((m) => m.type === 'busy-state'), 3000, 'B busy-state')

    // Neither should have a read-only banner.
    const aReadonly = wsA.sent.find((m) => m.event?._readonly === true)
    const bReadonly = wsB.sent.find((m) => m.event?._readonly === true)
    assert.ok(!aReadonly, 'server A with its own session must NOT be read-only')
    assert.ok(!bReadonly, 'server B with its own session must NOT be read-only')

    // Both lock files exist, held by their respective ports.
    const lockA = path.join(sharedHome, '.nanocode', 'session-locks', `${sessionIdA}.lock`)
    const lockB = path.join(sharedHome, '.nanocode', 'session-locks', `${sessionIdB}.lock`)
    assert.ok(existsSync(lockA), 'session A lock file exists')
    assert.ok(existsSync(lockB), 'session B lock file exists')
    assert.equal(JSON.parse(readFileSync(lockA, 'utf8')).port, 9477)
    assert.equal(JSON.parse(readFileSync(lockB, 'utf8')).port, 9478)

    serverA.store.close()
    serverB.store.close()
    wsA.close()
    wsB.close()
  })

  it('read-only server blocks the inject API (no consumer spawned); host still wakes', async () => {
    // Regression guard for the inject-bypass bug: the HTTP inject path
    // (POST /api/sessions/:id/inject, used by the crontab watchdog /
    // secretary-wake) is a SEPARATE entry point from the WS 'claude-input'
    // path. Without the readOnly guard in injectClaudeMessage, a server that
    // lost the lock would still spawn a second Claude consumer via inject —
    // the exact "two secretaries" conflict the lock is meant to prevent.
    const sharedHome = makeTempDir('nanocode-dualsrv-inject-')
    const projectId = 'test-proj-inject'
    const tabId = 'test-tab-inject'
    const claudeSessionId = '93cead89-inject-session'

    const serverA = makeServer(9477, sharedHome, projectId, tabId, claudeSessionId)
    const serverB = makeServer(9478, sharedHome, projectId, tabId, claudeSessionId)

    // Server A → host.
    const wsA = attachClaude(serverA.handleTerminalWs, projectId, tabId)
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')

    // Server B → read-only.
    const wsB = attachClaude(serverB.handleTerminalWs, projectId, tabId)
    await waitUntil(
      () => wsB.sent.find((m) => m.event?._readonly === true),
      3000, 'B read-only'
    )

    const sessionKey = `${projectId}:claude:${tabId}`

    // ── Read-only server (B): inject must be BLOCKED, no consumer spawned ──
    const turnsBeforeB = serverB.state.turns
    const resB = await invokeRoute(serverB.router, 'POST',
      `/api/sessions/${sessionKey}/inject`,
      { body: { text: 'wake from read-only server', sendNow: false } }
    )
    assert.equal(resB.statusCode, 423, 'read-only inject must return 423 Locked')
    assert.equal(resB.payload.ok, false, 'read-only inject must report ok:false')
    assert.equal(resB.payload.readOnly, true, 'read-only inject must set readOnly:true')
    assert.equal(resB.payload.lockHolderPort, 9477,
      'read-only inject must identify the host port 9477')
    await delay(150)
    assert.equal(serverB.state.turns, turnsBeforeB,
      'read-only server must NOT spawn a consumer via inject (turns unchanged)')

    // ── Host server (A): inject must STILL WORK (legitimate watchdog wake) ──
    const turnsBeforeA = serverA.state.turns
    const resA = await invokeRoute(serverA.router, 'POST',
      `/api/sessions/${sessionKey}/inject`,
      { body: { text: 'wake the host secretary COMPLETE', sendNow: false } }
    )
    assert.equal(resA.statusCode, 200, 'host inject must return 200')
    assert.equal(resA.payload.ok, true, 'host inject must report ok:true')
    await waitUntil(
      () => serverA.state.turns > turnsBeforeA,
      3000, 'host consumer spawned via inject'
    )
    assert.ok(serverA.state.turns > turnsBeforeA,
      'host server must still spawn a consumer via inject (wake path intact)')

    serverA.store.close()
    serverB.store.close()
    wsA.close()
    wsB.close()
  })
})
