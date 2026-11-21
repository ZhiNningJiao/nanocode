import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COCKPIT_MODULES, normalizeLayout, serializeLayout, isModuleOn, setModuleOn, moveModule, modulesIn,
  moduleByPlugin, normalizeView, normalizeMainView, startsExpanded, eventGroups, buildSwimlanes,
  swimlaneRows, layoutGraph, quoteText, spanWindow, normalizeSpan,
} from '../../public/js/cockpit-model.js'
import { layoutGantt, ganttWindow } from '../../public/js/command-center-layout.js'

const IDS = COCKPIT_MODULES.map((m) => m.id)

function car(id, state, start, end, extra = {}) {
  return { traceId: id, car: id, state, start, end, endOpen: !end, points: [], title: `${id} title`, ...extra }
}

function data() {
  return {
    configured: true,
    sources: { linear: { ok: true }, cars: { ok: true } },
    events: [
      { key: 'E-1', title: 'Quiet', state: 'done', carsAvailable: true, carCount: 1, waitingCount: 0, cars: [car('a1', 'done', '2026-11-21T10:00:00Z', '2026-11-21T11:00:00Z', { points: [{ t: '2026-11-21T10:30:00Z', kind: 'milestone', label: 'half' }] })] },
      { key: 'E-2', title: 'Busy', state: 'running', carsAvailable: true, carCount: 2, waitingCount: 1, progress: { done: 1, total: 4, basis: 'subissues' }, cars: [car('b1', 'running', '2026-11-21T09:00:00Z', null), car('b2', 'blocked', '2026-11-21T12:00:00Z', '2026-11-21T13:00:00Z')] },
      { key: 'E-3', title: 'Empty', state: null, carsAvailable: true, carCount: 0, waitingCount: 0, cars: [] },
    ],
    unassigned: { cars: [car('u1', 'unknown', '2026-11-21T08:00:00Z', '2026-11-21T08:30:00Z')] },
  }
}

describe('cockpit layout setting', () => {
  it('first run (nothing saved): every module, default order, on, not seeded', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}]) {
      const l = normalizeLayout(raw)
      assert.deepEqual(l.order, IDS)
      assert.deepEqual(l.off, [])
      assert.equal(l.seeded, false)
    }
  })
  it('keeps the saved order, drops unknown / duplicate ids, appends new modules', () => {
    const l = normalizeLayout({ v: 1, order: ['quota', 'bogus', 'quota', 'events', 7], off: ['chat', 'nope'] })
    assert.deepEqual(l.order, ['quota', 'events', ...IDS.filter((x) => x !== 'quota' && x !== 'events')])
    assert.deepEqual(l.off, ['chat'])
    assert.equal(l.seeded, true)
  })
  it('serialize → normalize round trip; serialize is versioned', () => {
    const l = setModuleOn(moveModule(normalizeLayout(null), 'machines', -1), 'quota', false)
    const back = normalizeLayout(JSON.parse(JSON.stringify(serializeLayout(l))))
    assert.deepEqual(back.order, l.order)
    assert.deepEqual(back.off, ['quota'])
    assert.equal(back.seeded, true)
  })
  it('on / off and move are pure; out-of-range moves are no-ops', () => {
    const l0 = normalizeLayout(null)
    const l1 = setModuleOn(l0, 'waiting', false)
    assert.equal(isModuleOn(l0, 'waiting'), true)
    assert.equal(isModuleOn(l1, 'waiting'), false)
    assert.equal(isModuleOn(setModuleOn(l1, 'waiting', true), 'waiting'), true)
    assert.equal(setModuleOn(l0, 'nope', false), l0)
    assert.equal(moveModule(l0, IDS[0], -1), l0)
    assert.equal(moveModule(l0, IDS[IDS.length - 1], 1), l0)
    assert.equal(moveModule(l0, 'nope', 1), l0)
    assert.deepEqual(moveModule(l0, IDS[1], -1).order.slice(0, 2), [IDS[1], IDS[0]])
  })
  it('modulesIn follows order and skips modules that are off', () => {
    let l = normalizeLayout({ v: 1, order: ['machines', 'quota', 'waiting'], off: ['quota'] })
    assert.deepEqual(modulesIn(l, 'side').map((m) => m.id), ['machines', 'waiting'])
    l = setModuleOn(l, 'events', false)
    assert.deepEqual(modulesIn(l, 'main'), [])
  })
  it('each module is exactly one plugin (one switch), and back', () => {
    const plugins = COCKPIT_MODULES.map((m) => m.plugin)
    assert.equal(new Set(plugins).size, plugins.length)
    for (const m of COCKPIT_MODULES) assert.equal(moduleByPlugin(m.plugin), m)
    assert.equal(moduleByPlugin('sessions'), null)
  })
  it('per-device memory normalises to the cockpit / list defaults', () => {
    assert.equal(normalizeMainView(null), 'cockpit')
    assert.equal(normalizeMainView('workspace'), 'workspace')
    assert.equal(normalizeMainView('<x>'), 'cockpit')
    assert.equal(normalizeView('gantt'), 'gantt')
    assert.equal(normalizeView('graph'), 'graph')
    assert.equal(normalizeView(''), 'list')
  })
})

describe('cockpit big events', () => {
  it('all green and nobody waiting starts folded; running / waiting / failed start open', () => {
    const d = data()
    assert.equal(startsExpanded(d.events[0]), false)
    assert.equal(startsExpanded(d.events[1]), true)
    assert.equal(startsExpanded({ state: 'failed', waitingCount: 0 }), true)
    assert.equal(startsExpanded({ state: 'done', waitingCount: 2 }), true)
    assert.equal(startsExpanded(null), false)
  })
  it('unassigned group only when it has cars or the car source is down', () => {
    const d = data()
    assert.deepEqual(eventGroups(d).map((e) => e.key), ['E-1', 'E-2', 'E-3', '_none'])
    d.unassigned.cars = []
    assert.deepEqual(eventGroups(d).map((e) => e.key), ['E-1', 'E-2', 'E-3'])
    d.sources.cars.ok = false
    assert.equal(eventGroups(d).at(-1).key, '_none')
    assert.deepEqual(eventGroups(null), [])
    assert.deepEqual(eventGroups({ configured: false }), [])
  })
})

describe('cockpit swimlane gantt', () => {
  it('lane bar spans first car start → last car end, open if any car still runs; points carry the car', () => {
    const lanes = buildSwimlanes(data(), () => false)
    const busy = lanes.find((l) => l.key === 'E-2')
    assert.equal(busy.summary.start, '2026-11-21T09:00:00Z')
    assert.equal(busy.summary.end, '2026-11-21T13:00:00Z')
    assert.equal(busy.summary.endOpen, true)
    const quiet = lanes.find((l) => l.key === 'E-1')
    assert.equal(quiet.summary.endOpen, false)
    assert.equal(quiet.summary.points[0].label, 'a1 · half')
    const empty = lanes.find((l) => l.key === 'E-3')
    assert.equal(empty.summary.start, null)
  })
  it('folded lanes contribute one row; unfolded lanes add one row per car', () => {
    const folded = swimlaneRows(buildSwimlanes(data(), () => false))
    assert.equal(folded.length, 4)
    assert.ok(folded.every((r) => r.kind === 'lane'))
    const open = swimlaneRows(buildSwimlanes(data(), (k) => k === 'E-2'))
    assert.deepEqual(open.map((r) => r.kind === 'lane' ? r.lane.key : r.id), ['E-1', 'E-2', 'b1', 'b2', 'E-3', '_none'])
  })
  it('rows feed layoutGantt without NaN; a lane with no cars is marked invalid, not drawn at 0', () => {
    const rows = swimlaneRows(buildSwimlanes(data(), () => true))
    const now = Date.parse('2026-11-21T14:00:00Z')
    const win = ganttWindow(rows, now)
    const lay = layoutGantt(rows, { width: 600, from: win.from, to: win.to, now })
    for (const r of lay.rows) {
      for (const v of [r.x, r.w]) assert.ok(Number.isFinite(v))
      assert.ok(r.x >= 0 && r.x + r.w <= 600 + 1e-9)
    }
    const emptyIdx = rows.findIndex((r) => r.kind === 'lane' && r.lane.key === 'E-3')
    assert.equal(lay.rows[emptyIdx].invalid, true)
  })
})

describe('cockpit gantt window', () => {
  const now = Date.parse('2026-11-21T14:00:00Z')
  const win = { from: Date.parse('2026-11-18T00:00:00Z'), to: now }
  it('cuts to the last N hours; 0 keeps everything; never inverted', () => {
    assert.deepEqual(spanWindow(win, now, 24), { from: now - 24 * 3600_000, to: now })
    assert.deepEqual(spanWindow(win, now, 0), win)
    const recent = { from: now - 3600_000, to: now }
    assert.deepEqual(spanWindow(recent, now, 72), recent)
    const r = spanWindow({ from: now + 10, to: now + 10 }, now, 24)
    assert.ok(r.to > r.from)
  })
  it('older bars become offscreen (not squeezed to the edge)', () => {
    const rows = [{ id: 'old', start: '2026-11-18T01:00:00Z', end: '2026-11-18T02:00:00Z' }, { id: 'new', start: '2026-11-21T13:00:00Z', end: null, endOpen: true }]
    const w = spanWindow(win, now, 24)
    const lay = layoutGantt(rows, { width: 500, from: w.from, to: w.to, now })
    assert.equal(lay.rows[0].offscreen, true)
    assert.equal(lay.rows[1].offscreen, false)
  })
  it('span setting normalises to 24 h', () => {
    assert.equal(normalizeSpan('72'), 72)
    assert.equal(normalizeSpan(0), 0)
    assert.equal(normalizeSpan('5'), 24)
    assert.equal(normalizeSpan(null), 24)
  })
})

describe('cockpit node graph', () => {
  it('requires an explicit width', () => {
    assert.throws(() => layoutGraph([], {}), /width/)
    assert.throws(() => layoutGraph([], { width: 0 }), /width/)
  })
  it('every coordinate is finite and inside the canvas; urgent cars first; overflow counted', () => {
    const many = Array.from({ length: 30 }, (_, i) => car(`c${i}`, i === 29 ? 'blocked' : 'done', '2026-11-21T10:00:00Z', '2026-11-21T11:00:00Z'))
    const groups = [...eventGroups(data()), { key: 'BIG', cars: many, carsAvailable: true, carCount: 30 }]
    for (const width of [390, 800, 1440]) {
      const g = layoutGraph(groups, { width, cell: 220, maxSatellites: 16 })
      assert.ok(Number.isFinite(g.height) && g.height > 0)
      for (const n of g.nodes) {
        for (const p of [n, ...n.satellites]) {
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
          assert.ok(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= g.height, `${width}: ${p.x},${p.y}`)
        }
      }
      const big = g.nodes.find((n) => n.event.key === 'BIG')
      assert.equal(big.satellites.length, 16)
      assert.equal(big.hidden, 14)
      assert.equal(big.satellites[0].car.state, 'blocked')
    }
  })
  it('progress ring: fraction of the event progress, null when there is none', () => {
    const g = layoutGraph(eventGroups(data()), { width: 800 })
    assert.equal(g.nodes.find((n) => n.event.key === 'E-2').progress, 0.25)
    assert.equal(g.nodes.find((n) => n.event.key === 'E-1').progress, null)
  })
})

describe('cockpit quote into chat', () => {
  const words = { event: 'EV', car: 'CAR', cars: 'cars', waiting: 'wait', last: 'last', issue: 'issue', unassigned: 'NONE', state: (s) => `<${s}>` }
  it('event line: key, title, state, car count, waiting, latest progress', () => {
    const e = { ...data().events[1], lastProgress: { car: 'b1', label: 'step 2\n done' } }
    assert.equal(quoteText('event', e, words), '[EV] E-2 Busy · <running> · cars 2 · wait 1 · last: b1 step 2 done')
  })
  it('car line: name, trace, state, issue, latest milestone (else the task title)', () => {
    const c = car('b2', 'blocked', '2026-11-21T12:00:00Z', null, { issue: 'E-2', points: [{ t: 'x', kind: 'milestone', label: 'needs a decision' }] })
    assert.equal(quoteText('car', c, words), '[CAR] b2 (b2) · <blocked> · issue E-2 · last: needs a decision')
    assert.equal(quoteText('car', car('u1', 'unknown', null, null), words), '[CAR] u1 (u1) · <unknown> · u1 title')
  })
  it('long text is clipped, unassigned group is named', () => {
    const e = { key: '_none', unassigned: true, title: 'x'.repeat(500), carsAvailable: true, carCount: 3 }
    assert.equal(quoteText('event', e, words), '[EV] NONE · cars 3')
    const long = quoteText('event', { key: 'K', title: 'y'.repeat(500) }, words)
    assert.ok(long.length < 120)
  })
})
