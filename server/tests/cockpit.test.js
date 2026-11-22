import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COCKPIT_MODULES, normalizeLayout, serializeLayout, isModuleOn, setModuleOn, moveModule, modulesIn,
  moduleByPlugin, normalizePage, normalizeMainView, startsExpanded, eventGroups, buildSwimlanes,
  swimlaneRows, quoteText, spanWindow, normalizeSpan, ganttColumns, buildFeed, carPoints, pointId,
  waitingEvents, GANTT_MIN_PLOT_PX,
} from '../../public/js/cockpit-model.js'
import { layoutGantt, ganttWindow } from '../../public/js/command-center-layout.js'
import { ganttViewHtml, feedHtml } from '../../public/js/cockpit-views.js'
import { layoutQuotaCurve, quotaLevel, quotaHoverHtml } from '../../public/js/cockpit-quota-curve.js'

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
  it('per-device memory normalises to the cockpit / home defaults', () => {
    assert.equal(normalizeMainView(null), 'cockpit')
    assert.equal(normalizeMainView('workspace'), 'workspace')
    assert.equal(normalizeMainView('<x>'), 'cockpit')
    assert.equal(normalizePage('quota'), 'quota')
    assert.equal(normalizePage('gantt'), 'home') // the old list / gantt / graph view memory is not a page
    assert.equal(normalizePage(null), 'home')
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

describe('cockpit gantt: one time → x conversion for axis, bars, points, now, eta', () => {
  const now = Date.parse('2026-11-21T14:00:00Z')
  const pt = (t, label) => ({ t, kind: 'milestone', label })
  function d2() {
    const d = data()
    d.events[1].cars[0] = car('b1', 'running', '2026-11-21T09:00:00Z', null, { eta: '2026-11-21T16:00:00Z', points: [pt('2026-11-21T10:00:00Z', 'ten'), pt('2026-11-21T14:00:00Z', 'at now')] })
    return d
  }
  it('columns: label + plot widths are the only two numbers; narrow screens keep a minimum plot and scroll', () => {
    for (const w of [390, 820, 1180, 1440]) {
      const c = ganttColumns(w)
      assert.ok(c.plotW >= GANTT_MIN_PLOT_PX)
      if (!c.scroll) assert.ok(c.labelPx + c.plotW <= w)
    }
    assert.equal(ganttColumns(390).scroll, true)
    assert.equal(ganttColumns(1440).scroll, false)
  })
  it('a point at "now" sits exactly on the now line; a point at a tick sits on that tick; bars start at their start time', () => {
    const rows = swimlaneRows(buildSwimlanes(d2(), () => true))
    const win = { from: Date.parse('2026-11-21T08:00:00Z'), to: Date.parse('2026-11-21T17:00:00Z') }
    const lay = layoutGantt(rows, { width: 900, from: win.from, to: win.to, now })
    const carRow = lay.rows[rows.findIndex((r) => r.id === 'b1')]
    const atNow = carRow.points.find((p) => p.label === 'at now')
    assert.equal(atNow.x, lay.nowX)
    const tick10 = lay.ticks.find((tk) => tk.t === Date.parse('2026-11-21T10:00:00Z'))
    assert.ok(tick10, 'a 10:00 tick exists')
    assert.equal(carRow.points.find((p) => p.label === 'ten').x, tick10.x)
    const tick9 = lay.ticks.find((tk) => tk.t === Date.parse('2026-11-21T09:00:00Z'))
    assert.equal(carRow.x, tick9.x)
    // the lane summary row shows the same milestone at the same x (same pid)
    const laneRow = lay.rows[rows.findIndex((r) => r.kind === 'lane' && r.lane.key === 'E-2')]
    const lanePt = laneRow.points.find((p) => p.pid === pointId('b1', 1))
    assert.equal(lanePt.x, atNow.x)
  })
  it('expected finish: dashed tail from the bar end to eta, also on the lane; window grows to include it', () => {
    const rows = swimlaneRows(buildSwimlanes(d2(), () => true))
    const win = ganttWindow(rows, now)
    assert.ok(win.to >= Date.parse('2026-11-21T16:00:00Z'))
    const lay = layoutGantt(rows, { width: 900, from: win.from, to: win.to, now })
    const carRow = lay.rows[rows.findIndex((r) => r.id === 'b1')]
    assert.ok(carRow.etaX > carRow.x + carRow.w)
    const laneRow = lay.rows[rows.findIndex((r) => r.kind === 'lane' && r.lane.key === 'E-2')]
    assert.equal(laneRow.etaX, carRow.etaX)
    const done = lay.rows[rows.findIndex((r) => r.id === 'a1')]
    assert.equal(done.etaX, null)
  })
  it('rendered HTML: axis now label, now line and point all use lay.nowX (offset by the one label column)', () => {
    const d = d2()
    const html = ganttViewHtml(d, { isExpanded: () => true, openCar: null, span: 0, now }, 1440)
    const { labelPx } = ganttColumns(1440)
    const nowLabel = Number(/class="cc-now" style="left:([\d.]+)px"/.exec(html)[1])
    const nowLine = Number(/class="cc-now-line" style="left:([\d.]+)px"/.exec(html)[1])
    assert.ok(Math.abs(nowLine - labelPx - nowLabel) < 0.11, `${nowLine} - ${labelPx} vs ${nowLabel}`)
    const pts = [...html.matchAll(/class="cc-pt cc-pt-milestone" style="left:([\d.]+)px" data-act="pt" data-pid="b1#1"/g)].map((m) => Number(m[1]))
    assert.equal(pts.length, 2) // lane summary + car row
    for (const x of pts) assert.ok(Math.abs(x - nowLabel) < 0.11)
    // every row is label + plot of the same two widths
    const widths = new Set([...html.matchAll(/class="cc-gtrack" style="width:(\d+)px"/g)].map((m) => m[1]))
    assert.equal(widths.size, 1)
  })
})

describe('cockpit 大事记流 (milestone feed)', () => {
  function feedData() {
    const d = data()
    d.events[0].cars[0].points = [{ t: '2026-11-20T23:30:00Z', kind: 'accepted', label: 'late' }, { t: '2026-11-21T10:30:00Z', kind: 'milestone', label: 'half' }]
    d.events[1].cars[0].points = [{ t: '2026-11-21T11:00:00Z', kind: 'blocked', label: 'stuck' }]
    return d
  }
  it('newest first, grouped by day then event; items carry the gantt pid', () => {
    const days = buildFeed(feedData())
    const flat = days.flatMap((dd) => dd.events.flatMap((g) => g.items.map((i) => i.label)))
    assert.deepEqual(flat, ['stuck', 'half', 'late'])
    assert.equal(days[0].events[0].key, 'E-2')
    assert.equal(days[0].events[0].items[0].pid, pointId('b1', 0))
    const items = days.flatMap((dd) => dd.events.flatMap((g) => g.items))
    assert.equal(items.find((i) => i.label === 'late').pid, pointId('a1', 0))
    for (const dd of days) assert.match(dd.day, /^\d{4}-\d{2}-\d{2}$/)
  })
  it('window + limit keep the newest', () => {
    const d = feedData()
    assert.deepEqual(buildFeed(d, { fromMs: Date.parse('2026-11-21T10:45:00Z') }).flatMap((x) => x.events.flatMap((g) => g.items.map((i) => i.label))), ['stuck'])
    assert.equal(buildFeed(d, { limit: 2 }).flatMap((x) => x.events.flatMap((g) => g.items)).length, 2)
    assert.deepEqual(buildFeed(null), [])
  })
  it('feed item and gantt point share the pid; the selected one is marked', () => {
    const d = feedData()
    const html = feedHtml(buildFeed(d), d, pointId('a1', 1))
    assert.match(html, /class="ck-fi ck-fi-step sel" data-act="pt" data-pid="a1#1"/)
    assert.equal(carPoints(d.events[0].cars[0])[1].pid, 'a1#1')
  })
  it('等你 chips: events with someone waiting, most first', () => {
    const d = data()
    d.events[2].waitingCount = 3
    assert.deepEqual(waitingEvents(d).map((e) => e.key), ['E-3', 'E-2'])
  })
})

describe('cockpit quota curve layout', () => {
  const series = {
    from: '2026-11-15T13:00:00.000Z',
    to: '2026-11-22T13:00:00.000Z',
    pools: ['T1', 'T2'],
    points: [
      { t: '2026-11-16T00:00:00.000Z', total7d: 0.5, total5h: 1.5, pools: { T1: { r7: 10, r5: 80 }, T2: { r7: 40, r5: 70 } } },
      { t: '2026-11-17T00:00:00.000Z', total7d: 1.4, total5h: 1.8, pools: { T1: { r7: 100, r5: 90 }, T2: { r7: 40, r5: 90 } } },
      { t: '2026-11-22T13:00:00.000Z', total7d: 1.0, total5h: 1.9, pools: { T1: { r7: 60, r5: 95 }, T2: { r7: 40, r5: 95 } } },
    ],
    resets: [{ t: '2026-11-17T00:00:00.000Z', pool: 'T1', beforeR7: 10, afterR7: 100 }],
    upcoming: [{ pool: 'T2', kind: '5h', at: '2026-11-22T15:00:00.000Z', gainPct: 5 }, { pool: 'T2', kind: '7d', at: '2026-11-24T13:00:00.000Z', gainPct: 60 }],
  }
  it('needs explicit size and valid times', () => {
    assert.throws(() => layoutQuotaCurve(series, {}), /width/)
    assert.throws(() => layoutQuotaCurve({ ...series, to: 'x' }, { width: 100, height: 50 }), /from\/to/)
  })
  it('now sits where the past ends (7 d back, 7 d ahead → the middle); spike on its reset point; 0 pools at the bottom', () => {
    const lay = layoutQuotaCurve(series, { width: 700, height: 100, pad: 0 })
    assert.equal(lay.nowX, 350)
    assert.equal(lay.spikes[0].x, lay.xs[1])
    assert.equal(lay.spikes[0].pool, 'T1')
    assert.equal(lay.spikes[0].y, 100 - (1.4 / 2) * 100)
    assert.equal(lay.totalNow, 1.0)
  })
  it('future: the 7-day total steps up at the next weekly reset by what that pool uses now; 5h resets are only marks', () => {
    const lay = layoutQuotaCurve(series, { width: 700, height: 100, pad: 0 })
    const m7 = lay.future.marks.find((m) => m.kind === '7d')
    assert.ok(Math.abs(m7.x - (350 + 100)) < 1e-9) // 2 of the 7 future days
    assert.ok(Math.abs(m7.y - (100 - (1.6 / 2) * 100)) < 1e-9)
    assert.ok(lay.future.marks.some((m) => m.kind === '5h'))
    assert.match(lay.future.path, /^M350\.0 50\.0 L450\.0 50\.0 L450\.0 20\.0 L700\.0 20\.0$/)
  })
  it('colour only when low (share of all pools left)', () => {
    assert.equal(quotaLevel(3.4, 6), 'ok')
    assert.equal(quotaLevel(1.2, 6), 'warn')
    assert.equal(quotaLevel(0.5, 6), 'crit')
    assert.equal(quotaLevel(null, 6), 'none')
  })
  it('hover read-out: nearest snapshot, every pool, nothing after now', () => {
    const lay = layoutQuotaCurve(series, { width: 700, height: 100 })
    const hit = quotaHoverHtml(series, lay, lay.xs[1] + 3)
    assert.equal(hit.x, lay.xs[1])
    assert.match(hit.html, /T1<\/td><td>100%/)
    assert.equal(quotaHoverHtml(series, lay, 600), null)
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
