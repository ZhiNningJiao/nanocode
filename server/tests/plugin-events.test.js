/**
 * P2: Plugin event coverage tests.
 *
 * Verifies that Core emits structured lifecycle events on the plugin host's
 * event bus so plugins can react to session, project, agent, and health
 * lifecycle changes without touching Core internals.
 *
 * Event contract:
 *   session:create  { sessionKey, cwd }
 *   session:destroy { sessionKey }
 *   project:create  { id, name, cwd }
 *   project:remove  { id }
 *   agent:start     { sessionKey, projectId, tabId, provider }
 *   agent:stop      { sessionKey, projectId, tabId, provider, subtype }
 *   agent:message   { sessionKey, event }
 *   agent:health    { state, reason, session_key, ... }
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createStore } from '../store.js'
import { createPluginHost } from '../plugin-host.js'
import { setPluginHost, getOrCreate, destroySession, destroySessions } from '../../terminal/sessions.js'
import { createTerminalRoutes } from '../../terminal/routes.js'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'
import { createCodexSdkDriver } from '../../terminal/codex-sdk-driver.js'
import { createAgentHealthMonitor } from '../../terminal/agent-health-monitor.js'

// ── session:create / session:destroy ─────────────────────────────────────────

describe('P2: session lifecycle events', () => {
  let host
  let events

  beforeEach(() => {
    events = []
    const store = createStore(':memory:')
    host = createPluginHost({ app: express(), store, broadcastNotify: () => {} })
    host.on('session:create', (e) => events.push(['session:create', e]))
    host.on('session:destroy', (e) => events.push(['session:destroy', e]))
    setPluginHost(host)
  })

  afterEach(() => {
    setPluginHost(null)
  })

  it('emits session:create when a new PTY session is created', () => {
    const key = 'test-proj:bash:tab1'
    const sess = getOrCreate(key, '/bin/true', [], 80, 24, '/tmp')
    assert.ok(sess, 'session should be created')
    const createEvents = events.filter(([t]) => t === 'session:create')
    assert.equal(createEvents.length, 1, 'one session:create event')
    assert.equal(createEvents[0][1].sessionKey, key)
    destroySession(key)
  })

  it('does NOT emit session:create when reusing an existing session', () => {
    const key = 'test-proj:bash:tab2'
    getOrCreate(key, '/bin/true', [], 80, 24, '/tmp')
    getOrCreate(key, '/bin/true', [], 80, 24, '/tmp')
    const createEvents = events.filter(([t]) => t === 'session:create')
    assert.equal(createEvents.length, 1, 'only one session:create for reuse')
    destroySession(key)
  })

  it('emits session:destroy when a session is destroyed by key', () => {
    const key = 'test-proj:bash:tab3'
    getOrCreate(key, '/bin/true', [], 80, 24, '/tmp')
    events.length = 0
    const existed = destroySession(key)
    assert.equal(existed, true)
    const destroyEvents = events.filter(([t]) => t === 'session:destroy')
    assert.equal(destroyEvents.length, 1)
    assert.equal(destroyEvents[0][1].sessionKey, key)
  })

  it('emits session:destroy for each session when destroying all project sessions', () => {
    const projectId = 'test-proj-multi'
    getOrCreate(`${projectId}:bash:tab1`, '/bin/true', [], 80, 24, '/tmp')
    getOrCreate(`${projectId}:bash:tab2`, '/bin/true', [], 80, 24, '/tmp')
    events.length = 0
    destroySessions(projectId)
    const destroyEvents = events.filter(([t]) => t === 'session:destroy')
    assert.equal(destroyEvents.length, 2)
  })
})

// ── project:create / project:remove ──────────────────────────────────────────

describe('P2: project lifecycle events', () => {
  let app
  let store
  let host
  let events

  beforeEach(() => {
    events = []
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    store.setSetting('plugin_monitor_enabled', false)
    host = createPluginHost({ app, store, broadcastNotify: () => {} })
    host.on('project:create', (e) => events.push(['project:create', e]))
    host.on('project:remove', (e) => events.push(['project:remove', e]))
    const { router } = createTerminalRoutes(store, { pluginHost: host })
    app.use(router)
  })

  afterEach(() => {
    try { host.emit('shutdown') } catch {}
  })

  it('emits project:create when a project is created via POST /api/projects', async () => {
    const server = app.listen(0)
    try {
      const { port } = server.address()
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-proj', cwd: '/tmp' }),
      })
      assert.equal(res.status, 201)
      const body = await res.json()
      const createEvents = events.filter(([t]) => t === 'project:create')
      assert.equal(createEvents.length, 1)
      assert.equal(createEvents[0][1].id, body.id)
      assert.equal(createEvents[0][1].name, 'test-proj')
      assert.equal(createEvents[0][1].cwd, '/tmp')
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('emits project:remove when a project is deleted via DELETE /api/projects/:id', async () => {
    const project = store.createProject('del-proj', '/tmp')
    const server = app.listen(0)
    try {
      const { port } = server.address()
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
        method: 'DELETE',
      })
      assert.equal(res.status, 204)
      const removeEvents = events.filter(([t]) => t === 'project:remove')
      assert.equal(removeEvents.length, 1)
      assert.equal(removeEvents[0][1].id, project.id)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

// ── agent:start / agent:stop (via driver callbacks) ──────────────────────────

describe('P2: agent:start / agent:stop via claude SDK driver', () => {
  it('calls onTurnStart when a turn begins and onTurnEnd when it finishes', async () => {
    const starts = []
    const ends = []
    const store = {
      getSetting(key) {
        if (key === 'claude_model') return 'test-model'
        if (key === 'claude_effort') return 'high'
        if (key === 'global_permission') return 'full-auto'
        if (key === 'claude_session_fallback') return 'continue'
        return null
      },
      updateTabMetadata() {},
    }
    const queryImpl = ({ prompt, options }) => {
      async function* run() {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-sess', tools: [] }
        yield { type: 'result', subtype: 'success', session_id: 'sdk-sess', result: 'OK' }
      }
      const it = run()
      it.interrupt = async () => {}
      it.close = async () => {}
      return it
    }

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: () => {},
      rerunTurn: () => {},
      queryImpl,
      onTurnStart: (cs, sessionKey) => starts.push({ sessionKey }),
      onTurnEnd: (cs, sessionKey, info) => ends.push({ sessionKey, info }),
    })

    const cs = {
      claudeSessionId: 'test-sess',
      busy: false,
      turnCount: 0,
      queue: [],
      history: [],
      clients: new Set(),
    }

    await driver.runSdkTurn(cs, 'hello', 'proj:claude:tab1', '/tmp')

    assert.equal(starts.length, 1, 'onTurnStart should fire once')
    assert.equal(starts[0].sessionKey, 'proj:claude:tab1')
    assert.equal(ends.length, 1, 'onTurnEnd should fire once')
    assert.equal(ends[0].sessionKey, 'proj:claude:tab1')
  })

  it('does NOT call onTurnStart when the message is queued (already busy)', async () => {
    const starts = []
    const store = {
      getSetting() { return null },
      updateTabMetadata() {},
    }
    const queryImpl = ({ prompt, options }) => {
      async function* run() { yield { type: 'result', subtype: 'success' } }
      const it = run()
      it.interrupt = async () => {}
      it.close = async () => {}
      return it
    }

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: () => {},
      rerunTurn: () => {},
      queryImpl,
      onTurnStart: (cs, sessionKey) => starts.push(sessionKey),
      onTurnEnd: () => {},
    })

    const cs = {
      claudeSessionId: 'test-sess2',
      busy: true,
      turnCount: 1,
      queue: [],
      history: [],
      clients: new Set(),
    }

    await driver.runSdkTurn(cs, 'queued msg', 'proj:claude:tab2', '/tmp')
    assert.equal(starts.length, 0, 'should not start when already busy')
  })
})

describe('P2: agent:start / agent:stop via codex SDK driver', () => {
  it('calls onTurnStart when a codex turn begins and onTurnEnd when it finishes', async () => {
    const starts = []
    const ends = []
    const store = {
      getSetting(key) {
        if (key === 'codex_model') return 'gpt-5-codex'
        if (key === 'codex_effort') return 'high'
        if (key === 'codex_sandbox_mode') return 'workspace-write'
        return null
      },
      updateTabMetadata() {},
    }

    class FakeCodex {
      constructor() {}
      startThread() {
        return {
          async runStreamed() {
            async function* events() {
              yield { type: 'turn.completed', thread_id: 'codex-thread-1' }
            }
            return { events: events() }
          },
        }
      }
    }

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: () => {},
      codexBroadcastEvent: () => {},
      codexBroadcastStreamText: () => {},
      rerunTurn: () => {},
      onTurnStart: (cs, sessionKey) => starts.push({ sessionKey }),
      onTurnEnd: (cs, sessionKey, info) => ends.push({ sessionKey, info }),
    })

    const cs = {
      busy: false,
      turnCount: 0,
      queue: [],
      clients: new Set(),
      scrollback: '',
      eventHistory: [],
      codexThreadId: null,
    }

    await driver.runCodexTurn(cs, 'hello', 'proj:codex:tab1', '/tmp')

    assert.equal(starts.length, 1, 'onTurnStart should fire once')
    assert.equal(starts[0].sessionKey, 'proj:codex:tab1')
    assert.equal(ends.length, 1, 'onTurnEnd should fire once')
    assert.equal(ends[0].sessionKey, 'proj:codex:tab1')
  })
})

// ── agent:health bridge ──────────────────────────────────────────────────────

describe('P2: agent:health event bridge', () => {
  it('emits agent:health on the plugin host when the monitor detects a state change', () => {
    const events = []
    const store = createStore(':memory:')
    store.setSetting('agent_health_enabled', true)
    const host = createPluginHost({ app: express(), store, broadcastNotify: () => {} })
    host.on('agent:health', (e) => events.push(e))

    const monitor = createAgentHealthMonitor({ store, autoStart: false })
    // Wire the monitor's notifier to emit on the plugin host
    monitor.setNotifier((payload) => {
      host.emit('agent:health', payload)
    })

    const meta = { sessionKey: 'proj:claude:tab1', projectId: 'proj', tabId: 'tab1', tabType: 'claude', provider: 'claude', source: 'sdk' }
    monitor.startTracking(meta)
    // Feed output that triggers an idle state (no output for idle threshold)
    // We use recordOutput with a rate-limit pattern to trigger a state change
    monitor.recordOutput(meta, 'rate limit exceeded')
    
    // The monitor should have emitted a payload via the notifier
    assert.ok(events.length >= 1, 'at least one agent:health event')
    assert.equal(events[0].type, 'agent_health')
    assert.equal(events[0].session_key, 'proj:claude:tab1')
    assert.equal(events[0].state, 'rate_limited')

    monitor.destroySession('proj:claude:tab1')
    monitor.stop()
  })
})
