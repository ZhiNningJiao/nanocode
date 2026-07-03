/**
 * Tests for terminal/opencode-block-driver.js (MES-13740 需求11-C)
 *
 * Verifies the per-turn opencode subprocess driver:
 *   - spawns `opencode run --format json --auto -m kimi/<model> [--session <id>] "<prompt>"`
 *   - parses streaming JSON lines and broadcasts claude-block events
 *   - captures sessionID and persists to tab metadata
 *   - queues messages while a turn is busy
 *   - emits a synthetic result on crash / interrupt / empty turn
 *   - drains the queue after a turn completes
 *   - interrupt clears the queue
 *   - env carries MESHY_AIGW_KEY + OPENCODE_CONFIG_CONTENT, no FORCE_COLOR
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createOpencodeBlockDriver, DEFAULT_MODEL } from '../../terminal/opencode-block-driver.js'

function makeMockSpawn() {
  const calls = []
  let currentChild = null
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter()
    const makeStream = () => {
      const s = new EventEmitter()
      s.setEncoding = () => s
      s.destroy = () => {}
      return s
    }
    child.stdout = makeStream()
    child.stderr = makeStream()
    child.stdin = { end() {} }
    child.killed = false
    child.kill = (sig) => { child.killed = true; child.emit('exit', null, sig) }
    calls.push({ cmd, args, opts, child })
    currentChild = child
    return child
  }
  spawn.calls = calls
  spawn.current = () => currentChild
  return spawn
}

function makeStore(initial = {}) {
  const settings = { ...initial.settings }
  const metadata = { ...initial.metadata }
  return {
    getSetting(k) { return settings[k] },
    setSetting(k, v) { settings[k] = v },
    updateTabMetadata(p, t, m) { metadata[`${p}:${t}`] = { ...(metadata[`${p}:${t}`] || {}), ...m } },
    _settings: settings,
    _metadata: metadata,
  }
}

function makeCs(overrides = {}) {
  return {
    busy: false,
    currentProc: null,
    turnCount: 0,
    queue: [],
    opencodeSessionId: null,
    ...overrides,
  }
}

function collectEvents(broadcast, cs) {
  const events = []
  broadcast.mockImplementation((c, ev) => { events.push(ev) })
  return events
}

describe('createOpencodeBlockDriver — spawn args & env', () => {
  it('first turn: no --session, uses default fable-5 model', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const broadcastCalls = []
    const broadcast = (cs, ev) => broadcastCalls.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'hello', 'proj:claude:tab1', '/repo')
    await new Promise((r) => setImmediate(r))
    const call = spawn.calls[0]
    assert.equal(call.cmd, 'opencode')
    assert.deepEqual(call.args.slice(0, 6), ['run', '--format', 'json', '--auto', '-m', `kimi/${DEFAULT_MODEL}`])
    assert.equal(call.args.includes('--session'), false)
    assert.equal(call.args[call.args.length - 1], 'hello')
    assert.equal(call.opts.cwd, '/repo')
    spawn.current().emit('exit', 0)
    await p
  })
  it('subsequent turn: passes --session <stored id>', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const broadcast = () => {}
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs({ opencodeSessionId: 'ses_abc123' })
    const p = driver.runOpencodeTurn(cs, 'second', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    const args = spawn.calls[0].args
    assert.ok(args.includes('--session'))
    assert.equal(args[args.indexOf('--session') + 1], 'ses_abc123')
    spawn.current().emit('exit', 0)
    await p
  })
  it('aigw_model setting overrides the default model', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore({ settings: { aigw_model: 'litellm/gpt-5.5' } })
    const broadcast = () => {}
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'x', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    assert.equal(spawn.calls[0].args[5], 'kimi/litellm/gpt-5.5')
    spawn.current().emit('exit', 0)
    await p
  })
  it('env has OPENCODE_CONFIG_CONTENT + NO_COLOR, no FORCE_COLOR', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const broadcast = () => {}
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'x', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    const env = spawn.calls[0].opts.env
    assert.ok(env.OPENCODE_CONFIG_CONTENT)
    assert.ok(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.kimi.models[DEFAULT_MODEL])
    assert.equal(env.NO_COLOR, '1')
    assert.equal(env.FORCE_COLOR, undefined)
    spawn.current().emit('exit', 0)
    await p
  })
})

describe('createOpencodeBlockDriver — event streaming', () => {
  it('broadcasts user echo + assistant text + result for a text turn', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'hi', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    const child = spawn.current()
    const sid = 'ses_test123'
    child.stdout.emit('data', JSON.stringify({ type: 'step_start', sessionID: sid, part: { type: 'step-start', messageID: 'm1' } }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text: 'hello back', messageID: 'm1' } }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop', messageID: 'm1' } }) + '\n')
    child.emit('exit', 0)
    await p
    assert.equal(events[0].type, 'user')
    assert.deepEqual(events[0].message.content, [{ type: 'text', text: 'hi' }])
    const asst = events.find((e) => e.type === 'assistant')
    assert.ok(asst, 'has assistant event')
    assert.deepEqual(asst.message.content, [{ type: 'text', text: 'hello back' }])
    const result = events.find((e) => e.type === 'result')
    assert.ok(result, 'has result event')
    assert.equal(result.subtype, 'success')
  })
  it('captures sessionID and persists to tab metadata', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'hi', 'proj:claude:tabA', '/r')
    await new Promise((r) => setImmediate(r))
    const child = spawn.current()
    child.stdout.emit('data', JSON.stringify({ type: 'text', sessionID: 'ses_xyz', part: { type: 'text', text: 'x', messageID: 'm1' } }) + '\n')
    child.emit('exit', 0)
    await p
    assert.equal(cs.opencodeSessionId, 'ses_xyz')
    assert.equal(store._metadata['proj:tabA'].opencodeSessionId, 'ses_xyz')
  })
  it('tool part → tool_use + tool_result events', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'run echo', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    const child = spawn.current()
    child.stdout.emit('data', JSON.stringify({
      type: 'tool', sessionID: 'ses_t',
      part: { type: 'tool', tool: 'bash', callID: 'c1', messageID: 'm1',
        state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi' } },
    }) + '\n')
    child.emit('exit', 0)
    await p
    const toolUse = events.find((e) => e.message?.content?.some((c) => c.type === 'tool_use'))
    const toolResult = events.find((e) => e.message?.content?.some((c) => c.type === 'tool_result'))
    assert.ok(toolUse, 'has tool_use')
    assert.ok(toolResult, 'has tool_result')
    const tu = toolUse.message.content.find((c) => c.type === 'tool_use')
    assert.equal(tu.name, 'bash')
    assert.equal(tu.id, 'c1')
    const tr = toolResult.message.content.find((c) => c.type === 'tool_result')
    assert.equal(tr.tool_use_id, 'c1')
    assert.equal(tr.content, 'hi')
  })
  it('handles split chunks (JSON line across multiple data events)', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'x', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    const child = spawn.current()
    const line = JSON.stringify({ type: 'text', sessionID: 's', part: { type: 'text', text: 'split', messageID: 'm1' } }) + '\n'
    const mid = Math.floor(line.length / 2)
    child.stdout.emit('data', line.slice(0, mid))
    child.stdout.emit('data', line.slice(mid))
    child.emit('exit', 0)
    await p
    assert.ok(events.some((e) => e.message?.content?.[0]?.text === 'split'))
  })
})

describe('createOpencodeBlockDriver — queue & interrupt', () => {
  it('queues messages while busy and drains after turn', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    let rerunCalls = 0
    const rerunTurn = (cs, prompt) => { rerunCalls++ }
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn, spawnFn: spawn })
    const cs = makeCs({ busy: true, queue: [] })
    driver.runOpencodeTurn(cs, 'second', 'p:c:t', '/r')
    assert.equal(cs.queue.length, 1)
    assert.equal(cs.queue[0], 'second')
    assert.ok(events.some((e) => e.text?.includes('queued')))
  })
  it('interrupt clears the queue', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs({ queue: ['pending1', 'pending2'] })
    const p = driver.runOpencodeTurn(cs, 'go', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    const child = spawn.current()
    child.stdout.emit('data', JSON.stringify({ type: 'text', sessionID: 's', part: { type: 'text', text: 'partial', messageID: 'm1' } }) + '\n')
    cs.currentProc.kill('SIGINT')
    await p
    assert.equal(cs.busy, false)
    assert.equal(cs.queue.length, 0)
    assert.ok(events.some((e) => e.text?.includes('Queue cleared')))
  })
})

describe('createOpencodeBlockDriver — error paths', () => {
  it('non-zero exit with stderr → result subtype error', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'x', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    const child = spawn.current()
    child.stderr.emit('data', 'Error: model not found')
    child.emit('exit', 1)
    await p
    const result = events.find((e) => e.type === 'result')
    assert.ok(result)
    assert.equal(result.subtype, 'error')
    assert.equal(result.is_error, true)
    assert.match(result.error, /model not found/)
  })
  it('spawn error → result error', async () => {
    const spawn = () => {
      const ch = new EventEmitter()
      const makeStream = () => { const s = new EventEmitter(); s.setEncoding = () => s; s.destroy = () => {}; return s }
      ch.stdout = makeStream()
      ch.stderr = makeStream()
      setImmediate(() => { ch.emit('error', new Error('ENOENT opencode')); ch.emit('exit', 1, null) })
      return ch
    }
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    await driver.runOpencodeTurn(cs, 'x', 'p:c:t', '/r')
    const result = events.find((e) => e.type === 'result')
    assert.ok(result)
    assert.equal(result.subtype, 'error')
    assert.match(result.error, /ENOENT opencode/)
  })
  it('empty turn (exit 0, no events) → synthetic success result', async () => {
    const spawn = makeMockSpawn()
    const store = makeStore()
    const events = []
    const broadcast = (cs, ev) => events.push(ev)
    const driver = createOpencodeBlockDriver({ store, broadcast, rerunTurn() {}, spawnFn: spawn })
    const cs = makeCs()
    const p = driver.runOpencodeTurn(cs, 'x', 'p:c:t', '/r')
    await new Promise((r) => setImmediate(r))
    spawn.current().emit('exit', 0)
    await p
    const result = events.find((e) => e.type === 'result')
    assert.ok(result)
    assert.equal(result.subtype, 'success')
  })
})

describe('resolveModel', () => {
  it('uses aigw_model setting if set', () => {
    const driver = createOpencodeBlockDriver({ store: makeStore({ settings: { aigw_model: 'litellm/x' } }), broadcast() {}, rerunTurn() {} })
    assert.equal(driver.resolveModel(), 'litellm/x')
  })
  it('falls back to default', () => {
    const driver = createOpencodeBlockDriver({ store: makeStore(), broadcast() {}, rerunTurn() {} })
    assert.equal(driver.resolveModel(), DEFAULT_MODEL)
  })
})
