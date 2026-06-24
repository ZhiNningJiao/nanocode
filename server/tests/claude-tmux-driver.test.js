import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdirSync, rmSync, existsSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeTmuxDriver } from '../../terminal/claude-tmux-driver.js'

const TEST_DIR = join(tmpdir(), `nanocode-tmux-test-${Date.now()}`)

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createFakeBridgeServer(socketPath) {
  let server
  let connections = []
  let nextConnId = 0
  let handlers = []

  const ready = new Promise((resolve) => {
    server = createServer((socket) => {
      const connId = ++nextConnId
      connections.push(socket)
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          for (const handler of handlers) {
            handler(msg, socket, connId)
          }
        }
      })
      socket.on('close', () => {
        connections = connections.filter((c) => c !== socket)
      })
    })
    server.listen(socketPath, () => resolve())
  })

  function onMessage(handler) {
    handlers.push(handler)
  }

  function broadcast(obj) {
    const line = JSON.stringify(obj) + '\n'
    for (const socket of connections) {
      try { socket.write(line) } catch {}
    }
  }

  function closeConnections() {
    for (const socket of connections.slice()) {
      try { socket.end() } catch {}
    }
    connections = []
  }

  async function close() {
    closeConnections()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  return { ready, onMessage, broadcast, closeConnections, close }
}

describe('claude tmux driver', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  after(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  })

  it('exposes the expected API and reflects tmux availability', () => {
    const driver = createClaudeTmuxDriver({
      store: { getSetting: () => null },
      claudeBroadcast: () => {},
      rerunTurn: () => {},
    })

    assert.equal(driver.name, 'claude_tmux')
    assert.equal(typeof driver.isAvailable, 'function')
    assert.equal(typeof driver.run, 'function')
    assert.equal(typeof driver.interrupt, 'function')
    assert.equal(typeof driver.reset, 'function')
    assert.equal(typeof driver.destroy, 'function')

    // tmux is installed in the CI/dev environment where this suite runs.
    // The driver default is disabled inside the Node test runner via the
    // controller, but the low-level availability check should still be truthful.
    assert.equal(driver.isAvailable(), true)
  })

  it('reconnects to a persistent bridge and resumes the same session id', async () => {
    const sessionKey = 'proj-test:claude:tab-test'

    // Create a fake bridge socket in a temp location. We drive the low-level
    // TmuxBridgeClient directly so the test never launches a real tmux session.
    const socketPath = join(TEST_DIR, 'fake-bridge.sock')
    const bridge = createFakeBridgeServer(socketPath)
    await bridge.ready

    let sessionIdFromBridge = 'bridge-session-abc'
    let turnsSeen = 0

    bridge.onMessage((msg, socket) => {
      if (msg.type === 'user') {
        turnsSeen += 1
        // Simulate the bridge acknowledging the turn with an init event that
        // carries the persistent session id, then a result.
        socket.write(JSON.stringify({
          type: 'event',
          event: { type: 'system', subtype: 'init', session_id: sessionIdFromBridge, tools: [] },
        }) + '\n')
        socket.write(JSON.stringify({
          type: 'event',
          event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
        }) + '\n')
        socket.write(JSON.stringify({
          type: 'turn-done',
          event: { type: 'result', subtype: 'success' },
        }) + '\n')
      }
    })

    const Client = createClaudeTmuxDriver({ store: { getSetting: () => null }, claudeBroadcast: () => {}, rerunTurn: () => {} })._TmuxBridgeClient
    const client = new Client(sessionKey, { onSessionId: (id) => { sessionIdFromBridge = id } })
    client.socketPath = socketPath

    const cs = {
      sessionKey,
      claudeSessionId: 'initial-session',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: false,
    }

    // First connection.
    await client._connectSocket()

    const firstTurn = new Promise((resolve, reject) => {
      const remove = client.onMessage((msg) => {
        if (msg.type === 'turn-done') {
          remove()
          resolve(msg.event)
        }
        if (msg.type === 'event' && msg.event?.type === 'system' && msg.event?.subtype === 'init' && msg.event?.session_id) {
          cs.claudeSessionId = msg.event.session_id
        }
      })
      client.send({ type: 'user', text: 'first turn' })
    })

    await firstTurn
    assert.equal(turnsSeen, 1)
    assert.equal(cs.claudeSessionId, 'bridge-session-abc')

    // Simulate nanocode restart / reconnect: close the socket but keep the
    // (fake) tmux bridge alive. The next turn should reconnect and resume the
    // same session id without launching a new OS process.
    client.close()
    assert.equal(client.connected, false)

    const client2 = new Client(sessionKey, {})
    client2.socketPath = socketPath
    await client2._connectSocket()

    const secondTurn = new Promise((resolve, reject) => {
      const remove = client2.onMessage((msg) => {
        if (msg.type === 'turn-done') {
          remove()
          resolve(msg.event)
        }
      })
      client2.send({ type: 'user', text: 'second turn' })
    })

    await secondTurn
    assert.equal(turnsSeen, 2)
    assert.equal(cs.claudeSessionId, 'bridge-session-abc')

    await bridge.close()
  })

  it('clears cs.busy when the bridge socket drops mid-turn (no wedged busy)', async () => {
    // Regression test for the "messages silently queue forever" bug: when the
    // bridge socket dropped mid-turn, the turn promise never resolved/rejected,
    // so cs.busy stayed true and every subsequent user message was queued and
    // never delivered to the agent. The disconnect guard must reject the turn
    // so the finally block clears cs.busy.
    const sessionKey = 'proj-drop:claude:tab-drop'
    const socketPath = join(TEST_DIR, 'drop-bridge.sock')
    const bridge = createFakeBridgeServer(socketPath)
    await bridge.ready

    // On receiving the user turn, emit an init event then drop the connection
    // WITHOUT sending turn-done — simulating a bridge crash / tmux kill / restart.
    bridge.onMessage((msg, socket) => {
      if (msg.type === 'user') {
        socket.write(JSON.stringify({
          type: 'event',
          event: { type: 'system', subtype: 'init', session_id: 'drop-session', tools: [] },
        }) + '\n')
        // Drop mid-turn.
        setTimeout(() => { try { socket.destroy() } catch {} }, 20)
      }
    })

    const broadcasts = []
    const driver = createClaudeTmuxDriver({
      store: { getSetting: () => null, updateTabMetadata: () => {} },
      claudeBroadcast: (cs, event) => broadcasts.push(event),
      rerunTurn: () => {},
    })

    // Inject a pre-connected client pointed at the fake bridge so run() does not
    // try to launch a real tmux session.
    const client = driver._getBridgeClient(sessionKey, {})
    client.socketPath = socketPath
    await client._connectSocket()
    // Short-circuit ensureConnected().
    client.ensureConnected = async () => {}

    const cs = {
      sessionKey,
      claudeSessionId: 'initial',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: false,
      tabLabel: '',
    }

    await driver.run(cs, 'hello agent', sessionKey, TEST_DIR)

    // The turn must have settled: busy cleared, proc released. Previously this
    // would hang forever and the assertion below would never be reached (the
    // test would time out), or busy would remain true.
    assert.equal(cs.busy, false, 'cs.busy must be cleared after a mid-turn disconnect')
    assert.equal(cs.currentProc, null, 'currentProc must be released')

    // A follow-up turn must actually dispatch (not silently queue). Re-point the
    // client at a fresh, healthy bridge connection and verify the turn completes.
    bridge.onMessage((msg, socket) => {
      if (msg.type === 'user') {
        socket.write(JSON.stringify({ type: 'turn-done', event: { type: 'result', subtype: 'success' } }) + '\n')
      }
    })
    await client._connectSocket()
    client.ensureConnected = async () => {}
    await driver.run(cs, 'second message', sessionKey, TEST_DIR)
    assert.equal(cs.busy, false, 'second turn must also settle cleanly')
    assert.equal(cs.queue.length, 0, 'second message must dispatch, not queue')

    await bridge.close()
  })

  it('writes and reads the session id persistence file', async () => {
    const sessionKey = 'proj-persist:claude:tab-persist'
    const driver = createClaudeTmuxDriver({
      store: { getSetting: () => null },
      claudeBroadcast: () => {},
      rerunTurn: () => {},
    })

    const socketPath = driver._getSocketPath(sessionKey)
    const socketDir = join(socketPath, '..')
    mkdirSync(socketDir, { recursive: true })

    // The driver exposes internal helpers for tests; write/read the sidecar
    // sessionId file the same way the production code does.
    const sessionIdFile = driver._getSessionIdPath(sessionKey)

    try { unlinkSync(sessionIdFile) } catch {}

    // Use reset to persist a new session id through the driver's public API.
    const cs = { sessionKey, claudeSessionId: 'new-session', turnCount: 5, queue: [] }
    await driver.reset(cs, 'new-session')

    assert.equal(existsSync(sessionIdFile), true)
    const saved = readFileSync(sessionIdFile, 'utf8').trim()
    assert.equal(saved, 'new-session')

    unlinkSync(sessionIdFile)
  })
})
