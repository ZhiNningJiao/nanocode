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

  it('releases cs.busy when the bridge socket closes mid-turn', async () => {
    // Regression: if the bridge process dies while a turn is in flight, the
    // turn promise used to hang forever (no turn-done/turn-error would ever
    // arrive), leaving cs.busy permanently true — the session was wedged.
    // The driver must reject the turn and clear cs.busy so the session can
    // recover.
    const sessionKey = 'proj-hang:claude:tab-hang'
    const socketPath = join(TEST_DIR, 'hang-bridge.sock')
    const bridge = createFakeBridgeServer(socketPath)
    await bridge.ready

    const driver = createClaudeTmuxDriver({
      store: { getSetting: () => null, updateTabMetadata: () => null },
      claudeBroadcast: () => {},
      rerunTurn: () => {},
    })

    // Pre-connect the bridge client so ensureConnected() short-circuits and
    // never launches a real tmux session.
    const client = driver._getBridgeClient(sessionKey, { onSessionId: () => {} })
    client.socketPath = socketPath
    await client._connectSocket()

    const cs = {
      sessionKey,
      claudeSessionId: 'sess-hang',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: false,
    }

    // Accept the user message but intentionally never reply with turn-done,
    // simulating a bridge that crashes mid-turn.
    bridge.onMessage(() => {})

    const runPromise = driver.run(cs, 'hello', sessionKey, TEST_DIR)
    await wait(50)
    assert.equal(cs.busy, true, 'busy should be true while the turn is in flight')

    // Bridge dies mid-turn.
    bridge.closeConnections()

    // run() catches turn errors internally, so this resolves (not rejects).
    await runPromise
    assert.equal(cs.busy, false, 'busy must be cleared after the bridge socket dies')

    try { client.close() } catch {}
    await bridge.close()
  })
})
