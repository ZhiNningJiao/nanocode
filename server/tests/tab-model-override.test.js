import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'
import { createCodexSdkDriver } from '../../terminal/codex-sdk-driver.js'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'

const tempDirs = []

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

// ---- codex driver harness (from codex-sdk-driver.test.js) ----

function createCodexImplFactory(plans, calls) {
  function makeThread(mode, threadId, options) {
    calls.threadCalls.push({ mode, threadId, options })
    return {
      runStreamedTurn(prompt) {
        calls.turnCalls.push({ prompt })
        const plan = plans.shift() || { events: [] }
        async function* run() {
          for (const event of plan.events || []) yield event
        }
        const iterator = run()
        iterator.interrupt = async () => {}
        iterator.close = async () => {}
        return iterator
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

function codexDriverHarness({ store, cs }) {
  const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
  const FakeCodex = createCodexImplFactory(
    [
      {
        events: [
          { type: 'thread.started', thread_id: 'thread-x' },
          { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: 'ok' } },
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
        ],
      },
    ],
    calls
  )
  const driver = createCodexSdkDriver({
    store,
    codexBroadcast: (_cs, text) => { _cs.scrollback += text },
    codexBroadcastEvent: () => {},
    codexBroadcastStreamText: () => {},
    rerunTurn: () => { throw new Error('rerunTurn should not be called') },
    CodexImpl: FakeCodex,
  })
  return { driver, calls }
}

// ---- claude sdk driver harness (from claude-sdk-driver.test.js) ----

function makeClaudeQueryFromPlan(plan, calls) {
  let callIndex = 0
  return ({ prompt, options }) => {
    calls.push({ prompt, options })
    const current = plan[callIndex++] || { events: [] }
    async function* run() {
      for (const event of current.events || []) yield event
      if (current.waitFor) await current.waitFor
      if (current.error) throw current.error
    }
    const iterator = run()
    iterator.interrupt = async () => { current.onInterrupt?.() }
    iterator.close = async () => { current.onClose?.() }
    return iterator
  }
}

function claudeDriverHarness({ store, cs }) {
  const calls = []
  const metadataUpdates = []
  const storeWithMeta = {
    getSetting: store.getSetting.bind(store),
    updateTabMetadata: (projectId, tabId, patch) => metadataUpdates.push({ projectId, tabId, patch }),
  }
  const queryImpl = makeClaudeQueryFromPlan(
    [
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
          { type: 'assistant', session_id: 'sdk-session', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
          { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'OK' },
        ],
      },
    ],
    calls
  )
  const driver = createClaudeSdkDriver({
    store: storeWithMeta,
    claudeBroadcast: () => {},
    rerunTurn: () => { throw new Error('rerunTurn should not be called') },
    queryImpl,
  })
  return { driver, calls, metadataUpdates }
}

// ---- HTTP route harness (from claude-interrupt-route.test.js) ----

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

function invokeRoute(router, method, url, body = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, body, query: {}, headers: {} }
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
      end(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
    }
    router.handle(req, res, (err) => {
      if (err) reject(err)
      else resolve({ statusCode: res.statusCode, payload: undefined })
    })
  })
}

// ===========================================================================

describe('tab model override (cross-tab /model isolation)', () => {
  it('store round-trips modelOverride and effortOverride on a tab', () => {
    const store = createStore(':memory:')
    const project = store.createProject('P', '/tmp/p')
    const tab = store.createTab(project.id, { type: 'claude', label: 'c1' })

    const updated = store.updateTabMetadata(project.id, tab.id, {
      modelOverride: 'claude-opus-4-8',
      effortOverride: 'high',
    })
    assert.equal(updated.modelOverride, 'claude-opus-4-8')
    assert.equal(updated.effortOverride, 'high')

    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.modelOverride, 'claude-opus-4-8')
    assert.equal(fetched.effortOverride, 'high')

    const listed = store.listTabs(project.id)
    const mine = listed.find((t) => t.id === tab.id)
    assert.equal(mine.modelOverride, 'claude-opus-4-8')
    assert.equal(mine.effortOverride, 'high')
  })

  it('clears the override when given null (the normalized form the route sends)', () => {
    const store = createStore(':memory:')
    const project = store.createProject('P', '/tmp/p')
    const tab = store.createTab(project.id, { type: 'claude', label: 'c1' })

    store.updateTabMetadata(project.id, tab.id, { modelOverride: 'opus' })
    assert.equal(store.getTab(project.id, tab.id).modelOverride, 'opus')

    // The PATCH route normalizes '' → null before calling updateTabMetadata;
    // the store itself passes through whatever it is given. Drivers and the
    // frontend both read `tab.modelOverride || global`, so null/undefined/''
    // all correctly fall back to the global default.
    store.updateTabMetadata(project.id, tab.id, { modelOverride: null })
    assert.equal(store.getTab(project.id, tab.id).modelOverride, null)
  })

  it('two tabs keep independent modelOverride values (no cross-tab sync)', () => {
    const store = createStore(':memory:')
    const project = store.createProject('P', '/tmp/p')
    const a = store.createTab(project.id, { type: 'claude', label: 'A' })
    const b = store.createTab(project.id, { type: 'claude', label: 'B' })

    store.updateTabMetadata(project.id, a.id, { modelOverride: 'claude-opus-4-8' })
    store.updateTabMetadata(project.id, b.id, { modelOverride: 'claude-sonnet-4-6' })

    assert.equal(store.getTab(project.id, a.id).modelOverride, 'claude-opus-4-8')
    assert.equal(store.getTab(project.id, b.id).modelOverride, 'claude-sonnet-4-6')

    // Re-set A — B must not change.
    store.updateTabMetadata(project.id, a.id, { modelOverride: 'claude-haiku' })
    assert.equal(store.getTab(project.id, a.id).modelOverride, 'claude-haiku')
    assert.equal(store.getTab(project.id, b.id).modelOverride, 'claude-sonnet-4-6')
  })
})

describe('codex sdk driver honors tab model override', () => {
  it('uses cs.codexModelOverride in preference to the global codex_model setting', async () => {
    const store = {
      getSetting(key) {
        if (key === 'codex_model') return 'gpt-5-codex'
        if (key === 'codex_effort') return 'high'
        if (key === 'codex_sandbox_mode') return 'workspace-write'
        if (key === 'codex_path_override') return '/tmp/codex-bin'
        return null
      },
      updateTabMetadata() {},
    }
    const cs = {
      codexThreadId: null,
      codexModelOverride: 'gpt-5.6-sol',
      busy: false,
      turnCount: 0,
      queue: [],
      clients: new Set(),
      scrollback: '',
    }
    const { driver, calls } = codexDriverHarness({ store, cs })
    await driver.runCodexTurn(cs, 'hi', 'project-1:codex:tab-1', '/tmp/w')

    assert.equal(calls.threadCalls.length, 1)
    assert.equal(calls.threadCalls[0].options.model, 'gpt-5.6-sol',
      'cs.codexModelOverride must win over the global codex_model')
  })

  it('falls back to the global codex_model when no tab override is set', async () => {
    const store = {
      getSetting(key) {
        if (key === 'codex_model') return 'gpt-5-codex'
        if (key === 'codex_effort') return 'high'
        if (key === 'codex_sandbox_mode') return 'workspace-write'
        if (key === 'codex_path_override') return '/tmp/codex-bin'
        return null
      },
      updateTabMetadata() {},
    }
    const cs = {
      codexThreadId: null,
      codexModelOverride: null,
      busy: false,
      turnCount: 0,
      queue: [],
      clients: new Set(),
      scrollback: '',
    }
    const { driver, calls } = codexDriverHarness({ store, cs })
    await driver.runCodexTurn(cs, 'hi', 'project-1:codex:tab-1', '/tmp/w')

    assert.equal(calls.threadCalls[0].options.model, 'gpt-5-codex',
      'null override must fall through to the global codex_model')
  })

  it('passes gpt-5.6-sol through with no whitelist blocking', async () => {
    const store = {
      getSetting(key) { return null },
      updateTabMetadata() {},
    }
    const cs = {
      codexThreadId: null,
      codexModelOverride: 'gpt-5.6-sol',
      busy: false,
      turnCount: 0,
      queue: [],
      clients: new Set(),
      scrollback: '',
    }
    const { driver, calls } = codexDriverHarness({ store, cs })
    await driver.runCodexTurn(cs, 'hi', 'project-1:codex:tab-1', '/tmp/w')

    assert.equal(calls.threadCalls[0].options.model, 'gpt-5.6-sol',
      'gpt-5.6-sol must reach the thread options unmodified (no model whitelist)')
  })
})

describe('claude sdk driver honors tab model/effort override', () => {
  it('uses cs.claudeModelOverride in preference to the global claude_model', async () => {
    const store = {
      getSetting(key) {
        if (key === 'claude_model') return 'claude-opus-4-8'
        if (key === 'claude_effort') return 'high'
        if (key === 'global_permission') return 'full-auto'
        return null
      },
    }
    const cs = {
      claudeSessionId: 'initial-session',
      claudeModelOverride: 'claude-sonnet-4-6',
      claudeEffortOverride: 'low',
      busy: false,
      turnCount: 0,
      queue: [],
      history: [],
      clients: new Set(),
    }
    const { driver, calls } = claudeDriverHarness({ store, cs })
    await driver.runSdkTurn(cs, 'hello', 'project-1:claude:tab-9', process.cwd())

    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.model, 'claude-sonnet-4-6',
      'cs.claudeModelOverride must win over the global claude_model')
    assert.equal(calls[0].options.effort, 'low',
      'cs.claudeEffortOverride must win over the global claude_effort')
  })

  it('falls back to the global claude_model when no tab override is set', async () => {
    const store = {
      getSetting(key) {
        if (key === 'claude_model') return 'claude-opus-4-8'
        if (key === 'claude_effort') return 'high'
        if (key === 'global_permission') return 'full-auto'
        return null
      },
    }
    const cs = {
      claudeSessionId: 'initial-session',
      claudeModelOverride: null,
      claudeEffortOverride: null,
      busy: false,
      turnCount: 0,
      queue: [],
      history: [],
      clients: new Set(),
    }
    const { driver, calls } = claudeDriverHarness({ store, cs })
    await driver.runSdkTurn(cs, 'hello', 'project-1:claude:tab-9', process.cwd())

    assert.equal(calls[0].options.model, 'claude-opus-4-8')
    assert.equal(calls[0].options.effort, 'high')
  })
})

describe('PATCH /api/projects/:id/tabs/:tabId/model', () => {
  it('persists modelOverride on one tab without touching a sibling tab', async () => {
    const tempRoot = makeTempDir('nanocode-tab-model-route-')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(projectCwd, { recursive: true })

    const store = createStore(':memory:')
    const project = store.createProject('Route Project', projectCwd)
    const a = store.createTab(project.id, { type: 'claude', label: 'A' })
    const b = store.createTab(project.id, { type: 'claude', label: 'B' })

    const { router } = createTerminalRoutes(store)

    const resA = await invokeRoute(
      router,
      'PATCH',
      `/api/projects/${project.id}/tabs/${a.id}/model`,
      { modelOverride: 'claude-opus-4-8' }
    )
    assert.equal(resA.statusCode, 200)
    assert.equal(resA.payload.modelOverride, 'claude-opus-4-8')

    // Sibling B was never touched (its modelOverride is still undefined —
    // createTab does not initialize it; the drivers read `tab.modelOverride
    // || global`, so undefined correctly means "follow the global default").
    assert.equal(store.getTab(project.id, a.id).modelOverride, 'claude-opus-4-8')
    assert.equal(store.getTab(project.id, b.id).modelOverride, undefined)
  })

  it('rejects a non-claude/codex tab with 400', async () => {
    const tempRoot = makeTempDir('nanocode-tab-model-route-')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(projectCwd, { recursive: true })

    const store = createStore(':memory:')
    const project = store.createProject('Route Project', projectCwd)
    const bash = store.createTab(project.id, { type: 'bash', label: 'bash' })

    const { router } = createTerminalRoutes(store)
    const res = await invokeRoute(
      router,
      'PATCH',
      `/api/projects/${project.id}/tabs/${bash.id}/model`,
      { modelOverride: 'claude-opus-4-8' }
    )
    assert.equal(res.statusCode, 400)
    assert.match(res.payload.error, /only supported on claude\/codex/)
  })

  it('returns 404 for an unknown tab', async () => {
    const tempRoot = makeTempDir('nanocode-tab-model-route-')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(projectCwd, { recursive: true })

    const store = createStore(':memory:')
    const project = store.createProject('Route Project', projectCwd)

    const { router } = createTerminalRoutes(store)
    const res = await invokeRoute(
      router,
      'PATCH',
      `/api/projects/${project.id}/tabs/nope/model`,
      { modelOverride: 'claude-opus-4-8' }
    )
    assert.equal(res.statusCode, 404)
  })

  it('broadcasts the updated tab list over the tabs websocket', async () => {
    const tempRoot = makeTempDir('nanocode-tab-model-route-')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(projectCwd, { recursive: true })

    const store = createStore(':memory:')
    const project = store.createProject('Route Project', projectCwd)
    const tab = store.createTab(project.id, { type: 'claude', label: 'c1' })

    const { router, handleTabsWs } = createTerminalRoutes(store)

    const ws = new MockWs()
    handleTabsWs(ws)
    // Subscribe the ws to this project's tab feed.
    ws.emit('message', JSON.stringify({ type: 'subscribe', projectId: project.id }))

    await invokeRoute(
      router,
      'PATCH',
      `/api/projects/${project.id}/tabs/${tab.id}/model`,
      { modelOverride: 'claude-opus-4-8' }
    )

    // The route calls broadcastTabs → a tabs:update with the new modelOverride.
    // ws.sent has at least two tabs:update messages: (1) the immediate snapshot
    // sent on subscribe (BEFORE the PATCH, so no modelOverride yet), and
    // (2) the broadcast after the PATCH. Take the LAST one.
    const tabsUpdates = ws.sent.filter((m) => m.type === 'tabs:update')
    assert.ok(tabsUpdates.length >= 2, 'expected subscribe snapshot + PATCH broadcast')
    const lastUpdate = tabsUpdates[tabsUpdates.length - 1]
    const broadcasted = (lastUpdate.tabs || []).find((t) => t.id === tab.id)
    assert.ok(broadcasted, 'the patched tab must appear in the broadcast')
    assert.equal(broadcasted.modelOverride, 'claude-opus-4-8')
  })
})
