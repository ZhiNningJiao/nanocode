/**
 * Long-lived token for team-pool tabs (claude-env.js).
 *
 * A tab whose config dir is ~/.claude-teamN and whose pool has a token file
 * CLAUDE_OAUTH_TOKEN_DIR/T<N>.token must spawn claude with that file on fd 3
 * and CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 — the token value never in
 * argv / env. Pools without a token file stay interactive, and the tab records
 * which credential its live claude process actually uses (authMode).
 *
 * The spawn tests start real child processes (node standing in for claude)
 * and check what the child really received: the bytes on its fd 3, its argv
 * and its environment.
 */
import { describe, it, before, after } from 'node:test'
import { setupSuite } from './fixtures/suite-hooks.mjs'

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LONG_TOKEN_FD,
  buildClaudeSpawnEnv,
  claudeOAuthTokenPath,
  resolveClaudeAuth,
  prepareClaudeAuth,
  claudeAuthForSpawn,
  wrapSpawnForAuth,
  bashArgsForAuth,
  recordTabAuthMode,
  stripClaudeTokenEnv,
} from '../../terminal/claude-env.js'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'
import { createClaudeTmuxDriver } from '../../terminal/claude-tmux-driver.js'
import { createPoolLoginDriver } from '../../terminal/pool-login.js'
import { createStore } from '../../server/store.js'

const TOKEN = 'TESTONLY-fake-oauth-token-not-real-0123456789'
const sha = (s) => createHash('sha256').update(s).digest('hex')

let TMP
let TOKEN_DIR
let POOL5 // has T5.token
let POOL6 // no token file

// Stand-in for claude: reports what it received. Never prints the token —
// only the sha of fd 3 — so a leak is detected by searching argv/env for it.
const CHILD = `
const fs = require('fs')
let fd3 = null
try { fd3 = fs.readFileSync(${LONG_TOKEN_FD}, 'utf8') } catch {}
const crypto = require('crypto')
process.stdout.write(JSON.stringify({
  fd3Sha: fd3 === null ? null : crypto.createHash('sha256').update(fd3).digest('hex'),
  argv: process.argv,
  env: process.env,
}))
`

function collect(child) {
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

function runWrapped(auth, { env = {} } = {}) {
  const w = wrapSpawnForAuth({ command: process.execPath, args: ['-e', CHILD] }, auth)
  const childEnv = buildClaudeSpawnEnv({ ...process.env, ...env }, { configDir: auth.configDir, auth })
  return collect(spawn(w.command, w.args, { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] }))
}

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'nanocode-longtoken-'))
  TOKEN_DIR = join(TMP, 'claude-oauth')
  mkdirSync(TOKEN_DIR, { mode: 0o700 })
  writeFileSync(join(TOKEN_DIR, 'T5.token'), TOKEN, { mode: 0o600 })
  writeFileSync(join(TOKEN_DIR, 'T7.token'), '', { mode: 0o600 }) // empty = no token
  POOL5 = join(TMP, '.claude-team5')
  POOL6 = join(TMP, '.claude-team6')
  mkdirSync(POOL5)
  mkdirSync(POOL6)
})

after(() => { rmSync(TMP, { recursive: true, force: true }) })

const envFor = () => ({ CLAUDE_OAUTH_TOKEN_DIR: TOKEN_DIR })

describe('claude-env: which pools use the long-lived token', () => {
  it('maps ~/.claude-teamN to T<N>.token (same rule as the worker cars)', () => {
    assert.equal(claudeOAuthTokenPath('/h/.claude-team4', { env: envFor() }), join(TOKEN_DIR, 'T4.token'))
    assert.equal(claudeOAuthTokenPath('/h/.claude-team12/', { env: envFor() }), join(TOKEN_DIR, 'T12.token'))
    assert.equal(claudeOAuthTokenPath('/h/.claude-team5', { env: {}, home: '/h' }), '/h/.config/claude-oauth/T5.token')
    assert.equal(claudeOAuthTokenPath('/h/.claude', { env: envFor() }), null)
    assert.equal(claudeOAuthTokenPath('/h/.claude-teamX', { env: envFor() }), null)
  })

  it('long_token only when the pool has a non-empty token file', async () => {
    assert.deepEqual(await resolveClaudeAuth(POOL5, { env: envFor() }),
      { configDir: POOL5, authMode: 'long_token', tokenFile: join(TOKEN_DIR, 'T5.token') })
    const noFile = await resolveClaudeAuth(POOL6, { env: envFor() })
    assert.equal(noFile.authMode, 'interactive')
    assert.match(noFile.reason, /T6\.token/)
    assert.equal((await resolveClaudeAuth(join(TMP, '.claude-team7'), { env: envFor() })).authMode, 'interactive')
    assert.equal((await resolveClaudeAuth(join(TMP, '.claude'), { env: envFor() })).authMode, 'interactive')
  })

  it('a spawn without a credential resolved for its dir throws instead of guessing', async () => {
    const cs = { claudeConfigDir: POOL5 }
    assert.throws(() => claudeAuthForSpawn(cs, POOL5), /not resolved/)
    await prepareClaudeAuth(cs, { env: envFor() })
    assert.equal(claudeAuthForSpawn(cs, POOL5).authMode, 'long_token')
    // Team moved (failover / switch-team) after resolution → refuse.
    assert.throws(() => claudeAuthForSpawn(cs, POOL6), /not resolved/)
  })
})

describe('claude-env: env never carries a token value', () => {
  it('long_token sets only the fd-number var; inherited token vars are stripped', () => {
    const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9' }
    const lt = buildClaudeSpawnEnv(base, { configDir: POOL5, auth: { authMode: 'long_token', tokenFile: 'x' } })
    assert.equal(lt.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3')
    assert.equal(lt.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    const ia = buildClaudeSpawnEnv(base, { configDir: POOL6, auth: { authMode: 'interactive', reason: 'r' } })
    assert.equal(ia.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined)
    assert.equal(ia.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    assert.equal(ia.CLAUDE_CONFIG_DIR, POOL6)
    assert.deepEqual(stripClaudeTokenEnv(base), { PATH: '/bin' })
  })
})

describe('claude-env: real child processes', () => {
  it('long_token: child reads the token on fd 3; argv and env do not contain it', async () => {
    const auth = await resolveClaudeAuth(POOL5, { env: envFor() })
    const { code, out } = await runWrapped(auth, { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } })
    assert.equal(code, 0)
    const r = JSON.parse(out)
    assert.equal(r.fd3Sha, sha(TOKEN), 'fd 3 must carry the token file')
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3')
    assert.equal(r.env.CLAUDE_CONFIG_DIR, POOL5)
    assert.equal(JSON.stringify(r.argv).includes(TOKEN), false, 'token in argv')
    assert.equal(JSON.stringify(r.env).includes(TOKEN), false, 'token in env')
    assert.equal(JSON.stringify(r.argv).includes('T5.token'), false, 'the final process argv is the original command')
  })

  it('interactive: no fd 3, no fd var', async () => {
    const auth = await resolveClaudeAuth(POOL6, { env: envFor() })
    const { code, out } = await runWrapped(auth)
    assert.equal(code, 0)
    const r = JSON.parse(out)
    assert.equal(r.fd3Sha, null)
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined)
  })

  it('token file gone between resolve and spawn → the spawn fails (exit 97), never falls back', async () => {
    const auth = { configDir: POOL5, authMode: 'long_token', tokenFile: join(TOKEN_DIR, 'T99.token') }
    const { code, out } = await runWrapped(auth)
    assert.equal(code, 97)
    assert.equal(out, '')
  })

  it('CLI driver bash script gets the same fd 3', async () => {
    const auth = await resolveClaudeAuth(POOL5, { env: envFor() })
    const launchCmd = `exec ${process.execPath} -e "$CHILD_JS"`
    const env = { ...buildClaudeSpawnEnv(process.env, { configDir: POOL5, auth }), CHILD_JS: CHILD }
    const { code, out } = await collect(spawn('bash', bashArgsForAuth(launchCmd, auth), { env, stdio: ['ignore', 'pipe', 'ignore'] }))
    assert.equal(code, 0)
    const r = JSON.parse(out)
    assert.equal(r.fd3Sha, sha(TOKEN))
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3')
    const ia = await resolveClaudeAuth(POOL6, { env: envFor() })
    assert.deepEqual(bashArgsForAuth(launchCmd, ia), ['-lc', launchCmd])
  })
})

// ── SDK driver: the path the secretary tab takes (and the tmux bridge uses) ──

function sdkStore(updates) {
  return {
    getSetting: (k) => (k === 'global_permission' ? 'full-auto' : null),
    updateTabMetadata: (projectId, tabId, patch) => updates.push({ projectId, tabId, patch }),
  }
}

// Calls the driver's spawn hook the way the SDK does, then reports the child.
function spawningPerTurnQuery(seen) {
  return ({ options }) => {
    async function* run() {
      const proxy = options.spawnClaudeCodeProcess({
        command: process.execPath, args: ['-e', CHILD], cwd: TMP,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      })
      let out = ''
      for await (const d of proxy.stdout) out += d
      seen.push(out ? JSON.parse(out) : null)
      yield { type: 'system', subtype: 'init', session_id: 's1', tools: [] }
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok' }
    }
    const it = run()
    it.interrupt = async () => {}
    it.close = async () => {}
    return it
  }
}

function spawningStreamingQuery(seen) {
  return ({ prompt, options }) => {
    const buf = []
    const waiters = []
    const push = (ev) => (waiters.length ? waiters.shift()({ value: ev, done: false }) : buf.push(ev))
    const proxy = options.spawnClaudeCodeProcess({
      command: process.execPath, args: ['-e', CHILD], cwd: TMP, env: { ...process.env },
    })
    let out = ''
    const done = (async () => { for await (const d of proxy.stdout) out += d; seen.push(out ? JSON.parse(out) : null) })()
    ;(async () => {
      for await (const _msg of prompt) {
        await done
        push({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
        push({ type: 'result', subtype: 'success', session_id: 's1', result: 'ok' })
      }
    })().catch(() => {})
    return {
      [Symbol.asyncIterator]() {
        return { next: () => (buf.length ? Promise.resolve({ value: buf.shift(), done: false }) : new Promise((r) => waiters.push(r))) }
      },
      interrupt: async () => {},
      close: async () => {},
    }
  }
}

function makeCs(configDir, tab = 'tab5') {
  return { sessionKey: `proj:claude:${tab}`, claudeSessionId: 's1', claudeConfigDir: configDir, busy: false, turnCount: 1, queue: [], history: [], clients: new Set() }
}

for (const mode of ['per-turn', 'streaming']) {
  describe(`claude sdk driver (${mode}): pool tabs`, () => {
    setupSuite(() => { process.env.CLAUDE_OAUTH_TOKEN_DIR = TOKEN_DIR }, () => { delete process.env.CLAUDE_OAUTH_TOKEN_DIR })

    const makeDriver = (updates, seen, spawns) => createClaudeSdkDriver({
      store: sdkStore(updates),
      home: TMP,
      claudeBroadcast: () => {},
      rerunTurn: () => {},
      runCliFallback: () => { throw new Error('no CLI fallback expected') },
      onClaudeSpawn: (s) => spawns.push(s),
      ...(mode === 'streaming'
        ? { queryImpl: spawningStreamingQuery(seen), forceStreaming: true }
        : { queryImpl: spawningPerTurnQuery(seen) }),
    })

    it('pool with T<N>.token: claude gets fd 3, tab records authMode=long_token', async () => {
      const updates = []; const seen = []; const spawns = []
      const driver = makeDriver(updates, seen, spawns)
      const cs = makeCs(POOL5)
      await driver.runSdkTurn(cs, 'hi', cs.sessionKey, TMP)
      driver.teardownStreamingSession(cs)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].fd3Sha, sha(TOKEN))
      assert.equal(seen[0].env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3')
      assert.equal(JSON.stringify(seen[0]).includes(TOKEN), false)
      const rec = updates.find((u) => u.patch.authMode)
      assert.deepEqual([rec.projectId, rec.tabId, rec.patch.authMode, rec.patch.authModeDetail],
        ['proj', 'tab5', 'long_token', join(TOKEN_DIR, 'T5.token')])
      assert.equal(spawns[0].auth.authMode, 'long_token')
    })

    it('pool without a token file: interactive, recorded with the reason', async () => {
      const updates = []; const seen = []; const spawns = []
      const driver = makeDriver(updates, seen, spawns)
      const cs = makeCs(POOL6, 'tab6')
      await driver.runSdkTurn(cs, 'hi', cs.sessionKey, TMP)
      driver.teardownStreamingSession(cs)
      assert.equal(seen[0].fd3Sha, null)
      assert.equal(seen[0].env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined)
      assert.equal(seen[0].env.CLAUDE_CONFIG_DIR, POOL6)
      const rec = updates.find((u) => u.patch.authMode)
      assert.equal(rec.patch.authMode, 'interactive')
      assert.match(rec.patch.authModeDetail, /no long-lived token file .*T6\.token/)
    })
  })
}

describe('claude tmux driver: bridge-reported credential lands on the tab', () => {
  it('tmux_claude_spawn event with authMode → updateTabMetadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-lt-tmux-'))
    const socketPath = join(dir, 'b.sock')
    const server = createServer((socket) => {
      let buf = ''
      socket.on('data', (c) => {
        buf += c
        if (!buf.includes('\n')) return
        const send = (o) => socket.write(JSON.stringify(o) + '\n')
        send({ type: 'event', event: { type: 'system', subtype: 'tmux_claude_spawn', text: '4242', pid: 4242, authMode: 'long_token', tokenFile: '/x/T5.token' } })
        send({ type: 'turn-done', event: { type: 'result', subtype: 'success' } })
      })
    })
    await new Promise((r) => server.listen(socketPath, r))
    const updates = []
    const driver = createClaudeTmuxDriver({
      store: { getSetting: () => null, updateTabMetadata: (p, t, patch) => updates.push({ p, t, patch }) },
      claudeBroadcast: () => {},
      rerunTurn: () => {},
    })
    const sessionKey = 'projT:claude:tabT'
    const client = driver._getBridgeClient(sessionKey, {})
    client.socketPath = socketPath
    await client._connectSocket()
    client.ensureConnected = async () => {}
    const cs = { sessionKey, claudeSessionId: 's', busy: false, turnCount: 1, queue: [], tabLabel: '' }
    await driver.run(cs, 'hi', sessionKey, dir)
    client.close()
    await new Promise((r) => server.close(r))
    rmSync(dir, { recursive: true, force: true })
    const rec = updates.find((u) => u.patch.authMode)
    assert.deepEqual([rec.p, rec.t, rec.patch.authMode, rec.patch.authModeDetail], ['projT', 'tabT', 'long_token', '/x/T5.token'])
  })
})

describe('store + login stay consistent', () => {
  it('authMode / authModeDetail / authModeAt persist through updateTabMetadata', () => {
    const store = createStore(':memory:')
    const p = store.createProject('p', TMP)
    const tab = store.createTab(p.id, { type: 'claude', claudeConfigDir: POOL5 })
    recordTabAuthMode(store, `${p.id}:claude:${tab.id}`, { authMode: 'long_token', tokenFile: '/x/T5.token' }, { now: () => 0 })
    const got = store.listTabs(p.id).find((t) => t.id === tab.id)
    assert.deepEqual([got.authMode, got.authModeDetail, got.authModeAt], ['long_token', '/x/T5.token', '1970-01-01T00:00:00.000Z'])
  })

  it('one-click pool sign-in (claude auth login) never gets a long-lived token', async () => {
    const saved = { a: process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, b: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = '3'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN
    let spawned = null
    try {
      const driver = createPoolLoginDriver({
        resolveEmail: () => 'owner@example.com',
        spawnPty: (cmd, args, opts) => {
          spawned = { cmd, args, env: opts.env }
          return { onData() {}, onExit() {}, write() {}, kill() {} }
        },
      })
      await driver.start({ id: 'T5', configDir: POOL5 })
      driver.cancel('T5')
    } finally {
      for (const [k, v] of [['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', saved.a], ['CLAUDE_CODE_OAUTH_TOKEN', saved.b]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    }
    assert.ok(spawned, 'login PTY was spawned')
    assert.deepEqual(spawned.args.slice(0, 2), ['auth', 'login'])
    assert.equal(spawned.env.CLAUDE_CONFIG_DIR, POOL5)
    assert.equal(spawned.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined)
    assert.equal(spawned.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  })
})

// ── CLI driver end-to-end through the session controller ──────────────────
// A fake `claude` (NANOCODE_CLAUDE_CODE_EXECUTABLE) records what it received
// and answers with one stream-json result line.
describe('claude session controller (CLI driver): pool tab end to end', () => {
  it('pool tab with T<N>.token: CLI claude gets fd 3, tab metadata says long_token', async () => {
    const { createClaudeSessionController } = await import('../../terminal/claude-session-controller.js')
    const home = mkdtempSync(join(tmpdir(), 'nc-lt-cli-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'nc-lt-cli-cwd-'))
    const report = join(home, 'report.json')
    const fakeClaude = join(home, 'fake-claude')
    writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('fs'); const crypto = require('crypto')
let fd3 = null; try { fd3 = fs.readFileSync(3, 'utf8') } catch {}
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  fd3Sha: fd3 === null ? null : crypto.createHash('sha256').update(fd3).digest('hex'),
  argv: process.argv, env: process.env }))
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cli-s', result: 'ok' }) + '\\n')
`, { mode: 0o755 })
    const saved = { exe: process.env.NANOCODE_CLAUDE_CODE_EXECUTABLE, dir: process.env.CLAUDE_OAUTH_TOKEN_DIR }
    process.env.NANOCODE_CLAUDE_CODE_EXECUTABLE = fakeClaude
    process.env.CLAUDE_OAUTH_TOKEN_DIR = TOKEN_DIR
    const store = createStore(':memory:')
    store.setSetting('claude_driver', 'cli')
    const project = store.createProject('p', cwd)
    const tab = store.createTab(project.id, { type: 'claude', claudeConfigDir: POOL5 })
    try {
      const controller = createClaudeSessionController({ store, home, recentAgents: { getRecentAgentsCached: () => [], primeRecentAgentsCache() {} } })
      const ens = await controller.ensureClaudeSession({ projectId: project.id, tabId: tab.id, project: store.getProject(project.id) })
      assert.equal(ens.ok, true)
      const res = await controller.injectClaudeMessage(ens.sessionKey, 'hello')
      assert.equal(res.ok, true)
      const end = Date.now() + 10_000
      let got = null
      while (Date.now() < end) {
        got = store.getTab(project.id, tab.id)
        let haveReport = false
        try { readFileSync(report); haveReport = true } catch {}
        if (haveReport && got.authMode) break
        await new Promise((r) => setTimeout(r, 20))
      }
      const r = JSON.parse(readFileSync(report, 'utf8'))
      assert.equal(r.fd3Sha, sha(TOKEN))
      assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3')
      assert.equal(r.env.CLAUDE_CONFIG_DIR, POOL5)
      assert.equal(JSON.stringify(r).includes(TOKEN), false)
      assert.equal(got.authMode, 'long_token')
      controller.disposeClaudeSessions?.()
    } finally {
      for (const [k, v] of [['NANOCODE_CLAUDE_CODE_EXECUTABLE', saved.exe], ['CLAUDE_OAUTH_TOKEN_DIR', saved.dir]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
