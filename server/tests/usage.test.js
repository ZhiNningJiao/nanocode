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
import { aggregateJsonlUsage, scanClaudeUsage, effectiveClaudeConfigDir, claudeProjectsDir, listTeams, aggregateOpencodeSessions, parseOpencodeModel, resolveOpencodeDbPaths, scanOpencodeUsage, opencodeUsageEmpty, readClaudeOAuthCredentials, mapClaudeOAuthToWindows, computeBurnRate, projectHitAt, estimateClaudeWindowsFromTimeline, attachBurnAndProjection, streamJsonlTimeline, mapAigwSpendResponse, buildUsageSummary, fetchAigwKeyInfo, fetchAigwSpendLogs, buildAigwSourceSummary } from '../../terminal/usage.js'
import { loadPersonalConfig, resetPersonalConfigCache } from '../../terminal/personal-config.js'
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
})

// ── AIGW spend source (personal-config loader + /key/info + /spend/logs/v2) ────

// Mock fetch for the AIGW /key/info + /spend/logs/v2 endpoints. Returns a
// controlled Response-ish object (ok/status/json/headers.get) so the source
// can be exercised hermetically without hitting the real gateway.
function mockAigwFetch({ spend = 426.34, alias = 'test@meshy.ai', maxBudget = null, logs = [] } = {}) {
  return async (url) => {
    const u = String(url)
    if (u.includes('/key/info')) {
      return {
        ok: true, status: 200,
        json: async () => ({ info: { spend, max_budget: maxBudget, key_alias: alias, budget_duration: null, budget_reset_at: null } }),
        headers: { get: () => null },
      }
    }
    if (u.includes('/spend/logs/v2')) {
      return {
        ok: true, status: 200,
        json: async () => ({ data: logs, total: logs.length, page: 1, page_size: 100, total_pages: 1 }),
        headers: { get: () => null },
      }
    }
    return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } }
  }
}

describe('usage: personal-config loader (AIGW key/base/budgetUsd fallback)', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-pcfg-')); resetPersonalConfigCache() })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  it('falls back to ~/.config/meshy-aigw.key + default base + default budget when personal.json absent', () => {
    // write a fake meshy-aigw.key under the fake home
    mkdirSync(join(tmp, '.config'), { recursive: true })
    writeFileSync(join(tmp, '.config', 'meshy-aigw.key'), 'fake-scattered-key\n')
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.aigw.key, 'fake-scattered-key')
    assert.equal(cfg.aigw.base, 'https://aigw.meshy.team')
    assert.equal(cfg.aigw.budgetUsd, 1000)
    assert.equal(cfg._source.personalFileExists, false)
  })

  it('reads aigw.key/base/budgetUsd + linear.apiKey + claude.teams from personal.json', () => {
    mkdirSync(join(tmp, '.config', 'nanocode'), { recursive: true })
    writeFileSync(join(tmp, '.config', 'nanocode', 'personal.json'), JSON.stringify({
      linear: { apiKey: 'lin_fake' },
      aigw: { base: 'https://aigw.test', key: 'aigw_fake', budgetUsd: 500 },
      claude: { teams: [{ name: 'Custom', configDir: join(tmp, '.claude-x') }] },
      ntfy: { url: 'http://ntfy.test/topic' },
    }))
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.aigw.key, 'aigw_fake')
    assert.equal(cfg.aigw.base, 'https://aigw.test')
    assert.equal(cfg.aigw.budgetUsd, 500)
    assert.equal(cfg.linear.apiKey, 'lin_fake')
    assert.equal(cfg.ntfy.url, 'http://ntfy.test/topic')
    assert.equal(cfg.claude.teams.length, 1)
    assert.equal(cfg.claude.teams[0].name, 'Custom')
    assert.equal(cfg._source.personalFileExists, true)
  })

  it('claude.teams is null when not declared (so listTeams auto-discovers)', () => {
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.claude.teams, null)
  })

  it('returns empty key when neither personal.json nor the scattered key file exist', () => {
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.aigw.key, '')
    assert.equal(cfg.linear.apiKey, '')
  })
})

describe('usage: fetchAigwKeyInfo + fetchAigwSpendLogs (mocked)', () => {
  it('fetchAigwKeyInfo parses nested info.spend + alias + max_budget', async () => {
    const f = mockAigwFetch({ spend: 426.34, alias: 'zhiningjiao@meshy.ai', maxBudget: null })
    const r = await fetchAigwKeyInfo({ key: 'k', base: 'https://aigw.test', fetchImpl: f })
    assert.equal(r.spend, 426.34)
    assert.equal(r.alias, 'zhiningjiao@meshy.ai')
    assert.equal(r.maxBudget, null)
    assert.equal(r.budgetResetAt, null)
  })

  it('fetchAigwKeyInfo returns { error } on HTTP failure (no throw)', async () => {
    const f = async () => ({ ok: false, status: 403, json: async () => ({ detail: 'not allowed' }), headers: { get: () => null } })
    const r = await fetchAigwKeyInfo({ key: 'k', base: 'https://aigw.test', fetchImpl: f })
    assert.ok(r.error)
    assert.equal(r.spend, undefined)
  })

  it('fetchAigwKeyInfo returns { error } when key is empty', async () => {
    const r = await fetchAigwKeyInfo({ key: '', base: 'https://aigw.test', fetchImpl: mockAigwFetch() })
    assert.ok(r.error)
  })

  it('fetchAigwSpendLogs aggregates window tokens + burn from data[]', async () => {
    const baseTs = Date.parse('2026-07-06T05:00:00Z')
    const logs = [
      { startTime: '2026-07-06T05:00:00.000+00:00', total_tokens: 100000, model_group: 'litellm/SGLang-GLM-5.2' },
      { startTime: '2026-07-06T05:20:00.000+00:00', total_tokens: 50000, model_group: 'litellm/SGLang-GLM-5.2' },
    ]
    const f = mockAigwFetch({ logs })
    const r = await fetchAigwSpendLogs({ key: 'k', base: 'https://aigw.test', fetchImpl: f, now: baseTs + 60000 })
    assert.equal(r.tokensWindow, 150000)
    // span 20 min -> 150000/20 = 7500 per min
    assert.equal(r.burnPerMin, 7500)
    assert.equal(r.sampled, 2)
    assert.equal(r.totalEntries, 2)
  })

  it('fetchAigwSpendLogs returns { error } on HTTP failure (no throw)', async () => {
    const f = async () => ({ ok: false, status: 500, json: async () => ({}), headers: { get: () => null } })
    const r = await fetchAigwSpendLogs({ key: 'k', base: 'https://aigw.test', fetchImpl: f })
    assert.ok(r.error)
  })
})

describe('usage: buildAigwSourceSummary (available path, mocked)', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-aigw-')); resetPersonalConfigCache() })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  function writePersonalConfig(home, aigw) {
    mkdirSync(join(home, '.config', 'nanocode'), { recursive: true })
    writeFileSync(join(home, '.config', 'nanocode', 'personal.json'), JSON.stringify({ aigw }))
  }

  it('returns available:true with real spend + local budgetUsd + burn (estimated)', async () => {
    writePersonalConfig(tmp, { base: 'https://aigw.test', key: 'fake-test-key', budgetUsd: 500 })
    const logs = [
      { startTime: '2026-07-06T05:00:00.000+00:00', total_tokens: 100000, model_group: 'litellm/x' },
      { startTime: '2026-07-06T05:20:00.000+00:00', total_tokens: 50000, model_group: 'litellm/x' },
    ]
    const f = mockAigwFetch({ spend: 426.34, alias: 'test@meshy.ai', maxBudget: null, logs })
    const src = await buildAigwSourceSummary({ home: tmp, fetchImpl: f, now: Date.parse('2026-07-06T06:00:00Z') })
    assert.equal(src.available, true)
    assert.equal(src.source, 'aigw-litellm')
    assert.equal(src.alias, 'test@meshy.ai')
    const w = src.windows[0]
    assert.equal(w.used, 426.34)
    assert.equal(w.limit, 500)            // local budgetUsd (key max_budget is null)
    assert.equal(w.remaining, 500 - 426.34)
    assert.equal(w.unit, 'usd')
    assert.equal(w.estimated, true)       // budget is local
    assert.equal(w.used_usd, 426.34)      // task unified-schema fields
    assert.equal(w.budget_usd, 500)
    assert.equal(w.remaining_usd, 500 - 426.34)
    assert.equal(w.tokens_window, 150000)
    assert.equal(w.burn_per_min, 7500)
    assert.ok(w.note.includes('spend $426.34'))
  })

  it('uses key-side max_budget when it is non-null (>0)', async () => {
    writePersonalConfig(tmp, { base: 'https://aigw.test', key: 'fake-test-key', budgetUsd: 500 })
    const f = mockAigwFetch({ spend: 12.5, maxBudget: 100, logs: [] })
    const src = await buildAigwSourceSummary({ home: tmp, fetchImpl: f })
    const w = src.windows[0]
    assert.equal(w.used, 12.5)
    assert.equal(w.limit, 100)            // key-side max_budget wins
    assert.equal(w.remaining, 87.5)
    assert.equal(w.budget_usd, 100)
  })

  it('degrades to unavailable when the key is absent (fake home, no files)', async () => {
    const src = await buildAigwSourceSummary({ home: tmp, fetchImpl: mockAigwFetch() })
    assert.equal(src.available, false)
    assert.ok(src.error)
    assert.equal(src.windows[0].used, null)
  })

  it('degrades to unavailable when /key/info fails (key present but gateway 403)', async () => {
    writePersonalConfig(tmp, { base: 'https://aigw.test', key: 'fake-test-key', budgetUsd: 500 })
    const f = async () => ({ ok: false, status: 403, json: async () => ({ detail: 'not allowed' }), headers: { get: () => null } })
    const src = await buildAigwSourceSummary({ home: tmp, fetchImpl: f })
    assert.equal(src.available, false)
    assert.ok(src.error.includes('/key/info'))
    assert.equal(src.windows[0].used, null)
  })
})

describe('usage: buildUsageSummary AIGW-available path (mocked, hermetic)', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-sum2-')); resetPersonalConfigCache() })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  it('emits Team1 + AIGW with real spend/remaining when personal.json + fetchImpl are provided', async () => {
    // fake home with .claude (no credentials -> jsonl degrade) + personal.json
    mkdirSync(join(tmp, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(tmp, '.config', 'nanocode'), { recursive: true })
    writeFileSync(join(tmp, '.config', 'nanocode', 'personal.json'), JSON.stringify({
      aigw: { base: 'https://aigw.test', key: 'fake-test-key', budgetUsd: 1000 },
    }))
    const store = createStore(':memory:')
    store.setSetting('claude_config_dir', join(tmp, '.claude'))
    // isolate XDG so no real opencode DB leaks
    const prevXdg = process.env.XDG_DATA_HOME
    const prevGlm = process.env.GLM_XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(tmp, 'xdg')
    delete process.env.GLM_XDG_DATA_HOME
    try {
      const f = mockAigwFetch({ spend: 426.3456, alias: 'zhiningjiao@meshy.ai', maxBudget: null, logs: [] })
      const sum = await buildUsageSummary({ home: tmp, store, now: NOW, fetchImpl: f })
      assert.equal(sum.schemaVersion, 1)
      // three sources: Team1 (Claude) + AIGW (Team2 ~/.claude-team2 absent in fake home)
      const aigw = sum.sources.find((s) => s.source === 'aigw-litellm')
      assert.ok(aigw, 'aigw source present')
      assert.equal(aigw.available, true)
      assert.equal(aigw.alias, 'zhiningjiao@meshy.ai')
      const w = aigw.windows[0]
      assert.equal(w.used, 426.3456)
      assert.equal(w.budget_usd, 1000)
      assert.equal(w.remaining_usd, 1000 - 426.3456)
      assert.equal(w.estimated, true)
      // the flat entries include the AIGW window with the unified-schema fields
      const aigwEntry = sum.entries.find((e) => e.source === 'aigw-litellm')
      assert.ok(aigwEntry)
      assert.equal(aigwEntry.used_usd, 426.3456)
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
      if (prevGlm === undefined) delete process.env.GLM_XDG_DATA_HOME
      else process.env.GLM_XDG_DATA_HOME = prevGlm
    }
  })
})
