/**
 * tools/reach/beacon.mjs — the address beacon. The ssh / notify runner is a
 * fake: relays are a map name → source address (or null = unreachable), and
 * every where.json write / notify call is recorded.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  runBeacon, parseSshClient, remoteWriteCommand, buildWhere, notifyText, loadState, WHERE_SCHEMA,
} from '../../tools/reach/beacon.mjs'

function makeCfg(dir) {
  return {
    directPort: 9475,
    stateFile: join(dir, 'state', 'state.json'),
    ssh: ['ssh', '-o', 'BatchMode=yes'],
    notify: ['notify-cmd'],
    relays: [
      { name: 'a', target: 'user@relay-a', entry: 'http://relay-a.example:9475', whereDir: '/var/reach', whereUrl: 'http://relay-a.example:9495/where.json' },
      { name: 'b', target: 'user@relay-b', entry: 'http://relay-b.example:9475', whereDir: '/var/reach', whereUrl: 'http://relay-b.example:9495/where.json' },
    ],
  }
}

/** Fake runner: relays[target] = source address | null (down). */
function makeRunner(relays, { notifyOk = true, writeOk = true } = {}) {
  const calls = { ask: [], write: [], notify: [] }
  const run = async (argv, { input } = {}) => {
    if (argv[0] === 'notify-cmd') {
      calls.notify.push({ key: argv[1], text: argv[2] })
      return { ok: notifyOk, stdout: '', stderr: notifyOk ? '' : 'send failed' }
    }
    const target = argv[3]
    const cmd = argv[4]
    const ip = relays[target]
    if (!ip) return { ok: false, stdout: '', stderr: 'ssh: connect to host: Connection timed out' }
    if (cmd === 'echo "$SSH_CLIENT"') {
      calls.ask.push(target)
      return { ok: true, stdout: `${ip} 51234 22\n`, stderr: '' }
    }
    calls.write.push({ target, cmd, body: JSON.parse(input) })
    return { ok: writeOk, stdout: '', stderr: writeOk ? '' : 'mv: permission denied' }
  }
  return { run, calls }
}

const quiet = () => {}
const at = (iso) => () => new Date(iso)

describe('reach beacon', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'reach-beacon-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('parses the first field of $SSH_CLIENT and rejects non-addresses', () => {
    assert.equal(parseSshClient('192.0.2.7 50122 22\n'), '192.0.2.7')
    assert.equal(parseSshClient('2001:db8::5 50122 22'), '2001:db8::5')
    assert.equal(parseSshClient('\n'), '')
    assert.equal(parseSshClient('not-an-ip 1 2'), '')
  })

  it('first run: writes where.json on every relay once and notifies once with the direct URL', async () => {
    const cfg = makeCfg(dir)
    const { run, calls } = makeRunner({ 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' })
    const r = await runBeacon(cfg, { run, now: at('2026-01-02T03:04:05Z'), log: quiet })
    assert.equal(r.ip, '192.0.2.7')
    assert.equal(r.changed, true)
    assert.deepEqual(calls.write.map((w) => w.target), ['user@relay-a', 'user@relay-b'])
    assert.equal(calls.notify.length, 1)
    assert.match(calls.notify[0].text, /Nanocode 直连地址变了：http:\/\/192\.0\.2\.7:9475/)
    assert.match(calls.notify[0].text, /relay-a\.example:9475.*relay-b\.example:9475/)
    const body = calls.write[0].body
    assert.equal(body.schema, WHERE_SCHEMA)
    assert.equal(body.direct, 'http://192.0.2.7:9475')
    assert.deepEqual(body.relays, [{ name: 'a', url: 'http://relay-a.example:9475' }, { name: 'b', url: 'http://relay-b.example:9475' }])
    assert.deepEqual(body.where, ['http://relay-a.example:9495/where.json', 'http://relay-b.example:9495/where.json'])
    assert.equal(body.updated_at, '2026-01-02T03:04:05.000Z')
  })

  it('same address on the next run: no write, no notify', async () => {
    const cfg = makeCfg(dir)
    const relays = { 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' }
    await runBeacon(cfg, { run: makeRunner(relays).run, log: quiet })
    const { run, calls } = makeRunner(relays)
    const r = await runBeacon(cfg, { run, log: quiet })
    assert.equal(r.changed, false)
    assert.deepEqual(calls.write, [])
    assert.deepEqual(calls.notify, [])
    assert.deepEqual(calls.ask, ['user@relay-a', 'user@relay-b'])
  })

  it('address changes: every relay written once, notified once, new idempotency key', async () => {
    const cfg = makeCfg(dir)
    const first = makeRunner({ 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' })
    await runBeacon(cfg, { run: first.run, now: at('2026-01-02T03:04:05Z'), log: quiet })
    const { run, calls } = makeRunner({ 'user@relay-a': '192.0.2.99', 'user@relay-b': '192.0.2.99' })
    const r = await runBeacon(cfg, { run, now: at('2026-01-02T05:00:00Z'), log: quiet })
    assert.equal(r.changed, true)
    assert.equal(calls.write.length, 2)
    assert.ok(calls.write.every((w) => w.body.direct === 'http://192.0.2.99:9475'))
    assert.equal(calls.notify.length, 1)
    assert.notEqual(calls.notify[0].key, first.calls.notify[0].key)
    assert.match(calls.notify[0].text, /192\.0\.2\.99:9475/)
  })

  it('one relay unreachable: skipped (not read as a change), the other still updated; it catches up when back', async () => {
    const cfg = makeCfg(dir)
    await runBeacon(cfg, { run: makeRunner({ 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' }).run, log: quiet })
    const logs = []
    const down = makeRunner({ 'user@relay-a': null, 'user@relay-b': '192.0.2.50' })
    const r = await runBeacon(cfg, { run: down.run, log: (l) => logs.push(l) })
    assert.deepEqual(r.skipped, ['a'])
    assert.equal(r.ip, '192.0.2.50')
    assert.deepEqual(down.calls.write.map((w) => w.target), ['user@relay-b'])
    assert.equal(down.calls.notify.length, 1)
    assert.ok(logs.some((l) => /relay a unreachable/.test(l)), logs.join('\n'))
    // relay a is back, address unchanged: only a gets the file, no second notify.
    const back = makeRunner({ 'user@relay-a': '192.0.2.50', 'user@relay-b': '192.0.2.50' })
    const r2 = await runBeacon(cfg, { run: back.run, log: quiet })
    assert.equal(r2.changed, false)
    assert.deepEqual(back.calls.write.map((w) => w.target), ['user@relay-a'])
    assert.deepEqual(back.calls.notify, [])
  })

  it('one relay down with an unchanged address: nothing written, nothing sent', async () => {
    const cfg = makeCfg(dir)
    await runBeacon(cfg, { run: makeRunner({ 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' }).run, log: quiet })
    const { run, calls } = makeRunner({ 'user@relay-a': null, 'user@relay-b': '192.0.2.7' })
    const r = await runBeacon(cfg, { run, log: quiet })
    assert.equal(r.changed, false)
    assert.deepEqual(calls.write, [])
    assert.deepEqual(calls.notify, [])
  })

  it('no relay answers: state untouched, nothing written or sent, run reported as failed', async () => {
    const cfg = makeCfg(dir)
    await runBeacon(cfg, { run: makeRunner({ 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' }).run, log: quiet })
    const before = readFileSync(cfg.stateFile, 'utf8')
    const { run, calls } = makeRunner({ 'user@relay-a': null, 'user@relay-b': null })
    const r = await runBeacon(cfg, { run, log: quiet })
    assert.deepEqual(r.skipped, ['a', 'b'])
    assert.deepEqual(r.failed, ['no relay answered'])
    assert.deepEqual(calls.write, [])
    assert.deepEqual(calls.notify, [])
    assert.equal(readFileSync(cfg.stateFile, 'utf8'), before)
  })

  it('a failed notify is retried on the next run (once), with the same idempotency key', async () => {
    const cfg = makeCfg(dir)
    const relays = { 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' }
    const failing = makeRunner(relays, { notifyOk: false })
    const r1 = await runBeacon(cfg, { run: failing.run, log: quiet })
    assert.deepEqual(r1.failed, ['notify'])
    const ok = makeRunner(relays)
    const r2 = await runBeacon(cfg, { run: ok.run, log: quiet })
    assert.equal(r2.notified, true)
    assert.deepEqual(ok.calls.write, [])
    assert.equal(ok.calls.notify[0].key, failing.calls.notify[0].key)
    const r3 = await runBeacon(cfg, { run: makeRunner(relays).run, log: quiet })
    assert.equal(r3.notified, false)
  })

  it('state survives a restart (it is a file) and a corrupt state file fails loudly', async () => {
    const cfg = makeCfg(dir)
    await runBeacon(cfg, { run: makeRunner({ 'user@relay-a': '192.0.2.7', 'user@relay-b': '192.0.2.7' }).run, now: at('2026-01-02T03:04:05Z'), log: quiet })
    const s = await loadState(cfg.stateFile)
    assert.deepEqual(s, { ip: '192.0.2.7', since: '2026-01-02T03:04:05.000Z', pushed: { a: '192.0.2.7', b: '192.0.2.7' }, notified: '192.0.2.7' })
    assert.deepEqual(readdirSync(join(dir, 'state')), ['state.json'])  // no temp file left behind
    writeFileSync(cfg.stateFile, '{not json')
    await assert.rejects(runBeacon(cfg, { run: makeRunner({}).run, log: quiet }), SyntaxError)
  })

  it('the remote write is atomic: temp file in the same directory, then mv over where.json', () => {
    const relayDir = join(dir, "relay dir with 'quote'")
    const cmd = remoteWriteCommand(relayDir)
    const doc = JSON.stringify(buildWhere(makeCfg(dir), { ip: '192.0.2.7', since: 'x' }))
    execFileSync('sh', ['-c', cmd], { input: doc })
    assert.equal(readFileSync(join(relayDir, 'where.json'), 'utf8'), doc)
    assert.deepEqual(readdirSync(relayDir), ['where.json'])
    assert.match(cmd, /cat > "\$t"; mv -f "\$t" "\$d\/where\.json"/)
  })

  it('rejects an incomplete config before touching anything', async () => {
    const cfg = makeCfg(dir)
    delete cfg.relays[1].whereDir
    await assert.rejects(runBeacon(cfg, { run: makeRunner({}).run, log: quiet }), /relays\[1\]\.whereDir/)
  })

  it('formats IPv6 direct addresses with brackets', () => {
    assert.match(notifyText(makeCfg(dir), { ip: '2001:db8::5' }), /http:\/\/\[2001:db8::5\]:9475/)
  })
})
