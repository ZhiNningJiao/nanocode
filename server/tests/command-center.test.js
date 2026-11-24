import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, readdir, utimes } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  mapTraceStatus,
  groupWorst,
  CAR_STATES,
  STATE_SEVERITY,
  mapLinearResponse,
  mapBar,
  mapCarsExport,
  buildCommandCenterView,
  loadCommandCenterConfig,
  createLinearSource,
  createCarsSource,
  createCommandCenterRoutes,
} from '../command-center.js'
import { buildEnvelope, stripGantt, writeAtomic, CARS_EXPORT_SCHEMA, GANTT_SCHEMA } from '../../tools/command-center/export-cars.mjs'
import { layoutGantt, ganttWindow } from '../../public/js/command-center-layout.js'

// Fixture files live in a gitignored dir inside this worktree — never host /tmp.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, '.fixtures-tmp', 'command-center')
const GQL = 'https://tracker.example/graphql'

// ─── fixtures (placeholder keys only) ───────────────────────────────────────

function linearJson({ truncated = false } = {}) {
  return {
    data: {
      issue: {
        identifier: 'TEAM-1', title: 'Root', url: 'https://tracker.example/TEAM-1', updatedAt: '2026-01-01T00:00:00Z',
        state: { name: 'Triage', type: 'triage' },
        children: {
          pageInfo: { hasNextPage: truncated },
          nodes: [
            {
              identifier: 'TEAM-2', title: 'Event A', url: 'https://tracker.example/TEAM-2', updatedAt: '2026-01-01T01:00:00Z',
              state: { name: 'In Progress', type: 'started' },
              children: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { identifier: 'TEAM-20', updatedAt: '2026-01-02T00:00:00Z', state: { type: 'completed' } },
                  { identifier: 'TEAM-21', updatedAt: '2026-01-01T02:00:00Z', state: { type: 'canceled' } },
                  { identifier: 'TEAM-22', updatedAt: '2026-01-01T03:00:00Z', state: { type: 'started' } },
                ],
              },
            },
            {
              identifier: 'TEAM-3', title: 'Event B', url: null, updatedAt: '2026-01-01T00:30:00Z',
              state: null,
              children: { pageInfo: { hasNextPage: false }, nodes: [] },
            },
          ],
        },
      },
    },
  }
}

function bar(over = {}) {
  return {
    trace_id: 'car_a', car: 'car_a', parent: null, parent_source: null,
    issue: 'TEAM-2', issue_source: 'car_issue_map', title: 'do the thing',
    start: '2026-01-01T10:00:00+08:00', end: '2026-01-01T11:00:00+08:00', end_open: false,
    status: 'accepted', verdict: 'READY', plain: 'plain words', model: 'm', pool: 'P1', effort: 'high', route: 'r',
    points: [
      { t: '2026-01-01T10:30:00+08:00', kind: 'milestone', label: 'half way', source: 'step' },
      { t: '2026-01-01T11:00:00+08:00', kind: 'accepted', label: 'accepted', source: 'flag' },
    ],
    last_event: { t: '2026-01-01T11:00:00+08:00', kind: 'accepted', label: 'accepted' },
    think: { cmd: 'trace think car_a', sessions: [{ iter: 1, session_id: 's1', start_t: '2026-01-01T10:00:00+08:00', end_t: '2026-01-01T11:00:00+08:00', jsonl_path: '/secret/a.jsonl', md_path: '/secret/a.md' }] },
    links: { task: '/x/TASK_car_a.md', step: null, report: '/x/REPORT_car_a.md', prs: ['https://git.example/o/r/pull/7'], branches: [], boards: [] },
    ...over,
  }
}

function gantt(bars) {
  return { schema: GANTT_SCHEMA, generated_at: '2026-01-01T12:00:00+08:00', from: '2026-01-01T00:00:00+08:00', to: '2026-01-01T12:00:00+08:00', n_bars: bars.length, groups: [], bars }
}

function envelope(bars, exportedAt = new Date().toISOString()) {
  return { schema: CARS_EXPORT_SCHEMA, exported_at: exportedAt, ok: true, error: null, last_ok_at: exportedAt, window_from: '-3d', gantt: gantt(bars) }
}

function okLinear() {
  return { ok: true, checkedAt: '2026-01-01T12:00:00Z', lastOkAt: '2026-01-01T12:00:00Z', error: null, data: mapLinearResponse(linearJson()) }
}

function okCars(bars) {
  return { ok: true, checkedAt: 'x', lastOkAt: 'y', error: null, data: mapCarsExport(envelope(bars)) }
}

function noNaN(obj) {
  JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite number in ${JSON.stringify(obj).slice(0, 200)}`)
    return v
  })
}

// ─── status vocabulary ──────────────────────────────────────────────────────

describe('mapTraceStatus', () => {
  it('maps every trace status onto the unified vocabulary', () => {
    const table = {
      running: ['running', null], stale: ['unknown', 'stale'], blocked: ['waiting_human', null],
      delivered: ['delivered', null], accepted: ['done', null], failed: ['failed', null],
      ended_noflag: ['unknown', 'ended_noflag'], superseded: ['unknown', 'superseded'],
    }
    for (const [raw, [state, reason]] of Object.entries(table)) {
      assert.deepEqual(mapTraceStatus(raw), { state, reason }, raw)
      assert.ok(CAR_STATES.includes(state))
    }
  })
  it('never guesses: unrecognised / missing status is unknown', () => {
    assert.deepEqual(mapTraceStatus('weird'), { state: 'unknown', reason: 'unrecognized' })
    assert.deepEqual(mapTraceStatus(undefined), { state: 'unknown', reason: 'unrecognized' })
  })
  it('every vocabulary state has a severity', () => {
    for (const s of CAR_STATES) assert.equal(typeof STATE_SEVERITY[s], 'number', s)
  })
})

describe('groupWorst', () => {
  const c = (state, reason = null) => ({ state, reason })
  it('returns the worst child state', () => {
    assert.equal(groupWorst([c('done'), c('running'), c('failed')]), 'failed')
    assert.equal(groupWorst([c('done'), c('waiting_human'), c('running')]), 'waiting_human')
    assert.equal(groupWorst([c('done'), c('delivered')]), 'delivered')
    assert.equal(groupWorst([c('running'), c('unknown')]), 'unknown')
  })
  it('ignores superseded segments and reports null for no cars', () => {
    assert.equal(groupWorst([c('done'), c('unknown', 'superseded')]), 'done')
    assert.equal(groupWorst([c('unknown', 'superseded')]), null)
    assert.equal(groupWorst([]), null)
  })
})

// ─── Linear mapping ─────────────────────────────────────────────────────────

describe('mapLinearResponse', () => {
  it('maps root children to events with sub-issue progress', () => {
    const m = mapLinearResponse(linearJson())
    assert.equal(m.root.key, 'TEAM-1')
    assert.equal(m.events.length, 2)
    const a = m.events[0]
    assert.equal(a.key, 'TEAM-2')
    assert.deepEqual(a.trackerState, { name: 'In Progress', type: 'started' })
    assert.deepEqual(a.subIssues, { keys: ['TEAM-20', 'TEAM-21', 'TEAM-22'], total: 3, done: 2 })
    assert.equal(a.updatedAt, '2026-01-02T00:00:00Z', 'latest of event and its sub-issues')
    assert.equal(m.truncated, false)
  })
  it('tolerates missing state / url / children', () => {
    const b = mapLinearResponse(linearJson()).events[1]
    assert.equal(b.trackerState, null)
    assert.equal(b.url, null)
    assert.deepEqual(b.subIssues, { keys: [], total: 0, done: 0 })
  })
  it('flags truncation instead of silently dropping', () => {
    assert.equal(mapLinearResponse(linearJson({ truncated: true })).truncated, true)
  })
  it('throws on GraphQL errors and on a missing root (caller shows unreachable)', () => {
    assert.throws(() => mapLinearResponse({ errors: [{ message: 'Authentication required' }] }), /Authentication required/)
    assert.throws(() => mapLinearResponse({ data: { issue: null } }), /not found/)
    assert.throws(() => mapLinearResponse(null), /not found/)
  })
})

// ─── cars mapping ───────────────────────────────────────────────────────────

describe('mapBar / mapCarsExport', () => {
  it('maps a full bar and keeps local paths server-side', () => {
    const c = mapBar(bar())
    assert.equal(c.state, 'done')
    assert.deepEqual(c.docs, { task: true, step: false, report: true })
    assert.deepEqual(c.prs, ['https://git.example/o/r/pull/7'])
    assert.equal(c.sessions[0].sessionId, 's1')
    const json = JSON.stringify(c)
    assert.ok(!json.includes('/secret/'), 'transcript paths must not reach the browser')
    assert.ok(!json.includes('/x/'), 'document paths must not reach the browser')
  })
  it('degrades missing fields instead of throwing', () => {
    const c = mapBar({ trace_id: 'bare' })
    assert.equal(c.traceId, 'bare')
    assert.equal(c.state, 'unknown')
    assert.equal(c.start, null)
    assert.deepEqual(c.points, [])
    assert.deepEqual(c.docs, { task: false, step: false, report: false })
    assert.equal(c.lastEvent, null)
    const empty = mapBar(null)
    assert.equal(empty.traceId, '?')
  })
  it('drops undatable points and sorts the rest', () => {
    const c = mapBar(bar({ points: [{ t: 'garbage', kind: 'milestone' }, { t: '2026-01-01T10:50:00+08:00', kind: 'milestone', label: 'b' }, { t: '2026-01-01T10:10:00+08:00', kind: 'milestone', label: 'a' }] }))
    assert.deepEqual(c.points.map((p) => p.label), ['a', 'b'])
  })
  it('marks text-inferred issues and parents', () => {
    const c = mapBar(bar({ issue_source: 'task_title', parent: 'p', parent_source: 'inferred' }))
    assert.equal(c.issueInferred, true)
    assert.equal(c.parentInferred, true)
    assert.equal(mapBar(bar()).issueInferred, false)
  })
  it('open bars without end are open', () => {
    const c = mapBar(bar({ end: null, end_open: true, status: 'running' }))
    assert.equal(c.endOpen, true)
    assert.equal(c.state, 'running')
  })
  it('rejects unknown export / gantt schema, passes failure envelopes through', () => {
    assert.throws(() => mapCarsExport({ schema: 'other' }), /unexpected schema/)
    assert.throws(() => mapCarsExport({ ...envelope([]), gantt: { schema: 'car-trace-gantt/v9' } }), /gantt schema/)
    const f = mapCarsExport({ schema: CARS_EXPORT_SCHEMA, exported_at: '2026-01-01T00:00:00Z', ok: false, error: 'boom', last_ok_at: '2025-12-31T00:00:00Z', gantt: null })
    assert.equal(f.ok, false)
    assert.equal(f.error, 'boom')
    assert.equal(f.lastOkAt, '2025-12-31T00:00:00Z')
  })
})

// ─── view assembly ──────────────────────────────────────────────────────────

describe('buildCommandCenterView', () => {
  it('folds cars under events (sub-issue keys roll up to their event)', () => {
    const v = buildCommandCenterView({
      linear: okLinear(),
      cars: okCars([
        bar(),
        bar({ trace_id: 'car_b', car: 'car_b', issue: 'TEAM-22', status: 'blocked', last_event: { t: '2026-01-01T12:00:00+08:00', kind: 'blocked', label: 'need a decision' } }),
        bar({ trace_id: 'car_c', car: 'car_c', issue: null }),
        bar({ trace_id: 'car_d', car: 'car_d', issue: 'OTHER-9' }),
      ]),
    })
    const a = v.events.find((e) => e.key === 'TEAM-2')
    assert.equal(a.carCount, 2)
    assert.equal(a.waitingCount, 1)
    assert.equal(a.state, 'waiting_human')
    assert.deepEqual(a.progress, { basis: 'subissues', done: 2, total: 3 })
    assert.equal(a.lastProgress.car, 'car_b')
    assert.ok(a.milestones.length >= 2)
    assert.equal(v.events[0].key, 'TEAM-2', 'events waiting on you sort first')
    const b = v.events.find((e) => e.key === 'TEAM-3')
    assert.equal(b.carCount, 0)
    assert.equal(b.state, null)
    assert.equal(b.progress, null)
    assert.deepEqual(v.unassigned.cars.map((c) => [c.traceId, c.unassignedReason]), [['car_c', 'no_issue'], ['car_d', 'not_under_root']])
    assert.deepEqual(v.summary, { events: 2, cars: 4, waiting: 1 })
    assert.equal(v.sources.linear.ok, true)
    assert.equal(v.sources.cars.ok, true)
  })
  it('falls back to car-count progress when an event has no sub-issues', () => {
    const v = buildCommandCenterView({ linear: okLinear(), cars: okCars([bar({ issue: 'TEAM-3' }), bar({ trace_id: 'x', issue: 'TEAM-3', status: 'running', end: null, end_open: true })]) })
    assert.deepEqual(v.events.find((e) => e.key === 'TEAM-3').progress, { basis: 'cars', done: 1, total: 2 })
  })
  it('tracker down: events come from car issue keys, flagged as not from the tracker', () => {
    const v = buildCommandCenterView({
      linear: { ok: false, checkedAt: 'now', lastOkAt: '2026-01-01T00:00:00Z', error: 'Linear HTTP 500', data: null },
      cars: okCars([bar(), bar({ trace_id: 'car_b', issue: 'TEAM-22' })]),
    })
    assert.deepEqual(v.events.map((e) => e.key).sort(), ['TEAM-2', 'TEAM-22'])
    assert.ok(v.events.every((e) => e.fromTracker === false && e.title === null && e.trackerState === null))
    assert.equal(v.sources.linear.ok, false)
    assert.equal(v.sources.linear.lastOkAt, '2026-01-01T00:00:00Z')
    assert.equal(v.sources.linear.error, 'Linear HTTP 500')
  })
  it('cars down: events still listed, car counts are "no data" not zero', () => {
    const v = buildCommandCenterView({ linear: okLinear(), cars: { ok: false, checkedAt: 'now', lastOkAt: '2026-01-01T00:00:00Z', error: 'stale', data: null } })
    assert.equal(v.events.length, 2)
    for (const e of v.events) {
      assert.equal(e.carsAvailable, false)
      assert.equal(e.carCount, null)
      assert.equal(e.state, null)
    }
    assert.equal(v.summary.cars, null)
    assert.equal(v.sources.cars.ok, false)
    assert.equal(v.sources.cars.lastOkAt, '2026-01-01T00:00:00Z')
  })
  it('both down: nothing invented', () => {
    const v = buildCommandCenterView({ linear: { ok: false, error: 'a' }, cars: { ok: false, error: 'b' } })
    assert.deepEqual(v.events, [])
    assert.equal(v.summary.cars, null)
  })

  // dailycat_0955 (owner 2026-11-24 令): daily:/misc: cars get their own groups, never
  // "unassigned"; the old none:<reason> spelling (gate still accepts it) folds in too —
  // none:daily-* → daily, every other none:* → misc — "maintenance" is retired.
  it('daily:/misc:/none: cars land in their own groups, not unassigned, with the name after the colon kept', () => {
    const v = buildCommandCenterView({
      linear: okLinear(),
      cars: okCars([
        bar(),
        bar({ trace_id: 'car_daily', car: 'car_daily', issue: 'daily:optscan' }),
        bar({ trace_id: 'car_misc', car: 'car_misc', issue: 'misc:video_demo' }),
        bar({ trace_id: 'car_none_misc', car: 'car_none_misc', issue: 'none:cleanup' }),
        bar({ trace_id: 'car_none_daily', car: 'car_none_daily', issue: 'none:daily-optscan' }),
      ]),
    })
    assert.deepEqual(v.daily.cars.map((c) => [c.traceId, c.categoryNote]), [['car_daily', 'optscan'], ['car_none_daily', 'daily-optscan']])
    assert.deepEqual(v.misc.cars.map((c) => [c.traceId, c.categoryNote]), [['car_misc', 'video_demo'], ['car_none_misc', 'cleanup']])
    assert.deepEqual(v.unassigned.cars, [])
    assert.ok(!('maintenance' in v.unassigned.reasons))
    assert.equal(v.daily.key, '_daily')
    assert.equal(v.misc.key, '_misc')
    assert.equal(v.summary.cars, 5)
  })
  it('tracker down: daily:/misc: cars still skip the fallback per-car event list and land in their groups', () => {
    const v = buildCommandCenterView({
      linear: { ok: false, checkedAt: 'now', lastOkAt: '2026-01-01T00:00:00Z', error: 'down', data: null },
      cars: okCars([bar({ issue: 'daily:optscan' }), bar({ trace_id: 'x', issue: 'misc:video' })]),
    })
    assert.deepEqual(v.events, [])
    assert.equal(v.daily.cars.length, 1)
    assert.equal(v.misc.cars.length, 1)
  })
})

// ─── config + sources ───────────────────────────────────────────────────────

describe('config and sources (fixtures)', () => {
  before(async () => { await mkdir(FIXTURE_DIR, { recursive: true }) })
  after(async () => { await rm(FIXTURE_DIR, { recursive: true, force: true }) })

  it('config: missing file / missing fields are reported, cache floor is 60s', async () => {
    assert.match(loadCommandCenterConfig(path.join(FIXTURE_DIR, 'nope.json')).error, /unreadable/)
    const p = path.join(FIXTURE_DIR, 'cfg.json')
    await writeFile(p, JSON.stringify({ linear: {} }))
    assert.match(loadCommandCenterConfig(p).error, /linear\.rootIssue, linear\.graphqlUrl, carsExport\.path/)
    await writeFile(p, JSON.stringify({ linear: { rootIssue: 'TEAM-1', graphqlUrl: GQL, cacheSeconds: 5 }, carsExport: { path: '/x.json' } }))
    const { config } = loadCommandCenterConfig(p)
    assert.equal(config.linearCacheSec, 60)
    assert.equal(config.carsStaleSec, 300)
  })

  it('linear source: caches >= cacheSec, failure keeps lastOkAt but drops data', async () => {
    let calls = 0
    let fail = false
    let t = Date.parse('2026-01-01T00:00:00Z')
    const fetchImpl = async () => {
      calls++
      if (fail) return { ok: false, status: 503, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => linearJson() }
    }
    const src = createLinearSource({ fetchImpl, getApiKey: () => 'k', now: () => t })
    const a = await src.get(GQL, 'TEAM-1', 60)
    assert.equal(a.ok, true)
    await src.get(GQL, 'TEAM-1', 60)
    assert.equal(calls, 1, 'second call within 60s is served from cache')
    t += 61_000
    fail = true
    const b = await src.get(GQL, 'TEAM-1', 60)
    assert.equal(calls, 2)
    assert.equal(b.ok, false)
    assert.equal(b.data, null)
    assert.equal(b.lastOkAt, a.checkedAt)
    assert.match(b.error, /503/)
  })

  it('linear source: no key → unreachable with a reason, no request made', async () => {
    let calls = 0
    const src = createLinearSource({ fetchImpl: async () => { calls++ }, getApiKey: () => null })
    const s = await src.get(GQL, 'TEAM-1', 60)
    assert.equal(s.ok, false)
    assert.match(s.error, /key not configured/)
    assert.equal(calls, 0)
  })

  it('linear source: never puts the key in the request body', async () => {
    let seen
    const src = createLinearSource({ fetchImpl: async (_u, init) => { seen = init; return { ok: true, json: async () => linearJson() } }, getApiKey: () => 'SECRET-KEY' })
    await src.get(GQL, 'TEAM-1', 60)
    assert.ok(!seen.body.includes('SECRET-KEY'))
    assert.equal(seen.headers.Authorization, 'SECRET-KEY')
  })

  it('cars source: missing file, fresh file, failure envelope, stale file', async () => {
    const p = path.join(FIXTURE_DIR, 'cars.json')
    let t = Date.now()
    const src = createCarsSource({ now: () => t })
    const missing = await src.get(p, 300)
    assert.equal(missing.ok, false)
    assert.match(missing.error, /ENOENT/)

    const exportedAt = new Date(t).toISOString()
    await writeFile(p, JSON.stringify(envelope([bar()], exportedAt)))
    const fresh = await src.get(p, 300)
    assert.equal(fresh.ok, true)
    assert.equal(fresh.data.cars.length, 1)
    assert.equal(src.docPath('car_a', 'report'), '/x/REPORT_car_a.md')

    t += 301_000
    const stale = await src.get(p, 300)
    assert.equal(stale.ok, false)
    assert.match(stale.error, /stale/)
    assert.equal(stale.lastOkAt, exportedAt)

    await writeFile(p, JSON.stringify({ schema: CARS_EXPORT_SCHEMA, exported_at: new Date(t).toISOString(), ok: false, error: 'trace gantt failed (2)', last_ok_at: exportedAt, gantt: null }))
    const future = new Date(Date.now() + 5000)
    await utimes(p, future, future) // force an mtime change even on coarse-mtime filesystems
    const failed = await src.get(p, 300)
    assert.equal(failed.ok, false)
    assert.equal(failed.error, 'trace gantt failed (2)')
    assert.equal(failed.lastOkAt, exportedAt)

    await writeFile(p, '{not json')
    const past = new Date(Date.now() + 10000)
    await utimes(p, past, past)
    const broken = await src.get(p, 300)
    assert.equal(broken.ok, false)
  })
})

// ─── routes ─────────────────────────────────────────────────────────────────

describe('routes', () => {
  let server
  let base
  const docDir = path.join(FIXTURE_DIR, 'docs')
  const cfgPath = path.join(FIXTURE_DIR, 'routes-cfg.json')
  const carsPath = path.join(FIXTURE_DIR, 'routes-cars.json')

  before(async () => {
    await mkdir(docDir, { recursive: true })
    await writeFile(path.join(docDir, 'REPORT_car_a.md'), '# report body')
    await writeFile(path.join(docDir, 'OTHER.md'), 'not listed')
    await writeFile(carsPath, JSON.stringify(envelope([bar({ links: { task: null, step: null, report: path.join(docDir, 'REPORT_car_a.md'), prs: [], branches: [], boards: [] } })])))
    await writeFile(cfgPath, JSON.stringify({ linear: { rootIssue: 'TEAM-1', graphqlUrl: GQL }, carsExport: { path: carsPath } }))
    const linearSource = createLinearSource({ fetchImpl: async () => ({ ok: true, json: async () => linearJson() }), getApiKey: () => 'k' })
    const app = express()
    app.use(createCommandCenterRoutes({ configPath: cfgPath, linearSource }))
    app.use('/unconfigured', createCommandCenterRoutes({ configPath: path.join(FIXTURE_DIR, 'missing.json') }))
    await new Promise((r) => { server = app.listen(0, 'localhost', r) })
    base = `http://localhost:${server.address().port}`
  })
  after(async () => {
    await new Promise((r) => server.close(r))
    await rm(FIXTURE_DIR, { recursive: true, force: true })
  })

  it('GET /api/command-center returns the joined view', async () => {
    const r = await fetch(`${base}/api/command-center`)
    const d = await r.json()
    assert.equal(d.configured, true)
    assert.equal(d.events.find((e) => e.key === 'TEAM-2').carCount, 1)
    assert.ok(!JSON.stringify(d).includes(docDir), 'no local paths in the view')
  })

  it('unconfigured → configured:false with the reason (not a crash, not empty data)', async () => {
    const d = await (await fetch(`${base}/unconfigured/api/command-center`)).json()
    assert.equal(d.configured, false)
    assert.match(d.error, /unreadable/)
  })

  it('doc route serves only the path the export lists for that trace', async () => {
    await fetch(`${base}/api/command-center`) // load cars cache
    const ok = await fetch(`${base}/api/command-center/doc?trace=car_a&kind=report`)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), '# report body')
    assert.equal((await fetch(`${base}/api/command-center/doc?trace=car_a&kind=task`)).status, 404)
    assert.equal((await fetch(`${base}/api/command-center/doc?trace=nobody&kind=report`)).status, 404)
    assert.equal((await fetch(`${base}/api/command-center/doc?trace=car_a&kind=../../etc/passwd`)).status, 400)
  })
})

// ─── exporter ───────────────────────────────────────────────────────────────

describe('export-cars envelope', () => {
  const now = new Date('2026-01-01T12:00:00Z')
  it('strips transcript paths and stamps last_ok_at', () => {
    const env = buildEnvelope({ gantt: gantt([bar()]), now, from: '-3d' })
    assert.equal(env.ok, true)
    assert.equal(env.last_ok_at, now.toISOString())
    assert.ok(!JSON.stringify(env).includes('/secret/'))
    assert.equal(env.gantt.bars[0].think.sessions[0].session_id, 's1')
    assert.ok(mapCarsExport(env).ok, 'server accepts what the exporter writes')
  })
  it('failure carries the previous last_ok_at forward', () => {
    const prev = buildEnvelope({ gantt: gantt([]), now: new Date('2026-01-01T11:00:00Z'), from: '-3d' })
    const env = buildEnvelope({ error: 'trace gantt failed (2)', prev, now, from: '-3d' })
    assert.equal(env.ok, false)
    assert.equal(env.gantt, null)
    assert.equal(env.last_ok_at, '2026-01-01T11:00:00.000Z')
    assert.equal(buildEnvelope({ error: 'x', prev: { schema: 'junk', last_ok_at: 'z' }, now, from: '-3d' }).last_ok_at, null)
  })
  it('a gantt with the wrong schema is a failure, not data', () => {
    const env = buildEnvelope({ gantt: { schema: 'car-trace-gantt/v2', bars: [] }, now, from: '-3d' })
    assert.equal(env.ok, false)
    assert.match(env.error, /schema/)
  })
  it('stripGantt tolerates bars without think', () => {
    assert.deepEqual(stripGantt({ bars: [{ trace_id: 'a' }] }).bars, [{ trace_id: 'a' }])
  })
  it('writeAtomic leaves no temp file behind', async () => {
    const dir = path.join(FIXTURE_DIR, 'atomic')
    await writeAtomic(path.join(dir, 'cars.json'), { a: 1 })
    assert.deepEqual(await readdir(dir), ['cars.json'])
    await rm(FIXTURE_DIR, { recursive: true, force: true })
  })
})

// ─── gantt layout ───────────────────────────────────────────────────────────

describe('layoutGantt', () => {
  const from = Date.parse('2026-01-01T00:00:00Z')
  const to = from + 3600_000
  const now = from + 1800_000
  it('requires an explicit positive width', () => {
    assert.throws(() => layoutGantt([], { from, to }), /width/)
    assert.throws(() => layoutGantt([], { width: 0, from, to }), /width/)
  })
  it('positions bars, open bars run to now, zero-length bars stay visible', () => {
    const lay = layoutGantt([
      { id: 'a', start: from, end: from + 900_000 },
      { id: 'b', start: from + 900_000, endOpen: true },
      { id: 'c', start: from + 600_000, end: from + 600_000 },
    ], { width: 400, from, to, now })
    const [a, b, c] = lay.rows
    assert.equal(a.x, 0)
    assert.equal(Math.round(a.w), 100)
    assert.equal(Math.round(b.x), 100)
    assert.equal(Math.round(b.x + b.w), 200, 'open bar ends at now')
    assert.ok(c.w >= 3, 'zero-length bar gets a minimum width')
    assert.equal(Math.round(lay.nowX), 200)
    noNaN(lay)
  })
  it('clamps into the box and marks offscreen / invalid rows', () => {
    const lay = layoutGantt([
      { id: 'early', start: from - 7200_000, end: from - 3600_000 },
      { id: 'wide', start: from - 3600_000, end: to + 3600_000 },
      { id: 'bad', start: 'not a date' },
      { id: 'backwards', start: from + 600_000, end: from },
    ], { width: 300, from, to, now })
    const [early, wide, bad, backwards] = lay.rows
    assert.equal(early.offscreen, true)
    assert.equal(wide.x, 0)
    assert.equal(wide.w, 300)
    assert.equal(bad.invalid, true)
    assert.ok(backwards.w >= 3)
    for (const r of lay.rows) assert.ok(r.x >= 0 && r.x + r.w <= 300 + 1e-9, r.id)
    noNaN(lay)
  })
  it('drops points outside the window, ticks stay inside', () => {
    const lay = layoutGantt([{ id: 'a', start: from, end: to, points: [{ t: from - 1, kind: 'milestone' }, { t: from + 60_000, kind: 'milestone' }, { t: 'junk' }] }], { width: 320, from, to, now })
    assert.equal(lay.rows[0].points.length, 1)
    assert.ok(lay.ticks.length >= 1)
    for (const tk of lay.ticks) assert.ok(tk.x >= 0 && tk.x <= 320)
  })
  it('ganttWindow covers the rows and survives empty input', () => {
    const w = ganttWindow([{ start: from, end: to }], now)
    assert.ok(w.from < from && w.to > to)
    const e = ganttWindow([], now)
    assert.equal(e.to - e.from, 3600_000)
    noNaN(e)
  })
})
