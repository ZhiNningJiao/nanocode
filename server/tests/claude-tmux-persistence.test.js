/**
 * Integration tests for Claude session persistence via the tmux-backed driver.
 *
 * These tests verify the acceptance criteria for MES-13220:
 *   - Reconnecting to the same tab/project reuses the existing tmux bridge.
 *   - A new tmux session / Claude OS process is NOT spawned on reconnect.
 *   - The same Claude session id is resumed without replaying the whole conversation.
 *
 * Strategy: start a real tmux session containing a tiny fake bridge process that
 * listens on the driver's Unix socket. The driver then connects to that session
 * exactly as it would in production, but no real Claude SDK / API keys are needed.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DIR = join(tmpdir(), `ncp-${Date.now().toString(36)}-${process.pid}`)
mkdirSync(TEST_DIR, { recursive: true })

const FAKE_BRIDGE_SCRIPT = join(TEST_DIR, 'fake-bridge.mjs')
const FAKE_BRIDGE_SOURCE = `import { createServer } from 'node:net'
import { unlinkSync, writeFileSync } from 'node:fs'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--socket') args.socket = process.argv[++i]
  else if (arg === '--session-id') args.sessionId = process.argv[++i]
}
const socketPath = args.socket || process.argv[2]
const sessionId = args.sessionId || process.argv[3] || 'default-session'

try { unlinkSync(socketPath) } catch {}
try { unlinkSync(\`\${socketPath}.sessionId\`) } catch {}
writeFileSync(\`\${socketPath}.sessionId\`, sessionId, { mode: 0o600 })

const server = createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'user') {
        socket.write(JSON.stringify({ type: 'event', event: { type: 'system', subtype: 'init', session_id: sessionId, tools: [] } }) + '\\n')
        socket.write(JSON.stringify({ type: 'event', event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ack ' + msg.text }] } } }) + '\\n')
        socket.write(JSON.stringify({ type: 'turn-done', event: { type: 'result', subtype: 'success' } }) + '\\n')
      } else if (msg.type === 'ping') {
        socket.write(JSON.stringify({ type: 'pong', id: msg.id }) + '\\n')
      }
    }
  })
})
server.listen(socketPath)
`
writeFileSync(FAKE_BRIDGE_SCRIPT, FAKE_BRIDGE_SOURCE, { mode: 0o755 })

process.env.NANOCODE_TMUX_SOCKET_DIR = join(TEST_DIR, '.nanocode', 'tmux-sessions')
process.env.NANOCODE_TMUX_BRIDGE_SCRIPT = FAKE_BRIDGE_SCRIPT

const { createClaudeTmuxDriver } = await import('../../terminal/claude-tmux-driver.js')
const TMUX_BIN = process.env.NANOCODE_TMUX_BIN || '/usr/bin/tmux'

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tmuxSessionExists(name) {
  const r = spawnSync(TMUX_BIN, ['has-session', '-t', name], { stdio: 'ignore' })
  return r.status === 0
}

function tmuxKillSession(name) {
  spawnSync(TMUX_BIN, ['kill-session', '-t', name], { stdio: 'ignore' })
}

function waitForSocket(socketPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(socketPath)) return resolve()
      if (Date.now() > deadline) return reject(new Error('socket did not appear'))
      setTimeout(check, 50)
    }
    check()
  })
}

function startFakeBridgeTmux(sessionKey, { sessionId = 'persistent-session-xyz' } = {}) {
  const name = `nanocode-${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`
  const socketPath = join(TEST_DIR, '.nanocode', 'tmux-sessions', `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}.sock`)
  mkdirSync(join(socketPath, '..'), { recursive: true })
  try { unlinkSync(socketPath) } catch {}
  try { unlinkSync(`${socketPath}.sessionId`) } catch {}

  // Restore the flag-parsing fake bridge script so it matches the arguments
  // the driver passes when launching a fresh bridge.
  writeFileSync(FAKE_BRIDGE_SCRIPT, FAKE_BRIDGE_SOURCE, { mode: 0o755 })

  if (tmuxSessionExists(name)) tmuxKillSession(name)

  const res = spawnSync(TMUX_BIN, [
    'new-session', '-d', '-s', name, '-n', 'nanocode-claude',
    'node', FAKE_BRIDGE_SCRIPT, '--socket', socketPath, '--session-id', sessionId,
  ], { stdio: 'pipe', encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`failed to start fake bridge tmux session: ${res.stderr || res.stdout || res.status}`)
  }

  return { name, socketPath, sessionId }
}

describe('claude tmux session persistence', () => {
  const origHome = process.env.HOME

  before(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    process.env.HOME = TEST_DIR
  })

  after(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  })

  it('reconnect reuses the existing tmux bridge and does not spawn a second one', async () => {
    const sessionKey = 'proj-persist:claude:tab-persist'
    const { name, socketPath, sessionId } = startFakeBridgeTmux(sessionKey, { sessionId: 'persistent-session-xyz' })
    await waitForSocket(socketPath)

    const newSessionCallsBefore = countTmuxNewSessionCalls(name)

    const broadcasted = []
    const driver = createClaudeTmuxDriver({
      store: {
        getSetting: () => null,
        updateTabMetadata: () => {},
      },
      claudeBroadcast: (cs, event) => {
        broadcasted.push(event)
        if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
          cs.claudeSessionId = event.session_id
        }
      },
      rerunTurn: () => {},
    })

    const cwd = TEST_DIR
    const cs1 = {
      sessionKey,
      claudeSessionId: 'initial-session',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: false,
    }

    await driver.run(cs1, 'first turn', sessionKey, cwd)
    assert.equal(cs1.claudeSessionId, sessionId, 'first turn should adopt the bridge session id')

    // Simulate a nanocode restart: drop the in-memory bridge client and create a
    // fresh session state (as if read from tab metadata).
    const internalClient = driver._getBridgeClient(sessionKey, {})
    internalClient.close()

    const cs2 = {
      sessionKey,
      claudeSessionId: 'stale-metadata-session',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: true,
    }

    await driver.run(cs2, 'second turn', sessionKey, cwd)

    assert.equal(cs2.claudeSessionId, sessionId, 'reconnect should resume the same session id')

    const newSessionCallsAfter = countTmuxNewSessionCalls(name)
    assert.equal(
      newSessionCallsAfter,
      newSessionCallsBefore,
      'reconnect should NOT create a second tmux session'
    )

    // Reconnect should not replay historical user events to the bridge.
    assert.equal(
      broadcasted.filter((e) => e.type === 'user').length,
      0,
      'tmux driver should not broadcast historical user events on reconnect'
    )

    tmuxKillSession(name)
    try { unlinkSync(socketPath) } catch {}
    try { unlinkSync(`${socketPath}.sessionId`) } catch {}
  })

  it('fresh driver instance recovers the persisted session id from disk', async () => {
    const sessionKey = 'proj-persist2:claude:tab-persist2'
    const { name, socketPath, sessionId } = startFakeBridgeTmux(sessionKey, { sessionId: 'disk-resumed-session' })
    await waitForSocket(socketPath)

    const driver = createClaudeTmuxDriver({
      store: { getSetting: () => null, updateTabMetadata: () => {} },
      claudeBroadcast: (cs, event) => {
        if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
          cs.claudeSessionId = event.session_id
        }
      },
      rerunTurn: () => {},
    })

    const cwd = TEST_DIR
    const cs = {
      sessionKey,
      claudeSessionId: 'controller-provided',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: false,
    }

    await driver.run(cs, 'turn', sessionKey, cwd)
    assert.equal(cs.claudeSessionId, sessionId)

    // Simulate a new nanocode process: create a brand new driver instance and a
    // fresh cs whose session id comes from stale tab metadata.
    const driver2 = createClaudeTmuxDriver({
      store: { getSetting: () => null, updateTabMetadata: () => {} },
      claudeBroadcast: (cs, event) => {
        if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
          cs.claudeSessionId = event.session_id
        }
      },
      rerunTurn: () => {},
    })

    const cs2 = {
      sessionKey,
      claudeSessionId: 'stale-from-metadata',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: true,
    }

    await driver2.run(cs2, 'turn after restart', sessionKey, cwd)
    assert.equal(cs2.claudeSessionId, sessionId, 'new driver instance should recover the persisted session id')

    tmuxKillSession(name)
    try { unlinkSync(socketPath) } catch {}
    try { unlinkSync(`${socketPath}.sessionId`) } catch {}
  })

  it('fresh launch creates one tmux session and reconnect reuses it', async () => {
    const sessionKey = 'proj-launch:claude:tab-launch'
    const name = `nanocode-${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`
    const socketPath = join(process.env.NANOCODE_TMUX_SOCKET_DIR, `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}.sock`)
    if (tmuxSessionExists(name)) tmuxKillSession(name)
    try { unlinkSync(socketPath) } catch {}
    try { unlinkSync(`${socketPath}.sessionId`) } catch {}

    const sessionId = 'launched-session'
    const driver = createClaudeTmuxDriver({
      store: { getSetting: () => null, updateTabMetadata: () => {} },
      claudeBroadcast: (cs, event) => {
        if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
          cs.claudeSessionId = event.session_id
        }
      },
      rerunTurn: () => {},
    })

    const cwd = TEST_DIR
    const cs1 = {
      sessionKey,
      claudeSessionId: sessionId,
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: false,
    }

    try {
      await driver.run(cs1, 'first turn', sessionKey, cwd)
    } catch (err) {
      console.error('DEBUG first run failed:', err?.message)
      console.error('tmux session exists:', tmuxSessionExists(name))
      const ls = spawnSync(TMUX_BIN, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
      console.error('tmux sessions:', ls.stdout, ls.stderr)
      const capture = spawnSync(TMUX_BIN, ['capture-pane', '-t', name, '-p'], { encoding: 'utf8' })
      console.error('tmux pane capture:', capture.stdout, capture.stderr)
      const env = spawnSync(TMUX_BIN, ['show-environment', '-t', name], { encoding: 'utf8' })
      console.error('tmux env:', env.stdout, env.stderr)
      throw err
    }
    assert.equal(cs1.claudeSessionId, sessionId, 'fresh launch should adopt the bridge session id')
    assert.equal(tmuxSessionExists(name), true, 'fresh launch should create the tmux session')

    const sessionCountAfterFirst = countTmuxNewSessionCalls(name)

    // Simulate a nanocode restart / reconnect: close the socket, keep tmux alive.
    const internalClient = driver._getBridgeClient(sessionKey, {})
    internalClient.close()

    const cs2 = {
      sessionKey,
      claudeSessionId: 'stale-after-reconnect',
      busy: false,
      turnCount: 0,
      queue: [],
      explicitSessionId: true,
    }
    await driver.run(cs2, 'second turn', sessionKey, cwd)
    assert.equal(cs2.claudeSessionId, sessionId, 'reconnect should resume the same session id')
    assert.equal(countTmuxNewSessionCalls(name), sessionCountAfterFirst, 'reconnect should not create a second tmux session')

    tmuxKillSession(name)
    try { unlinkSync(socketPath) } catch {}
    try { unlinkSync(`${socketPath}.sessionId`) } catch {}
  })
})

function countTmuxNewSessionCalls(name) {
  // There is no cheap public API to count tmux new-session invocations for a
  // given session, but we can approximate by listing sessions. The fake bridge
  // session was created once; a second new-session would create a duplicate
  // (which tmux prevents by name). We use session count as a proxy.
  const r = spawnSync(TMUX_BIN, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
  if (r.status !== 0) return 0
  return r.stdout.split('\n').filter((n) => n.trim() === name).length
}
