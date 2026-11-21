// Command Center phase 2: link safety (P1), bounded doc read (P3), the
// "waiting on you" queue (P0-4) and quota per pool (P0-5).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, utimes } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { safeHttpUrl } from '../../public/js/command-center-url.js'
import { mapBar, mapLinearResponse, createCarsSource, createLinearSource, createCommandCenterRoutes, readTextCapped } from '../command-center.js'
import {
  OWNER_PENDING_SCHEMA, mapExportWaiting, mapCarWaitingItems, mapOwnerPending, buildWaitingView, createOwnerPendingSource,
} from '../command-center-waiting.js'
import { parseReadingTime, mapQuotaReading, buildQuotaView, createQuotaSource, DEFAULT_QUOTA_STALE_SEC } from '../command-center-quota.js'
import {
  CARS_EXPORT_SCHEMA, GANTT_SCHEMA, WAITING_SCHEMA, classifySignalName, matchTraceId, pickSignals, buildWaitingSection, buildEnvelope, scanWaiting,
} from '../../tools/command-center/export-cars.mjs'

// Fixture files live in a gitignored dir inside this worktree — never host /tmp.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, '.fixtures-tmp', 'command-center-p2')

after(async () => { await rm(FIXTURE_DIR, { recursive: true, force: true }) })

function bar(over = {}) {
  return {
    trace_id: 'car_a', car: 'car_a', issue: null, title: 'do the thing', status: 'delivered', plain: 'it is done',
    start: '2026-01-01T10:00:00+08:00', end: '2026-01-01T11:00:00+08:00', points: [],
    links: { task: null, step: null, report: null, prs: [], branches: [], boards: [] },
    ...over,
  }
}

function gantt(bars) {
  return { schema: GANTT_SCHEMA, from: '2026-01-01T00:00:00+08:00', to: '2026-01-01T12:00:00+08:00', n_bars: bars.length, groups: [], bars }
}

// ─── P1: only http(s) links ─────────────────────────────────────────────────

describe('safeHttpUrl (P1)', () => {
  it('keeps absolute http / https links (normalized)', () => {
    assert.equal(safeHttpUrl('https://git.example/o/r/pull/7'), 'https://git.example/o/r/pull/7')
    assert.equal(safeHttpUrl('http://board.example/x?y=1'), 'http://board.example/x?y=1')
    assert.equal(safeHttpUrl('HTTPS://Git.Example/a'), 'https://git.example/a')
    assert.equal(safeHttpUrl('  https://git.example/a \n'), 'https://git.example/a')
  })
  it('drops script / data / other schemes, mixed case and padded too', () => {
    for (const bad of [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', '\tjavascript:alert(1)', 'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>', 'DATA:text/html;base64,PHNjcmlwdD4=', ' vbscript:x', 'file:///etc/passwd',
      'ftp://x.example/a', 'mailto:nobody', '//evil.example/a', '/relative/path', 'git.example/o/r', '', '   ', null, 42, ['https://x.example'],
    ]) assert.equal(safeHttpUrl(bad), null, JSON.stringify(bad))
  })
  it('mapBar keeps only safe PR / board links; branches stay plain text', () => {
    const c = mapBar(bar({ links: { prs: ['https://git.example/o/r/pull/7', 'javascript:alert(1)', ' JAVASCRIPT:x'], boards: ['data:text/html,x', 'http://board.example/1'], branches: ['zn/x'] } }))
    assert.deepEqual(c.prs, ['https://git.example/o/r/pull/7'])
    assert.deepEqual(c.boards, ['http://board.example/1'])
    assert.deepEqual(c.branches, ['zn/x'])
  })
  it('tracker issue urls go through the same filter', () => {
    const m = mapLinearResponse({ data: { issue: { identifier: 'T-1', title: 'R', url: 'javascript:alert(1)', children: { nodes: [
      { identifier: 'T-2', title: 'a', url: 'data:text/html,x' }, { identifier: 'T-3', title: 'b', url: 'https://tracker.example/T-3' },
    ] } } } })
    assert.equal(m.root.url, null)
    assert.equal(m.events[0].url, null)
    assert.equal(m.events[1].url, 'https://tracker.example/T-3')
  })
})

// ─── P3: bounded document read ──────────────────────────────────────────────

describe('readTextCapped + doc route (P3)', () => {
  let server
  let base
  const dir = path.join(FIXTURE_DIR, 'doc')
  before(async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'small.md'), 'hello')
    await writeFile(path.join(dir, 'big.md'), 'x'.repeat(512 * 1024 + 10))
    const carsPath = path.join(dir, 'cars.json')
    const now = new Date().toISOString()
    await writeFile(carsPath, JSON.stringify({ schema: CARS_EXPORT_SCHEMA, exported_at: now, ok: true, last_ok_at: now, gantt: gantt([
      bar({ trace_id: 'small', links: { report: path.join(dir, 'small.md') } }),
      bar({ trace_id: 'big', links: { report: path.join(dir, 'big.md') } }),
      bar({ trace_id: 'dir', links: { report: dir } }),
    ]) }))
    const cfg = path.join(dir, 'cfg.json')
    await writeFile(cfg, JSON.stringify({ linear: { rootIssue: 'T-1', graphqlUrl: 'https://tracker.example/graphql' }, carsExport: { path: carsPath } }))
    const linearSource = createLinearSource({ fetchImpl: async () => ({ ok: false, status: 503 }), getApiKey: () => 'k' })
    const app = express()
    app.use(createCommandCenterRoutes({ configPath: cfg, linearSource }))
    await new Promise((r) => { server = app.listen(0, 'localhost', r) })
    base = `http://localhost:${server.address().port}`
    await fetch(`${base}/api/command-center`)
  })
  after(async () => { await new Promise((r) => server.close(r)) })

  it('never reads more than the cap, says when it cut', async () => {
    assert.deepEqual(await readTextCapped(path.join(dir, 'small.md'), 100), { text: 'hello', truncated: false })
    const r = await readTextCapped(path.join(dir, 'small.md'), 3)
    assert.deepEqual(r, { text: 'hel', truncated: true })
    await assert.rejects(readTextCapped(dir, 10), /not a regular file/)
  })
  it('doc route: a file larger than the cap comes back truncated (marked), not whole', async () => {
    const r = await fetch(`${base}/api/command-center/doc?trace=big&kind=report`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-truncated'), String(512 * 1024))
    const txt = await r.text()
    assert.ok(txt.length < 512 * 1024 + 100)
    assert.match(txt, /truncated at 524288 bytes\]$/)
    assert.equal(await (await fetch(`${base}/api/command-center/doc?trace=small&kind=report`)).text(), 'hello')
    assert.equal((await fetch(`${base}/api/command-center/doc?trace=dir&kind=report`)).status, 404)
  })
})

// ─── exporter: waiting signals ──────────────────────────────────────────────

describe('export-cars waiting section', () => {
  it('classifies signal names (accepted flags and other files are not signals)', () => {
    assert.deepEqual(classifySignalName('NEEDSIG_car_a'), { kind: 'needsig', tag: 'car_a' })
    assert.deepEqual(classifySignalName('FLAG_car_a'), { kind: 'flag', tag: 'car_a' })
    for (const n of ['FLAG_car_a.accepted-2032', 'FLAG_car_a.accepted-2149-timeout-partial', 'FLAG_', 'NEEDSIG_', 'REPORT_car_a.md', 'STEP_x', 'xFLAG_a', null]) {
      assert.equal(classifySignalName(n), null, String(n))
    }
  })
  it('matches NEEDSIG suffixes to the longest car id at a word boundary, never a guess', () => {
    const ids = new Set(['car', 'car_a', 'car_ab'])
    assert.equal(matchTraceId('car_a', ids), 'car_a')
    assert.equal(matchTraceId('car_a_login', ids), 'car_a')
    assert.equal(matchTraceId('car_a.txt', ids), 'car_a')
    assert.equal(matchTraceId('car_abc', new Set(['car_a', 'car_ab'])), null) // 'car_ab' + 'c' is not a boundary
    assert.equal(matchTraceId('car_abc', ids), 'car') // 'car' + '_' is
    assert.equal(matchTraceId('other', ids), null)
  })
  it('only flags of known cars are picked; others are counted; no car list → no flags', () => {
    const names = ['FLAG_car_a', 'FLAG_cron_1', 'FLAG_car_b.accepted-1200', 'NEEDSIG_car_b_key', 'NEEDSIG_lost', 'README']
    const p = pickSignals(names, new Set(['car_a', 'car_b']))
    assert.deepEqual(p.picks.map((x) => [x.kind, x.tag, x.traceId]), [['flag', 'car_a', 'car_a'], ['needsig', 'car_b_key', 'car_b'], ['needsig', 'lost', null]])
    assert.equal(p.skippedFlags, 1)
    assert.equal(p.flagsChecked, true)
    const q = pickSignals(names, null)
    assert.deepEqual(q.picks.map((x) => x.kind), ['needsig', 'needsig'])
    assert.equal(q.flagsChecked, false)
  })
  it('builds items oldest first, skips files that vanished, caps NEEDSIG text', () => {
    const picked = pickSignals(['NEEDSIG_car_a', 'FLAG_car_b', 'FLAG_car_c'], new Set(['car_a', 'car_b', 'car_c']))
    const files = new Map([
      ['NEEDSIG_car_a', { mtimeMs: Date.parse('2026-01-01T02:00:00Z'), text: `  need the key\n${'z'.repeat(2000)}` }],
      ['FLAG_car_b', { mtimeMs: Date.parse('2026-01-01T01:00:00Z'), text: null }],
    ])
    const w = buildWaitingSection({ picked, files, now: new Date('2026-01-01T03:00:00Z') })
    assert.equal(w.schema, WAITING_SCHEMA)
    assert.deepEqual(w.items.map((i) => i.tag), ['car_b', 'car_a'])
    assert.ok(w.items[1].text.startsWith('need the key'))
    assert.equal(w.items[1].text.length, 600)
    const bad = buildWaitingSection({ error: 'signals dir unreadable: EACCES' })
    assert.equal(bad.ok, false)
  })
  it('the envelope carries waiting on success and on trace failure', () => {
    const waiting = { schema: WAITING_SCHEMA, ok: true, items: [] }
    assert.equal(buildEnvelope({ gantt: gantt([]), from: '-3d', waiting }).waiting, waiting)
    const f = buildEnvelope({ error: 'trace down', from: '-3d', waiting })
    assert.equal(f.ok, false)
    assert.equal(f.waiting, waiting)
    assert.equal(buildEnvelope({ gantt: gantt([]), from: '-3d' }).waiting, null)
  })
  it('scanWaiting reads a real directory (fixture)', async () => {
    const dir = path.join(FIXTURE_DIR, 'signals')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'NEEDSIG_car_a'), 'need: login for the pool\n')
    await writeFile(path.join(dir, 'FLAG_car_b'), '')
    await writeFile(path.join(dir, 'FLAG_car_c.accepted-1000'), '')
    await writeFile(path.join(dir, 'FLAG_cron_x'), '')
    await mkdir(path.join(dir, 'NEEDSIG_car_dir'), { recursive: true }) // a directory is not a signal
    await utimes(path.join(dir, 'FLAG_car_b'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    const w = await scanWaiting(dir, gantt([bar({ trace_id: 'car_a' }), bar({ trace_id: 'car_b' }), bar({ trace_id: 'car_c' })]))
    assert.equal(w.ok, true)
    assert.deepEqual(w.items.map((i) => [i.kind, i.tag]), [['flag', 'car_b'], ['needsig', 'car_a']])
    assert.equal(w.items[1].text, 'need: login for the pool')
    assert.equal(w.skipped_flags, 1)
    const gone = await scanWaiting(path.join(FIXTURE_DIR, 'nope'), gantt([]))
    assert.equal(gone.ok, false)
    assert.match(gone.error, /ENOENT/)
  })
})

// ─── server: waiting queue ──────────────────────────────────────────────────

function carsSnapWith(signals, bars, { ok = true } = {}) {
  const cars = bars.map(mapBar)
  return {
    ok, checkedAt: '2026-01-01T03:00:00Z', lastOkAt: '2026-01-01T03:00:00Z', error: ok ? null : 'trace down',
    data: ok ? { cars } : null,
    waiting: mapExportWaiting({ schema: WAITING_SCHEMA, ok: true, scanned_at: '2026-01-01T03:00:00Z', flags_checked: true, skipped_flags: 3, items: signals }),
  }
}

const OWNER_DOC = {
  schema: OWNER_PENDING_SCHEMA,
  updated_at: '2026-01-01T03:00:00Z',
  items: [
    { id: 'pr-7', title: 'merge PR 7?', summary: 'one line', url: 'https://git.example/o/r/pull/7', since: '2026-01-01T00:30:00Z', recommendation: 'merge', options: ['merge', 'hold'], waiter: 'secretary' },
    { id: 'bad-url', title: 'x', url: 'javascript:alert(1)', since: '2026-01-01T02:30:00Z' },
    { id: 'no-since', title: 'y' },
    { title: 'no id', since: '2026-01-01T00:00:00Z' },
  ],
}

describe('waiting queue mapping', () => {
  it('maps the export section; missing / wrong / failed sections are errors, not empty', () => {
    assert.match(mapExportWaiting(null).error, /without --signals-dir/)
    assert.match(mapExportWaiting({ schema: 'x/v9' }).error, /unexpected schema/)
    assert.equal(mapExportWaiting({ schema: WAITING_SCHEMA, ok: false, error: 'EACCES' }).error, 'EACCES')
    const m = mapExportWaiting({ schema: WAITING_SCHEMA, ok: true, flags_checked: true, skipped_flags: 2, items: [
      { kind: 'needsig', tag: 'a', trace_id: 'a', since: '2026-01-01T00:00:00Z', text: 'help' },
      { kind: 'weird', tag: 'b', since: '2026-01-01T00:00:00Z' },
      { kind: 'flag', tag: 'c', since: 'not a time' },
    ] })
    assert.deepEqual(m.signals.map((s) => s.tag), ['a'])
  })
  it('car items say what is stuck and who waits; blocked cars without NEEDSIG are included once', () => {
    const snap = carsSnapWith(
      [
        { kind: 'needsig', tag: 'car_a', file: 'NEEDSIG_car_a', trace_id: 'car_a', since: '2026-01-01T01:00:00Z', text: 'need the pool login' },
        { kind: 'flag', tag: 'car_b', file: 'FLAG_car_b', trace_id: 'car_b', since: '2026-01-01T02:00:00Z' },
        { kind: 'flag', tag: 'cron_1', file: 'FLAG_cron_1', trace_id: 'cron_1', since: '2026-01-01T00:10:00Z' },
      ],
      [
        bar({ trace_id: 'car_a', status: 'blocked', title: 'car A task' }),
        bar({ trace_id: 'car_b', status: 'delivered', plain: 'B finished' }),
        bar({ trace_id: 'car_c', status: 'blocked', points: [{ t: '2026-01-01T00:20:00Z', kind: 'blocked', label: 'asked for a key' }] }),
        bar({ trace_id: 'cron_1', status: 'delivered' }),
      ],
    )
    const { items, hidden } = mapCarWaitingItems(snap.waiting, snap.data.cars, ['cron_'])
    assert.equal(hidden, 1)
    const byId = Object.fromEntries(items.map((i) => [i.traceId, i]))
    assert.equal(byId.car_a.kind, 'blocked')
    assert.equal(byId.car_a.detail, 'need the pool login')
    assert.equal(byId.car_a.title, 'car A task')
    assert.equal(byId.car_a.waitingOn, 'secretary')
    assert.equal(byId.car_b.kind, 'delivered')
    assert.equal(byId.car_b.detail, 'B finished')
    assert.equal(byId.car_c.detail, 'asked for a key')
    assert.equal(byId.car_c.since, '2026-01-01T00:20:00Z')
    assert.equal(items.length, 3, 'car_a not doubled by its blocked trace status')
  })
  it('owner file: schema enforced, bad items counted, unsafe links dropped', () => {
    assert.throws(() => mapOwnerPending({ schema: 'other' }), /unexpected schema/)
    const m = mapOwnerPending(OWNER_DOC)
    assert.equal(m.invalid, 2)
    assert.deepEqual(m.items.map((i) => i.id), ['owner:pr-7', 'owner:bad-url'])
    assert.equal(m.items[0].url, 'https://git.example/o/r/pull/7')
    assert.equal(m.items[1].url, null)
    assert.deepEqual(m.items[0].options, ['merge', 'hold'])
    assert.equal(m.items[0].waitingOn, 'owner')
  })
  it('view: longest wait first across both sources, counts per source', () => {
    const snap = carsSnapWith([{ kind: 'flag', tag: 'car_b', file: 'FLAG_car_b', trace_id: 'car_b', since: '2026-01-01T02:00:00Z' }], [bar({ trace_id: 'car_b' })])
    const owner = { ok: true, checkedAt: 'c', lastOkAt: 'c', data: mapOwnerPending(OWNER_DOC) }
    const v = buildWaitingView({ carsSnap: snap, owner })
    assert.deepEqual(v.items.map((i) => i.id), ['owner:pr-7', 'flag:FLAG_car_b', 'owner:bad-url'])
    assert.deepEqual(v.counts, { total: 3, owner: 2, cars: 1 })
    assert.equal(v.sources.owner.invalid, 2)
    assert.equal(v.sources.cars.skippedFlags, 3)
  })
  it('view: one source down only blanks its own part; owner file missing = not connected', () => {
    const snap = { ok: false, error: 'cars export stale (900s old, limit 300s)', lastOkAt: 'L', waiting: { ok: false, error: 'cars export stale (900s old, limit 300s)', signals: [] } }
    const owner = { ok: false, notConnected: true, error: 'owner pending file does not exist' }
    const v = buildWaitingView({ carsSnap: snap, owner })
    assert.deepEqual(v.counts, { total: null, owner: null, cars: null })
    assert.equal(v.sources.cars.ok, false)
    assert.match(v.sources.cars.error, /stale/)
    assert.equal(v.sources.cars.lastOkAt, 'L')
    assert.equal(v.sources.owner.notConnected, true)
    const v2 = buildWaitingView({ carsSnap: snap, owner: { ok: true, data: mapOwnerPending(OWNER_DOC) } })
    assert.deepEqual(v2.counts, { total: 2, owner: 2, cars: null })
  })
  it('trace part failed but signals scanned: queue still shown, titles fall back to tags', () => {
    const snap = carsSnapWith([{ kind: 'needsig', tag: 'car_a', trace_id: null, since: '2026-01-01T01:00:00Z', text: 'help' }], [], { ok: false })
    const v = buildWaitingView({ carsSnap: snap, owner: { ok: false, notConnected: true } })
    assert.equal(v.items.length, 1)
    assert.equal(v.items[0].title, 'car_a')
    assert.equal(v.sources.cars.carsKnown, false)
  })
  it('owner source: no path / no file = not connected; bad JSON = unreachable; mtime cache', async () => {
    const dir = path.join(FIXTURE_DIR, 'owner')
    await mkdir(dir, { recursive: true })
    const src = createOwnerPendingSource()
    assert.equal((await src.get(null)).notConnected, true)
    const p = path.join(dir, 'owner_pending.json')
    const missing = await src.get(p)
    assert.equal(missing.notConnected, true)
    assert.equal(missing.ok, false)
    await writeFile(p, '{oops')
    const bad = await src.get(p)
    assert.equal(bad.ok, false)
    assert.equal(bad.notConnected, false)
    await writeFile(p, JSON.stringify(OWNER_DOC))
    const good = await src.get(p)
    assert.equal(good.ok, true)
    assert.equal(good.data.items.length, 2)
    assert.equal((await src.get(p)).data, good.data, 'unchanged mtime → cached')
  })
})

// ─── server: quota ──────────────────────────────────────────────────────────

const NOW = Date.parse('2026-11-21T13:40:00+08:00')
const READING = {
  pool: 'T3', fetched_at: '2026-11-21 13:29:14+08:00', util_5h: 0.03, reset_5h_bjt: '2026-11-21 14:00:00+08:00',
  util_7d: 0.97, reset_7d_bjt: '2026-11-22 02:00:00+08:00', status: 'allowed_warning', overage_status: 'rejected', error: null,
}

describe('quota mapping', () => {
  it('parses the cache time format', () => {
    assert.equal(parseReadingTime('2026-11-21 13:29:14+08:00'), Date.parse('2026-11-21T05:29:14Z'))
    assert.equal(parseReadingTime('2026-11-21T05:29:14Z'), Date.parse('2026-11-21T05:29:14Z'))
    assert.equal(parseReadingTime('garbage'), null)
    assert.equal(parseReadingTime(null), null)
  })
  it('fresh reading: % per window, reset time, logged in, source + read time', () => {
    const p = mapQuotaReading(READING, { name: 'T3.json', nowMs: NOW })
    assert.equal(p.pool, 'T3')
    assert.equal(p.source, 'official_headers')
    assert.equal(p.stale, false)
    assert.equal(p.ageSec, 646)
    assert.equal(p.loggedIn, true)
    assert.deepEqual(p.windows.map((w) => [w.key, w.pct, w.expired]), [['5h', 3, false], ['7d', 97, false]])
    assert.equal(p.windows[0].resetAt, '2026-11-21T06:00:00.000Z')
  })
  it('older than 15 minutes = stale (still shown); past the reset time = void', () => {
    const later = Date.parse('2026-11-21T14:10:00+08:00')
    const p = mapQuotaReading(READING, { name: 'T3.json', nowMs: later })
    assert.equal(p.stale, true)
    assert.equal(p.windows[0].expired, true)
    assert.equal(p.windows[0].pct, null)
    assert.equal(p.windows[1].pct, 97)
    assert.equal(DEFAULT_QUOTA_STALE_SEC, 900)
    // read at 13:29:14 → 14:59 later is 14:59 old (fresh), 15:01 old is stale
    assert.equal(mapQuotaReading(READING, { name: 'T3.json', nowMs: Date.parse('2026-11-21T13:44:13+08:00') }).stale, false)
    assert.equal(mapQuotaReading(READING, { name: 'T3.json', nowMs: Date.parse('2026-11-21T13:44:15+08:00') }).stale, true)
    assert.equal(mapQuotaReading(READING, { name: 'T3.json', nowMs: NOW, staleSec: 60 }).stale, true)
  })
  it('missing / bad fields degrade, never guess; logged-out errors are told apart', () => {
    const p = mapQuotaReading({ fetched_at: 'nope', util_5h: 'x', util_7d: -1 }, { name: 'T9.json', nowMs: NOW })
    assert.equal(p.pool, 'T9')
    assert.equal(p.stale, true)
    assert.equal(p.ageSec, null)
    assert.equal(p.loggedIn, null)
    assert.deepEqual(p.windows.map((w) => [w.pct, w.missing]), [[null, true], [null, true]])
    assert.equal(mapQuotaReading({ ...READING, error: 'HTTP 401 Unauthorized' }, { name: 'a', nowMs: NOW }).loggedIn, false)
    assert.equal(mapQuotaReading({ ...READING, error: 'timeout' }, { name: 'a', nowMs: NOW }).loggedIn, null)
  })
  it('tightest = highest live window %, errors and void windows excluded', () => {
    const pools = [
      mapQuotaReading(READING, { name: 'T3.json', nowMs: NOW }),
      mapQuotaReading({ ...READING, pool: 'T2', util_7d: 0.21, util_5h: 0.09 }, { name: 'T2.json', nowMs: NOW }),
      mapQuotaReading({ ...READING, pool: 'T1', util_7d: 0.5, util_5h: 0.99, reset_5h_bjt: '2026-11-21 13:00:00+08:00' }, { name: 'T1.json', nowMs: NOW }),
      mapQuotaReading({ ...READING, pool: 'T0', util_7d: 1, error: 'boom' }, { name: 'T0.json', nowMs: NOW }),
    ]
    const v = buildQuotaView(pools)
    assert.deepEqual(v.pools.map((p) => p.pool), ['T0', 'T1', 'T2', 'T3'])
    assert.deepEqual(v.tightest.map((t) => [t.pool, t.key, t.pct]), [['T3', '7d', 97], ['T1', '7d', 50]])
  })
  it('quota source: not configured / dir missing / broken file row / mtime cache', async () => {
    const src = createQuotaSource({ now: () => NOW })
    assert.equal((await src.get(null, 900)).notConnected, true)
    const gone = await src.get(path.join(FIXTURE_DIR, 'no-quota'), 900)
    assert.equal(gone.ok, false)
    assert.match(gone.error, /ENOENT/)
    const dir = path.join(FIXTURE_DIR, 'quota')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'T3.json'), JSON.stringify(READING))
    await writeFile(path.join(dir, 'T4.json'), '{broken')
    await writeFile(path.join(dir, 'notes.txt'), 'ignored')
    const r = await src.get(dir, 900)
    assert.equal(r.ok, true)
    assert.deepEqual(r.data.pools.map((p) => [p.pool, !!p.error]), [['T3', false], ['T4', true]])
    assert.match(r.data.pools[1].error, /not valid JSON/)
    assert.equal(r.data.tightest[0].pool, 'T3')
    assert.equal(gone.lastOkAt, null)
  })
})

describe('phase 2 routes', () => {
  let server
  let base
  const dir = path.join(FIXTURE_DIR, 'routes')
  before(async () => {
    await mkdir(path.join(dir, 'quota'), { recursive: true })
    await writeFile(path.join(dir, 'quota', 'T3.json'), JSON.stringify({ ...READING, fetched_at: new Date().toISOString(),
      // windows must still be open at test time, or the reading is voided
      reset_5h_bjt: new Date(Date.now() + 3600e3).toISOString(), reset_7d_bjt: new Date(Date.now() + 86400e3).toISOString() }))
    const now = new Date().toISOString()
    const carsPath = path.join(dir, 'cars.json')
    await writeFile(carsPath, JSON.stringify({ schema: CARS_EXPORT_SCHEMA, exported_at: now, ok: true, last_ok_at: now, gantt: gantt([bar({ trace_id: 'car_b' })]),
      waiting: { schema: WAITING_SCHEMA, ok: true, scanned_at: now, flags_checked: true, skipped_flags: 0, items: [{ kind: 'flag', tag: 'car_b', file: 'FLAG_car_b', trace_id: 'car_b', since: now }] } }))
    await writeFile(path.join(dir, 'owner.json'), JSON.stringify(OWNER_DOC))
    const full = path.join(dir, 'cfg.json')
    await writeFile(full, JSON.stringify({ linear: { rootIssue: 'T-1', graphqlUrl: 'https://tracker.example/graphql' }, carsExport: { path: carsPath },
      ownerPending: { path: path.join(dir, 'owner.json') }, quota: { dir: path.join(dir, 'quota') } }))
    const phase1Only = path.join(dir, 'cfg1.json')
    await writeFile(phase1Only, JSON.stringify({ linear: { rootIssue: 'T-1', graphqlUrl: 'https://tracker.example/graphql' }, carsExport: { path: carsPath } }))
    const app = express()
    app.use(createCommandCenterRoutes({ configPath: full }))
    app.use('/p1', createCommandCenterRoutes({ configPath: phase1Only }))
    await new Promise((r) => { server = app.listen(0, 'localhost', r) })
    base = `http://localhost:${server.address().port}`
  })
  after(async () => { await new Promise((r) => server.close(r)) })

  it('GET /api/command-center/waiting joins both sources, no local paths leak', async () => {
    const d = await (await fetch(`${base}/api/command-center/waiting`)).json()
    assert.equal(d.configured, true)
    assert.deepEqual(d.counts, { total: 3, owner: 2, cars: 1 })
    assert.ok(!JSON.stringify(d).includes(dir))
  })
  it('GET /api/command-center/quota returns pools + tightest + source', async () => {
    const d = await (await fetch(`${base}/api/command-center/quota`)).json()
    assert.equal(d.configured, true)
    assert.equal(d.source.ok, true)
    assert.equal(d.pools[0].pool, 'T3')
    assert.equal(d.tightest[0].pct, 97)
    assert.equal(d.staleSec, 900)
    assert.ok(!JSON.stringify(d).includes(dir))
  })
  it('a phase-1 config still works: new blocks say "not connected"', async () => {
    const w = await (await fetch(`${base}/p1/api/command-center/waiting`)).json()
    assert.equal(w.sources.owner.notConnected, true)
    assert.equal(w.counts.cars, 1)
    const q = await (await fetch(`${base}/p1/api/command-center/quota`)).json()
    assert.equal(q.source.notConnected, true)
    assert.deepEqual(q.pools, [])
  })
})

describe('cars source carries the waiting section', () => {
  it('fresh file → waiting mapped; stale file → waiting down too', async () => {
    const dir = path.join(FIXTURE_DIR, 'carsrc')
    await mkdir(dir, { recursive: true })
    const p = path.join(dir, 'cars.json')
    const old = '2026-01-01T00:00:00Z'
    await writeFile(p, JSON.stringify({ schema: CARS_EXPORT_SCHEMA, exported_at: old, ok: true, last_ok_at: old, gantt: gantt([]), waiting: { schema: WAITING_SCHEMA, ok: true, items: [] } }))
    const fresh = await createCarsSource({ now: () => Date.parse(old) + 1000 }).get(p, 300)
    assert.equal(fresh.ok, true)
    assert.equal(fresh.waiting.ok, true)
    const stale = await createCarsSource({ now: () => Date.parse(old) + 3600_000 }).get(p, 300)
    assert.equal(stale.waiting.ok, false)
    assert.match(stale.waiting.error, /stale/)
    const failed = path.join(dir, 'failed.json')
    await writeFile(failed, JSON.stringify({ schema: CARS_EXPORT_SCHEMA, exported_at: old, ok: false, error: 'trace down', waiting: { schema: WAITING_SCHEMA, ok: true, items: [] } }))
    const f = await createCarsSource({ now: () => Date.parse(old) + 1000 }).get(failed, 300)
    assert.equal(f.ok, false)
    assert.equal(f.waiting.ok, true, 'signals still usable when only the trace part failed')
  })
})
