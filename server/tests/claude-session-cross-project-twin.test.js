/**
 * Cross-project resume twin-tab test for the in-process session ownership guard.
 *
 * Reproduces the bug: resuming a session from project A while in project B
 * creates a duplicate tab bound to the same `claudeSessionId`. Because both
 * tabs live in the SAME process (same pid+port), the cross-PROCESS file lock
 * (session-lock.js) does not prevent the twin — acquireSessionLock returns
 * acquired=true for same pid+port (re-entrant). Both cs objects think they
 * are the host, both can inject, and the original tab goes "silent" as the
 * two Claude consumers compete for the same jsonl.
 *
 * The in-process ownership registry (claudeSessionOwners Map) fixes this:
 * the second tab to attach migrates ownership — the old tab is demoted to
 * read-only, the new tab becomes the active host. The displaced tab is
 * promoted back when the host's last client disconnects.
 *
 * Asserts:
 *  1. Cross-project resume: project A (host) → project B attaches same
 *     sessionId → A is displaced to read-only, B becomes the host.
 *  2. The displaced tab's client receives a displacement banner.
 *  3. Input from the displaced tab is blocked (no consumer spawned).
 *  4. The host tab can still send input.
 *  5. When the host's last client disconnects, the displaced tab promotes
 *     back to host (clears read-only, can send input).
 *  6. Two tabs with different sessions do not conflict (both hosts).
 *  7. The inject API is blocked on a displaced tab.
 *  8. Dirty-data fallback: two tabs pre-persisted with the same sessionId
 *     (e.g. after a server restart) — the most-recent to attach wins.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

// ── Helper: set up one server with TWO projects and one tab each ───────────
function makeDualProjectServer(sharedHome, port, projAId, tabAId, projBId, tabBId, claudeSessionId) {
  process.env.HOME = sharedHome
  const store = createStore(':memory:')
  store.setSetting('renderMode', 'block')
  const cwdA = path.join(sharedHome, 'workspace', 'projA')
  const cwdB = path.join(sharedHome, 'workspace', 'projB')
  mkdirSync(cwdA, { recursive: true })
  mkdirSync(cwdB, { recursive: true })
  const projA = store.createProject('Project A', cwdA, projAId)
  const projB = store.createProject('Project B', cwdB, projBId)
  store.createTab(projA.id, {
    id: tabAId, type: 'claude', label: 'resume·team1', claudeSessionId,
    claudeSessionStarted: true,
  })
  store.createTab(projB.id, {
    id: tabBId, type: 'claude', label: 'resume·team2', claudeSessionId,
    claudeSessionStarted: true,
  })
  const { factory, state } = makeMockStreamingQuery()
  const { router, handleTerminalWs, sessionController } = createTerminalRoutes(store, {
    port,
    testQueryImpl: factory,
  })
  return { store, projA, projB, handleTerminalWs, router, state, port, sessionController }
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

// Invoke an Express router route in-process (no HTTP server).
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
      end(payload) { resolve({ statusCode: this.statusCode, payload: undefined }) },
    }
    router.handle(req, res, (err) => {
      if (err) reject(err)
      else resolve({ statusCode: res.statusCode, payload: undefined })
    })
  })
}

describe('cross-project resume twin guard (in-process ownership)', () => {
  it('project A (host) → project B attaches same sessionId → A displaced to read-only, B becomes host', async () => {
    const sharedHome = makeTempDir('nanocode-xproj-twin-')
    const claudeSessionId = 'd1ffad35-twin-session'
    const server = makeDualProjectServer(
      sharedHome, 9475,
      'projA', 'tabA', 'projB', 'tabB', claudeSessionId
    )

    // Project A attaches first → becomes host.
    const wsA = attachClaude(server.handleTerminalWs, 'projA', 'tabA')
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')

    // Assert A is NOT read-only.
    const aReadonlyBefore = wsA.sent.find((m) => m.event?._readonly === true)
    assert.ok(!aReadonlyBefore, 'project A (first host) must NOT start read-only')

    // Project B attaches same sessionId → twin detected, A displaced, B host.
    const wsB = attachClaude(server.handleTerminalWs, 'projB', 'tabB')
    await waitUntil(
      () => wsA.sent.find((m) =>
        m.type === 'claude-event' &&
        m.event?.subtype === 'info' &&
        m.event?._readonly === true &&
        m.event?._displacedTo
      ),
      3000, 'A displacement banner'
    )

    // Assert: A received a displacement banner mentioning B's tab label.
    const aDisplaced = wsA.sent.find((m) =>
      m.type === 'claude-event' &&
      m.event?._readonly === true &&
      m.event?._displacedTo
    )
    assert.ok(aDisplaced, 'project A must receive a displacement banner')
    assert.ok(aDisplaced.event.text.includes('只读'),
      'displacement banner must mention read-only mode')
    assert.ok(aDisplaced.event._displacedTo.tabLabel,
      'displacement banner must carry the new host tab label')

    // Assert: B did NOT receive a read-only banner (B is the host).
    const bReadonly = wsB.sent.find((m) => m.event?._readonly === true)
    assert.ok(!bReadonly, 'project B (new host) must NOT be read-only')

    // Assert: in-process registry shows B as the owner.
    const owner = server.sessionController.claudeSessionOwners.get(claudeSessionId)
    assert.equal(owner, 'projB:claude:tabB',
      'in-process ownership must be transferred to project B tab')

    server.store.close()
    wsA.close()
    wsB.close()
  })

  it('displaced tab blocks input (no consumer spawned); host still works', async () => {
    const sharedHome = makeTempDir('nanocode-xproj-block-')
    const claudeSessionId = 'd1ffad35-block-session'
    const server = makeDualProjectServer(
      sharedHome, 9475,
      'projA', 'tabA', 'projB', 'tabB', claudeSessionId
    )

    // A → host, B → displaces A
    const wsA = attachClaude(server.handleTerminalWs, 'projA', 'tabA')
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')
    const wsB = attachClaude(server.handleTerminalWs, 'projB', 'tabB')
    await waitUntil(
      () => wsA.sent.find((m) => m.event?._displacedTo),
      3000, 'A displaced'
    )

    // Displaced A tries to send input — must be blocked.
    const turnsBefore = server.state.turns
    emitJson(wsA, { type: 'claude-input', text: 'hello from displaced tab', _nonce: 'dis1' })
    await delay(200)
    assert.equal(server.state.turns, turnsBefore,
      'displaced tab must NOT spawn a consumer (turns unchanged)')

    // Assert: A's client received a "blocked" info message.
    const blockedMsg = wsA.sent.find((m) =>
      m.type === 'claude-event' &&
      m.event?.subtype === 'info' &&
      typeof m.event?.text === 'string' &&
      m.event.text.includes('只读')
    )
    assert.ok(blockedMsg, 'displaced tab must tell the client input was blocked')

    // Host B can still send input (consumer spawned).
    const turnsBeforeB = server.state.turns
    emitJson(wsB, { type: 'claude-input', text: 'hello from host COMPLETE', _nonce: 'host1' })
    await waitUntil(
      () => server.state.turns > turnsBeforeB,
      3000, 'host consumer spawned'
    )
    assert.ok(server.state.turns > turnsBeforeB,
      'host tab must still be able to spawn a consumer')

    server.store.close()
    wsA.close()
    wsB.close()
  })

  it('host disconnects → displaced tab promotes back to host (can send input)', async () => {
    const sharedHome = makeTempDir('nanocode-xproj-promo-')
    const claudeSessionId = 'd1ffad35-promo-session'
    const server = makeDualProjectServer(
      sharedHome, 9475,
      'projA', 'tabA', 'projB', 'tabB', claudeSessionId
    )

    // A → host, B → displaces A
    const wsA = attachClaude(server.handleTerminalWs, 'projA', 'tabA')
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')
    const wsB = attachClaude(server.handleTerminalWs, 'projB', 'tabB')
    await waitUntil(
      () => wsA.sent.find((m) => m.event?._displacedTo),
      3000, 'A displaced'
    )

    // Host B disconnects → ownership released, A promoted back.
    wsB.close()
    await waitUntil(
      () => wsA.sent.find((m) =>
        m.type === 'claude-event' &&
        m.event?.subtype === 'info' &&
        m.event?._readonly === false
      ),
      3000, 'A promotion event'
    )

    // Assert: A received a promotion event.
    const promoEvent = wsA.sent.find((m) =>
      m.type === 'claude-event' &&
      m.event?.subtype === 'info' &&
      m.event?._readonly === false
    )
    assert.ok(promoEvent, 'displaced tab must receive a promotion event after host disconnects')

    // Assert: in-process registry shows A as the owner again.
    const owner = server.sessionController.claudeSessionOwners.get(claudeSessionId)
    assert.equal(owner, 'projA:claude:tabA',
      'in-process ownership must be transferred back to project A')

    // Assert: A can now send input (consumer spawned).
    const turnsBefore = server.state.turns
    emitJson(wsA, { type: 'claude-input', text: 'hello after promotion COMPLETE', _nonce: 'promo1' })
    await waitUntil(
      () => server.state.turns > turnsBefore,
      3000, 'A consumer spawned after promotion'
    )
    assert.ok(server.state.turns > turnsBefore,
      'promoted tab must be able to spawn a consumer')

    server.store.close()
    wsA.close()
  })

  it('two tabs with different sessions do not conflict (both hosts)', async () => {
    const sharedHome = makeTempDir('nanocode-xproj-indep-')
    process.env.HOME = sharedHome
    const store = createStore(':memory:')
    store.setSetting('renderMode', 'block')
    const cwdA = path.join(sharedHome, 'workspace', 'projA')
    const cwdB = path.join(sharedHome, 'workspace', 'projB')
    mkdirSync(cwdA, { recursive: true })
    mkdirSync(cwdB, { recursive: true })
    const projA = store.createProject('Project A', cwdA, 'projA')
    const projB = store.createProject('Project B', cwdB, 'projB')
    store.createTab(projA.id, {
      id: 'tabA', type: 'claude', label: 'A', claudeSessionId: 'sess-A-123',
      claudeSessionStarted: true,
    })
    store.createTab(projB.id, {
      id: 'tabB', type: 'claude', label: 'B', claudeSessionId: 'sess-B-456',
      claudeSessionStarted: true,
    })
    const { factory, state } = makeMockStreamingQuery()
    const { handleTerminalWs, sessionController } = createTerminalRoutes(store, {
      port: 9475,
      testQueryImpl: factory,
    })

    // Both attach DIFFERENT sessions → both should be hosts (no read-only).
    const wsA = attachClaude(handleTerminalWs, 'projA', 'tabA')
    const wsB = attachClaude(handleTerminalWs, 'projB', 'tabB')

    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')
    await waitUntil(() => wsB.sent.find((m) => m.type === 'busy-state'), 3000, 'B busy-state')

    const aReadonly = wsA.sent.find((m) => m.event?._readonly === true)
    const bReadonly = wsB.sent.find((m) => m.event?._readonly === true)
    assert.ok(!aReadonly, 'project A with its own session must NOT be read-only')
    assert.ok(!bReadonly, 'project B with its own session must NOT be read-only')

    // Both registered as owners of their own sessions.
    assert.equal(sessionController.claudeSessionOwners.get('sess-A-123'), 'projA:claude:tabA')
    assert.equal(sessionController.claudeSessionOwners.get('sess-B-456'), 'projB:claude:tabB')

    store.close()
    wsA.close()
    wsB.close()
  })

  it('inject API blocked on displaced tab (no consumer spawned); host inject still works', async () => {
    const sharedHome = makeTempDir('nanocode-xproj-inject-')
    const claudeSessionId = 'd1ffad35-inject-session'
    const server = makeDualProjectServer(
      sharedHome, 9475,
      'projA', 'tabA', 'projB', 'tabB', claudeSessionId
    )

    // A → host, B → displaces A
    const wsA = attachClaude(server.handleTerminalWs, 'projA', 'tabA')
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')
    const wsB = attachClaude(server.handleTerminalWs, 'projB', 'tabB')
    await waitUntil(
      () => wsA.sent.find((m) => m.event?._displacedTo),
      3000, 'A displaced'
    )

    const sessionKeyA = 'projA:claude:tabA'
    const sessionKeyB = 'projB:claude:tabB'

    // ── Displaced tab (A): inject must be BLOCKED, no consumer spawned ──
    const turnsBefore = server.state.turns
    const resA = await invokeRoute(server.router, 'POST',
      `/api/sessions/${sessionKeyA}/inject`,
      { body: { text: 'wake from displaced tab', sendNow: false } }
    )
    assert.equal(resA.statusCode, 423, 'displaced inject must return 423 Locked')
    assert.equal(resA.payload.ok, false, 'displaced inject must report ok:false')
    assert.equal(resA.payload.readOnly, true, 'displaced inject must set readOnly:true')
    await delay(150)
    assert.equal(server.state.turns, turnsBefore,
      'displaced tab must NOT spawn a consumer via inject (turns unchanged)')

    // ── Host tab (B): inject must STILL WORK ──
    const turnsBeforeB = server.state.turns
    const resB = await invokeRoute(server.router, 'POST',
      `/api/sessions/${sessionKeyB}/inject`,
      { body: { text: 'wake the host COMPLETE', sendNow: false } }
    )
    assert.equal(resB.statusCode, 200, 'host inject must return 200')
    assert.equal(resB.payload.ok, true, 'host inject must report ok:true')
    await waitUntil(
      () => server.state.turns > turnsBeforeB,
      3000, 'host consumer spawned via inject'
    )
    assert.ok(server.state.turns > turnsBeforeB,
      'host tab must still spawn a consumer via inject')

    server.store.close()
    wsA.close()
    wsB.close()
  })

  it('dirty-data fallback: two tabs pre-persisted with same sessionId, most-recent to attach wins', async () => {
    const sharedHome = makeTempDir('nanocode-xproj-dirty-')
    const claudeSessionId = 'd1ffad35-dirty-session'
    const server = makeDualProjectServer(
      sharedHome, 9475,
      'projA', 'tabA', 'projB', 'tabB', claudeSessionId
    )

    // Simulate dirty data: both tabs have the same sessionId persisted.
    // A attaches first → becomes host.
    const wsA = attachClaude(server.handleTerminalWs, 'projA', 'tabA')
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')

    // B attaches second → displaces A (most-recent wins).
    const wsB = attachClaude(server.handleTerminalWs, 'projB', 'tabB')
    await waitUntil(
      () => wsA.sent.find((m) => m.event?._displacedTo),
      3000, 'A displaced by dirty-data B'
    )

    // Assert: B is the host, A is read-only.
    const owner = server.sessionController.claudeSessionOwners.get(claudeSessionId)
    assert.equal(owner, 'projB:claude:tabB',
      'most-recent tab to attach must win ownership (dirty-data fallback)')

    const bReadonly = wsB.sent.find((m) => m.event?._readonly === true)
    assert.ok(!bReadonly, 'most-recent tab (B) must be the host, not read-only')

    const aDisplaced = wsA.sent.find((m) =>
      m.type === 'claude-event' &&
      m.event?._displacedTo
    )
    assert.ok(aDisplaced, 'earlier tab (A) must be displaced to read-only')

    server.store.close()
    wsA.close()
    wsB.close()
  })

  it('lock file lifecycle: displacement does not release the host lock; displaced disconnect does not delete it; promotion re-acquires', async () => {
    const sharedHome = makeTempDir('nanocode-xproj-lock-')
    const claudeSessionId = 'd1ffad35-lock-lifecycle'
    const server = makeDualProjectServer(
      sharedHome, 9475,
      'projA', 'tabA', 'projB', 'tabB', claudeSessionId
    )
    const lockFile = path.join(sharedHome, '.nanocode', 'session-locks', `${claudeSessionId}.lock`)

    // A → host. Lock file exists, held by port 9475.
    const wsA = attachClaude(server.handleTerminalWs, 'projA', 'tabA')
    await waitUntil(() => wsA.sent.find((m) => m.type === 'busy-state'), 3000, 'A busy-state')
    assert.ok(existsSync(lockFile), 'lock file must exist after A (host) attaches')
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).port, 9475)

    // B → displaces A. Lock file STILL exists (B is the new host, same pid+port).
    const wsB = attachClaude(server.handleTerminalWs, 'projB', 'tabB')
    await waitUntil(
      () => wsA.sent.find((m) => m.event?._displacedTo),
      3000, 'A displaced'
    )
    assert.ok(existsSync(lockFile),
      'lock file must STILL exist after displacement (new host B holds it)')

    // A (displaced) disconnects. Lock file must NOT be deleted — A no longer
    // holds the lock (_lockHeld=false after displacement). B is still host.
    wsA.close()
    await delay(150)
    assert.ok(existsSync(lockFile),
      'lock file must NOT be deleted when the displaced tab disconnects (B is host)')

    // B (host) disconnects. Lock is released, then A is promoted back and
    // re-acquires it. Lock file must exist again, held by port 9475.
    wsB.close()
    await delay(150)
    assert.ok(existsSync(lockFile),
      'lock file must be re-created after A is promoted back to host')
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).port, 9475,
      're-acquired lock must be held by port 9475')

    // Re-attach a new WS to A to verify it was promoted (receives promotion
    // event on re-attach because _justPromoted was set during promotion).
    const wsA2 = attachClaude(server.handleTerminalWs, 'projA', 'tabA')
    await waitUntil(
      () => wsA2.sent.find((m) =>
        m.type === 'claude-event' &&
        m.event?.subtype === 'info' &&
        m.event?._readonly === false
      ),
      3000, 'A promotion event on re-attach'
    )
    assert.ok(wsA2.sent.find((m) => m.event?._readonly === false),
      're-attached A must receive a promotion event')

    server.store.close()
    wsA2.close()
  })
})
