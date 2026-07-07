/**
 * Tests for the MES-13740 需求1 usage module.
 *
 * Covers the three honest data sources:
 *   - Claude JSONL token aggregation (aggregateJsonlUsage / scanClaudeUsage)
 *   - CLAUDE_CONFIG_DIR honouring (effectiveClaudeConfigDir / claudeProjectsDir)
 *   - Team discovery (listTeams)
 *
 * AIGW live calls (listAigwModels / probeAigwCost) are not unit-tested — they
 * need the real gateway + key; they are exercised in the 9476 hand-test.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateJsonlUsage, scanClaudeUsage, effectiveClaudeConfigDir, claudeProjectsDir, listTeams, aggregateOpencodeSessions, parseOpencodeModel, resolveOpencodeDbPaths, scanOpencodeUsage, opencodeUsageEmpty, readClaudeOAuthCredentials, mapClaudeOAuthToWindows, computeBurnRate, projectHitAt, estimateClaudeWindowsFromTimeline, attachBurnAndProjection, streamJsonlTimeline, mapAigwSpendResponse, buildUsageSummary, computeAigwBudgetTier, computeBudgetDaysLeft, mapAigwBudgetResponse, fetchAigwBudget, AIGW_BUDGET_ADVICE } from '../../terminal/usage.js'
import { createStore } from '../store.js'

// node:sqlite is experimental (Node 22+). Guard so the temp-DB scan test is
// skipped (not failed) on a runtime without it.
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
let _DatabaseSync = null
try { ({ DatabaseSync: _DatabaseSync } = _require('node:sqlite')) } catch {}
const itSqlite = _DatabaseSync ? it : it.skip

function makeJsonlRow(overrides = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: overrides.uuid || 'u-' + Math.random().toString(36).slice(2),
    requestId: overrides.requestId || 'r-1',
    timestamp: overrides.timestamp || '2026-07-03T10:00:00.000Z',
    message: {
      id: 'msg-1',
      model: overrides.model || 'claude-sonnet-4-6',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: overrides.input ?? 10,
        output_tokens: overrides.output ?? 5,
        cache_creation_input_tokens: overrides.cacheCreation ?? 100,
        cache_read_input_tokens: overrides.cacheRead ?? 200,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    },
  })
}

describe('usage: aggregateJsonlUsage', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-usage-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('sums usage across assistant rows and ignores non-usage rows', () => {
    const p = join(tmp, 's.jsonl')
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'foo', timestamp: 't', sessionId: 's' }),
      JSON.stringify({ type: 'user', uuid: 'uu', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      makeJsonlRow({ uuid: 'a1', input: 10, output: 5, cacheCreation: 100, cacheRead: 200, model: 'claude-sonnet-4-6' }),
      makeJsonlRow({ uuid: 'a2', input: 20, output: 15, cacheCreation: 0, cacheRead: 50, model: 'claude-opus-4-8' }),
      '', // trailing newline friendliness
    ]
    writeFileSync(p, lines.join('\n'))
    const agg = aggregateJsonlUsage(p)
    assert.equal(agg.input, 30)
    assert.equal(agg.output, 20)
    assert.equal(agg.cacheCreation, 100)
    assert.equal(agg.cacheRead, 250)
    assert.equal(agg.rows, 2)
    assert.equal(agg.truncated, false)
    // per-model counts
    assert.equal(agg.modelCounts['claude-sonnet-4-6'].input, 10)
    assert.equal(agg.modelCounts['claude-opus-4-8'].input, 20)
  })

  it('returns null for empty/missing files', () => {
    assert.equal(aggregateJsonlUsage(join(tmp, 'nope.jsonl')), null)
    writeFileSync(join(tmp, 'empty.jsonl'), '')
    assert.equal(aggregateJsonlUsage(join(tmp, 'empty.jsonl')), null)
  })

  it('skips assistant rows without a usage block', () => {
    const p = join(tmp, 's2.jsonl')
    const noUsage = JSON.stringify({
      type: 'assistant', uuid: 'x', requestId: 'r',
      message: { model: 'm', role: 'assistant', content: [{ type: 'text', text: 'x' }] },
    })
    writeFileSync(p, noUsage + '\n' + makeJsonlRow({ input: 7, output: 3 }) + '\n')
    const agg = aggregateJsonlUsage(p)
    assert.equal(agg.rows, 1)
    assert.equal(agg.input, 7)
    assert.equal(agg.output, 3)
  })
})

describe('usage: scanClaudeUsage', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-scan-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('aggregates across project dirs under $configDir/projects', () => {
    // Two encoded project dirs (cwd '/' -> '-').
    const projA = join(tmp, 'projects', '-tmp-alpha')
    const projB = join(tmp, 'projects', '-tmp-beta')
    mkdirSync(projA, { recursive: true })
    mkdirSync(projB, { recursive: true })
    writeFileSync(join(projA, 'aaa.jsonl'), makeJsonlRow({ input: 100, output: 10, model: 'claude-sonnet-4-6' }) + '\n')
    writeFileSync(join(projB, 'bbb.jsonl'), makeJsonlRow({ input: 1, output: 2, model: 'claude-opus-4-8' }) + '\n')
    const result = scanClaudeUsage(tmp)
    assert.equal(result.totals.input, 101)
    assert.equal(result.totals.output, 12)
    assert.equal(result.files, 2)
    assert.equal(result.configDir, tmp)
    // byModel sorted by total tokens desc; sonnet (110) > opus (3)
    assert.equal(result.byModel[0].model, 'claude-sonnet-4-6')
    assert.equal(result.byModel[1].model, 'claude-opus-4-8')
    // byDay has one bucket (today, from file mtime)
    assert.ok(result.byDay.length >= 1)
  })

  it('returns zeroed shape when projects dir is missing', () => {
    const result = scanClaudeUsage(join(tmp, 'no-such'))
    assert.equal(result.totals.input, 0)
    assert.equal(result.totals.rows, 0)
    assert.equal(result.files, 0)
    assert.deepEqual(result.byModel, [])
  })
})

describe('usage: CLAUDE_CONFIG_DIR / teams', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-cfg-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('effectiveClaudeConfigDir defaults to ~/.claude and honours store setting', () => {
    const store = createStore(':memory:')
    assert.equal(effectiveClaudeConfigDir(store, tmp), join(tmp, '.claude'))
    store.setSetting('claude_config_dir', join(tmp, '.claude-team2'))
    assert.equal(effectiveClaudeConfigDir(store, tmp), join(tmp, '.claude-team2'))
  })

  it('claudeProjectsDir encodes cwd with dashes under the given config dir', () => {
    assert.equal(
      claudeProjectsDir(join(tmp, '.claude-team2'), '/tmp/proj'),
      join(tmp, '.claude-team2', 'projects', '-tmp-proj')
    )
  })

  it('listTeams includes ~/.claude plus ~/.claude-team* dirs', () => {
    // Create a fake home with .claude and .claude-team2
    mkdirSync(join(tmp, '.claude'), { recursive: true })
    mkdirSync(join(tmp, '.claude-team2'), { recursive: true })
    mkdirSync(join(tmp, '.claude-team999'), { recursive: true })
    const store = createStore(':memory:')
    const { teams, activePath } = listTeams(tmp, store)
    const ids = teams.map((t) => t.id).sort()
    assert.ok(ids.includes('team1'))
    assert.ok(ids.includes('team2'))
    assert.ok(ids.includes('team999'))
    const t2 = teams.find((t) => t.id === 'team2')
    assert.equal(t2.path, join(tmp, '.claude-team2'))
    assert.equal(t2.exists, true)
    // active defaults to ~/.claude
    assert.equal(activePath, join(tmp, '.claude'))
    // honours store setting
    store.setSetting('claude_config_dir', join(tmp, '.claude-team2'))
    const { activePath: active2 } = listTeams(tmp, store)
    assert.equal(active2, join(tmp, '.claude-team2'))
  })
})

// ── opencode SQLite session usage (需求15 item6) ──────────────────────────────

describe('usage: aggregateOpencodeSessions (pure)', () => {
  it('sums tokens, parses JSON model ids, buckets by model/day/directory', () => {
    const ms = 1783133879857 // 2026-07-04T02:57:59Z (live DB epoch ms)
    const rows = [
      { model: '{"id":"litellm/SGLang-GLM-latest","providerID":"kimi"}', cost: 0, tokens_input: 100, tokens_output: 10, tokens_reasoning: 5, tokens_cache_read: 200, tokens_cache_write: 50, time_created: ms, time_updated: ms, directory: '/home/me/proj' },
      { model: '{"id":"litellm/claude-fable-5","providerID":"kimi"}', cost: 0, tokens_input: 50, tokens_output: 5, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, time_created: ms, time_updated: ms, directory: '/home/me/proj' },
      { model: 'plain-model', cost: 0, tokens_input: 7, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, time_created: ms, time_updated: ms, directory: '/other' },
    ]
    const r = aggregateOpencodeSessions(rows)
    assert.equal(r.totals.input, 157)
    assert.equal(r.totals.output, 15)
    assert.equal(r.totals.reasoning, 5)
    assert.equal(r.totals.cacheRead, 200)
    assert.equal(r.totals.cacheWrite, 50)
    assert.equal(r.sessionCount, 3)
    assert.equal(r.costTotal, 0)
    const ids = r.byModel.map((m) => m.model)
    assert.ok(ids.includes('litellm/SGLang-GLM-latest'))
    assert.ok(ids.includes('litellm/claude-fable-5'))
    assert.ok(ids.includes('plain-model'))
    // byDirectory: /home/me/proj has 2 sessions
    const proj = r.byDirectory.find((d) => d.directory === '/home/me/proj')
    assert.equal(proj.sessions, 2)
    assert.equal(proj.input, 150)
    // byDay has the 2026-07-04 bucket
    assert.ok(r.byDay.some((d) => d.day === '2026-07-04'))
  })

  it('returns the empty shape for non-array / empty input', () => {
    assert.equal(aggregateOpencodeSessions(null).sessionCount, 0)
    assert.equal(aggregateOpencodeSessions([]).sessionCount, 0)
    assert.deepEqual(aggregateOpencodeSessions([]).byModel, [])
  })

  it('tolerates null / non-object / missing-field rows', () => {
    const r = aggregateOpencodeSessions([null, 'x', {}, { model: '', tokens_input: 3 }])
    assert.equal(r.sessionCount, 2) // {} and the last row count; null/'x' skipped
    assert.equal(r.totals.input, 3)
    // empty model -> (unknown)
    assert.ok(r.byModel.some((m) => m.model === '(unknown)'))
  })

  it('parseOpencodeModel extracts id from JSON, falls back to raw / (unknown)', () => {
    assert.equal(parseOpencodeModel('{"id":"litellm/x","providerID":"kimi"}'), 'litellm/x')
    assert.equal(parseOpencodeModel('plain-string'), 'plain-string')
    assert.equal(parseOpencodeModel(''), '(unknown)')
    assert.equal(parseOpencodeModel(null), '(unknown)')
    assert.equal(parseOpencodeModel('not-json'), 'not-json')
  })
})

describe('usage: scanOpencodeUsage / resolveOpencodeDbPaths', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-opc-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('resolveOpencodeDbPaths honours OPENCODE_DB_PATH override and filters missing', () => {
    const dbPath = join(tmp, 'opencode.db')
    writeFileSync(dbPath, 'x') // non-empty placeholder so existsSync+size passes
    // Isolate BOTH env vars: on machines where XDG_DATA_HOME points at a real
    // opencode DB (e.g. GLM_XDG_DATA_HOME), the real DB would leak in and the
    // "only the override survives" assertion would break. Point XDG at an
    // empty fake-home so resolveOpencodeDbPaths only returns the override.
    const prevDb = process.env.OPENCODE_DB_PATH
    const prevXdg = process.env.XDG_DATA_HOME
    const prevGlm = process.env.GLM_XDG_DATA_HOME
    process.env.OPENCODE_DB_PATH = dbPath
    process.env.XDG_DATA_HOME = join(tmp, 'fake-home', '.local', 'share')
    delete process.env.GLM_XDG_DATA_HOME
    try {
      const paths = resolveOpencodeDbPaths(join(tmp, 'fake-home'))
      assert.deepEqual(paths, [dbPath])
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_DB_PATH
      else process.env.OPENCODE_DB_PATH = prevDb
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
      if (prevGlm === undefined) delete process.env.GLM_XDG_DATA_HOME
      else process.env.GLM_XDG_DATA_HOME = prevGlm
    }
  })

  it('opencodeUsageEmpty returns a consistent zeroed shape', () => {
    const e = opencodeUsageEmpty()
    assert.equal(e.sessionCount, 0)
    assert.equal(e.costTotal, 0)
    assert.deepEqual(e.byModel, [])
    assert.deepEqual(e.totals.input, 0)
  })

  itSqlite('scanOpencodeUsage reads a temp SQLite DB and aggregates tokens', () => {
    const dbPath = join(tmp, 'opencode.db')
    const db = new _DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (
        id TEXT, model TEXT, cost REAL,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER,
        time_created INTEGER, time_updated INTEGER, directory TEXT
      )
    `)
    const ins = db.prepare(
      'INSERT INTO session (id, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, directory) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    const ms = 1783133879857
    ins.run('s1', '{"id":"litellm/SGLang-GLM-latest"}', 0, 1000, 100, 50, 200, 30, ms, ms, '/home/me/proj')
    ins.run('s2', '{"id":"litellm/claude-fable-5"}', 0, 500, 50, 0, 0, 0, ms, ms, '/home/me/proj')
    db.close()

    const r = scanOpencodeUsage(dbPath)
    assert.equal(r.error, undefined)
    assert.equal(r.sessionCount, 2)
    assert.equal(r.totals.input, 1500)
    assert.equal(r.totals.output, 150)
    assert.equal(r.totals.reasoning, 50)
    assert.equal(r.totals.cacheRead, 200)
    assert.equal(r.totals.cacheWrite, 30)
    assert.equal(r.dbPath, dbPath)
    assert.equal(r.source, 'opencode SQLite session table')
    const ids = r.byModel.map((m) => m.model)
    assert.ok(ids.includes('litellm/SGLang-GLM-latest'))
    assert.ok(ids.includes('litellm/claude-fable-5'))
  })

  itSqlite('scanOpencodeUsage returns error for a missing DB path', () => {
    const r = scanOpencodeUsage(join(tmp, 'nope.db'))
    assert.ok(r.error)
    assert.equal(r.sessionCount, 0)
  })
})

// ── MES-13788 CodexBar-style windows + burn + projection ──────────────────────

const NOW = Date.parse('2026-07-06T06:00:00.000Z')
const REAL_OAUTH = {
  five_hour: { utilization: 67.0, resets_at: '2026-07-06T07:29:59.957238+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null },
  seven_day: { utilization: 58.0, resets_at: '2026-07-07T00:59:59.957267+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null },
  extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: 4732.0, utilization: 9.464, currency: 'USD' },
  limits: [
    { kind: 'session', group: 'session', percent: 67, severity: 'normal', resets_at: '2026-07-06T07:29:59.957238+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 58, severity: 'normal', resets_at: '2026-07-07T00:59:59.957267+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 94, severity: 'critical', resets_at: '2026-07-07T00:59:59.957634+00:00', scope: { model: { display_name: 'Fable' } }, is_active: true },
  ],
}

describe('usage: mapClaudeOAuthToWindows (pure)', () => {
  it('maps 5h + weekly + monthly windows from a real OAuth response', () => {
    const w = mapClaudeOAuthToWindows(REAL_OAUTH, { source: 'claude-team1', label: 'Team 1', now: NOW })
    assert.equal(w.length, 3)
    const five = w.find((x) => x.windowType === '5h')
    assert.equal(five.used, 67)
    assert.equal(five.limit, 100)
    assert.equal(five.remaining, 33)
    assert.equal(five.unit, 'percent')
    assert.equal(five.resetAt, '2026-07-06T07:29:59.957238+00:00')
    assert.equal(five.estimated, false)
    assert.equal(five.severity, 'normal') // from limits[] session
    const weekly = w.find((x) => x.windowType === 'weekly')
    assert.equal(weekly.used, 58)
    assert.equal(weekly.severity, 'normal') // weekly_all severity
    const monthly = w.find((x) => x.windowType === 'monthly')
    assert.equal(monthly.used, 4732)
    assert.equal(monthly.limit, 50000)
    assert.equal(monthly.remaining, 50000 - 4732)
    assert.equal(monthly.unit, 'credits')
  })

  it('derives severity from utilization when limits[] is absent', () => {
    const api = { five_hour: { utilization: 95, resets_at: '2026-07-06T07:29:59Z' }, seven_day: { utilization: 80, resets_at: '2026-07-07T00:59:59Z' }, extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 50, utilization: 50 } }
    const w = mapClaudeOAuthToWindows(api, { source: 'c', label: 'l', now: NOW })
    assert.equal(w.find((x) => x.windowType === '5h').severity, 'critical')
    assert.equal(w.find((x) => x.windowType === 'weekly').severity, 'warning')
  })

  it('returns no windows for an empty / null response (no fabrication)', () => {
    assert.deepEqual(mapClaudeOAuthToWindows(null, { source: 'c', label: 'l' }), [])
    assert.deepEqual(mapClaudeOAuthToWindows({}, { source: 'c', label: 'l' }), [])
  })
})

describe('usage: computeBurnRate + projectHitAt (pure)', () => {
  it('computeBurnRate sums tokens and rates over the active span (floored to 1min)', () => {
    const rows = [
      { ts: NOW - 30 * 60 * 1000, tokens: 100000 },
      { ts: NOW - 10 * 60 * 1000, tokens: 50000 },
    ]
    const r = computeBurnRate(rows, { now: NOW })
    assert.equal(r.usedTokens, 150000)
    // span = 20 min -> floor 1 -> 150000/20 = 7500 per min
    assert.equal(r.burnRatePerMin, 7500)
  })

  it('computeBurnRate floors to 1 min for a single bursty row', () => {
    const r = computeBurnRate([{ ts: NOW, tokens: 6000 }], { now: NOW })
    assert.equal(r.usedTokens, 6000)
    assert.equal(r.burnRatePerMin, 6000) // 6000 / max(0,1) = 6000
  })

  it('computeBurnRate returns null burn for empty input', () => {
    const r = computeBurnRate([], { now: NOW })
    assert.equal(r.usedTokens, 0)
    assert.equal(r.burnRatePerMin, null)
  })

  it('projectHitAt infers limit from utilization and projects the hit time', () => {
    // 67% = 670000 tokens -> limit ~1,000,000 -> remaining 330,000 @ 5000/min = 66 min
    const iso = projectHitAt({ utilization: 67, burnRatePerMin: 5000, usedTokens: 670000, now: NOW })
    assert.equal(iso, '2026-07-06T07:06:00.000Z')
  })

  it('projectHitAt returns null at/over 100% or with no burn', () => {
    assert.equal(projectHitAt({ utilization: 100, burnRatePerMin: 5000, usedTokens: 670000, now: NOW }), null)
    assert.equal(projectHitAt({ utilization: 50, burnRatePerMin: 0, usedTokens: 100, now: NOW }), null)
    assert.equal(projectHitAt({ utilization: 50, burnRatePerMin: 5000, usedTokens: 0, now: NOW }), null)
  })
})

describe('usage: estimateClaudeWindowsFromTimeline + attachBurnAndProjection (pure)', () => {
  it('estimates 5h + weekly windows from a jsonl timeline (estimated:true, limit null)', () => {
    const tl = [
      { ts: NOW - 60 * 60 * 1000, tokens: 100000 },
      { ts: NOW - 30 * 60 * 1000, tokens: 50000 },
    ]
    const w = estimateClaudeWindowsFromTimeline(tl, { source: 'claude-team1', label: 'Team 1', now: NOW })
    assert.equal(w.length, 2)
    const five = w.find((x) => x.windowType === '5h')
    assert.equal(five.estimated, true)
    assert.equal(five.limit, null)
    assert.equal(five.unit, 'tokens')
    assert.equal(five.usedTokens, 150000)
    assert.ok(five.resetAt) // oldest + 5h
    assert.equal(five.resetAt, '2026-07-06T10:00:00.000Z') // oldest ts + 5h
    const weekly = w.find((x) => x.windowType === 'weekly')
    assert.equal(weekly.estimated, true)
    assert.equal(weekly.usedTokens, 150000)
  })

  it('returns estimated empty windows with no reset when timeline is empty', () => {
    const w = estimateClaudeWindowsFromTimeline([], { source: 'c', label: 'l', now: NOW })
    assert.equal(w[0].usedTokens, null)
    assert.equal(w[0].resetAt, null)
    assert.equal(w[0].estimated, true)
  })

  it('attachBurnAndProjection adds jsonl burn + projected hit to an OAuth 5h window', () => {
    const win = { source: 'c', label: 'l', windowType: '5h', used: 67, limit: 100, remaining: 33, utilization: 67, unit: 'percent', resetAt: '2026-07-06T07:29:59Z', estimated: false, severity: 'normal', note: '' }
    // two rows 134 min apart, summing to 670000 tokens -> burn 5000/min.
    // projectHitAt: util 67 + used 670000 -> inferred limit 1M, remaining 330000,
    // at 5000/min -> hit in 66 min -> 06:00 + 66min = 07:06:00Z
    const tl = [
      { ts: NOW - 134 * 60 * 1000, tokens: 335000 },
      { ts: NOW, tokens: 335000 },
    ]
    const out = attachBurnAndProjection(win, tl, { now: NOW })
    assert.equal(out.usedTokens, 670000)
    assert.equal(out.burnRatePerMin, 5000)
    assert.equal(out.projectedHitAt, '2026-07-06T07:06:00.000Z')
    assert.equal(out.estimated, false) // core used/limit still real from OAuth
    assert.equal(out.projectedHitEstimated, true)
  })

  it('attachBurnAndProjection leaves monthly windows untouched', () => {
    const win = { windowType: 'monthly', used: 5, limit: 100, utilization: 5, unit: 'credits', estimated: false, note: '' }
    const out = attachBurnAndProjection(win, [{ ts: NOW, tokens: 999 }], { now: NOW })
    assert.equal(out.usedTokens, undefined) // not attached
    assert.equal(out.projectedHitAt, undefined)
  })
})

describe('usage: streamJsonlTimeline + readClaudeOAuthCredentials', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-tl-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('streamJsonlTimeline collects assistant rows with ts + tokens since sinceMs', () => {
    const p = join(tmp, 's.jsonl')
    const oldTs = '2026-07-01T00:00:00.000Z'
    const newTs = '2026-07-06T05:30:00.000Z'
    const lines = [
      JSON.stringify({ type: 'user', timestamp: newTs, message: { role: 'user', content: [] } }),
      JSON.stringify({ type: 'assistant', timestamp: oldTs, message: { model: 'm', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      JSON.stringify({ type: 'assistant', timestamp: newTs, message: { model: 'm', role: 'assistant', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ]
    writeFileSync(p, lines.join('\n') + '\n')
    const since = Date.parse('2026-07-06T00:00:00Z')
    const rows = streamJsonlTimeline(p, since)
    assert.equal(rows.length, 1) // old row filtered out
    assert.equal(rows[0].tokens, 150)
    assert.equal(rows[0].ts, Date.parse(newTs))
  })

  it('readClaudeOAuthCredentials reads accessToken + tier from a tmp credentials file', () => {
    const cfgDir = join(tmp, '.claude')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-test', expiresAt: NOW + 999999, subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x', scopes: ['user:profile'] },
    }))
    const c = readClaudeOAuthCredentials(cfgDir)
    assert.equal(c.accessToken, 'sk-ant-oat01-test')
    assert.equal(c.subscriptionType, 'team')
    assert.equal(c.rateLimitTier, 'default_claude_max_5x')
    assert.ok(c.scopes.includes('user:profile'))
  })

  it('readClaudeOAuthCredentials returns null for missing / malformed file', () => {
    assert.equal(readClaudeOAuthCredentials(join(tmp, 'nope')), null)
    writeFileSync(join(tmp, '.credentials.json'), '{not json')
    assert.equal(readClaudeOAuthCredentials(tmp), null)
    writeFileSync(join(tmp, '.credentials2.json'), '{}')
    const cfgDir2 = join(tmp, 'sub')
    mkdirSync(cfgDir2, { recursive: true })
    writeFileSync(join(cfgDir2, '.credentials.json'), JSON.stringify({ other: 1 }))
    assert.equal(readClaudeOAuthCredentials(cfgDir2), null)
  })
})

describe('usage: mapAigwSpendResponse (pure)', () => {
  it('maps /key/info soft_budget + spend into a monthly usd window', () => {
    const r = mapAigwSpendResponse('/key/info', { soft_budget: 100, spend: 12.5 }, { tried: [{ endpoint: '/key/info', status: 200 }] })
    assert.equal(r.available, true)
    assert.equal(r.windows[0].used, 12.5)
    assert.equal(r.windows[0].limit, 100)
    assert.equal(r.windows[0].remaining, 87.5)
    assert.equal(r.windows[0].unit, 'usd')
    assert.equal(r.windows[0].windowType, 'monthly')
  })

  it('maps /global/spend total_spend into a spend-only window (limit null, no fabrication)', () => {
    const r = mapAigwSpendResponse('/global/spend', { total_spend: 42.1 }, { tried: [] })
    assert.equal(r.available, true)
    assert.equal(r.windows[0].used, 42.1)
    assert.equal(r.windows[0].limit, null)
  })

  it('returns unavailable for an unparseable / empty body', () => {
    const r = mapAigwSpendResponse('/key/info', null, { tried: [] })
    assert.equal(r.available, false)
    assert.ok(r.error)
  })
})

// ── MES-13788 延续: AIGW /user/info monthly budget + self-adapting tier ─────────

describe('usage: computeAigwBudgetTier (pure, aigw_budget.sh port)', () => {
  it('FREE_ONLY when remaining < 10%', () => {
    assert.equal(computeAigwBudgetTier({ pctRemaining: 5, daysLeft: 20 }), 'FREE_ONLY')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 9.9, daysLeft: 20 }), 'FREE_ONLY')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 0, daysLeft: 20 }), 'FREE_ONLY')
  })
  it('BURN when reset <= 4 days and remaining > 25% (checked before SPEND_PAID)', () => {
    assert.equal(computeAigwBudgetTier({ pctRemaining: 50, daysLeft: 4 }), 'BURN')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 90, daysLeft: 1 }), 'BURN')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 26, daysLeft: 0 }), 'BURN')
  })
  it('SPEND_PAID when remaining > 40% and reset is far (>4 days)', () => {
    assert.equal(computeAigwBudgetTier({ pctRemaining: 80, daysLeft: 25 }), 'SPEND_PAID')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 41, daysLeft: 20 }), 'SPEND_PAID')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 100, daysLeft: 30 }), 'SPEND_PAID')
  })
  it('BALANCED for 10-40% remaining', () => {
    assert.equal(computeAigwBudgetTier({ pctRemaining: 20, daysLeft: 20 }), 'BALANCED')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 40, daysLeft: 20 }), 'BALANCED')
    assert.equal(computeAigwBudgetTier({ pctRemaining: 10, daysLeft: 20 }), 'BALANCED')
  })
  it('BURN is unreachable when daysLeft is null (reset unknown)', () => {
    // 50% remaining but no reset info -> not BURN, falls to SPEND_PAID (>40%)
    assert.equal(computeAigwBudgetTier({ pctRemaining: 50, daysLeft: null }), 'SPEND_PAID')
    // 30% remaining, no reset -> BALANCED (not BURN)
    assert.equal(computeAigwBudgetTier({ pctRemaining: 30, daysLeft: null }), 'BALANCED')
  })
  it('degrades to BALANCED for non-finite pct', () => {
    assert.equal(computeAigwBudgetTier({ pctRemaining: NaN, daysLeft: 5 }), 'BALANCED')
    assert.equal(computeAigwBudgetTier({}), 'BALANCED')
  })
  it('BURN requires remaining > 25% (not <=25%) even when reset is soon', () => {
    // 25% remaining, reset in 3 days -> not BURN (needs >25%), not FREE (<10%),
    // not SPEND (>40%) -> BALANCED
    assert.equal(computeAigwBudgetTier({ pctRemaining: 25, daysLeft: 3 }), 'BALANCED')
  })
  it('AIGW_BUDGET_ADVICE has a zh hint for every tier', () => {
    for (const tier of ['FREE_ONLY', 'BALANCED', 'SPEND_PAID', 'BURN']) {
      assert.ok(typeof AIGW_BUDGET_ADVICE[tier] === 'string' && AIGW_BUDGET_ADVICE[tier].length > 0, `advice for ${tier}`)
    }
  })
})

describe('usage: computeBudgetDaysLeft (pure)', () => {
  it('floors whole days from now to reset', () => {
    // NOW + 3.5 days -> 3
    const reset = new Date(NOW + 3.5 * 86400_000).toISOString()
    assert.equal(computeBudgetDaysLeft(reset, NOW), 3)
  })
  it('returns 0 when reset is in the past or now', () => {
    assert.equal(computeBudgetDaysLeft(new Date(NOW - 1000).toISOString(), NOW), 0)
    assert.equal(computeBudgetDaysLeft(new Date(NOW).toISOString(), NOW), 0)
  })
  it('returns null for missing / unparseable reset', () => {
    assert.equal(computeBudgetDaysLeft(null, NOW), null)
    assert.equal(computeBudgetDaysLeft('', NOW), null)
    assert.equal(computeBudgetDaysLeft('not-a-date', NOW), null)
    assert.equal(computeBudgetDaysLeft(12345, NOW), null)
  })
})

describe('usage: mapAigwBudgetResponse (pure)', () => {
  const REAL_USER_INFO = {
    user_id: 'b3a432ba', user_email: 'zhiningjiao@meshy.ai',
    max_budget: 1000.0, spend: 197.8257218000002,
    budget_duration: '30d', budget_reset_at: '2026-08-01T00:00:00Z',
  }
  // NOW = 2026-07-06T06:00:00Z -> 25.75 days to reset -> floor 25
  it('maps a real /user/info body into remaining/pct/tier/days_left', () => {
    const r = mapAigwBudgetResponse({ user_info: REAL_USER_INFO }, { now: NOW })
    assert.equal(r.available, true)
    assert.equal(r.max_budget, 1000)
    assert.equal(r.spend, 197.82572) // rounded to 5 dp
    assert.equal(r.remaining, 802.17) // rounded to 2 dp
    assert.equal(r.pct_remaining, 80.2)
    assert.equal(r.pct_used, 19.8)
    assert.equal(r.reset_at, '2026-08-01T00:00:00Z')
    assert.equal(r.days_left, 25)
    assert.equal(r.budget_duration, '30d')
    assert.equal(r.user_email, 'zhiningjiao@meshy.ai')
    // 80.2% remaining, 25 days to reset -> SPEND_PAID
    assert.equal(r.tier, 'SPEND_PAID')
    assert.equal(r.advice, AIGW_BUDGET_ADVICE.SPEND_PAID)
  })
  it('classifies BURN when reset is soon and remaining is high', () => {
    const ui = { ...REAL_USER_INFO, spend: 300, budget_reset_at: new Date(NOW + 3 * 86400_000).toISOString() }
    // remaining = 700 -> 70% > 25%, days_left = 3 <= 4 -> BURN
    const r = mapAigwBudgetResponse({ user_info: ui }, { now: NOW })
    assert.equal(r.tier, 'BURN')
    assert.equal(r.days_left, 3)
    assert.equal(r.advice, AIGW_BUDGET_ADVICE.BURN)
  })
  it('classifies FREE_ONLY when nearly exhausted', () => {
    const ui = { ...REAL_USER_INFO, spend: 960 } // remaining 40 -> 4% < 10%
    const r = mapAigwBudgetResponse({ user_info: ui }, { now: NOW })
    assert.equal(r.tier, 'FREE_ONLY')
    assert.equal(r.pct_remaining, 4)
  })
  it('returns limit=null + pct=null when max_budget is missing/zero', () => {
    const ui = { ...REAL_USER_INFO, max_budget: 0, spend: 12.3 }
    const r = mapAigwBudgetResponse({ user_info: ui }, { now: NOW })
    assert.equal(r.available, true)
    assert.equal(r.max_budget, null)
    assert.equal(r.remaining, null)
    assert.equal(r.pct_remaining, null)
    assert.equal(r.pct_used, null)
    // pct_remaining null -> computeAigwBudgetTier gets -1 (<10) -> FREE_ONLY
    assert.equal(r.tier, 'FREE_ONLY')
  })
  it('returns unavailable when user_info is missing / not an object', () => {
    assert.equal(mapAigwBudgetResponse(null, { now: NOW }).available, false)
    assert.equal(mapAigwBudgetResponse({}, { now: NOW }).available, false)
    assert.equal(mapAigwBudgetResponse({ user_info: 'x' }, { now: NOW }).available, false)
  })
  it('returns unavailable when spend is not a number', () => {
    const r = mapAigwBudgetResponse({ user_info: { ...REAL_USER_INFO, spend: 'oops' } }, { now: NOW })
    assert.equal(r.available, false)
    assert.ok(r.error)
  })
  it('days_left is null when budget_reset_at is absent (BURN unreachable)', () => {
    const ui = { ...REAL_USER_INFO, budget_reset_at: null }
    const r = mapAigwBudgetResponse({ user_info: ui }, { now: NOW })
    assert.equal(r.days_left, null)
    assert.equal(r.reset_at, null)
    // 80% remaining, no reset -> SPEND_PAID (not BURN)
    assert.equal(r.tier, 'SPEND_PAID')
  })
})

describe('usage: fetchAigwBudget (fetchImpl injection, no live network)', () => {
  it('returns the mapped budget when /user/info is 200', async () => {
    const fetchStub = async (url) => {
      assert.ok(String(url).endsWith('/user/info'), 'hits /user/info')
      return {
        ok: true, status: 200,
        json: async () => ({ user_info: { max_budget: 1000, spend: 197.83, budget_reset_at: '2026-08-01T00:00:00Z', budget_duration: '30d', user_email: 'zhiningjiao@meshy.ai' } }),
      }
    }
    const r = await fetchAigwBudget({ key: 'stub-key', fetchImpl: fetchStub, now: NOW })
    assert.equal(r.available, true)
    assert.equal(r.keyPresent, true)
    assert.equal(r.max_budget, 1000)
    assert.equal(r.tier, 'SPEND_PAID')
    assert.equal(r.days_left, 25)
  })
  it('returns unavailable with keyPresent=false when no key', async () => {
    const r = await fetchAigwBudget({ key: '', fetchImpl: async () => { throw new Error('should not be called') } })
    assert.equal(r.available, false)
    assert.equal(r.keyPresent, false)
    assert.ok(r.error)
  })
  it('returns unavailable on a non-ok response', async () => {
    const fetchStub = async () => ({ ok: false, status: 403, json: async () => ({ detail: ' forbidden' }) })
    const r = await fetchAigwBudget({ key: 'stub-key', fetchImpl: fetchStub, now: NOW })
    assert.equal(r.available, false)
    assert.equal(r.keyPresent, true)
    assert.ok(r.error)
  })
  it('returns unavailable when fetch throws', async () => {
    const fetchStub = async () => { throw new Error('network down') }
    const r = await fetchAigwBudget({ key: 'stub-key', fetchImpl: fetchStub, now: NOW })
    assert.equal(r.available, false)
    assert.ok(/network down/.test(r.error))
  })
})

describe('usage: buildUsageSummary shape (integration, no live network)', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-sum-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('returns schemaVersion + sources + flat entries for a fake home with one team + AIGW', async () => {
    // fake home with .claude (no credentials -> oauth degrades to jsonl estimate)
    mkdirSync(join(tmp, '.claude', 'projects'), { recursive: true })
    const store = createStore(':memory:')
    // point the team active path at the fake .claude so listTeams resolves it
    store.setSetting('claude_config_dir', join(tmp, '.claude'))
    // isolate XDG so no real opencode DB leaks; AIGW key absent -> unavailable
    const prevXdg = process.env.XDG_DATA_HOME
    const prevGlm = process.env.GLM_XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(tmp, 'xdg')
    delete process.env.GLM_XDG_DATA_HOME
    // no AIGW key in the fake home: readAigwKey still reads the real file, so
    // probeAigwSpend will try the real gateway and get 403 -> unavailable.
    // That's honest and the shape is what we assert.
    try {
      const sum = await buildUsageSummary({ home: tmp, store, now: NOW })
      assert.equal(sum.schemaVersion, 1)
      assert.ok(sum.generatedAt)
      assert.ok(Array.isArray(sum.sources))
      assert.ok(sum.sources.length >= 1)
      assert.ok(Array.isArray(sum.entries))
      // every entry has the unified-schema core fields
      for (const e of sum.entries) {
        assert.ok(typeof e.source === 'string')
        assert.ok(['5h', 'weekly', 'monthly'].includes(e.windowType))
        assert.ok(typeof e.estimated === 'boolean')
      }
      // AIGW source is present and (with the LLM-only key) unavailable
      const aigw = sum.sources.find((s) => s.source === 'aigw-litellm')
      assert.ok(aigw, 'aigw source present')
      assert.equal(aigw.available, false)
      assert.ok(aigw.error)
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
      if (prevGlm === undefined) delete process.env.GLM_XDG_DATA_HOME
      else process.env.GLM_XDG_DATA_HOME = prevGlm
    }
  })

  it('includes the aigw-budget source via injected fetchImpl (MES-13788 延续)', async () => {
    mkdirSync(join(tmp, '.claude', 'projects'), { recursive: true })
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', join(tmp, '.claude'))
    const prevXdg = process.env.XDG_DATA_HOME
    const prevGlm = process.env.GLM_XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(tmp, 'xdg')
    delete process.env.GLM_XDG_DATA_HOME
    // fetch stub: /user/info returns a real-shaped body; /key/info 403.
    const fetchStub = async (url) => {
      const u = String(url)
      if (u.endsWith('/user/info')) {
        return { ok: true, status: 200, json: async () => ({ user_info: { max_budget: 1000, spend: 197.83, budget_reset_at: '2026-08-01T00:00:00Z', budget_duration: '30d', user_email: 'zhiningjiao@meshy.ai', user_id: 'b3a432ba' } }) }
      }
      // /key/info -> 403 to keep aigw-litellm unavailable (shape-only)
      return { ok: false, status: 403, json: async () => ({ detail: 'forbidden' }) }
    }
    try {
      const sum = await buildUsageSummary({ home: tmp, store, now: NOW, fetchImpl: fetchStub })
      const budget = sum.sources.find((s) => s.source === 'aigw-budget')
      assert.ok(budget, 'aigw-budget source present')
      assert.equal(budget.available, true)
      assert.equal(budget.max_budget, 1000)
      assert.equal(budget.spend, 197.83)
      assert.equal(budget.remaining, 802.17)
      assert.equal(budget.tier, 'SPEND_PAID')
      assert.equal(budget.days_left, 25)
      assert.equal(budget.reset_at, '2026-08-01T00:00:00Z')
      assert.ok(typeof budget.advice === 'string' && budget.advice.length > 0)
      // flat entries include a monthly window for the budget source
      const monthly = sum.entries.find((e) => e.source === 'aigw-budget' && e.windowType === 'monthly')
      assert.ok(monthly, 'monthly entry for aigw-budget')
      assert.equal(monthly.limit, 1000)
      assert.equal(monthly.used, 197.83)
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
      if (prevGlm === undefined) delete process.env.GLM_XDG_DATA_HOME
      else process.env.GLM_XDG_DATA_HOME = prevGlm
    }
  })
})
