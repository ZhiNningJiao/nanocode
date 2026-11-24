/**
 * tools/dispatch — the form check: one test per refusal reason (each must
 * name its own code), plus the clean path. All IO is faked through deps.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planDispatch } from '../../tools/dispatch/plan.mjs'
import { normalizeForm, bjtHHMM } from '../../tools/dispatch/form.mjs'

const NOW = Date.parse('2026-11-23T06:30:00Z') // 14:30 Beijing
const HOUR = 3600 * 1000

// tracker fixture: ROOT-1 ← CAT-9 (category) ← LINE-13 ← ALG-45 ← ALG-31 (cross-team chain)
const CHAINS = {
  'ROOT-1': [['ROOT-1', 'Root']],
  'CAT-9': [['CAT-9', '【Retarget quality】'], ['ROOT-1', 'Root']],
  'LINE-13': [['LINE-13', '【IK】'], ['CAT-9', '【Retarget quality】'], ['ROOT-1', 'Root']],
  'ALG-45': [['ALG-45', 'box IK'], ['LINE-13', '【IK】'], ['CAT-9', '【Retarget quality】'], ['ROOT-1', 'Root']],
  'ALG-31': [['ALG-31', 'collision body'], ['ALG-45', 'box IK'], ['LINE-13', '【IK】'], ['CAT-9', '【Retarget quality】'], ['ROOT-1', 'Root']],
  'MES-77': [['MES-77', 'tools thing'], ['CAT-2', '【Tools】'], ['ROOT-1', 'Root']],
  'OUT-5': [['OUT-5', 'elsewhere'], ['OTHER-1', 'Other root']],
  'ALG-99': [['ALG-99', 'closed one'], ['LINE-13', '【IK】'], ['CAT-9', 'x'], ['ROOT-1', 'Root']],
}

function lineageMap(keys, { down = [], closed = ['ALG-99'] } = {}) {
  const out = new Map()
  for (const k of keys) {
    if (down.includes(k)) { out.set(k, { ok: false, error: 'Linear HTTP 503' }); continue }
    const ch = CHAINS[k]
    out.set(k, ch
      ? { ok: true, data: { found: true, key: k, title: ch[0][1], team: k.split('-')[0], closed: closed.includes(k), chain: ch.map(([key, title]) => ({ key, title })) } }
      : { ok: true, data: { found: false } })
  }
  return out
}

const quotaRow = (pool, p5, p7, reset7h, { ageSec = 120 } = {}) => ({
  pool, ageSec, stale: false, error: null,
  windows: [
    { key: '5h', pct: p5, resetAt: new Date(NOW + 2 * HOUR).toISOString() },
    { key: '7d', pct: p7, resetAt: new Date(NOW + reset7h * HOUR).toISOString() },
  ],
})

const CFG = {
  rootIssue: 'ROOT-1',
  hostLabel: '.box',
  paths: { workRoot: '/w', dispatchScript: '/bin/dispatch.sh', steerScript: '/bin/steer.sh', sharedCheckouts: '/code/*', boardRoot: '/boards', issueMap: '/w/map.jsonl' },
  lines: {
    ik: { parent: 'LINE-13', team: 'ALG' },
    moved: { parent: 'OUT-5', team: 'MES' },
    gone: { parent: 'GONE-1', team: 'MES' },
  },
  pools: {
    T1: { configDir: '/pools/t1', overage: true, guardTagsFile: '/w/guard.txt' },
    T2: { configDir: '/pools/t2' },
    T5: { configDir: '/pools/t5', secretary: true },
  },
  poolRules: {},
  dispatchTimeoutSec: 280,
}

function deps(over = {}) {
  return {
    nowMs: NOW,
    exists: async (p) => p.startsWith('/w/') && !p.includes('missing'),
    listWorkRoot: async () => over.names || ['TASK_old_1200.md', 'FLAG_old_1200', 'old_1200'],
    issueMapTags: async () => new Set(over.mapTags || ['old_1200']),
    lineage: async (keys) => lineageMap(keys, over.lineage || {}),
    quotaRows: async () => over.quota || [quotaRow('T1', 40, 43, 18), quotaRow('T2', 0, 40, 72), quotaRow('T5', 10, 10, 1)],
    cars: async () => over.cars || [
      { car: 'ikmap_1430', issue: 'ALG-45', state: 'running', endOpen: true, pool: 'T1' },
      { car: 'tool_1300', issue: 'MES-77', state: 'running', endOpen: true, pool: 'T2' },
    ],
  }
}

function form(over = {}) {
  return {
    tag: 'ikbody_1430',
    line: 'ik',
    issue: 'ALG-31',
    model: 'opus',
    effort: 'high',
    hardCapHours: 3,
    title: 'collision bodies per bone',
    why: ['owner said: arms too fat'],
    readFirst: ['/w/IK_DIRECTIONS.md', { path: '/w/REPORT_a.md', note: 'base' }],
    todo: ['build bodies', 'measure'],
    ...over,
  }
}

async function codes(f, d = deps(), cfg = CFG) {
  const r = await planDispatch(f, cfg, d)
  return { r, codes: r.errors.map((e) => e.code) }
}

describe('dispatch form — clean path', () => {
  it('a good form plans: issue under the line, pool picked, sibling found, exact command', async () => {
    const { r, codes: c } = await codes(form())
    assert.deepEqual(c, [])
    assert.equal(r.ok, true)
    assert.equal(r.plan.pool, 'T1') // weekly reset soonest (18h) beats T2 (72h)
    assert.deepEqual(r.plan.siblings, ['ikmap_1430']) // MES-77 car is another line
    assert.deepEqual(r.plan.argv, ['bash', '/bin/dispatch.sh', 'ikbody_1430', '/w/ikbody_1430', '/w/FLAG_ikbody_1430', '/w/TASK_ikbody_1430.md', '/w/loop_ikbody_1430.log', 'opus', '10800'])
    assert.deepEqual(r.plan.env, { LINEAR_ISSUE: 'ALG-31', WORKER_CLAUDE_EFFORT: 'high', WORKER_CLAUDE_CONFIG_DIR: '/pools/t1' })
    assert.equal(r.plan.guardTagsFile, '/w/guard.txt')
    assert.match(r.plan.summary, /派车 ikbody_1430 \| 线 ik（LINE-13）\| 单 ALG-31 \| 池 T1 \| Opus high \| 硬顶 3 小时 \| 预计交付 2026-11-23 17:30/)
  })

  it('no tag → topic_HHMM in Beijing time', async () => {
    assert.equal(bjtHHMM(NOW), '1430')
    const { form: f, errors } = normalizeForm(form({ tag: undefined, topic: 'ikbody' }), { nowMs: NOW, lines: CFG.lines })
    assert.deepEqual(errors, [])
    assert.equal(f.tag, 'ikbody_1430')
  })

  it('glm uses no pool and passes MODEL "" to the dispatch script', async () => {
    const { r, codes: c } = await codes(form({ model: 'glm' }))
    assert.deepEqual(c, [])
    assert.equal(r.plan.pool, null)
    assert.equal(r.plan.argv[7], '')
    assert.equal(r.plan.env.WORKER_CLAUDE_CONFIG_DIR, undefined)
  })

  it('newIssue plans a child issue under the line parent (created only on a real dispatch)', async () => {
    const { r, codes: c } = await codes(form({ issue: undefined, newIssue: { title: 'new sub task' } }))
    assert.deepEqual(c, [])
    assert.equal(r.plan.issue, null)
    assert.equal(r.plan.env.LINEAR_ISSUE, '<新建子单>')
    assert.match(r.plan.summary, /单 新建「new sub task」/)
  })
})

describe('dispatch form — every refusal reason has its own code', () => {
  const cases = [
    ['missing_field', form({ why: [] })],
    ['bad_tag', form({ tag: 'Bad Tag!' })],
    ['unknown_line', form({ line: 'nope' })],
    ['bad_issue', form({ issue: 'alg 31' })],
    ['bad_model', form({ model: 'claude-opus-5-5' })],
    ['fable_needs_owner', form({ model: 'fable' })],
    ['bad_effort', form({ effort: 'ultra' })],
    ['bad_hardcap', form({ hardCapHours: 0 })],
    ['read_first_not_absolute', form({ readFirst: ['REPORT_a.md'] })],
    ['read_first_missing', form({ readFirst: ['/w/missing.md'] })],
    ['issue_not_found', form({ issue: 'ALGO-404' })],
    ['issue_not_in_line', form({ issue: 'MES-77' })],
    ['issue_closed', form({ issue: 'ALG-99' })],
    ['line_not_under_root', form({ line: 'moved', issue: 'OUT-5' })],
    ['line_parent_missing', form({ line: 'gone', issue: undefined, newIssue: { title: 'x' } })],
    ['pool_capped', form({ pool: 'T2' }), deps({ quota: [quotaRow('T1', 40, 43, 18), quotaRow('T2', 95, 40, 72)] })],
    ['no_pool', form(), deps({ quota: [quotaRow('T1', 40, 43, 18, { ageSec: 9999 }), quotaRow('T2', 40, 99, 72)] })],
    ['pool_not_applicable', form({ model: 'glm', pool: 'T2' })],
    ['key_in_taskbook', form({ todo: [`use ${['lin', 'api'].join('_')}_${'A'.repeat(40)} to read`] })],
  ]
  for (const [code, f, d] of cases) {
    it(`refuses with ${code}`, async () => {
      const { r, codes: c } = await codes(f, d || deps())
      assert.equal(r.ok, false)
      assert.ok(c.includes(code), `expected ${code}, got ${JSON.stringify(r.errors)}`)
    })
  }

  it('refuses a tag already used — by flag, task book, workdir or the issue map', async () => {
    for (const d of [
      deps({ names: ['FLAG_ikbody_1430.accepted-1'] }),
      deps({ names: ['TASK_ikbody_1430.md'] }),
      deps({ names: ['ikbody_1430'] }),
      deps({ names: [], mapTags: ['ikbody_1430'] }),
    ]) {
      const { codes: c } = await codes(form(), d)
      assert.deepEqual(c, ['tag_taken'])
    }
  })

  it('refuses when Linear cannot be reached (never dispatches unverified)', async () => {
    const { codes: c } = await codes(form(), deps({ lineage: { down: ['ALG-31'] } }))
    assert.deepEqual(c, ['linear_unreachable'])
  })

  it('fable passes only with the owner authorisation id, and forwards it', async () => {
    const { r, codes: c } = await codes(form({ model: 'fable', ownerFableOk: 'om_123' }))
    assert.deepEqual(c, [])
    assert.equal(r.plan.env.OWNER_FABLE_OK, 'om_123')
  })

  it('a secretary pool can be named only with allowSecretaryPool', async () => {
    assert.ok((await codes(form({ pool: 'T5' }))).codes.includes('pool_capped'))
    const { r, codes: c } = await codes(form({ pool: 'T5', allowSecretaryPool: true }))
    assert.deepEqual(c, [])
    assert.equal(r.plan.pool, 'T5')
  })
})

// dailycat_0955 (owner 2026-11-24 令): line: daily / misc — no tracker issue needed at all.
describe('dispatch form — daily / misc (no Linear issue)', () => {
  it('daily:<name> plans clean, no lineage lookup, LINEAR_ISSUE passed through as-is', async () => {
    const { r, codes: c } = await codes(form({ line: 'daily', issue: 'daily:optscan', newIssue: undefined }))
    assert.deepEqual(c, [])
    assert.equal(r.ok, true)
    assert.equal(r.plan.lineParent, null)
    assert.equal(r.plan.team, null)
    assert.equal(r.plan.env.LINEAR_ISSUE, 'daily:optscan')
    assert.match(r.plan.summary, /线 daily（每日，无 Linear 单）\| 单 daily:optscan/)
  })

  it('misc:<name> plans clean too', async () => {
    const { r, codes: c } = await codes(form({ line: 'misc', issue: 'misc:video_demo', newIssue: undefined }))
    assert.deepEqual(c, [])
    assert.equal(r.plan.env.LINEAR_ISSUE, 'misc:video_demo')
    assert.match(r.plan.summary, /线 misc（杂项，无 Linear 单）\| 单 misc:video_demo/)
  })

  it('never calls out to Linear for daily/misc — dispatches even while Linear is fully down', async () => {
    const { codes: c } = await codes(form({ line: 'daily', issue: 'daily:optscan', newIssue: undefined }), deps({ lineage: { down: ['ALG-31', 'LINE-13'] } }))
    assert.deepEqual(c, [])
  })

  it('refuses newIssue on a daily/misc line (nothing to build a child issue under)', async () => {
    const { codes: c } = await codes(form({ line: 'daily', issue: undefined, newIssue: { title: 'x' } }))
    assert.ok(c.includes('bad_issue'))
  })

  it('refuses when the issue is missing, empty, or the wrong prefix for the line', async () => {
    for (const issue of [undefined, 'daily:', 'daily', 'misc:optscan', 'ALG-31']) {
      const { codes: c } = await codes(form({ line: 'daily', issue, newIssue: undefined }))
      assert.ok(c.includes('bad_issue'), `issue=${JSON.stringify(issue)} should be bad_issue, got ${JSON.stringify(c)}`)
    }
  })

  it('siblings on a daily/misc line come only from the form, never auto-matched by lineage', async () => {
    const { r, codes: c } = await codes(form({ line: 'daily', issue: 'daily:optscan', newIssue: undefined, siblings: ['ikmap_1430'] }))
    assert.deepEqual(c, [])
    assert.deepEqual(r.plan.siblings, ['ikmap_1430'])
  })
})
