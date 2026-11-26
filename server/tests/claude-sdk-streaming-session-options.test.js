/**
 * Streaming mode must CREATE a fresh tab's session ({ sessionId }) on its first
 * turn and only RESUME ({ resume }) when the caller decided so. A duplicated
 * ternary (`a ? x : y ? x : y`) made buildStreamingOptions return { resume }
 * for every turn, so a brand-new tab resumed a session that does not exist
 * ("No conversation found") and never started.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'

function capturingStreamingQuery(captured) {
  return ({ prompt, options }) => {
    captured.push(options)
    const buf = []
    const waiters = []
    const push = (ev) => (waiters.length ? waiters.shift()({ value: ev, done: false }) : buf.push(ev))
    ;(async () => {
      for await (const _m of prompt) {
        push({ type: 'system', subtype: 'init', session_id: 'sid', tools: [] })
        push({ type: 'result', subtype: 'success', session_id: 'sid', result: 'ok' })
      }
    })().catch(() => {})
    return {
      [Symbol.asyncIterator]() {
        return { next: () => (buf.length ? Promise.resolve({ value: buf.shift(), done: false }) : new Promise((r) => waiters.push(r))) }
      },
      interrupt: async () => {},
      close: async () => {},
    }
  }
}

async function firstTurnOptions(csOverrides) {
  const captured = []
  const driver = createClaudeSdkDriver({
    store: { getSetting: () => null, updateTabMetadata() {} },
    claudeBroadcast: () => {},
    rerunTurn: () => {},
    queryImpl: capturingStreamingQuery(captured),
    forceStreaming: true,
  })
  const cs = { sessionKey: 'p:claude:t', claudeSessionId: 'sid', busy: false, queue: [], history: [], clients: new Set(), ...csOverrides }
  await driver.runSdkTurn(cs, 'hi', cs.sessionKey, process.cwd())
  driver.teardownStreamingSession(cs)
  return captured[0]
}

describe('claude sdk streaming: create vs resume on the first turn', () => {
  it('fresh tab (turnCount 0, not explicit) creates the session', async () => {
    const o = await firstTurnOptions({ turnCount: 0, explicitSessionId: false })
    assert.equal(o.sessionId, 'sid')
    assert.equal(o.resume, undefined)
  })

  it('a tab with history (turnCount 1) resumes', async () => {
    const o = await firstTurnOptions({ turnCount: 1 })
    assert.equal(o.resume, 'sid')
    assert.equal(o.sessionId, undefined)
  })

  it('explicit session on its first turn resumes', async () => {
    const o = await firstTurnOptions({ turnCount: 0, explicitSessionId: true })
    assert.equal(o.resume, 'sid')
  })
})
