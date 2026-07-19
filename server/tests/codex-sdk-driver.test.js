import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexSdkDriver } from '../../terminal/codex-sdk-driver.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createCodexImplFactory(plan, calls) {
  let turnIndex = 0

  function makeThread(mode, threadId, options) {
    calls.threadCalls.push({ mode, threadId, options })
    return {
      async runStreamed(prompt, { signal } = {}) {
        const current = plan[turnIndex++] || {}
        calls.turnCalls.push({ mode, threadId, prompt, options, signal })

        async function* events() {
          if (current.waitFor) await current.waitFor
          if (current.signalError && signal) {
            if (signal.aborted) throw current.signalError
            await new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => reject(current.signalError), { once: true })
            })
          }
          for (const event of current.events || []) {
            yield event
          }
          if (current.error) throw current.error
        }

        return { events: events() }
      },
    }
  }

  return class FakeCodex {
    constructor(options = {}) {
      calls.codexOptions.push(options)
    }

    startThread(options = {}) {
      return makeThread('start', null, options)
    }

    resumeThread(id, options = {}) {
      return makeThread('resume', id, options)
    }
  }
}

describe('codex sdk driver', () => {
  it('forwards raw events, renders PTY-style output, and persists thread metadata', async () => {
    const textEvents = []
    const rawEvents = []
    const metadataUpdates = []
    const streamTextEvents = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const store = {
      getSetting(key) {
        if (key === 'codex_model') return 'gpt-5-codex'
        if (key === 'codex_effort') return 'high'
        if (key === 'codex_sandbox_mode') return 'workspace-write'
        if (key === 'codex_path_override') return '/tmp/codex-bin'
        return null
      },
      updateTabMetadata(projectId, tabId, patch) {
        metadataUpdates.push({ projectId, tabId, patch })
      },
    }
    const FakeCodex = createCodexImplFactory([
      {
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la', status: 'in_progress', aggregated_output: '' } },
          { type: 'item.completed', item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la', status: 'completed', aggregated_output: 'file-a\nfile-b', exit_code: 0 } },
          { type: 'item.completed', item: { type: 'file_change', id: 'chg-1', status: 'completed', changes: [{ kind: 'update', path: 'src/app.js' }] } },
          { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: 'Done.' } },
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } },
        ],
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: (_cs, text, opts = {}) => {
        _cs.scrollback += text
        if (!opts.historyOnly) textEvents.push(text)
      },
      codexBroadcastEvent: (_cs, event) => { rawEvents.push(event) },
      codexBroadcastStreamText: (_cs, payload) => { streamTextEvents.push(payload) },
      rerunTurn: () => { throw new Error('rerunTurn should not be called') },
      CodexImpl: FakeCodex,
    })

    const cs = {
      codexThreadId: null,
      busy: false,
      turnCount: 0,
      queue: [],
      clients: new Set(),
      scrollback: '',
    }

    await driver.runCodexTurn(cs, 'summarize repo', 'project-1:codex:tab-1', '/tmp/workspace')

    assert.deepEqual(calls.codexOptions, [{ codexPathOverride: '/tmp/codex-bin' }])
    assert.equal(calls.threadCalls.length, 1)
    assert.deepEqual(calls.threadCalls[0], {
      mode: 'start',
      threadId: null,
      options: {
        workingDirectory: '/tmp/workspace',
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        networkAccessEnabled: true,
        model: 'gpt-5-codex',
        modelReasoningEffort: 'high',
      },
    })
    assert.equal(calls.turnCalls[0].prompt, 'summarize repo')
    assert.equal(cs.codexThreadId, 'thread-1')
    assert.deepEqual(metadataUpdates, [
      { projectId: 'project-1', tabId: 'tab-1', patch: { codexThreadId: 'thread-1' } },
    ])
    assert.deepEqual(rawEvents.map((event) => event.type), [
      'thread.started',
      'item.started',
      'item.completed',
      'item.completed',
      'item.completed',
      'turn.completed',
    ])
    // Agent message text is streamed and recorded to scrollback; it is no longer
    // emitted as a single live output block.
    assert.deepEqual(textEvents, [
      '› summarize repo\n',
      'Running: ls -la\n',
      'file-a\nfile-b\n',
      'patch: update src/app.js\n',
      '────────────\n',
    ])
    assert.deepEqual(streamTextEvents, [
      { itemId: 'msg-1', textDelta: 'Done.' },
    ])
    assert.ok(cs.scrollback.includes('Done.\n'))
    assert.equal(cs.busy, false)
    assert.equal(cs.currentProc, null)
  })

  it('streams agent_message text via deltas and flushes remaining text on completion', async () => {
    const textEvents = []
    const streamTextEvents = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const store = { getSetting() { return null } }
    const FakeCodex = createCodexImplFactory([
      {
        events: [
          { type: 'thread.started', thread_id: 'thread-2' },
          { type: 'item.started', item: { type: 'agent_message', id: 'msg-2' } },
          { type: 'agent_message_content_delta', item_id: 'msg-2', delta: { text: 'Hello, ' } },
          { type: 'agent_message_content_delta', item_id: 'msg-2', delta: { text: 'world!' } },
          { type: 'item.completed', item: { type: 'agent_message', id: 'msg-2', text: 'Hello, world!' } },
          { type: 'turn.completed', usage: {} },
        ],
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: (_cs, text, opts = {}) => {
        _cs.scrollback += text
        if (!opts.historyOnly) textEvents.push(text)
      },
      codexBroadcastEvent: () => {},
      codexBroadcastStreamText: (_cs, payload) => { streamTextEvents.push(payload) },
      rerunTurn: () => {},
      CodexImpl: FakeCodex,
    })

    const cs = {
      codexThreadId: null,
      busy: false,
      turnCount: 0,
      queue: [],
      clients: new Set(),
      scrollback: '',
    }

    await driver.runCodexTurn(cs, 'greet', 'project-1:codex:tab-1', '/tmp/workspace')

    assert.deepEqual(streamTextEvents, [
      { itemId: 'msg-2', textDelta: 'Hello, ' },
      { itemId: 'msg-2', textDelta: 'world!' },
    ])
    assert.deepEqual(textEvents, [
      '› greet\n',
      '────────────\n',
    ])
    assert.ok(cs.scrollback.includes('Hello, world!\n'))
  })

  it('resumes existing threads and drains queued prompts one turn at a time', async () => {
    const textEvents = []
    const reruns = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const firstTurnGate = createDeferred()
    const store = {
      getSetting() {
        return null
      },
    }
    const FakeCodex = createCodexImplFactory([
      {
        waitFor: firstTurnGate.promise,
        events: [
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
        ],
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: (_cs, text) => { textEvents.push(text) },
      codexBroadcastEvent: () => {},
      rerunTurn: (...args) => { reruns.push(args) },
      CodexImpl: FakeCodex,
    })

    const cs = {
      codexThreadId: 'thread-existing',
      busy: false,
      turnCount: 2,
      queue: [],
      clients: new Set(),
    }

    const firstRun = driver.runCodexTurn(cs, 'first', 'project-1:codex:tab-2', '/tmp/workspace')
    await Promise.resolve()

    await driver.runCodexTurn(cs, 'second', 'project-1:codex:tab-2', '/tmp/workspace')
    await driver.runCodexTurn(cs, 'third', 'project-1:codex:tab-2', '/tmp/workspace')

    assert.equal(calls.threadCalls[0].mode, 'resume')
    assert.equal(calls.threadCalls[0].threadId, 'thread-existing')
    assert.deepEqual(textEvents.slice(0, 3), [
      '› first\n',
      '[queued: Message queued (position 1). Will run after current turn.]\n',
      '[queued: Message queued (position 2). Will run after current turn.]\n',
    ])

    firstTurnGate.resolve()
    await firstRun
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(reruns.length, 1)
    assert.equal(reruns[0][0], cs)
    assert.equal(reruns[0][1], 'second')
    assert.equal(reruns[0][2], 'project-1:codex:tab-2')
    assert.equal(reruns[0][3], '/tmp/workspace')
    assert.deepEqual(cs.queue, ['third'])
  })

  it('emits interrupt fallback output and clears queued prompts after abort (auto_flush off)', async () => {
    const textEvents = []
    const reruns = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    // auto_flush_queue_on_interrupt='0' opts out of auto-flush; without
    // _forceFlushQueue the driver must still discard on interrupt (the
    // send-now path sets _forceFlushQueue to override this — covered below).
    const store = {
      getSetting(key) {
        if (key === 'auto_flush_queue_on_interrupt') return '0'
        return null
      },
    }
    const FakeCodex = createCodexImplFactory([
      {
        signalError: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: (_cs, text) => { textEvents.push(text) },
      codexBroadcastEvent: () => {},
      rerunTurn: (...args) => { reruns.push(args) },
      CodexImpl: FakeCodex,
    })

    const cs = {
      codexThreadId: 'thread-existing',
      busy: false,
      turnCount: 1,
      queue: [],
      clients: new Set(),
    }

    const run = driver.runCodexTurn(cs, 'first', 'project-1:codex:tab-3', '/tmp/workspace')
    await Promise.resolve()
    await driver.runCodexTurn(cs, 'queued after interrupt', 'project-1:codex:tab-3', '/tmp/workspace')

    assert.equal(typeof cs.currentProc?.kill, 'function')
    cs.currentProc.kill('SIGINT')
    await run

    assert.equal(reruns.length, 0)
    assert.deepEqual(cs.queue, [])
    assert.deepEqual(textEvents, [
      '› first\n',
      '[queued: Message queued (position 1). Will run after current turn.]\n',
      '[Request interrupted by user]\n',
      '────────────\n',
      '[Queue cleared (1 pending message discarded after interrupt).]\n',
    ])
  })

  // ── Interrupt queue policy parity (claude/opencode block "send now") ──────
  // On interrupt the driver now mirrors claude-session-controller.js ~L690-704:
  //   - _forceFlushQueue (set by the WS "send now" atomic flush or the HTTP
  //     /interrupt?andFlush route) → drain the queue as the next turn, always.
  //   - auto_flush_queue_on_interrupt ON (default) → drain on interrupt too.
  //   - auto_flush OFF + no _forceFlushQueue → discard (the test above).
  // This makes the codex block-mode queue tray meaningful: "立刻发送"
  // (send now) and a plain stop both preserve queued messages by default.

  it('forceFlush on interrupt drains the queued message as the next turn (send-now parity)', async () => {
    const reruns = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    // auto_flush OFF — forceFlush must win regardless (the send-now contract).
    const store = {
      getSetting(key) {
        if (key === 'auto_flush_queue_on_interrupt') return '0'
        return null
      },
    }
    const FakeCodex = createCodexImplFactory([
      { signalError: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: () => {},
      codexBroadcastEvent: () => {},
      rerunTurn: (...args) => { reruns.push(args) },
      CodexImpl: FakeCodex,
    })

    const cs = baseClientState()
    cs.codexThreadId = 'thread-x'

    const run = driver.runCodexTurn(cs, 'first', 'p:codex:t', '/tmp/w')
    await Promise.resolve()
    await driver.runCodexTurn(cs, 'queued send-now', 'p:codex:t', '/tmp/w')

    assert.equal(typeof cs.currentProc?.kill, 'function')
    cs._forceFlushQueue = true
    cs.currentProc.kill('SIGINT')
    await run
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(reruns.length, 1, 'forceFlush must drain the queued message as the next turn')
    assert.equal(reruns[0][0], cs)
    assert.equal(reruns[0][1], 'queued send-now')
    assert.deepEqual(cs.queue, [])
    assert.equal(cs._forceFlushQueue, false, '_forceFlushQueue must be reset after draining')
  })

  it('auto-flush on interrupt (default) drains the queued message as the next turn', async () => {
    const reruns = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const store = { getSetting() { return null } } // auto_flush default ON
    const FakeCodex = createCodexImplFactory([
      { signalError: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: () => {},
      codexBroadcastEvent: () => {},
      rerunTurn: (...args) => { reruns.push(args) },
      CodexImpl: FakeCodex,
    })

    const cs = baseClientState()
    cs.codexThreadId = 'thread-y'

    const run = driver.runCodexTurn(cs, 'first', 'p:codex:t', '/tmp/w')
    await Promise.resolve()
    await driver.runCodexTurn(cs, 'queued auto', 'p:codex:t', '/tmp/w')

    assert.equal(typeof cs.currentProc?.kill, 'function')
    // No _forceFlushQueue — auto_flush default must still drain on interrupt.
    cs.currentProc.kill('SIGINT')
    await run
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(reruns.length, 1, 'auto-flush default must drain the queued message as the next turn')
    assert.equal(reruns[0][1], 'queued auto')
    assert.deepEqual(cs.queue, [])
  })

  it('resumes the same codex thread after an interrupt (thread id preserved)', async () => {
    // E2e core guarantee: interrupt must NOT discard the codexThreadId; the
    // next turn resumes the same thread (conversation continuity), mirroring
    // claude session resume. This is the "stop → resume same thread" red line.
    const reruns = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const store = { getSetting() { return null } }
    const FakeCodex = createCodexImplFactory([
      {
        signalError: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      },
      {
        events: [
          { type: 'thread.started', thread_id: 'thread-resume' },
          { type: 'turn.completed', usage: {} },
        ],
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: () => {},
      codexBroadcastEvent: () => {},
      rerunTurn: (...args) => { reruns.push(args) },
      CodexImpl: FakeCodex,
    })

    const cs = baseClientState()
    // First turn establishes the thread id.
    cs.codexThreadId = 'thread-resume'

    const run = driver.runCodexTurn(cs, 'first', 'p:codex:t', '/tmp/w')
    await Promise.resolve()
    await driver.runCodexTurn(cs, 'after-interrupt', 'p:codex:t', '/tmp/w')

    cs.currentProc.kill('SIGINT')
    await run
    await new Promise((resolve) => setImmediate(resolve))

    // The interrupt must not clear the thread id; the drained next turn resumes it.
    assert.equal(cs.codexThreadId, 'thread-resume', 'thread id must survive interrupt')
    assert.equal(reruns.length, 1, 'queued message must drain after interrupt')
    assert.equal(reruns[0][1], 'after-interrupt')

    // The drained turn runs via rerunTurn — invoke it and assert it resumes the
    // same thread (resumeThread called with the preserved id).
    await driver.runCodexTurn(reruns[0][0], reruns[0][1], reruns[0][2], reruns[0][3])
    assert.equal(calls.threadCalls[1].mode, 'resume', 'next turn must resume the existing thread')
    assert.equal(calls.threadCalls[1].threadId, 'thread-resume', 'must resume the SAME thread id')
  })

  // ── Cut 2: codex binary resolution & model passthrough ───────────────────
  // When codex_path_override is unset, the driver defaults to the
  // user-installed CLI at ~/.local/lib/npm-global/bin/codex (0.144+, supports
  // gpt-5.6-sol). If that file is missing too, it falls back to the SDK's
  // bundled 0.137 codex and warns once per session via onBundledCodexFallback.

  function minimalPlan() {
    return [{ events: [{ type: 'thread.started', thread_id: 't-x' }, { type: 'turn.completed', usage: {} }] }]
  }

  function baseClientState() {
    return { codexThreadId: null, busy: false, turnCount: 0, queue: [], clients: new Set(), scrollback: '' }
  }

  it('defaults codexPathOverride to the user-installed CLI and passes codex_model through', async () => {
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const fallbackCalls = []
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    const codexBin = join(home, '.local', 'lib', 'npm-global', 'bin')
    mkdirSync(codexBin, { recursive: true })
    writeFileSync(join(codexBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    try {
      const store = {
        getSetting(key) {
          if (key === 'codex_model') return 'gpt-5.6-sol'
          return null
        },
      }
      const FakeCodex = createCodexImplFactory(minimalPlan(), calls)
      const driver = createCodexSdkDriver({
        store,
        codexBroadcast: () => {},
        codexBroadcastEvent: () => {},
        rerunTurn: () => {},
        CodexImpl: FakeCodex,
        home,
        onBundledCodexFallback: () => { fallbackCalls.push('fallback') },
      })
      const cs = baseClientState()
      await driver.runCodexTurn(cs, 'hi', 'p:codex:t', '/tmp/w')

      assert.equal(fallbackCalls.length, 0, 'bundled fallback must NOT fire when user CLI exists')
      assert.equal(calls.codexOptions.length, 1)
      assert.equal(calls.codexOptions[0].codexPathOverride, join(codexBin, 'codex'))
      assert.equal(calls.threadCalls[0].options.model, 'gpt-5.6-sol')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('falls back to bundled codex and warns exactly once when the user-installed CLI is missing', async () => {
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const fallbackCalls = []
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    // NOTE: ~/.local/lib/npm-global/bin/codex intentionally NOT created
    try {
      const store = { getSetting() { return null } }
      const FakeCodex = createCodexImplFactory([
        ...minimalPlan(),
        { events: [{ type: 'turn.completed', usage: {} }] },
      ], calls)
      const driver = createCodexSdkDriver({
        store,
        codexBroadcast: () => {},
        codexBroadcastEvent: () => {},
        rerunTurn: () => {},
        CodexImpl: FakeCodex,
        home,
        onBundledCodexFallback: (csArg) => { fallbackCalls.push(csArg) },
      })
      const cs = baseClientState()
      await driver.runCodexTurn(cs, 'hi', 'p:codex:t', '/tmp/w')

      assert.equal(fallbackCalls.length, 1, 'bundled fallback must fire on first turn')
      assert.equal(fallbackCalls[0], cs, 'callback must receive the client state')
      assert.equal(calls.codexOptions.length, 1)
      assert.equal(calls.codexOptions[0].codexPathOverride, undefined, 'no override when user CLI missing')

      await driver.runCodexTurn(cs, 'again', 'p:codex:t', '/tmp/w')
      assert.equal(fallbackCalls.length, 1, 'bundled fallback must fire only once per session')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('honors an explicit codex_path_override even when the user-installed CLI exists', async () => {
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const fallbackCalls = []
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    const codexBin = join(home, '.local', 'lib', 'npm-global', 'bin')
    mkdirSync(codexBin, { recursive: true })
    writeFileSync(join(codexBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    try {
      const store = {
        getSetting(key) {
          if (key === 'codex_path_override') return '/custom/codex'
          if (key === 'codex_model') return 'gpt-5.6-sol'
          return null
        },
      }
      const FakeCodex = createCodexImplFactory(minimalPlan(), calls)
      const driver = createCodexSdkDriver({
        store,
        codexBroadcast: () => {},
        codexBroadcastEvent: () => {},
        rerunTurn: () => {},
        CodexImpl: FakeCodex,
        home,
        onBundledCodexFallback: () => { fallbackCalls.push('fallback') },
      })
      const cs = baseClientState()
      await driver.runCodexTurn(cs, 'hi', 'p:codex:t', '/tmp/w')

      assert.equal(fallbackCalls.length, 0, 'explicit override must not trigger bundled fallback')
      assert.equal(calls.codexOptions[0].codexPathOverride, '/custom/codex')
      assert.equal(calls.threadCalls[0].options.model, 'gpt-5.6-sol')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
