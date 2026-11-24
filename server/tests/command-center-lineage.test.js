/**
 * Board grouping by the tracker's real parent chain (linear-lineage.js +
 * buildCommandCenterView): cars on deep / cross-team issues land in the
 * root's direct child they descend from, with the nearest 【named】 issue
 * as sub-row; only cars with no issue or an issue outside the root are
 * unassigned, each with a reason. Lineage lookups are cached.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapLineageResponse, classifyLineage, groupLabel, createLineageSource, lineageIncludes } from '../linear-lineage.js'
import { buildCommandCenterView, carIssueKeys } from '../command-center.js'
import { laneSubgroups, swimlaneRows, buildSwimlanes } from '../../public/js/cockpit-model.js'

function chainJson(pairs) {
  // [[key, title], ...] issue first → nested parent JSON
  let node = null
  for (let i = pairs.length - 1; i >= 0; i--) node = { identifier: pairs[i][0], title: pairs[i][1], parent: node }
  return { data: { issue: { ...node, team: { key: pairs[0][0].split('-')[0] }, state: { type: 'started' }, updatedAt: '2026-11-23T06:00:00Z' } } }
}

// the 11-23 structure: ALGO-31 → ALGO-45 → TEAM-113【IK】 → TEAM-109【重定向质量（…）】 → TEAM-100 (root)
const IK_CHAIN = [
  ['ALGO-31', 'IK 碰撞 ① 碰撞体'],
  ['ALGO-45', '碰撞盒 IK：重定向后胳膊和腿不穿进身体'],
  ['TEAM-113', '【IK】'],
  ['TEAM-109', '【重定向质量（动作库 / retarget 精度 / 动画评测）】'],
  ['TEAM-100', 'Animation 总单'],
]

describe('lineage (pure)', () => {
  it('maps the nested parent chain, issue first', () => {
    const l = mapLineageResponse(chainJson(IK_CHAIN))
    assert.equal(l.found, true)
    assert.deepEqual(l.chain.map((n) => n.key), ['ALGO-31', 'ALGO-45', 'TEAM-113', 'TEAM-109', 'TEAM-100'])
    assert.equal(l.team, 'ALGO')
    assert.ok(lineageIncludes(l, 'TEAM-113'))
    assert.ok(!lineageIncludes(l, 'TEAM-117'))
  })

  it('unknown issue = found:false; other GraphQL errors throw (never "not under root" by accident)', () => {
    assert.deepEqual(mapLineageResponse({ errors: [{ message: 'Entity not found: Issue' }], data: { issue: null } }), { found: false })
    assert.throws(() => mapLineageResponse({ errors: [{ message: 'rate limited' }] }), /rate limited/)
  })

  it('classifies across teams: ALG issue four levels down → the MES category, sub-row = nearest 【named】 issue', () => {
    const cls = classifyLineage(mapLineageResponse(chainJson(IK_CHAIN)), new Set(['TEAM-109', 'TEAM-117']), 'TEAM-100')
    assert.equal(cls.eventKey, 'TEAM-109')
    assert.deepEqual(cls.sub, { key: 'TEAM-113', label: 'IK' })
    assert.deepEqual(cls.path, ['ALGO-31', 'ALGO-45', 'TEAM-113', 'TEAM-109'])
  })

  it('an issue hung straight on the category has no sub-row; a 【named】 issue itself is its own sub-row', () => {
    const direct = classifyLineage(mapLineageResponse(chainJson([['TEAM-147', '派车脚本化'], ['TEAM-117', '【基础设施 / 秘书工具】'], ['TEAM-100', 'root']])), new Set(['TEAM-117']), 'TEAM-100')
    assert.equal(direct.eventKey, 'TEAM-117')
    assert.equal(direct.sub, null)
    const self = classifyLineage(mapLineageResponse(chainJson(IK_CHAIN.slice(2))), new Set(['TEAM-109']), 'TEAM-100')
    assert.deepEqual(self.sub, { key: 'TEAM-113', label: 'IK' })
  })

  it('outside the root / the root itself / not found', () => {
    const ev = new Set(['TEAM-109'])
    assert.equal(classifyLineage(mapLineageResponse(chainJson([['OUT-1', 'x'], ['OUT-0', 'y']])), ev, 'TEAM-100').reason, 'not_under_root')
    assert.equal(classifyLineage(mapLineageResponse(chainJson([['TEAM-100', 'root']])), ev, 'TEAM-100').reason, 'root_itself')
    assert.equal(classifyLineage({ found: false }, ev, 'TEAM-100').reason, 'not_found')
  })

  it('group names: text inside 【】 minus a trailing explanation', () => {
    assert.equal(groupLabel('【重定向质量（动作库 / retarget 精度 / 动画评测）】'), '重定向质量')
    assert.equal(groupLabel('【四足（Quadruped）】'), '四足')
    assert.equal(groupLabel('【IK】'), 'IK')
    assert.equal(groupLabel('碰撞盒 IK'), null)
  })
})

describe('lineage source cache', () => {
  function fakeFetch(counter, { fail = false } = {}) {
    return async (_u, init) => {
      counter.n++
      if (fail) return { ok: false, status: 503, json: async () => null }
      const id = JSON.parse(init.body).variables.id
      return { ok: true, json: async () => chainJson([[id, 't'], ['TEAM-109', '【x】'], ['TEAM-100', 'root']]) }
    }
  }

  it('asks the tracker once per issue within the cache window, again after it (owner re-parenting shows up)', async () => {
    const counter = { n: 0 }
    let t = 0
    const src = createLineageSource({ fetchImpl: fakeFetch(counter), getApiKey: () => 'k', now: () => t, cacheSec: 600 })
    const keys = ['ALG-1', 'ALG-2', 'none:maintenance', 'ALG-1', null]
    const m1 = await src.get('u', keys)
    assert.deepEqual([...m1.keys()].sort(), ['ALG-1', 'ALG-2'])
    await src.get('u', keys)
    t = 599_000
    await src.get('u', keys)
    assert.equal(counter.n, 2)
    t = 601_000
    await src.get('u', keys)
    assert.equal(counter.n, 4)
  })

  it('a failed lookup is remembered only briefly (60 s), as an error entry', async () => {
    const counter = { n: 0 }
    let t = 0
    const src = createLineageSource({ fetchImpl: fakeFetch(counter, { fail: true }), getApiKey: () => 'k', now: () => t })
    const m = await src.get('u', ['ALG-1'])
    assert.equal(m.get('ALG-1').ok, false)
    t = 30_000; await src.get('u', ['ALG-1'])
    assert.equal(counter.n, 1)
    t = 61_000; await src.get('u', ['ALG-1'])
    assert.equal(counter.n, 2)
  })
})

describe('buildCommandCenterView with lineage', () => {
  const linear = {
    ok: true,
    data: {
      root: { key: 'TEAM-100', title: 'root' },
      truncated: false,
      events: [
        { key: 'TEAM-109', title: '【重定向质量（动作库）】', subIssues: { keys: ['TEAM-113'], total: 1, done: 0 } },
        { key: 'TEAM-117', title: '【基础设施 / 秘书工具】', subIssues: { keys: ['TEAM-147'], total: 1, done: 0 } },
      ].map((e) => ({ url: null, trackerState: null, updatedAt: null, ...e })),
    },
  }
  const car = (name, issue) => ({ traceId: name, car: name, issue, state: 'running', start: '2026-11-23T06:00:00Z', end: null, endOpen: true, points: [], lastEvent: null })
  const cars = {
    ok: true,
    data: {
      window: null,
      cars: [car('ikbody_1430', 'ALGO-31'), car('ikold_1200', 'TEAM-113'), car('dispatchform_1440', 'TEAM-147'),
        car('optscan_x', 'none:daily-optscan'), car('old_1100', null), car('stray_1000', 'OUT-1'), car('blind_1000', 'ALG-7')],
    },
  }
  const lin = (pairs) => ({ ok: true, data: mapLineageResponse(chainJson(pairs)) })
  const lineage = new Map([
    ['ALGO-31', lin(IK_CHAIN)],
    ['TEAM-113', lin(IK_CHAIN.slice(2))],
    ['TEAM-147', lin([['TEAM-147', 'x'], ['TEAM-117', '【基础设施 / 秘书工具】'], ['TEAM-100', 'root']])],
    ['OUT-1', lin([['OUT-1', 'x'], ['OUT-0', 'other root']])],
    ['ALG-7', { ok: false, error: 'Linear HTTP 503' }],
  ])

  it('asks lineage only for real issue keys', () => {
    assert.deepEqual(carIssueKeys(cars).sort(), ['ALG-7', 'ALGO-31', 'OUT-1', 'TEAM-113', 'TEAM-147'])
  })

  it('deep cross-team car → its category with the IK sub-row; unassigned only the truly unattached, each with a reason', () => {
    const v = buildCommandCenterView({ linear, cars, lineage })
    const rq = v.events.find((e) => e.key === 'TEAM-109')
    assert.deepEqual(rq.cars.map((c) => [c.car, c.sub?.label]).sort(), [['ikbody_1430', 'IK'], ['ikold_1200', 'IK']])
    assert.deepEqual(rq.cars.find((c) => c.car === 'ikbody_1430').issuePath, ['ALGO-31', 'ALGO-45', 'TEAM-113', 'TEAM-109'])
    assert.deepEqual(v.events.find((e) => e.key === 'TEAM-117').cars.map((c) => c.car), ['dispatchform_1440'])
    // dailycat_0955: none:daily-optscan folds into the "daily" group, never "unassigned".
    assert.deepEqual(v.daily.cars.map((c) => c.car), ['optscan_x'])
    assert.equal(v.daily.cars[0].categoryNote, 'daily-optscan')
    const un = Object.fromEntries(v.unassigned.cars.map((c) => [c.car, c.unassignedReason]))
    assert.deepEqual(un, { old_1100: 'no_issue', stray_1000: 'not_under_root', blind_1000: 'lineage_unknown' })
    assert.deepEqual(v.unassigned.reasons, { no_issue: 1, not_under_root: 1, lineage_unknown: 1 })
  })

  it('without lineage (lookup down) the shallow tree still files direct grandchildren — never worse than before', () => {
    const v = buildCommandCenterView({ linear, cars, lineage: null })
    assert.deepEqual(v.events.find((e) => e.key === 'TEAM-109').cars.map((c) => c.car), ['ikold_1200'])
    assert.equal(v.unassigned.cars.find((c) => c.car === 'ikbody_1430').unassignedReason, 'not_under_root')
  })

  it('gantt: the expanded category shows a 「重定向质量 › IK」 sub-row; the unassigned lane groups by reason', () => {
    const v = buildCommandCenterView({ linear, cars, lineage })
    const lanes = buildSwimlanes(v, () => true)
    const rq = lanes.find((l) => l.key === 'TEAM-109')
    assert.deepEqual(laneSubgroups(rq).map((g) => g.label), ['重定向质量 › IK'])
    const rows = swimlaneRows([rq])
    assert.deepEqual(rows.map((r) => r.kind), ['lane', 'sub', 'car', 'car'])
    const un = lanes.find((l) => l.unassigned)
    assert.deepEqual(laneSubgroups(un).map((g) => g.reason).sort(), ['lineage_unknown', 'no_issue', 'not_under_root'])
    const daily = lanes.find((l) => l.key === '_daily')
    assert.deepEqual(daily.cars.map((c) => c.car), ['optscan_x'])
    const tools = lanes.find((l) => l.key === 'TEAM-117')
    assert.deepEqual(swimlaneRows([tools]).map((r) => r.kind), ['lane', 'car']) // straight under the category: no header
  })
})
