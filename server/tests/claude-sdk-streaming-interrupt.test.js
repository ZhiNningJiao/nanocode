import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'

// ── Streaming-mode mock query ────────────────────────────────────────────────
// Simulates the SDK's persistent streaming query():
//   - prompt is an AsyncIterable<SDKUserMessage>; we consume it in the background
//     and record every pushed message.
//   - the query object is itself an AsyncIterable of events that we drive
//     manually via _emit().
//   - interrupt() optionally ends the current turn by emitting a result.
//   - close() ends the event stream.
function makeStreamingQuery({ interruptEmitsResult = true } = {}) {
  const buffer = []        // pending events to yield
  const waiters = []       // resolvers for next()
  let closed = false

  const pushEvent = (ev) => {
    if (closed) return
    if (waiters.length) waiters.shift()({ value: ev, done: false })
    else buffer.push(ev)
  }
  const endStream = () => {
    closed = true
    while (waiters.length) waiters.shift()({ value: undefined, done: true })
  }

  const state = {
    consumed: [],
    interruptCalls: 0,
    closeCalls: 0,
  }

  const factory = ({ prompt }) => {
    // Consume the prompt stream in the background.
    ;(async () => {
      try {
        for await (const msg of prompt) state.consumed.push(msg)
      } catch { /* stream closed */ }
    })()

    const q = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => waiters.push(resolve))
          },
        }
      },
      interrupt: async () => {
        state.interruptCalls += 1
        if (interruptEmitsResult) {
          pushEvent({ type: 'result', subtype: 'error_during_execution', session_id: 's' })
        }
      },
      close: async () => {
        state.closeCalls += 1
        endStream()
      },
    }
    return q
  }

  return { factory, state, pushEvent, endStream }
}

function makeCs(overrides = {}) {
  return {
    claudeSessionId: 's',
    busy: false,
    turnCount: 1,
    queue: [],
    history: [],
    clients: new Set(),
    ...overrides,
  }
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('claude sdk streaming interrupt (red line: never kill sub-agents)', () => {
  it('soft + force interrupt only call q.interrupt(), never q.close()', async () => {
    const broadcasted = []
    const { factory, state, pushEvent } = makeStreamingQuery({ interruptEmitsResult: true })
    const store = { getSetting: () => null, updateTabMetadata() {} }
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, ev) => broadcasted.push(ev),
      rerunTurn: () => {},
      queryImpl: factory,
      forceStreaming: true,
      forceUnlockMs: 50,
    })

    const cs = makeCs()
    const run = driver.runSdkTurn(cs, 'hello', 'p:claude:t', '/tmp')
    await settle()
    pushEvent({ type: 'system', subtype: 'init', session_id: 's' })
    await settle()
    assert.equal(cs.busy, true, 'turn should be running')

    // Force interrupt (SIGKILL) — must remap to q.interrupt(), NOT q.close().
    cs.currentProc.kill('SIGKILL')
    await run

    assert.equal(state.interruptCalls, 1, 'q.interrupt() must be called')
    assert.equal(state.closeCalls, 0, 'q.close() must NEVER be called on a force interrupt (would kill sub-agents)')
    assert.equal(cs.busy, false, 'busy must reset after interrupt')
    assert.ok(broadcasted.some((e) => e.type === 'result' && e.subtype === 'error_during_execution'))
  })

  it('force interrupt unlocks via watchdog even when the SDK interrupt is unresponsive', async () => {
    const broadcasted = []
    // interruptEmitsResult=false → q.interrupt() does nothing (hung turn).
    const { factory, state, pushEvent } = makeStreamingQuery({ interruptEmitsResult: false })
    const store = { getSetting: () => null, updateTabMetadata() {} }
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, ev) => broadcasted.push(ev),
      rerunTurn: () => {},
      queryImpl: factory,
      forceStreaming: true,
      forceUnlockMs: 40,
    })

    const cs = makeCs()
    const run = driver.runSdkTurn(cs, 'hello', 'p:claude:t', '/tmp')
    await settle()
    pushEvent({ type: 'system', subtype: 'init', session_id: 's' })
    await settle()

    cs.currentProc.kill('SIGKILL')  // force
    await run  // resolves via the 40ms watchdog

    assert.equal(state.interruptCalls, 1)
    assert.equal(state.closeCalls, 0, 'watchdog must not close the process')
    assert.equal(cs.busy, false, 'busy must reset via force-unlock watchdog')
    assert.ok(
      broadcasted.some((e) => e.type === 'result' && e.subtype === 'error_during_execution'),
      'watchdog must broadcast a synthetic result so the client leaves the thinking state',
    )
  })

  it('a force-interrupted turn flushes a queued "send now" message regardless of auto-flush=off', async () => {
    const broadcasted = []
    const reruns = []
    const { factory, pushEvent } = makeStreamingQuery({ interruptEmitsResult: true })
    const store = {
      getSetting: (k) => (k === 'auto_flush_queue_on_interrupt' ? '0' : null),
      updateTabMetadata() {},
    }
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, ev) => broadcasted.push(ev),
      rerunTurn: (...args) => reruns.push(args),
      queryImpl: factory,
      forceStreaming: true,
      forceUnlockMs: 50,
    })

    const cs = makeCs()
    const run = driver.runSdkTurn(cs, 'long turn', 'p:claude:t', '/tmp')
    await settle()
    pushEvent({ type: 'system', subtype: 'init', session_id: 's' })
    await settle()

    // "send now": message lands in the server queue while busy, quiet banner.
    cs._quietQueueOnce = true
    await driver.runSdkTurn(cs, 'urgent', 'p:claude:t', '/tmp')
    assert.equal(cs.queue.length, 1)
    assert.equal(
      broadcasted.some((e) => e.subtype === 'queued'),
      false,
      'quiet queue: no "Message queued" banner for send-now',
    )

    // Force interrupt + flush (what the "立刻发送" button triggers).
    cs._forceFlushQueue = true
    cs.currentProc.kill('SIGKILL')
    await run
    await settle()

    assert.equal(reruns.length, 1, 'queued message must flush despite auto_flush=off')
    assert.equal(reruns[0][1], 'urgent')
    assert.equal(cs.queue.length, 0)
    // No "Resuming with N queued…" banner on a force-flush (it's an immediate send).
    assert.equal(
      broadcasted.some((e) => e.subtype === 'info' && /Resuming with/.test(e.text || '')),
      false,
    )
  })

  it('close() settles a hung turn so busy never sticks (anti-lockout)', async () => {
    const broadcasted = []
    // No result ever, interrupt no-ops — only close() can end it.
    const { factory, pushEvent } = makeStreamingQuery({ interruptEmitsResult: false })
    const store = { getSetting: () => null, updateTabMetadata() {} }
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, ev) => broadcasted.push(ev),
      rerunTurn: () => {},
      queryImpl: factory,
      forceStreaming: true,
      forceUnlockMs: 9999,  // watchdog won't fire in this test window
    })

    const cs = makeCs()
    const run = driver.runSdkTurn(cs, 'hello', 'p:claude:t', '/tmp')
    await settle()
    pushEvent({ type: 'system', subtype: 'init', session_id: 's' })
    await settle()
    assert.equal(cs.busy, true)

    // Simulate handleReset tearing down the session.
    cs._streamingSession.close()
    await run

    assert.equal(cs.busy, false, 'close() must settle the pending turn and reset busy')
  })
})
