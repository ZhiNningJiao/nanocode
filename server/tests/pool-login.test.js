import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  poolLabel,
  resolveOwnerEmail,
  discoverLoginPools,
  interactiveCredStatus,
  longTokenStatus,
  readDutyConfigDir,
  buildPoolLoginView,
  createPoolLoginDriver,
  verifyPool,
} from '../../terminal/pool-login.js'

// ─── a fake node-pty: an EventEmitter-ish PTY the driver can drive without a real `claude` process ──
function fakePty() {
  const onDataCbs = []
  const onExitCbs = []
  const written = []
  let killed = false
  const proc = {
    onData(cb) { onDataCbs.push(cb) },
    onExit(cb) { onExitCbs.push(cb) },
    write(s) { written.push(s) },
    kill() { killed = true },
  }
  return {
    proc,
    written,
    isKilled: () => killed,
    emitData(s) { for (const cb of onDataCbs) cb(s) },
    emitExit(exitCode) { for (const cb of onExitCbs) cb({ exitCode, signal: null }) },
  }
}

describe('poolLabel', () => {
  it('maps .claude (team1) and .claude-teamN to T1/TN', () => {
    assert.equal(poolLabel('team1'), 'T1')
    assert.equal(poolLabel('team4'), 'T4')
    assert.equal(poolLabel('team12'), 'T12')
  })
  it('passes through anything it does not recognise, never throws', () => {
    assert.equal(poolLabel('custom-pool'), 'custom-pool')
    assert.equal(poolLabel(''), '')
  })
})

describe('resolveOwnerEmail', () => {
  it('reads git config user.email and trims it', () => {
    const exec = mock.fn(() => '  owner@example.com\n')
    assert.equal(resolveOwnerEmail({ exec }), 'owner@example.com')
    assert.equal(exec.mock.calls[0].arguments[0], 'git')
    assert.deepEqual(exec.mock.calls[0].arguments[1], ['config', '--global', 'user.email'])
  })
  it('degrades to null (never throws) when git config is unset or git is missing', () => {
    const exec = mock.fn(() => { throw new Error('exit 1') })
    assert.equal(resolveOwnerEmail({ exec }), null)
  })
  it('degrades to null on a blank email', () => {
    assert.equal(resolveOwnerEmail({ exec: () => '\n' }), null)
  })
})

describe('discoverLoginPools', () => {
  it('only lists pools that actually exist on disk, with id/label/configDir', async () => {
    const listTeams = async () => ({
      teams: [
        { id: 'team1', name: 'Team 1', path: '/home/.claude', exists: true },
        { id: 'team2', name: 'Team 2', path: '/home/.claude-team2', exists: false },
        { id: 'team4', name: 'Team 4', path: '/home/.claude-team4', exists: true },
      ],
    })
    const pools = await discoverLoginPools({ listTeams })
    assert.deepEqual(pools, [
      { id: 'team1', label: 'T1', name: 'Team 1', configDir: '/home/.claude' },
      { id: 'team4', label: 'T4', name: 'Team 4', configDir: '/home/.claude-team4' },
    ])
  })

  it('dedupes by id, keeping the first directory (terminal/usage.js can hand back two dirs for one id when both ~/.claude and a literal ~/.claude-team1 exist)', async () => {
    const listTeams = async () => ({
      teams: [
        { id: 'team1', name: 'Team 1', path: '/home/.claude', exists: true },
        { id: 'team1', name: 'Team team1', path: '/home/.claude-team1', exists: true },
      ],
    })
    const pools = await discoverLoginPools({ listTeams })
    assert.deepEqual(pools, [{ id: 'team1', label: 'T1', name: 'Team 1', configDir: '/home/.claude' }])
  })
})

describe('interactiveCredStatus / longTokenStatus', () => {
  it('interactiveCredStatus is a plain boolean, never the credential object itself', async () => {
    // readClaudeOAuthCredentials degrades to null for a configDir with no .credentials.json
    assert.equal(await interactiveCredStatus('/does/not/exist-nanologin-2250'), false)
  })
  it('longTokenStatus is false for a token file that does not exist', async () => {
    assert.equal(await longTokenStatus('T9', { oauthDir: '/does/not/exist-nanologin-2250' }), false)
  })
})

describe('readDutyConfigDir', () => {
  it('degrades to null (not a guess) when the file is missing or unparseable', async () => {
    assert.equal(await readDutyConfigDir('/does/not/exist-nanologin-2250/duty-status.json'), null)
  })
})

describe('buildPoolLoginView', () => {
  it('assembles id/label/duty-pool flag/cred flags/last-call per pool, never leaking a token value', async () => {
    const discover = async () => [{ id: 'team4', label: 'T4', name: 'Team 4', configDir: '/does/not/exist-nanologin-2250' }]
    const view = await buildPoolLoginView({
      discover,
      dutyStatusPath: null,
      quotaByLabel: new Map([['T4', { ok: true, error: null, at: '2026-11-26T12:00:00.000Z' }]]),
      credCheck: async () => false,
      tokenCheck: async () => false,
    })
    assert.deepEqual(view, [{
      id: 'team4', label: 'T4', name: 'Team 4', isDutyPool: false,
      interactiveCred: false, longToken: false,
      lastRealCall: { ok: true, error: null, at: '2026-11-26T12:00:00.000Z' },
    }])
    for (const v of view) assert.ok(JSON.stringify(v).indexOf('sk-ant') === -1)
  })
})

const POOL = { id: 'team9', label: 'T9', name: 'Team 9', configDir: '/tmp/nanologin-2250-fake-pool' }

describe('createPoolLoginDriver', () => {
  it('idle before start() is ever called', () => {
    const driver = createPoolLoginDriver()
    assert.deepEqual(driver.get('never-started'), { state: 'idle' })
  })

  it('happy path: starting -> awaiting_code (url scraped) -> submitting -> verifying -> done, with a verify result', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({
      spawnPty: () => fp.proc,
      execFileImpl: (cmd, args, opts, cb) => cb(null, 'ok\n'),
      resolveEmail: () => 'owner@example.com',
    })
    const started = await driver.start(POOL)
    assert.equal(started.state, 'starting')

    fp.emitData('Visit this URL to authenticate:\nhttps://claude.com/cai/oauth/authorize?foo=bar\nPaste code here: ')
    let st = driver.get(POOL.id)
    assert.equal(st.state, 'awaiting_code')
    assert.equal(st.url, 'https://claude.com/cai/oauth/authorize?foo=bar')

    const submitted = driver.submitCode(POOL.id, '  123-456  ')
    assert.equal(submitted.ok, true)
    assert.deepEqual(fp.written, ['123-456\r\n'])
    assert.equal(driver.get(POOL.id).state, 'submitting')

    fp.emitData('Login successful!\n')
    // runVerify is async (the fake execFileImpl resolves on the next tick)
    await new Promise((r) => setTimeout(r, 10))
    st = driver.get(POOL.id)
    assert.equal(st.state, 'done')
    assert.equal(st.verify.ok, true)
    assert.equal(st.verify.reply, 'ok')
  })

  it('never returns the PTY handle or timer handles from get()', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => fp.proc, resolveEmail: () => 'a@b.com' })
    await driver.start(POOL)
    const st = driver.get(POOL.id)
    assert.equal('_proc' in st, false)
    assert.equal('_timers' in st, false)
  })

  it('a second start() while one is in flight is a no-op (idempotent), does not spawn twice', async () => {
    let spawnCount = 0
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => { spawnCount++; return fp.proc }, resolveEmail: () => 'a@b.com' })
    await driver.start(POOL)
    await driver.start(POOL)
    assert.equal(spawnCount, 1)
  })

  it('submitCode is rejected when not awaiting a code', () => {
    const driver = createPoolLoginDriver()
    const r = driver.submitCode('idle-pool', '123456')
    assert.equal(r.ok, false)
    assert.match(r.error, /not awaiting a code/)
  })

  it('a bad/expired code reported by the CLI fails the login with a plain-English reason (no leaked code value)', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => fp.proc, resolveEmail: () => 'a@b.com' })
    await driver.start(POOL)
    fp.emitData('Paste code here: ')
    driver.submitCode(POOL.id, '000000')
    fp.emitData('Error: invalid code, please try again\n')
    const st = driver.get(POOL.id)
    assert.equal(st.state, 'error')
    assert.doesNotMatch(st.error, /000000/)
  })

  it('CLI exiting 0 right after the code was submitted (no "Login successful" string seen) still verifies', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({
      spawnPty: () => fp.proc,
      execFileImpl: (cmd, args, opts, cb) => cb(null, 'hi'),
      resolveEmail: () => 'a@b.com',
    })
    await driver.start(POOL)
    fp.emitData('Paste code here: ')
    driver.submitCode(POOL.id, '123456')
    fp.emitExit(0)
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(driver.get(POOL.id).state, 'done')
  })

  it('CLI exiting non-zero before login completes is reported as an error', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => fp.proc, resolveEmail: () => 'a@b.com' })
    await driver.start(POOL)
    fp.emitExit(1)
    const st = driver.get(POOL.id)
    assert.equal(st.state, 'error')
    assert.match(st.error, /exited/)
  })

  it('times out waiting for the auth link and kills the PTY', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => fp.proc, resolveEmail: () => 'a@b.com', urlWaitMs: 15 })
    await driver.start(POOL)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(driver.get(POOL.id).state, 'error')
    assert.match(driver.get(POOL.id).error, /timed out waiting for the auth link/)
    assert.equal(fp.isKilled(), true)
  })

  it('times out waiting for the pasted-back code once the link is shown', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => fp.proc, resolveEmail: () => 'a@b.com', codeWaitMs: 15 })
    await driver.start(POOL)
    fp.emitData('Paste code here: ')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(driver.get(POOL.id).state, 'error')
    assert.match(driver.get(POOL.id).error, /timed out waiting for the pasted-back code/)
  })

  it('times out when the CLI neither confirms nor rejects the code', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => fp.proc, resolveEmail: () => 'a@b.com', afterCodeMs: 15 })
    await driver.start(POOL)
    fp.emitData('Paste code here: ')
    driver.submitCode(POOL.id, '123456')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(driver.get(POOL.id).state, 'error')
    assert.match(driver.get(POOL.id).error, /timed out after submitting the code/)
  })

  it('refuses to start without a resolvable owner email, and never puts the email in the error text', async () => {
    const driver = createPoolLoginDriver({ resolveEmail: () => null })
    const st = await driver.start(POOL)
    assert.equal(st.state, 'error')
    assert.doesNotMatch(st.error, /@/)
  })

  it('cancel() kills the PTY and resets to idle', async () => {
    const fp = fakePty()
    const driver = createPoolLoginDriver({ spawnPty: () => fp.proc, resolveEmail: () => 'a@b.com' })
    await driver.start(POOL)
    driver.cancel(POOL.id)
    assert.equal(fp.isKilled(), true)
    assert.deepEqual(driver.get(POOL.id), { state: 'idle' })
  })
})

describe('verifyPool', () => {
  it('ok: true with a trimmed, length-capped reply on success', async () => {
    const r = await verifyPool('/some/pool', { execFileImpl: (cmd, args, opts, cb) => cb(null, '  ok  \n') })
    assert.deepEqual({ ok: r.ok, reply: r.reply }, { ok: true, reply: 'ok' })
    assert.ok(typeof r.at === 'string')
  })
  it('ok: false with a short error message on failure, never throws', async () => {
    const r = await verifyPool('/some/pool', { execFileImpl: (cmd, args, opts, cb) => cb(new Error('spawn claude ENOENT')) })
    assert.equal(r.ok, false)
    assert.match(r.error, /ENOENT/)
  })
  it('calls the pool with its own CLAUDE_CONFIG_DIR, never a hardcoded one', async () => {
    let seenEnv = null
    await verifyPool('/pool/abc', { execFileImpl: (cmd, args, opts, cb) => { seenEnv = opts.env; cb(null, 'ok') } })
    assert.equal(seenEnv.CLAUDE_CONFIG_DIR, '/pool/abc')
  })
})
