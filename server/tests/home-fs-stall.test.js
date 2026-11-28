/**
 * A stalled home filesystem must not stall the server (REPORT_nanolock_0730.md).
 *
 * Production keeps HOME on a shared sshfs mount (/jfs). When it stalls, any
 * synchronous fs call on the event loop froze every endpoint at once — the
 * wedge probe then restarted nanocode. This test runs the REAL server
 * (server/index.js) in a child process with a HOME whose files block on open:
 * a FIFO with no writer makes open() sleep in the kernel until a writer shows
 * up, exactly like a read on a stalled mount. Then:
 *   - the session-lock heartbeat (lock-watch, every 3 s) hits a FIFO lock file;
 *   - three new claude tabs attach over WS, each with a FIFO jsonl (attach
 *     recovers history from it).
 * While those reads hang, /api/health and /api/sessions must still answer
 * within 100 ms, and so must a static asset (/style.css).
 *
 * What turns it red:
 *   - any of those reads made synchronous again (readFileSync on the event
 *     loop) → the event loop sleeps in open() → every probe times out;
 *   - the home-fs slot budget (bounded-scan.js withFsSlot) removed → the
 *     hung reads take every libuv pool worker → /style.css (serve-static
 *     needs a worker) times out.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { OWNER_WATCH } from './fixtures/owner-watch.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const WebSocket = createRequire(import.meta.url)('ws')
const BUDGET_MS = 100
// The spawned server exits once this test process is gone (fixtures/owner-watch.mjs),
// so a test killed before its after() hook does not leave it running.
const SERVER_ARGS = ['--import', OWNER_WATCH, join(REPO, 'server', 'index.js')]
const OWNER_ENV = { NANOCODE_TEST_OWNER_PID: String(process.pid) }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function timedGet(url, timeoutMs) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer()
    return { ms: Date.now() - t0, status: res.status }
  } catch (err) {
    return { ms: Date.now() - t0, status: 0, error: String(err?.name || err) }
  }
}

describe('home filesystem stall does not stall the server', { timeout: 60_000 }, () => {
  const hasMkfifo = spawnSync('mkfifo', ['--version'], { stdio: 'ignore' }).status === 0
  let root, home, runDir, port, child, logs
  const sockets = []
  const projectId = 'p0000000-0000-4000-8000-0000000000aa'
  const tabs = [0, 1, 2, 3].map((i) => ({
    id: `tabstall${i}`, label: `claude ${i}`, type: 'claude', createdAt: Date.now(),
    claudeSessionId: `5a11000${i}-0000-4000-8000-00000000000${i}`, claudeSessionStarted: true,
  }))
  const lockFile = (t) => join(home, '.nanocode', 'session-locks', `${t.claudeSessionId}.lock`)

  function attach(tab) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`)
    sockets.push(ws)
    ws.on('error', () => {})
    return new Promise((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', projectId, sessionType: 'bash', tabType: 'claude', tabId: tab.id, cols: 80, rows: 24 })))
      ws.on('message', (d) => { try { if (JSON.parse(d).type === 'busy-state') resolve(true) } catch {} })
      setTimeout(() => resolve(false), 8000)
    })
  }

  before(async () => {
    if (!hasMkfifo) return
    root = mkdtempSync(join(tmpdir(), 'nano-fsstall-'))
    home = join(root, 'home')
    runDir = join(root, 'run')
    const cwd = join(home, 'proj')
    const projDir = join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'))
    for (const d of [cwd, projDir, join(runDir, 'data'), join(home, '.nanocode', 'session-locks')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(runDir, 'data', 'nanocode.json'), JSON.stringify({
      projects: [{ id: projectId, name: 'stall', cwd, created_at: Date.now() }],
      settings: { secretary_favorites_seeded_v1: '1', remote_defaults_seeded: '1' },
      tabs: { [projectId]: tabs },
    }))
    // tab 0: a real jsonl (attaches normally, then holds the lock + heartbeat);
    // tabs 1-3: the jsonl is a FIFO — attach-time history recovery blocks on it.
    const row = (t) => JSON.stringify({ type: 'user', uuid: `u-${t.id}`, sessionId: t.claudeSessionId, message: { role: 'user', content: 'hi' } })
    writeFileSync(join(projDir, `${tabs[0].claudeSessionId}.jsonl`), row(tabs[0]) + '\n')
    for (const t of tabs.slice(1)) assert.equal(spawnSync('mkfifo', [join(projDir, `${t.claudeSessionId}.jsonl`)]).status, 0)

    port = await freePort()
    logs = []
    const env = { ...process.env, ...OWNER_ENV, HOME: home, PORT: String(port), HOST: '127.0.0.1' }
    delete env.CLAUDE_CONFIG_DIR
    delete env.NANOCODE_PERSONAL_CONFIG
    child = spawn(process.execPath, SERVER_ARGS, {
      cwd: runDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (b) => logs.push(String(b)))
    child.stderr.on('data', (b) => logs.push(String(b)))
    const end = Date.now() + 20_000
    while (Date.now() < end && (await timedGet(`http://127.0.0.1:${port}/api/health`, 1000)).status !== 200) await sleep(100)
  })

  after(() => {
    for (const ws of sockets) try { ws.terminate() } catch {}
    if (child) child.kill('SIGKILL') // threads blocked in a FIFO open() die with the process
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('keeps /api/health, /api/sessions and static assets under 100 ms while lock + history reads hang', { skip: !hasMkfifo && 'mkfifo not available' }, async () => {
    assert.equal((await timedGet(`http://127.0.0.1:${port}/api/health`, 2000)).status, 200, `server did not start:\n${logs.join('')}`)

    // tab 0 attaches on a healthy disk and takes the session lock.
    assert.equal(await attach(tabs[0]), true, 'tab 0 should attach')
    const lf = lockFile(tabs[0])
    assert.ok(existsSync(lf), 'tab 0 should hold its lock file')
    assert.equal(JSON.parse(readFileSync(lf, 'utf8')).pid, child.pid)

    const worst = { health: 0, sessions: 0, static: 0 }
    const failures = []
    async function probeFor(ms, phase) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        for (const [key, path] of [['health', '/api/health'], ['sessions', '/api/sessions'], ['static', '/style.css']]) {
          const r = await timedGet(`http://127.0.0.1:${port}${path}`, 3000)
          worst[key] = Math.max(worst[key], r.ms)
          if (r.status !== 200) failures.push(`[${phase}] ${path} → ${r.status || r.error} after ${r.ms}ms`)
          else if (r.ms >= BUDGET_MS) failures.push(`[${phase}] ${path} took ${r.ms}ms (budget ${BUDGET_MS}ms)`)
        }
        await sleep(20)
      }
    }

    // Stall 1: the held lock becomes a FIFO — the next lock-watch tick
    // (every LOCK_WATCH_INTERVAL_MS = 3 s) blocks reading it.
    unlinkSync(lf)
    assert.equal(spawnSync('mkfifo', [lf]).status, 0)
    await sleep(3500)
    await probeFor(1000, 'heartbeat stalled')

    // Stall 2: three new tabs attach against FIFO jsonls (history recovery
    // blocks); together with the heartbeat that is more hung reads than the
    // libuv pool has workers, unless the home-fs budget holds them back.
    const lateAttaches = tabs.slice(1).map(attach)
    await sleep(500)
    await probeFor(1500, 'heartbeat + 3 attaches stalled')

    assert.deepEqual(failures, [], `every probe must answer 200 within ${BUDGET_MS}ms (worst: ${JSON.stringify(worst)})`)

    // The stall is still real (not a vacuous pass): the FIFO tabs never finished attaching.
    const settled = await Promise.race([Promise.all(lateAttaches).then((r) => r.some(Boolean)), sleep(200).then(() => 'pending')])
    assert.equal(settled, 'pending', 'FIFO-backed attaches should still be blocked on their history read')
  })
})

/**
 * Same stalled home, tmux driver (the production default): the lifeline path
 * — inject → turn on a tmux-held bridge — must keep working and keep the
 * event loop free.
 *
 * Bridge sockets and sidecars now live in a local dir. The test runs the real
 * server with the tmux driver on a private tmux server (fixtures/
 * tmux-isolated.js, `-S <tmp socket>`, stub bridges instead of Claude) and
 * three pre-existing/new sessions:
 *   F  fresh: no tmux session yet → the driver launches a bridge;
 *   L  local: a bridge already listening in the local dir;
 *   O  legacy: a bridge launched before the move, listening under
 *      ~/.nanocode/tmux-sessions — must be reattached, never relaunched.
 * Two more tabs attach against FIFO jsonls and hold the whole home-fs budget.
 * While that stall lasts: F and L must complete an injected turn, every
 * /api/health probe must answer within 100 ms, and O's turn may wait (its
 * socket is on the home disk; the lookup is async and budgeted) but must not
 * block anything. When the stall clears O's turn lands on its ORIGINAL bridge
 * process. Then the server restarts and all three are reattached again.
 *
 * What turns it red: sockets/sidecars back under HOME (the old dir holds FIFO
 * sidecars for F and L here, so their turns hang behind the stalled home), or
 * a legacy session relaunched instead of reattached (pid changes).
 */
describe('home filesystem stall does not stall tmux-driven injects', { timeout: 90_000 }, async () => {
  const { createIsolatedTmux, outerTmuxAlive, tmuxInstalled } = await import('./fixtures/tmux-isolated.js')
  const hasMkfifo = spawnSync('mkfifo', ['--version'], { stdio: 'ignore' }).status === 0
  const usable = hasMkfifo && tmuxInstalled()
  let root, home, runDir, localDir, legacyDir, projDir, tmux, port, child, logs
  const sockets = []
  const projectId = 'pq' // short ids: socket paths must fit sun_path (108 bytes)
  const mk = (id, i) => ({
    id, label: id, type: 'claude', createdAt: Date.now(),
    claudeSessionId: `7a11000${i}-0000-4000-8000-00000000000${i}`, claudeSessionStarted: true,
  })
  const F = mk('tf', 0), L = mk('tl', 1), O = mk('to', 2), S1 = mk('sx', 3), S2 = mk('sy', 4)
  const keyOf = (t) => `${projectId}:claude:${t.id}`
  const fileOf = (t) => keyOf(t).replace(/[^a-zA-Z0-9_-]/g, '-')
  const tmuxName = (t) => `nanocode-${fileOf(t)}`
  const localSock = (t) => join(localDir, `${fileOf(t)}.sock`)
  const legacySock = (t) => join(legacyDir, `${fileOf(t)}.sock`)
  const served = (sock) => existsSync(`${sock}.log`)
    ? readFileSync(`${sock}.log`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []

  function attach(tab) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`)
    sockets.push(ws)
    ws.on('error', () => {})
    return new Promise((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', projectId, sessionType: 'bash', tabType: 'claude', tabId: tab.id, cols: 80, rows: 24 })))
      ws.on('message', (d) => { try { if (JSON.parse(d).type === 'busy-state') resolve(true) } catch {} })
      setTimeout(() => resolve(false), 8000)
    })
  }

  async function startServer() {
    port = await freePort()
    logs = []
    const env = { ...process.env, ...OWNER_ENV, HOME: home, PORT: String(port), HOST: '127.0.0.1',
      NANOCODE_TMUX_SOCKET_DIR: localDir, NANOCODE_TMUX_BIN: tmux.bin, NANOCODE_CLAUDE_TMUX: '1',
      // A tmux failure falls back to the SDK driver; never let that reach a real claude.
      NANOCODE_CLAUDE_CODE_EXECUTABLE: '/bin/false' }
    for (const k of ['CLAUDE_CONFIG_DIR', 'NANOCODE_PERSONAL_CONFIG', 'TMUX']) delete env[k]
    child = spawn(process.execPath, SERVER_ARGS, { cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (b) => logs.push(String(b)))
    child.stderr.on('data', (b) => logs.push(String(b)))
    const end = Date.now() + 20_000
    while (Date.now() < end && (await timedGet(`http://127.0.0.1:${port}/api/health`, 1000)).status !== 200) await sleep(100)
    assert.equal((await timedGet(`http://127.0.0.1:${port}/api/health`, 2000)).status, 200, `server did not start:\n${logs.join('')}`)
  }

  async function stopServer() {
    for (const ws of sockets.splice(0)) try { ws.terminate() } catch {}
    if (!child) return
    // A server that already died (e.g. crashed on load) emits no further
    // 'exit' — waiting for one would hang the after() hook forever.
    const exited = child.exitCode === null && child.signalCode === null && new Promise((r) => child.once('exit', r))
    child.kill('SIGKILL')
    await exited
    child = null
  }

  async function inject(tab, text) {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(keyOf(tab))}/inject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, isUser: false }), signal: AbortSignal.timeout(3000),
    })
    return res.status
  }

  async function waitServed(sock, n, ms) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (served(sock).length >= n) return true
      await sleep(50)
    }
    return false
  }

  async function cleanUp() {
    try {
      await stopServer()
    } finally {
      tmux?.killServer()
      if (root) rmSync(root, { recursive: true, force: true })
      tmux = root = null
    }
  }

  // node 18's runner skips a suite's after() when its before() fails (e.g. the
  // server crashed on load), so a failed setup cleans up after itself.
  before(async () => {
    if (!usable) return
    try {
      await setUp()
    } catch (err) {
      await cleanUp()
      throw err
    }
  })

  async function setUp() {
    root = mkdtempSync(join(tmpdir(), 'nano-tmuxstall-'))
    home = join(root, 'home')
    runDir = join(root, 'run')
    localDir = join(root, 'local')
    legacyDir = join(home, '.nanocode', 'tmux-sessions')
    const cwd = join(home, 'proj')
    projDir = join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'))
    for (const d of [cwd, projDir, join(runDir, 'data'), join(home, '.nanocode', 'session-locks'), legacyDir, localDir]) mkdirSync(d, { recursive: true, mode: 0o700 })
    writeFileSync(join(runDir, 'data', 'nanocode.json'), JSON.stringify({
      projects: [{ id: projectId, name: 'tmuxstall', cwd, created_at: Date.now() }],
      settings: { secretary_favorites_seeded_v1: '1', remote_defaults_seeded: '1' },
      tabs: { [projectId]: [F, L, O, S1, S2] },
    }))
    const row = (t) => JSON.stringify({ type: 'user', uuid: `u-${t.id}`, sessionId: t.claudeSessionId, message: { role: 'user', content: 'hi' } })
    for (const t of [F, L, O]) writeFileSync(join(projDir, `${t.claudeSessionId}.jsonl`), row(t) + '\n')
    for (const t of [S1, S2]) assert.equal(spawnSync('mkfifo', [join(projDir, `${t.claudeSessionId}.jsonl`)]).status, 0)
    // The old home dir holds FIFO sidecars for F and L: only code that still
    // keeps its sidecars under HOME ever opens them (and then hangs).
    for (const t of [F, L]) assert.equal(spawnSync('mkfifo', [join(legacyDir, `${fileOf(t)}.sessionId`)]).status, 0)

    assert.ok(Buffer.byteLength(legacySock(O)) < 108, `TMPDIR too long for unix socket paths: ${legacySock(O)}`)
    tmux = createIsolatedTmux(root)
    tmux.startBridge(tmuxName(L), localSock(L), L.claudeSessionId)
    tmux.startBridge(tmuxName(O), legacySock(O), O.claudeSessionId)
    writeFileSync(join(legacyDir, `${fileOf(O)}.sessionId`), O.claudeSessionId)
    const end = Date.now() + 5000
    while (Date.now() < end && !(existsSync(localSock(L)) && existsSync(legacySock(O)))) await sleep(50)
    await startServer()
  }

  after(async () => {
    await cleanUp()
    assert.equal(outerTmuxAlive(), true, 'the tmux server this test runs inside must still be alive')
  })

  it('injects into fresh/local bridges, keeps the API under 100 ms, reattaches legacy bridges (also after restart)', { skip: !usable && 'needs mkfifo + tmux' }, async () => {
    const pidL = tmux.panePid(tmuxName(L))
    const pidO = tmux.panePid(tmuxName(O))
    assert.ok(pidL && pidO, 'pre-existing bridges are running')
    for (const t of [F, L, O]) assert.equal(await attach(t), true, `${t.id} should attach`)

    // Stall the home disk: two FIFO-jsonl attaches take both home-fs slots.
    const stalled = [S1, S2].map(attach)
    await sleep(500)

    const failures = []
    let worst = 0
    let probing = true
    const probe = (async () => {
      while (probing) {
        const r = await timedGet(`http://127.0.0.1:${port}/api/health`, 3000)
        worst = Math.max(worst, r.ms)
        if (r.status !== 200 || r.ms >= BUDGET_MS) failures.push(`/api/health → ${r.status || r.error} after ${r.ms}ms`)
        await sleep(20)
      }
    })()

    try {
      assert.deepEqual(await Promise.all([inject(F, 'lifeline F'), inject(L, 'lifeline L'), inject(O, 'lifeline O')]), [200, 200, 200])
      assert.equal(await waitServed(localSock(F), 1, 8000), true, `fresh bridge must serve the turn during the stall\n${logs.join('')}`)
      assert.equal(await waitServed(localSock(L), 1, 8000), true, `local bridge must serve the turn during the stall\n${logs.join('')}`)
      await sleep(500)
      // Not vacuous: the home disk is still stalled.
      const still = await Promise.race([Promise.all(stalled).then((r) => r.some(Boolean)), sleep(100).then(() => 'pending')])
      assert.equal(still, 'pending', 'FIFO-backed attaches should still be blocked')
    } finally {
      probing = false
      await probe
    }
    assert.deepEqual(failures, [], `/api/health must answer within ${BUDGET_MS}ms during the stall (worst ${worst}ms)`)

    // Clear the stall (writers open the FIFOs → the hung reads see EOF).
    for (const t of [S1, S2]) spawnSync('sh', ['-c', `: > "${join(projDir, `${t.claudeSessionId}.jsonl`)}"`])
    assert.equal(await waitServed(legacySock(O), 1, 10_000), true, `legacy bridge must serve the turn once the home disk answers\n${logs.join('')}`)
    assert.deepEqual(served(legacySock(O)).map((l) => l.pid), [pidO], 'legacy session reattached, not relaunched')
    assert.equal(existsSync(localSock(O)), false, 'no replacement bridge for the legacy session')
    assert.deepEqual(served(localSock(L)).map((l) => l.pid), [pidL])
    const pidF = tmux.panePid(tmuxName(F))

    // Restart: every bridge (fresh, local, legacy) is reattached by the new process.
    await stopServer()
    await startServer()
    for (const t of [F, L, O]) assert.equal(await attach(t), true, `${t.id} should re-attach after restart`)
    assert.deepEqual(await Promise.all([inject(F, 'again F'), inject(L, 'again L'), inject(O, 'again O')]), [200, 200, 200])
    for (const [sock, pid] of [[localSock(F), pidF], [localSock(L), pidL], [legacySock(O), pidO]]) {
      assert.equal(await waitServed(sock, 2, 8000), true, `${sock} must serve the post-restart turn\n${logs.join('')}`)
      assert.deepEqual(served(sock).map((l) => l.pid), [pid, pid], `${sock}: same bridge process before and after restart`)
    }
  })
})
