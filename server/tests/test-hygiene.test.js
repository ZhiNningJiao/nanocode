/**
 * Tests clean up after themselves however they end.
 *
 *   - A test that spawns the real server/index.js preloads owner-watch, so the
 *     server exits with the test process (a test killed by an outer timeout or
 *     the OOM killer leaves no orphan server).
 *   - system-mode-switch.test.js removes its socket dir when the server never
 *     comes up. It used to create the dir outside its try/finally: a server
 *     that crashed on load left an empty /tmp/nano-system-mode-switch-test-*.
 *   - A claude session controller's lock-watch tick still in flight after the
 *     controller is disposed re-creates <home>/.nanocode/session-locks/… in a
 *     HOME the test already removed; tests settle that lock IO first
 *     (fixtures/session-locks.mjs), and leave no nanocode-home-* /
 *     nanocode-dualsrv-* / nanocode-unwedge-* behind.
 *   - node 18 skips a describe's after() when its before() throws. Suites that
 *     set up resources use setupSuite (fixtures/suite-hooks.mjs), which tears
 *     down from before() itself on a failed setup, and runs every teardown
 *     step even if an earlier one throws.
 *
 * What turns it red: a server spawn without OWNED_NODE_ARGS and OWNER_ENV /
 * ownerEnvRemoving; the socket dir created outside the try/finally again;
 * setupSuite no longer tearing down on a failed setup or stopping at the
 * first failing step; a describe that pairs a raw before() with an after();
 * settleSessionLocks returning before an in-flight lock-watch tick has landed,
 * or the controller tests removing HOME without it (that one is a race: red
 * in most runs, not all — see the case).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, setPriority } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLockHolder, acquireSessionLock, releaseSessionLock } from '../../terminal/session-lock.js'
import { settleSessionLocks } from './fixtures/session-locks.mjs'

const TESTS = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(TESTS, '..', '..')
const SUITE_HOOKS = new URL('./fixtures/suite-hooks.mjs', import.meta.url).href
const testFiles = () => readdirSync(TESTS).filter((f) => f.endsWith('.test.js'))
const source = (f) => readFileSync(join(TESTS, f), 'utf8')

/** Run `node --test <files>` as its own top-level run; resolves { code, out }.
 * `niced`: at low CPU priority, so a repeated run does not starve the timing
 * budgets of tests running alongside in the same npm test. */
function nodeTest(files, extraEnv, cwd = REPO, { niced = false } = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.NODE_TEST_CONTEXT // we are a child of the outer runner; this run is standalone
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...files], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    if (niced) try { setPriority(child.pid, 19) } catch {}
    let out = ''
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { out += b })
    child.on('close', (code) => resolve({ code, out }))
  })
}

function withScratch(prefix, fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

describe('test hygiene', () => {
  it('every test that spawns server/index.js preloads owner-watch', () => {
    const spawnsServer = testFiles().filter((f) => {
      const s = source(f)
      return /\bspawn\(/.test(s) && /['"]server['"],\s*['"]index\.js['"]|['"]\.\.['"],\s*['"]index\.js['"]/.test(s)
    })
    // The detector itself must still see the known spawners.
    for (const known of ['home-fs-stall.test.js', 'reach-api.test.js', 'system-mode-switch.test.js', 'token-auth.test.js']) {
      assert.ok(spawnsServer.includes(known), `detector missed ${known}`)
    }
    const unwatched = spawnsServer.filter((f) => !(/\.\.\.OWNED_NODE_ARGS\b/.test(source(f)) && /\.\.\.(OWNER_ENV\b|ownerEnvRemoving\()/.test(source(f))))
    assert.deepEqual(unwatched, [], 'spawn the server with [...OWNED_NODE_ARGS, entry] and env { ...ownerEnvRemoving(tmpDir) } or { ...OWNER_ENV } (fixtures/owner-watch.mjs)')
  })

  it('no describe pairs a raw before() with an after() (use setupSuite)', () => {
    // Indented hooks live inside a describe; top-level after() still runs when a top-level before() throws.
    const offenders = testFiles().filter((f) => /^[ \t]+before\(/m.test(source(f)) && /^[ \t]+after\(/m.test(source(f)))
    assert.deepEqual(offenders, [], 'node 18 skips after() when before() throws — register both halves with setupSuite (fixtures/suite-hooks.mjs)')
  })

  it('setupSuite tears down when setup fails part-way, and runs every teardown step', withScratch('nano-hygiene-hooks-', async (dir) => {
    const probe = join(dir, 'probe.test.mjs')
    const mark = (name) => `writeFileSync(${JSON.stringify(join(dir, name))}, '')`
    writeFileSync(probe, `
import { describe, it } from 'node:test'
import { writeFileSync } from 'node:fs'
import { setupSuite } from ${JSON.stringify(SUITE_HOOKS)}
describe('setup fails', () => {
  let started = false
  setupSuite(() => { started = true; throw new Error('setup failed') }, () => { if (started) ${mark('torn-down')} })
  it('never runs', () => {})
})
describe('a teardown step throws', () => {
  setupSuite(() => {}, () => { throw new Error('first step failed') }, () => { ${mark('second-step-ran')} })
  it('runs', () => {})
})
`)
    const { code, out } = await nodeTest([probe], {}, dir)
    assert.notEqual(code, 0, out)
    assert.ok(existsSync(join(dir, 'torn-down')), `failed setup was not torn down:\n${out}`)
    assert.ok(existsSync(join(dir, 'second-step-ran')), `teardown stopped at the first failing step:\n${out}`)
  }))

  it('settleSessionLocks waits out a lock-watch tick that was already in flight', withScratch('nano-hygiene-locks-', async (home) => {
    const sid = 'hygiene-tick'
    const own = { pid: process.pid, port: 1 }
    assert.equal((await acquireSessionLock(sid, own, home)).acquired, true)
    await releaseSessionLock(sid, own, home) // the lock file is gone, as after disposeClaudeSessions
    // What an in-flight tick does when the holder is gone: read it, then re-acquire.
    let tickLanded = false
    const tick = getLockHolder(sid, home).then((holder) => holder ? null : acquireSessionLock(sid, own, home)).then(() => { tickLanded = true })
    await settleSessionLocks(home, [sid])
    assert.equal(tickLanded, true, 'settleSessionLocks returned while the tick could still re-create the lock dir')
    await tick
  }))

  it('controller tests leave no temp HOME behind (lock IO settled before removal)', { timeout: 120_000 }, withScratch('nano-hygiene-ctl-', async (tmp) => {
    // The leak was a race (about half the runs), so run the pair a few times.
    for (let run = 0; run < 5; run++) {
      const { code, out } = await nodeTest(['claude-session-resume.test.js', 'session-lock-dual-server.test.js', 'claude-force-unwedge.test.js'].map((f) => join(TESTS, f)), { TMPDIR: tmp }, REPO, { niced: true })
      assert.equal(code, 0, out)
      assert.deepEqual(readdirSync(tmp), [], `run ${run + 1} left these behind`)
    }
  }))

  it('system-mode switch leaves no socket dir when the server crashes on load', { timeout: 60_000 }, withScratch('nano-hygiene-sms-', async (dir) => {
    const crash = join(dir, 'crash-on-load.mjs')
    writeFileSync(crash, "throw new SyntaxError('crashed on load (test-hygiene)')\n")
    const tmp = join(dir, 'tmp')
    mkdirSync(tmp)
    const { code, out } = await nodeTest([join(TESTS, 'system-mode-switch.test.js')], { NANOCODE_TEST_INDEX_PATH: crash, TMPDIR: tmp })
    assert.notEqual(code, 0, 'a server that crashes on load must fail the integration tests')
    assert.match(out, /server did not become ready/)
    assert.deepEqual(readdirSync(tmp), [], `left behind in TMPDIR:\n${out}`)
  }))
})
