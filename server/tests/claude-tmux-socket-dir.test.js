/**
 * Bridge sockets live on local disk, and bridges launched before that move
 * (socket under ~/.nanocode/tmux-sessions) are reattached, never relaunched.
 *
 * Runs the real tmux driver against a private tmux server (fixtures/
 * tmux-isolated.js: every call pinned to `-S <tmp socket>`) whose sessions run
 * a stub bridge instead of Claude. The stub logs which pid served each turn,
 * so "reattached" is checked as "served by the pid that was running before".
 *
 * The legacy case uses a HOME whose socket path is longer than sun_path (108
 * bytes): connect() by that path cannot work, only the O_PATH fd route can.
 * That is what turns it red if the driver ever connects to the legacy path
 * directly again — the call that walks the home mount on the event loop.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIsolatedTmux, outerTmuxAlive, tmuxInstalled } from './fixtures/tmux-isolated.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const logLines = (socketPath) => existsSync(`${socketPath}.log`)
  ? readFileSync(`${socketPath}.log`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []

describe('tmux bridge socket directory', { skip: !tmuxInstalled() && 'tmux not installed', timeout: 60_000 }, () => {
  let root, home, localDir, legacyTarget, tmux, driverMod, driver
  const savedEnv = {}

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'nano-tmuxdir-'))
    // HOME long enough that <HOME>/.nanocode/tmux-sessions/<key>.sock exceeds sun_path.
    home = join(root, 'h'.repeat(60), 'home')
    localDir = join(root, 'local')
    legacyTarget = join(root, 'legacy') // short real dir behind the legacy path
    mkdirSync(join(home, '.nanocode'), { recursive: true })
    mkdirSync(legacyTarget, { recursive: true })
    symlinkSync(legacyTarget, join(home, '.nanocode', 'tmux-sessions'))
    tmux = createIsolatedTmux(root)
    for (const k of ['HOME', 'NANOCODE_TMUX_SOCKET_DIR', 'NANOCODE_TMUX_BIN', 'XDG_RUNTIME_DIR']) savedEnv[k] = process.env[k]
    process.env.HOME = home
    process.env.NANOCODE_TMUX_SOCKET_DIR = localDir
    process.env.NANOCODE_TMUX_BIN = tmux.bin // read once at module load
    driverMod = await import('../../terminal/claude-tmux-driver.js')
    driver = driverMod.createClaudeTmuxDriver({ store: { getSetting: () => null }, claudeBroadcast: () => {}, rerunTurn: () => {} })
  })

  after(() => {
    tmux?.killServer()
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    if (root) rmSync(root, { recursive: true, force: true })
    assert.equal(outerTmuxAlive(), true, 'the tmux server this test runs inside must still be alive')
  })

  const makeCs = (sessionKey, claudeSessionId) => ({
    sessionKey, claudeSessionId, busy: false, turnCount: 1, queue: [], explicitSessionId: true, tabLabel: '',
  })

  it('resolves the directory: override, then $XDG_RUNTIME_DIR, then /tmp/nanocode-tmux-<uid>', () => {
    const { resolveTmuxSocketDir } = driverMod
    assert.equal(resolveTmuxSocketDir({ NANOCODE_TMUX_SOCKET_DIR: '/x/y', XDG_RUNTIME_DIR: '/run/user/1' }), '/x/y')
    assert.equal(resolveTmuxSocketDir({ XDG_RUNTIME_DIR: '/run/user/1' }), '/run/user/1/nanocode-tmux')
    assert.equal(resolveTmuxSocketDir({}), `/tmp/nanocode-tmux-${process.getuid()}`)
    assert.equal(driver._getSocketPath('p:claude:t'), join(localDir, 'p-claude-t.sock'))
    assert.equal(driver._getSessionIdPath('p:claude:t'), join(localDir, 'p-claude-t.sessionId'))
  })

  it('launches a new bridge with its socket in the local dir (mode 0700), not under HOME', async () => {
    const key = 'pfresh:claude:tfresh'
    const cs = makeCs(key, 'fresh-sid')
    await driver.run(cs, 'hello fresh', key, root)
    const sock = driver._getSocketPath(key)
    assert.ok(sock.startsWith(localDir + '/'))
    assert.deepEqual(logLines(sock).map((l) => l.text), ['hello fresh'])
    assert.equal(logLines(sock)[0].pid, tmux.panePid(driver._getTmuxName(key)))
    assert.equal(existsSync(join(legacyTarget, 'pfresh-claude-tfresh.sock')), false)
    assert.equal(statSync(localDir).mode & 0o777, 0o700)
  })

  it('tightens an existing socket dir with group/other access to 0700', async () => {
    const dir = join(root, 'loose')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    process.env.NANOCODE_TMUX_SOCKET_DIR = dir
    try {
      await driver.reset(makeCs('ploose:claude:tloose', 'x'), 'loose-sid') // writes the sidecar → ensures the dir
      assert.equal(statSync(dir).mode & 0o777, 0o700)
      assert.equal(readFileSync(join(dir, 'ploose-claude-tloose.sessionId'), 'utf8'), 'loose-sid')
    } finally {
      process.env.NANOCODE_TMUX_SOCKET_DIR = localDir
    }
  })

  it('reattaches a bridge whose socket is still in the legacy home dir — same process, sessionId adopted', async () => {
    const key = 'plegacy:claude:tlegacy'
    const name = driver._getTmuxName(key)
    const legacySock = join(home, '.nanocode', 'tmux-sessions', 'plegacy-claude-tlegacy.sock')
    assert.ok(Buffer.byteLength(legacySock) > 107, 'legacy path must exceed sun_path for this test to mean anything')
    // A pre-upgrade session: bridge listening in the legacy dir, sidecar there too.
    tmux.startBridge(name, join(legacyTarget, 'plegacy-claude-tlegacy.sock'), 'legacy-sid')
    writeFileSync(join(legacyTarget, 'plegacy-claude-tlegacy.sessionId'), 'legacy-sid')
    await waitFor(() => existsSync(join(legacyTarget, 'plegacy-claude-tlegacy.sock')), 5000, 'legacy stub socket')
    const pidBefore = tmux.panePid(name)
    // Direct connect by the legacy path is impossible here (sun_path overflow).
    const direct = await new Promise((res) => { const c = createConnection(legacySock); c.on('connect', () => { c.end(); res('connected') }); c.on('error', (e) => res(e.code)) })
    assert.notEqual(direct, 'connected')

    const cs = makeCs(key, 'stale-sid')
    await driver.run(cs, 'hello legacy', key, root)
    const served = logLines(join(legacyTarget, 'plegacy-claude-tlegacy.sock'))
    assert.deepEqual(served.map((l) => l.text), ['hello legacy'], 'turn must reach the pre-existing bridge')
    assert.equal(served[0].pid, pidBefore, 'served by the same bridge process (reattached, not relaunched)')
    assert.equal(tmux.panePid(name), pidBefore)
    assert.equal(existsSync(driver._getSocketPath(key)), false, 'no replacement bridge was launched in the local dir')
    assert.equal(cs.claudeSessionId, 'legacy-sid', 'sessionId taken from the legacy sidecar')
    assert.equal(readFileSync(driver._getSessionIdPath(key), 'utf8'), 'legacy-sid', 'sidecar copied to the local dir')

    // A later reconnect (fresh client state, e.g. after a nanocode restart) still reaches it.
    driver._getBridgeClient(key, {}).close()
    await sleep(50)
    await driver.run(cs, 'hello again', key, root)
    const again = logLines(join(legacyTarget, 'plegacy-claude-tlegacy.sock'))
    assert.deepEqual(again.map((l) => [l.text, l.pid]), [['hello legacy', pidBefore], ['hello again', pidBefore]])
  })

  it('never starts a tmux client for availability, and keeps non-starting tmux calls off HOME', async () => {
    // tmux resolves ~/.tmux.conf & co. (realpath on HOME) before parsing any
    // flag: `tmux -V` on every dispatch held the event loop on a stalled home,
    // and has-session outlasted its deadline. Only new-session (which may start
    // the server) may see the real HOME.
    const before = tmux.calls().length
    assert.equal(driver.isAvailable(), true)
    const key = 'penv:claude:tenv'
    await driver.run(makeCs(key, 'env-sid'), 'hello env', key, root) // has-session (miss) + new-session
    driver._getBridgeClient(key, {}).close()
    await sleep(50)
    await driver.run(makeCs(key, 'env-sid'), 'hello env 2', key, root) // has-session (hit)
    const calls = tmux.calls().slice(before)
    assert.deepEqual(calls.filter((c) => c.args === '-V'), [], 'isAvailable must not run tmux')
    const byCmd = (cmd) => calls.filter((c) => c.args.split(' ')[0] === cmd)
    assert.equal(byCmd('has-session').length, 2)
    for (const c of byCmd('has-session')) assert.equal(c.home, localDir, 'has-session runs with HOME = local socket dir')
    assert.equal(byCmd('new-session').length, 1)
    assert.equal(byCmd('new-session')[0].home, home, 'new-session keeps the real HOME (it may start the server)')
  })

  it('reattaches a bridge whose socket is in the local dir', async () => {
    const key = 'plocal:claude:tlocal'
    const name = driver._getTmuxName(key)
    const sock = driver._getSocketPath(key)
    mkdirSync(localDir, { recursive: true })
    tmux.startBridge(name, sock, 'local-sid')
    await waitFor(() => existsSync(sock), 5000, 'local stub socket')
    const pidBefore = tmux.panePid(name)
    const cs = makeCs(key, 'stale-sid')
    await driver.run(cs, 'hello local', key, root)
    assert.deepEqual(logLines(sock).map((l) => [l.text, l.pid]), [['hello local', pidBefore]])
  })
})
