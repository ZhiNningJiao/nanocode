import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createClaudeSessionController } from '../../terminal/claude-session-controller.js'

// Regression: the force-unwedge branch of _interruptRunningClaudeTurn
// (busy=true, currentProc=null — e.g. tmux fallback leaked busy) used to call
// _emitAgentStop(), a helper that only exists on the archived p1p5-plugin-host
// line. The orphan call threw ReferenceError mid-unwedge: busy was cleared but
// the result broadcast and stranded-queue drain never ran, and the HTTP route
// 500'd. This suite drives the wedge through the public handleInterrupt surface.

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

// Minimal self-completing streaming queryImpl: every user message immediately
// yields init + result success, so a drained queue message can run to
// completion without a real claude process.
function makeInstantQueryImpl() {
  return function queryImpl({ prompt }) {
    const eventBuffer = []
    const eventWaiters = []
    let closed = false

    function pushEvent(ev) {
      const waiter = eventWaiters.shift()
      if (waiter) waiter({ value: ev, done: false })
      else eventBuffer.push(ev)
    }

    function endStream() {
      closed = true
      while (eventWaiters.length) eventWaiters.shift()({ value: undefined, done: true })
    }

    ;(async () => {
      try {
        for await (const _msg of prompt) {
          pushEvent({ type: 'system', subtype: 'init', session_id: 'mock-session' })
          await delay(10)
          pushEvent({ type: 'result', subtype: 'success', session_id: 'mock-session' })
        }
      } catch { /* stream closed */ }
      endStream()
    })()

    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (eventBuffer.length) return Promise.resolve({ value: eventBuffer.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => eventWaiters.push(resolve))
          },
        }
      },
      interrupt: async () => {},
      close: async () => { endStream() },
    }
  }
}

function invokeInterrupt(controller, projectId, tabId, { force = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      params: { id: projectId, tabId },
      query: force ? { force: '1' } : {},
      body: {},
      headers: {},
    }
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
    }
    try {
      controller.handleInterrupt(req, res)
    } catch (err) {
      reject(err)
    }
  })
}

describe('claude force interrupt unwedge (busy=true, currentProc=null)', () => {
  it('force interrupt settles the wedged turn and drains stranded queued messages', async () => {
    const tempRoot = makeTempDir('nanocode-unwedge-')
    const homeDir = path.join(tempRoot, 'home')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectCwd, { recursive: true })

    const store = createStore(':memory:')
    const project = store.createProject('Unwedge Project', projectCwd)
    const tab = store.createTab(project.id, { type: 'claude', label: 'unwedge' })
    const controller = createClaudeSessionController({
      store,
      home: homeDir,
      testQueryImpl: makeInstantQueryImpl(),
    })

    const ws = new MockWs()
    controller.handleTerminalWs(ws)
    ws.emit('message', JSON.stringify({
      type: 'attach',
      projectId: project.id,
      sessionType: 'bash',
      tabId: tab.id,
      cols: 120,
      rows: 40,
    }))

    const sessionKey = `${project.id}:claude:${tab.id}`
    const cs = await waitUntil(() => controller.claudeSessions.get(sessionKey), 3000, 'claude session attach')

    // Reproduce the real wedge: busy leaked true with no running process,
    // and a user message stranded in the in-memory queue.
    cs.busy = true
    cs.currentProc = null
    cs.queue = ['STRANDED_MSG']

    const res = await invokeInterrupt(controller, project.id, tab.id, { force: true })
    assert.equal(res.statusCode, 200, `force unwedge must not 500 (got ${JSON.stringify(res.payload)})`)
    assert.equal(res.payload.ok, true)
    assert.equal(res.payload.unwedged, true)
    assert.equal(cs.busy, false, 'busy must be cleared by the unwedge')

    // The settled turn is broadcast so the UI stops the spinner.
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'result' && m.event?.subtype === 'error_during_execution'),
      3000,
      'synthetic error_during_execution result broadcast'
    )

    // The stranded queued message must run as a fresh turn (mock completes it).
    await waitUntil(
      () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'result' && m.event?.subtype === 'success'),
      4000,
      'drained queue message ran as a fresh turn'
    )
    assert.equal(cs.queue.length, 0, 'stranded queue must be drained')

    store.close()
    ws.close()
  })

  it('soft interrupt on a wedged session still reports not busy (no unwedge without force)', async () => {
    const tempRoot = makeTempDir('nanocode-unwedge-soft-')
    const homeDir = path.join(tempRoot, 'home')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectCwd, { recursive: true })

    const store = createStore(':memory:')
    const project = store.createProject('Unwedge Soft Project', projectCwd)
    const tab = store.createTab(project.id, { type: 'claude', label: 'unwedge-soft' })
    const controller = createClaudeSessionController({
      store,
      home: homeDir,
      testQueryImpl: makeInstantQueryImpl(),
    })

    const ws = new MockWs()
    controller.handleTerminalWs(ws)
    ws.emit('message', JSON.stringify({
      type: 'attach',
      projectId: project.id,
      sessionType: 'bash',
      tabId: tab.id,
      cols: 120,
      rows: 40,
    }))

    const sessionKey = `${project.id}:claude:${tab.id}`
    const cs = await waitUntil(() => controller.claudeSessions.get(sessionKey), 3000, 'claude session attach')

    cs.busy = true
    cs.currentProc = null

    const res = await invokeInterrupt(controller, project.id, tab.id, { force: false })
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.ok, false)
    assert.equal(res.payload.reason, 'not busy')
    // Soft interrupt must not silently unwedge — that is the force path's job.
    assert.equal(cs.busy, true)

    store.close()
    ws.close()
  })
})
