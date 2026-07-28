/**
 * injectCodexMessage — the codex counterpart of injectClaudeMessage, reached by
 * POST /api/sessions/:id/inject when the sessionKey names a codex tab.
 *
 * These tests exercise the controller function directly with a seeded busy codex
 * session (a busy turn queues rather than spawning the real codex SDK, so no
 * subprocess is launched). They lock in the "send now" contract: a busy session
 * enqueues the message + sets _forceFlushQueue + interrupts the running turn, so
 * the codex driver's finally flushes the queued message as the next turn instead
 * of leaving it stranded behind a possibly hour-long turn.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const stores = []

afterEach(() => {
  while (stores.length > 0) {
    try { stores.pop().close() } catch { /* already closed */ }
  }
})

function makeController() {
  const store = createStore(':memory:')
  stores.push(store)
  const { sessionController } = createTerminalRoutes(store, {})
  return sessionController
}

function seedBusyCodexSession(sessionController, sessionKey) {
  const killCalls = []
  const cs = {
    sessionKey,
    busy: true,
    currentProc: {
      _nanocodeInterrupted: false,
      kill(sig) { killCalls.push(sig) },
    },
    queue: [],
    clients: new Set(),
    scrollback: '',
    eventHistory: [],
    cwd: '/tmp/workspace',
    codexThreadId: 'thread-x',
  }
  sessionController.codexSessions.set(sessionKey, cs)
  return { cs, killCalls }
}

describe('injectCodexMessage', () => {
  it('sendNow=true on a busy codex session enqueues + force-flushes + interrupts', () => {
    const sessionController = makeController()
    const sessionKey = 'p1:codex:t1'
    const { cs, killCalls } = seedBusyCodexSession(sessionController, sessionKey)

    const res = sessionController.injectCodexMessage(sessionKey, 'urgent send-now', { sendNow: true })

    assert.equal(res.ok, true)
    assert.equal(res.type, 'codex')
    assert.equal(res.dispatched, true)
    // A busy turn queues the message (no codex subprocess spawned).
    assert.deepEqual(cs.queue, ['urgent send-now'])
    // "send now": force-flush is armed and the running turn is interrupted so the
    // driver's finally flushes the queued message as the next turn.
    assert.equal(cs._forceFlushQueue, true)
    assert.equal(cs.currentProc._nanocodeInterrupted, true)
    assert.deepEqual(killCalls, ['SIGINT'])
    // The message is echoed to scrollback exactly like a real user turn.
    assert.ok(cs.scrollback.includes('› urgent send-now'))
  })

  it('default (no sendNow) on a busy codex session queues WITHOUT interrupting', () => {
    const sessionController = makeController()
    const sessionKey = 'p1:codex:t2'
    const { cs, killCalls } = seedBusyCodexSession(sessionController, sessionKey)

    const res = sessionController.injectCodexMessage(sessionKey, 'queue me', {})

    assert.equal(res.ok, true)
    assert.deepEqual(cs.queue, ['queue me'])
    assert.notEqual(cs._forceFlushQueue, true)
    assert.equal(cs.currentProc._nanocodeInterrupted, false)
    assert.deepEqual(killCalls, [])
  })

  it('returns session-not-found for an unknown codex session', () => {
    const sessionController = makeController()
    const res = sessionController.injectCodexMessage('nope:codex:x', 'hi', {})
    assert.equal(res.ok, false)
    assert.equal(res.error, 'session not found')
  })

  it('returns empty-text for blank input', () => {
    const sessionController = makeController()
    const sessionKey = 'p1:codex:t3'
    seedBusyCodexSession(sessionController, sessionKey)
    const res = sessionController.injectCodexMessage(sessionKey, '   ', {})
    assert.equal(res.ok, false)
    assert.equal(res.error, 'empty text')
  })
})
