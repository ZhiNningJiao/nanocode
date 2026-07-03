import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeQueryFromPlan(plan, calls) {
  let callIndex = 0
  return ({ prompt, options }) => {
    calls.push({ prompt, options })
    const current = plan[callIndex++] || { events: [] }

    async function* run() {
      for (const event of current.events || []) {
        yield event
      }
      if (current.waitFor) await current.waitFor
      if (current.error) throw current.error
    }

    const iterator = run()
    iterator.interrupt = async () => {
      current.onInterrupt?.()
    }
    iterator.close = async () => {
      current.onClose?.()
    }
    return iterator
  }
}

describe('claude sdk driver', () => {
  it('forwards sdk events and updates session metadata on init', async () => {
    const calls = []
    const broadcasted = []
    const metadataUpdates = []
    const store = {
      getSetting(key) {
        if (key === 'claude_model') return 'claude-opus-4-8'
        if (key === 'claude_effort') return 'high'
        if (key === 'global_permission') return 'full-auto'
        return null
      },
      updateTabMetadata(projectId, tabId, patch) {
        metadataUpdates.push({ projectId, tabId, patch })
      },
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
          { type: 'assistant', session_id: 'sdk-session', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
          { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'OK' },
        ],
      },
    ], calls)

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: () => { throw new Error('rerunTurn should not be called') },
      queryImpl,
    })

    const cs = {
      claudeSessionId: 'initial-session',
      busy: false,
      turnCount: 0,
      queue: [],
      history: [],
      clients: new Set(),
    }

    await driver.runSdkTurn(cs, 'hello sdk', 'project-1:claude:tab-9', process.cwd())

    assert.equal(calls.length, 1)
    assert.equal(calls[0].prompt, 'hello sdk')
    assert.equal(calls[0].options.cwd, process.cwd())
    assert.equal(calls[0].options.sessionId, 'initial-session')
    assert.equal(calls[0].options.resume, undefined)
    assert.equal(calls[0].options.permissionMode, 'bypassPermissions')
    assert.equal(calls[0].options.allowDangerouslySkipPermissions, true)
    assert.equal(calls[0].options.includePartialMessages, true)
    assert.equal(calls[0].options.forwardSubagentText, true)
    assert.equal(calls[0].options.model, 'claude-opus-4-8')
    assert.equal(calls[0].options.effort, 'high')
    assert.equal(cs.claudeSessionId, 'sdk-session')
    assert.deepEqual(metadataUpdates, [
      { projectId: 'project-1', tabId: 'tab-9', patch: { claudeSessionId: 'sdk-session' } },
    ])
    assert.deepEqual(
      broadcasted.map((event) => event.type),
      ['system', 'assistant', 'result']
    )
    assert.equal(cs.busy, false)
    assert.equal(cs.currentProc, null)
  })

  it('queues messages while busy and drains them as one follow-up turn after result', async () => {
    const calls = []
    const broadcasted = []
    const reruns = []
    const firstTurnDone = createDeferred()
    const store = {
      getSetting(key) {
        if (key === 'claude_permission_mode') return 'bypass'
        return null
      },
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
          { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'first' },
        ],
        waitFor: firstTurnDone.promise,
      },
    ], calls)

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: (...args) => { reruns.push(args) },
      queryImpl,
    })

    const cs = {
      claudeSessionId: 'sdk-session',
      busy: false,
      turnCount: 1,
      queue: [],
      history: [],
      clients: new Set(),
    }

    const firstRun = driver.runSdkTurn(cs, 'first', 'project-1:claude:tab-2', '/tmp/workspace')
    await Promise.resolve()

    await driver.runSdkTurn(cs, 'second', 'project-1:claude:tab-2', '/tmp/workspace')
    await driver.runSdkTurn(cs, 'third', 'project-1:claude:tab-2', '/tmp/workspace')

    assert.equal(cs.queue.length, 2)
    assert.deepEqual(
      broadcasted.filter((event) => event.subtype === 'queued').map((event) => event.text),
      [
        'Message queued (position 1). Will run after current turn.',
        'Message queued (position 2). Will run after current turn.',
      ]
    )

    firstTurnDone.resolve()
    await firstRun
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(reruns.length, 1)
    assert.equal(reruns[0][0], cs)
    assert.equal(reruns[0][1], 'second\n\nthird')
    assert.equal(reruns[0][2], 'project-1:claude:tab-2')
    assert.equal(reruns[0][3], '/tmp/workspace')
    assert.equal(cs.queue.length, 0)
  })

  it('synthesizes an interrupted result and clears queued messages when the sdk query is interrupted', async () => {
    const calls = []
    const broadcasted = []
    const reruns = []
    const interrupted = createDeferred()
    const store = {
      getSetting(key) {
        if (key === 'claude_permission_mode') return 'bypass'
        return null
      },
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
        ],
        waitFor: interrupted.promise,
        error: new Error('interrupted by test'),
      },
    ], calls)

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: (...args) => { reruns.push(args) },
      queryImpl,
    })

    const cs = {
      claudeSessionId: 'sdk-session',
      busy: false,
      turnCount: 1,
      queue: [],
      history: [],
      clients: new Set(),
    }

    const run = driver.runSdkTurn(cs, 'first', 'project-1:claude:tab-3', '/tmp/workspace')
    await Promise.resolve()
    await driver.runSdkTurn(cs, 'queued after interrupt', 'project-1:claude:tab-3', '/tmp/workspace')

    assert.equal(typeof cs.currentProc?.kill, 'function')
    cs.currentProc.kill('SIGINT')
    interrupted.resolve()
    await run
    // Let setImmediate callbacks fire (auto-flush uses setImmediate(() => rerunTurn(...)))
    await new Promise((resolve) => setImmediate(resolve))

    // After interrupt + auto-flush: rerunTurn fires for the queued message,
    // then queue is drained (length=0). reruns contains the auto-flush call.
    assert.equal(reruns.length, 1)
    assert.equal(reruns[0][1], 'queued after interrupt')
    assert.equal(cs.queue.length, 0)
    // a33d294: interrupt subtype is 'error_during_execution' (matches CLI stdout output)
    assert.equal(
      broadcasted.some((event) => event.type === 'result' && event.subtype === 'error_during_execution'),
      true
    )
    // 9840310: auto-flush emits "Resuming with N queued message(s)…" not "Queue cleared"
    assert.equal(
      broadcasted.some((event) => event.type === 'system' && event.subtype === 'info' && /Resuming with/.test(event.text || '')),
      true
    )
  })

  // ── Permission mapping: global_permission → SDK permissionMode ──────────────
  // Verifies the SDK driver maps all three nanocode permission tiers the same
  // way the CLI driver does, and that allowDangerouslySkipPermissions only fires
  // on the bypass tier. Also covers the legacy claude_permission_mode fallback.
  async function runWithPermission(settings) {
    const calls = []
    const store = {
      getSetting(key) { return settings[key] ?? null },
      updateTabMetadata() {},
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
          { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'OK' },
        ],
      },
    ], calls)
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: () => {},
      rerunTurn: () => {},
      queryImpl,
    })
    const cs = {
      claudeSessionId: 's', busy: false, turnCount: 0,
      queue: [], history: [], clients: new Set(),
    }
    await driver.runSdkTurn(cs, 'hi', 'p:claude:t', '/tmp')
    return calls[0].options
  }

  it('maps global_permission=full-auto → bypassPermissions + dangerous skip', async () => {
    const opts = await runWithPermission({ global_permission: 'full-auto' })
    assert.equal(opts.permissionMode, 'bypassPermissions')
    assert.equal(opts.allowDangerouslySkipPermissions, true)
  })

  it('maps global_permission=auto-edits → acceptEdits (no dangerous skip)', async () => {
    const opts = await runWithPermission({ global_permission: 'auto-edits' })
    assert.equal(opts.permissionMode, 'acceptEdits')
    assert.equal(opts.allowDangerouslySkipPermissions, false)
  })

  it('maps global_permission=ask → default (no dangerous skip)', async () => {
    const opts = await runWithPermission({ global_permission: 'ask' })
    assert.equal(opts.permissionMode, 'default')
    assert.equal(opts.allowDangerouslySkipPermissions, false)
  })

  it('defaults to bypassPermissions when no permission setting is present', async () => {
    const opts = await runWithPermission({})
    assert.equal(opts.permissionMode, 'bypassPermissions')
    assert.equal(opts.allowDangerouslySkipPermissions, true)
  })

  it('honours legacy claude_permission_mode=accept-edits when global_permission absent', async () => {
    const opts = await runWithPermission({ claude_permission_mode: 'accept-edits' })
    assert.equal(opts.permissionMode, 'acceptEdits')
    assert.equal(opts.allowDangerouslySkipPermissions, false)
  })

  // ── SDK-wrapped result error suppression (model_not_found / rate_limit etc.) ──
  // When the SDK throws "Claude Code returned an error result: <reason>" (non-resume-miss),
  // the driver must NOT fall back to CLI. The result event was already broadcast, so the
  // client sees the error cleanly without the "SDK error → 已自动切回 CLI" banner.
  it('suppresses CLI fallback for SDK-wrapped api error results (e.g. model_not_found)', async () => {
    const broadcasted = []
    const fallbacks = []
    const store = { getSetting() { return null } }

    // Simulate the SDK broadcasting the error result event THEN throwing the wrapped error.
    let throwFn
    const queryImpl = () => {
      async function* run() {
        yield { type: 'result', subtype: 'success', is_error: true, session_id: 's',
          result: "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it." }
        // After emitting the result, throw like the SDK does internally.
        // We use a deferred approach: the generator throws synchronously after yielding.
        throw new Error("Claude Code returned an error result: There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.")
      }
      const it = run()
      it.interrupt = async () => {}
      it.close = async () => {}
      return it
    }

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: () => {},
      runCliFallback: (...args) => { fallbacks.push(args) },
      queryImpl,
    })
    const cs = {
      claudeSessionId: 's', busy: false, turnCount: 0,
      queue: [], history: [], clients: new Set(),
    }
    await driver.runSdkTurn(cs, 'hi', 'p:claude:t', '/tmp')

    // No CLI fallback triggered
    assert.equal(fallbacks.length, 0, 'CLI fallback must NOT be triggered for SDK-wrapped result errors')
    // No sdk_error_fallback system event in the broadcast
    const sdkFallbackEvents = broadcasted.filter((e) => e.subtype === 'sdk_error_fallback')
    assert.equal(sdkFallbackEvents.length, 0, 'sdk_error_fallback system event must NOT be broadcast')
    // The result event WAS broadcast (sawResult=true before throw)
    const resultEvents = broadcasted.filter((e) => e.type === 'result')
    assert.equal(resultEvents.length >= 1, true, 'result event must be broadcast')
    // cs is cleaned up properly
    assert.equal(cs.busy, false)
  })

  it('still falls back to CLI for resume-miss errors even when SDK wraps them as result errors', async () => {
    const broadcasted = []
    const fallbacks = []
    const store = { getSetting() { return null } }

    const queryImpl = () => {
      async function* run() {
        throw new Error('Claude Code returned an error result: No conversation found with session ID: abc123')
      }
      const it = run()
      it.interrupt = async () => {}
      it.close = async () => {}
      return it
    }

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: () => {},
      runCliFallback: (...args) => { fallbacks.push(args) },
      queryImpl,
    })
    const cs = {
      claudeSessionId: 'abc123', busy: false, turnCount: 1,
      explicitSessionId: true, queue: [], history: [], clients: new Set(),
    }
    await driver.runSdkTurn(cs, 'hi', 'p:claude:t', '/tmp')
    // Let setImmediate fire (the CLI fallback is dispatched via setImmediate)
    await new Promise((resolve) => setImmediate(resolve))

    // Resume-miss → CLI fallback IS triggered
    assert.equal(fallbacks.length, 1, 'CLI fallback must be triggered for resume-miss errors')
  })

  // ── 需求9: server-owned queue delivery ───────────────────────────────────
  // The client persists queued-while-busy messages to tab.pendingQueue
  // IMMEDIATELY (no debounce, keepalive) and the server drains that store in the
  // turn's finally block when the in-memory cs.queue path did not fire — so the
  // message is delivered even if the browser page was closed/suspended before
  // the agent went idle (the mobile message-loss bug).

  it('drains persisted tab.pendingQueue as a follow-up turn when cs.queue is empty (需求9 server-owned delivery)', async () => {
    const calls = []
    const broadcasted = []
    const reruns = []
    const userEchos = []
    const metadataUpdates = []
    const store = {
      getSetting() { return null },
      getTab(projectId, tabId) {
        return { id: tabId, pendingQueue: ['QMSG_ONE', 'QMSG_TWO'] }
      },
      updateTabMetadata(projectId, tabId, patch) {
        metadataUpdates.push({ projectId, tabId, patch })
      },
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session-9', tools: [] },
          { type: 'result', subtype: 'success', session_id: 'sdk-session-9', result: 'first' },
        ],
      },
    ], calls)

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      broadcastUserEcho: (_cs, text) => { userEchos.push(text) },
      rerunTurn: (...args) => { reruns.push(args) },
      queryImpl,
    })

    const cs = {
      sessionKey: 'proj9:claude:tab9',
      claudeSessionId: 'sdk-session-9',
      busy: false,
      turnCount: 1,
      queue: [],
      history: [],
      clients: new Set(),
    }

    await driver.runSdkTurn(cs, 'first turn', 'proj9:claude:tab9', '/tmp/ws9')
    // The drain dispatches rerunTurn via setImmediate; let it fire.
    await new Promise((resolve) => setImmediate(resolve))

    // The server delivered the persisted queue as the next turn.
    assert.equal(reruns.length, 1, 'persisted pendingQueue must be drained as one follow-up turn')
    assert.equal(reruns[0][0], cs, 'rerunTurn receives the same cs')
    assert.equal(reruns[0][1], 'QMSG_ONE\n\nQMSG_TWO', 'queued messages are combined with double-newline')
    assert.equal(reruns[0][2], 'proj9:claude:tab9', 'sessionKey is passed through')
    assert.equal(reruns[0][3], '/tmp/ws9', 'cwd is passed through')

    // The store was cleared so the message can never be re-delivered.
    assert.ok(
      metadataUpdates.some((u) => u.projectId === 'proj9' && u.tabId === 'tab9' && Array.isArray(u.patch.pendingQueue) && u.patch.pendingQueue.length === 0),
      'store.updateTabMetadata must clear tab.pendingQueue after draining'
    )

    // A queue-drained system event was broadcast so live clients clear their tray.
    assert.ok(
      broadcasted.some((e) => e.type === 'system' && e.subtype === 'queue-drained'),
      'a queue-drained system event must be broadcast'
    )

    // The user echo was broadcast so connected clients render the delivered message live.
    assert.deepEqual(userEchos, ['QMSG_ONE\n\nQMSG_TWO'], 'broadcastUserEcho receives the combined text')

    // cs.queue was never touched (it was empty — the else branch owns this path).
    assert.equal(cs.queue.length, 0)
    assert.equal(cs.busy, false)
  })

  it('does not drain tab.pendingQueue when cs.queue already has items (no double delivery)', async () => {
    const reruns = []
    const broadcasted = []
    const userEchos = []
    const metadataUpdates = []
    const store = {
      getSetting() { return null },
      getTab() { return { pendingQueue: ['PENDING_ONLY'] } },
      updateTabMetadata(projectId, tabId, patch) { metadataUpdates.push({ projectId, tabId, patch }) },
    }
    const queryImpl = makeQueryFromPlan([
      { events: [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-x', tools: [] },
        { type: 'result', subtype: 'success', session_id: 'sdk-session-x' },
      ] },
    ], [])
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      broadcastUserEcho: (_cs, text) => { userEchos.push(text) },
      rerunTurn: (...args) => { reruns.push(args) },
      queryImpl,
    })
    const cs = {
      sessionKey: 'projX:claude:tabX',
      claudeSessionId: 'sdk-session-x',
      busy: false, turnCount: 1,
      queue: ['CSQ_MSG'], history: [], clients: new Set(),
    }

    await driver.runSdkTurn(cs, 'turn', 'projX:claude:tabX', '/tmp/wsX')
    await new Promise((resolve) => setImmediate(resolve))

    // The in-memory cs.queue path fired (NOT the persisted pendingQueue drain).
    assert.equal(reruns.length, 1, 'cs.queue path fires exactly one follow-up')
    assert.equal(reruns[0][1], 'CSQ_MSG', 'cs.queue message is delivered, not tab.pendingQueue')
    // tab.pendingQueue was NOT cleared this turn (left for the next idle drain).
    assert.equal(metadataUpdates.length, 0, 'tab.pendingQueue must not be cleared when cs.queue path fired')
    // No queue-drained event (that is only for the persisted-drain path).
    assert.ok(!broadcasted.some((e) => e.subtype === 'queue-drained'), 'no queue-drained event when cs.queue fired')
    assert.equal(userEchos.length, 0, 'no user echo when cs.queue fired (cs.queue path uses rerunTurn only)')
    assert.equal(cs.queue.length, 0)
  })

  it('does not fire a follow-up turn when both cs.queue and tab.pendingQueue are empty', async () => {
    const reruns = []
    const broadcasted = []
    const store = {
      getSetting() { return null },
      getTab() { return { pendingQueue: [] } },
      updateTabMetadata() {},
    }
    const queryImpl = makeQueryFromPlan([
      { events: [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-e', tools: [] },
        { type: 'result', subtype: 'success', session_id: 'sdk-session-e' },
      ] },
    ], [])
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      broadcastUserEcho: () => { throw new Error('should not echo') },
      rerunTurn: (...args) => { reruns.push(args) },
      queryImpl,
    })
    const cs = {
      sessionKey: 'projE:claude:tabE',
      claudeSessionId: 'sdk-session-e',
      busy: false, turnCount: 1,
      queue: [], history: [], clients: new Set(),
    }
    await driver.runSdkTurn(cs, 'turn', 'projE:claude:tabE', '/tmp/wsE')
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(reruns.length, 0, 'no follow-up turn when nothing is queued')
    assert.ok(!broadcasted.some((e) => e.subtype === 'queue-drained'), 'no queue-drained event when nothing queued')
  })
})
