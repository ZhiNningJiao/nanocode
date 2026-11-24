/**
 * tools/dispatch — pool choice from a quota snapshot, task book rendering
 * (fixed sections present, nothing shell-expanded), the real-dispatch
 * sequence against fakes, and child-issue creation against a fake tracker.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickPool, judgePool } from '../../tools/dispatch/pool-pick.mjs'
import { renderTaskbook, fillTemplate, findKeyShapes, loadTemplate } from '../../tools/dispatch/taskbook.mjs'
import { normalizeForm } from '../../tools/dispatch/form.mjs'
import { executeDispatch } from '../../tools/dispatch/execute.mjs'
import { createChildIssue } from '../../tools/dispatch/linear-create.mjs'

const NOW = Date.parse('2026-11-23T06:30:00Z')
const H = 3600 * 1000
const row = (pool, p5, p7, reset7h, { reset5h = 2, ageSec = 60, error = null } = {}) => ({
  pool, ageSec, error, stale: false,
  windows: [
    { key: '5h', pct: p5, resetAt: new Date(NOW + reset5h * H).toISOString() },
    { key: '7d', pct: p7, resetAt: new Date(NOW + reset7h * H).toISOString() },
  ],
})
const POOLS = { T1: { configDir: '/t1', overage: true }, T2: { configDir: '/t2' }, T3: { configDir: '/t3' }, T4: { configDir: '/t4' }, T5: { configDir: '/t5', secretary: true } }

describe('pool choice (snapshot → pool)', () => {
  // 11-23 14:30 snapshot shape: T1 resets tomorrow 09:00, T4 in 2 days, T2 in 3, T3 in 5; T5 = secretary
  const snap = [row('T1', 40, 43, 18.5), row('T2', 0, 40, 79.5), row('T3', 10, 11, 139.5), row('T4', 29, 41, 50.5), row('T5', 13, 60, 42)]

  it('picks the pool whose weekly window resets soonest', () => {
    const r = pickPool({ pools: POOLS, quotaRows: snap, nowMs: NOW })
    assert.equal(r.pool, 'T1')
    assert.ok(r.considered.find((j) => j.pool === 'T5' && !j.ok && /秘书/.test(j.why)))
  })

  it('a capped non-overage pool is skipped; the overage pool stays usable past its cap', () => {
    const r = pickPool({ pools: POOLS, quotaRows: [row('T1', 96, 43, 18.5), row('T4', 91, 41, 10), row('T2', 0, 40, 79.5)], nowMs: NOW })
    assert.equal(r.pool, 'T1') // T1 pays overage; T4 (sooner reset) is over its 5h cap
    assert.ok(!r.considered.find((j) => j.pool === 'T4').ok)
  })

  it('heavy cars avoid a hot 5h window far from reset and pools already running 3+ cars', () => {
    const quota = [row('T4', 65, 41, 10, { reset5h: 2 }), row('T2', 20, 40, 20), row('T3', 10, 11, 30)]
    const r = pickPool({ pools: POOLS, quotaRows: quota, nowMs: NOW, heavy: true, runningByPool: { T2: 3 } })
    assert.equal(r.pool, 'T3')
    const light = pickPool({ pools: POOLS, quotaRows: quota, nowMs: NOW, heavy: false, runningByPool: { T2: 3 } })
    assert.equal(light.pool, 'T4') // the same pools are fine for a light car
  })

  it('a hot 5h window that resets within the grace period does not block a heavy car', () => {
    const j = judgePool('T4', POOLS.T4, row('T4', 70, 41, 10, { reset5h: 0.1 }), { nowMs: NOW, heavy: true })
    assert.equal(j.ok, true)
  })

  it('old, missing or broken readings are never picked blind', () => {
    const r = pickPool({ pools: { T2: POOLS.T2, T3: POOLS.T3, T4: POOLS.T4 }, quotaRows: [row('T2', 0, 0, 5, { ageSec: 4000 }), row('T3', 0, 0, 5, { error: 'HTTP 401' })], nowMs: NOW })
    assert.equal(r.pool, null)
    assert.deepEqual(r.considered.map((j) => j.ok), [false, false, false])
  })

  it('ties on reset time go to the pool with fewer running cars', () => {
    const r = pickPool({ pools: POOLS, quotaRows: [row('T2', 10, 10, 20), row('T3', 10, 10, 20)], nowMs: NOW, runningByPool: { T2: 2, T3: 0 } })
    assert.equal(r.pool, 'T3')
  })
})

const CTX = { modelLabel: 'Opus', hostLabel: '.box', paths: { workRoot: '/w', sharedCheckouts: '/code/*', boardRoot: '/boards' }, issue: 'ALG-31', siblings: ['ikmap_1430'] }
function baseForm(over = {}) {
  const { form, errors } = normalizeForm({
    tag: 'ikbody_1430', line: 'ik', issue: 'ALG-31', model: 'opus', effort: 'high', hardCapHours: 3,
    title: 'T', why: ['w'], readFirst: ['/w/a.md'], todo: ['do'], ...over,
  }, { nowMs: NOW, lines: { ik: { parent: 'X-1' } } })
  assert.deepEqual(errors, [])
  return form
}

describe('task book rendering', () => {
  it('carries every fixed section with the car\'s absolute paths', () => {
    const text = renderTaskbook(baseForm({ boardDir: 'ikbody_1430' }), CTX)
    for (const needle of [
      '# TASK ikbody_1430 — T（Opus high；.box；硬顶 3 小时；Linear ALG-31）',
      '## 为什么', '## 先读（开工必读，读完再动手）', '## 要做', '## 交付', '## 红线',
      '`/w/REPORT_ikbody_1430.md`：首行 `VERDICT: DONE|PARTIAL`',
      'touch /w/FLAG_ikbody_1430', '`/w/STEP_ikbody_1430.md` 一行开工条', '`/w/NEEDSIG_ikbody_1430.md`',
      '姊妹车 `ikmap_1430` 同时在跑',
      '绝不在 `/code/*` 共享检出里跑会写的 git 命令或改文件（板目录 `/boards/ikbody_1430/` 除外）',
      '不许运行任何 tmux 命令', '不发飞书 / Slack / Linear', '不许用 Agent 工具 / 子代理、MCP 连接器',
      '不写宿主机 `/tmp`（临时文件放 `/w/ikbody_1430/tmp/`）', '每条 Bash 显式 timeout', '不按命令行模式 kill',
      '--unit=ikbody-1430-<名> -p CPUQuota=800% -p MemoryMax=20G -p MemorySwapMax=0', '同时最多 1 个重活',
      'STEP / REPORT / FLAG / NEEDSIG 写在 `/w/` 顶层。硬顶前留 15 分钟写报告。', '不用任何 key。',
    ]) assert.ok(text.includes(needle), `missing: ${needle}`)
    assert.ok(!/\{\{\w+\}\}/.test(text), 'no placeholder left')
  })

  it('keeps backticks, $(…), $& and {{…}} from the form as plain text (no shell, no second expansion)', () => {
    const evil = 'run `rm -rf /` and $(touch /x) then $& and {{flag}} ${HOME}'
    const text = renderTaskbook(baseForm({ todo: [evil], title: 'a `b` $(c)' }), CTX)
    assert.ok(text.includes(`1. ${evil}`))
    assert.ok(text.includes('# TASK ikbody_1430 — a `b` $(c)（'))
  })

  it('a template placeholder with no value throws instead of leaving a blank', () => {
    assert.throws(() => fillTemplate('a {{nope}} b', {}), /no value for \{\{nope\}\}/)
    assert.ok(loadTemplate().includes('{{redlinesExtra}}'))
  })

  it('no siblings → still tells the car to re-check if one joins', () => {
    const text = renderTaskbook(baseForm(), { ...CTX, siblings: [] })
    assert.ok(text.includes('同线没有别的车在跑'))
  })

  it('finds key-shaped strings (masked) and leaves normal text alone', () => {
    assert.equal(findKeyShapes('plain text, ALGO-31, /path/x').length, 0)
    const hits = findKeyShapes('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 and ghp_' + 'a'.repeat(36))
    assert.deepEqual(hits.map((h) => h.kind).sort(), ['bearer-token', 'github-token'])
    assert.ok(hits.every((h) => h.sample.length < 30))
  })
})

describe('real dispatch sequence (fakes only)', () => {
  const plan = {
    tag: 'n_1500', lineParent: 'LINE-13', team: 'ALG', issue: null, newIssue: { title: 'sub' },
    taskbook: '# TASK n_1500 — x（Opus high；Linear <新建子单>）', summary: '派车 n_1500 | 单 新建「sub」 | 池 T1',
    paths: { workdir: '/w/n_1500', tmp: '/w/n_1500/tmp', task: '/w/TASK_n_1500.md' },
    guardTagsFile: '/w/guard.txt', env: { LINEAR_ISSUE: '<新建子单>', WORKER_CLAUDE_CONFIG_DIR: '/t1' },
    argv: ['bash', '/bin/dispatch.sh', 'n_1500'], cwd: '/w', timeoutSec: 280,
  }
  it('creates the issue first, writes the book exclusively, guards the tag, then runs the script with the new key', async () => {
    const calls = []
    const out = await executeDispatch(plan, {
      createIssue: async (spec) => { calls.push(['createIssue', spec]); return 'ALGO-900' },
      mkdir: async (p) => calls.push(['mkdir', p]),
      writeNew: async (p, t) => calls.push(['writeNew', p, t]),
      appendLine: async (p, l) => calls.push(['appendLine', p, l]),
      run: async (argv, o) => { calls.push(['run', argv, o.env.LINEAR_ISSUE]); return { code: 0 } },
    })
    assert.deepEqual(calls.map((c) => c[0]), ['createIssue', 'mkdir', 'writeNew', 'appendLine', 'run'])
    assert.deepEqual(calls[0][1], { parentKey: 'LINE-13', teamKey: 'ALG', title: 'sub', description: '' })
    assert.match(calls[2][2], /Linear ALGO-900/)
    assert.deepEqual(calls[3].slice(1), ['/w/guard.txt', 'n_1500'])
    assert.deepEqual(calls[4].slice(1), [['bash', '/bin/dispatch.sh', 'n_1500'], 'ALGO-900'])
    assert.equal(out.ok, true)
    assert.match(out.summary, /单 ALGO-900/)
  })
})

describe('child issue creation (fake tracker)', () => {
  it('looks up parent + team, then issueCreate with parentId; the key only travels in the header', async () => {
    const seen = []
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body)
      seen.push({ q: body.query.trim().split(/\s+/)[0], auth: init.headers.Authorization, vars: body.variables })
      if (body.query.includes('issueCreate')) return { ok: true, json: async () => ({ data: { issueCreate: { success: true, issue: { identifier: 'ALGO-900' } } } }) }
      if (body.query.includes('teams')) return { ok: true, json: async () => ({ data: { teams: { nodes: [{ id: 'team-alg', key: 'ALG' }] } } }) }
      return { ok: true, json: async () => ({ data: { issue: { id: 'uuid-parent', identifier: 'TEAM-113', team: { id: 'team-mes', key: 'MES' } } } }) }
    }
    const key = await createChildIssue({ graphqlUrl: 'https://tracker.example/graphql', fetchImpl, getApiKey: () => 'k-secret' }, { parentKey: 'TEAM-113', teamKey: 'ALG', title: 'sub' })
    assert.equal(key, 'ALGO-900')
    assert.equal(seen.length, 3)
    assert.ok(seen.every((s) => s.auth === 'k-secret' && !JSON.stringify(s.vars).includes('k-secret')))
    assert.deepEqual(seen[2].vars.input, { teamId: 'team-alg', parentId: 'uuid-parent', title: 'sub', description: '' })
  })

  it('a tracker error surfaces as a thrown error (no half-made dispatch)', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'Entity not found' }] }) })
    await assert.rejects(createChildIssue({ graphqlUrl: 'u', fetchImpl, getApiKey: () => 'k' }, { parentKey: 'X-1', title: 't' }), /Entity not found/)
  })
})

describe('one-off issue backfill (pure decision)', async () => {
  const { proposeBackfill, titleKeys, isoNoZ } = await import('../../tools/dispatch/backfill-issue-map.mjs')
  const cfg = {
    lines: { ik: { parent: 'TEAM-113' } },
    backfill: { maintenancePrefixes: { optscan_: 'daily-optscan' }, tagPrefixLines: { ikctrl: 'ik' } },
  }
  const car = (name, parent = null) => ({ car: name, issue: null, parent, start: '2026-11-22T10:00:00+08:00' })

  it('reads the key from the task book heading; two keys are not guessed between', () => {
    assert.deepEqual(titleKeys('# TASK x — y（Opus high；Linear ALGO-31）'), ['ALGO-31'])
    assert.deepEqual(titleKeys('# TASK x — no key'), [])
  })

  it('evidence order: title > re-dispatch parent > maintenance prefix > configured tag prefix; a child of an inferred parent stays inferred', () => {
    const cars = [car('a_1000'), car('a2_1100', 'a_1000'), car('optscan_2026-11-21'), car('ikctrl_1550'), car('ikctrl2_1855', 'ikctrl_1550'), car('mystery_1200'), car('two_1300'), car('done_0900')]
    const headings = new Map([['a_1000', '# TASK a_1000 — t（Linear TEAM-147）'], ['two_1300', '# TASK two — Linear ALG-1 Linear ALG-2'], ['mystery_1200', '# TASK mystery']])
    const { proposals, left } = proposeBackfill({ cars, issueMap: new Map([['done_0900', 'MES-1']]), headings, cfg })
    const got = Object.fromEntries(proposals.map((p) => [p.tag, [p.issue, p.source]]))
    assert.deepEqual(got, {
      a_1000: ['TEAM-147', 'task_title'],
      a2_1100: ['TEAM-147', 'trace_parent'],
      'optscan_2026-11-21': ['none:daily-optscan', 'maintenance'],
      ikctrl_1550: ['TEAM-113', 'tag_prefix'],
      ikctrl2_1855: ['TEAM-113', 'tag_prefix'],
    })
    assert.deepEqual(left.map((l) => l.tag).sort(), ['mystery_1200', 'two_1300'])
    assert.ok(!proposals.some((p) => p.tag === 'done_0900')) // already registered
  })

  it('writes dispatched_at without a trailing Z (the map\'s Python reader)', () => {
    assert.equal(isoNoZ('2026-11-22T02:00:00.000Z'), '2026-11-22T02:00:00+00:00')
    assert.equal(isoNoZ('2026-11-22T10:00:00+08:00'), '2026-11-22T10:00:00+08:00')
  })
})
