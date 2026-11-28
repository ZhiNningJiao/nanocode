/**
 * A test process that dies without cleaning up leaves no private tmux server
 * and no server process it spawned.
 *
 * createIsolatedTmux's tmux server daemonizes (PPID 1): if the test process is
 * killed (outer `timeout`, SIGKILL) or exits before its after() hook reaches
 * killServer (the hook threw or hung), nothing else stops it. Two such servers,
 * each with two stub bridges, were found alive 34 h after a home-fs-stall run.
 *
 * Each case runs the minimal scenario in a child node — createIsolatedTmux, a
 * bridge via startBridge, and one launched the way the driver does it (real
 * bridge path, swapped by the wrapper), plus a stand-in for the nanocode
 * server spawned the way home-fs-stall.test.js spawns it (`--import
 * owner-watch.mjs`, given a temp dir to remove) — then ends the child WITHOUT
 * any cleanup and checks the tmux server, both bridges and the spawned server
 * are gone within 5 s, and so is the server's temp dir.
 *
 * What turns it red: stub bridges that no longer watch the test process
 * (--owner-pid dropped from the wrapper, or the watch removed from the stub),
 * or owner-watch.mjs no longer acting as a preload or no longer removing
 * NANOCODE_TEST_OWNER_CLEANUP.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmuxInstalled } from './fixtures/tmux-isolated.js'
import { OWNER_WATCH, pidAlive } from './fixtures/owner-watch.mjs'

const FIXTURE = new URL('./fixtures/tmux-isolated.js', import.meta.url).href
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ENV = { ...process.env }
delete ENV.TMUX // pin every tmux call to the private socket, never the outer server
const privateTmux = (socket, ...args) => spawnSync('/usr/bin/tmux', ['-S', socket, ...args], { env: ENV, encoding: 'utf8' })
const cmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return '' } }

async function waitFor(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(100)
  }
  return fn()
}

describe('private tmux does not outlive its test process', { skip: !tmuxInstalled() && 'tmux not installed', timeout: 60_000 }, () => {
  const leftovers = [] // { root, socket, pids } per case; whatever a red run leaves is stopped here

  after(() => {
    for (const { root, socket, pids } of leftovers) {
      if (existsSync(socket)) privateTmux(socket, 'kill-server')
      // Only pids recorded by this test whose command line still names this case's dir.
      for (const pid of pids) if (pidAlive(pid) && cmdline(pid).includes(root)) try { process.kill(pid, 'SIGKILL') } catch {}
      rmSync(root, { recursive: true, force: true })
    }
  })

  for (const ending of ['exit', 'SIGTERM', 'SIGKILL']) {
    it(`tmux server, stub bridges and spawned server exit after the test process ends by ${ending}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'nano-tmuxkill-'))
      const socket = join(root, 'tmux.sock')
      const sockA = join(root, 'a.sock')
      const sockB = join(root, 'b.sock')
      const serverTmp = join(root, 'server-tmp') // stands for the test's temp dir a killed test never removes
      mkdirSync(serverTmp)
      writeFileSync(join(serverTmp, 'f'), '')
      const leftover = { socket, root, pids: [] }
      leftovers.push(leftover)

      const script = `
        import { spawn } from 'node:child_process'
        import { createIsolatedTmux } from ${JSON.stringify(FIXTURE)}
        const tmux = createIsolatedTmux(${JSON.stringify(root)})
        tmux.startBridge('owner-a', ${JSON.stringify(sockA)}, 'sid-a')
        const r = tmux.run('new-session', '-d', '-s', 'owner-b', process.execPath, '/x/terminal/claude-tmux-bridge.mjs', '--socket', ${JSON.stringify(sockB)}, '--session-id', 'sid-b')
        if (r.status !== 0) throw new Error(r.stderr)
        const server = spawn(process.execPath, ['--import', ${JSON.stringify(OWNER_WATCH)}, '-e', 'setInterval(() => {}, 1000) // ' + ${JSON.stringify(root)}],
          { env: { ...process.env, NANOCODE_TEST_OWNER_PID: String(process.pid), NANOCODE_TEST_OWNER_CLEANUP: ${JSON.stringify(serverTmp)} }, stdio: 'ignore' })
        process.stdout.write('ready ' + server.pid + '\\n')
        process.stdin.once('data', () => process.exit(1)) // ends like an after() hook that threw
        setInterval(() => {}, 1000)
      `
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: ENV, stdio: ['pipe', 'pipe', 'inherit'] })
      const exited = new Promise((r) => child.once('exit', r))
      const serverPid = await new Promise((resolve) => {
        child.stdout.on('data', (b) => { const m = /ready (\d+)/.exec(String(b)); if (m) resolve(Number(m[1])) })
        child.once('exit', () => resolve(0))
      })
      assert.ok(serverPid > 0, 'child should start the private tmux and the server')
      leftover.pids.push(serverPid)
      assert.equal(await waitFor(() => existsSync(sockA) && existsSync(sockB), 5000), true, 'both bridges should be listening')

      const tmux = (...args) => privateTmux(socket, ...args)
      const tmuxPid = Number(tmux('display-message', '-p', '#{pid}').stdout.trim())
      const panePids = tmux('list-panes', '-a', '-F', '#{pane_pid}').stdout.trim().split('\n').map(Number)
      leftover.pids.push(tmuxPid, ...panePids)
      assert.ok(tmuxPid > 0 && panePids.length === 2, `expected a tmux server with 2 bridges, got ${tmuxPid} / ${panePids}`)
      const pids = [tmuxPid, ...panePids, serverPid]
      assert.ok(pids.every(pidAlive), 'tmux server, bridges and server are running')

      if (ending === 'exit') child.stdin.write('x')
      else child.kill(ending)
      await exited

      const gone = await waitFor(() => !pids.some(pidAlive), 5000)
      assert.equal(gone, true, `still alive 5 s after the test process ended (tmux, bridges, server = ${pids}): ${pids.filter(pidAlive)}`)
      assert.notEqual(tmux('ls').status, 0, 'private tmux server must be gone')
      assert.equal(existsSync(serverTmp), false, 'the server removes the temp dir it was given when the test process is gone')
    })
  }
})
