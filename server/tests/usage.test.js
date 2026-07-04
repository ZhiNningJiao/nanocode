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
import { aggregateJsonlUsage, scanClaudeUsage, effectiveClaudeConfigDir, claudeProjectsDir, listTeams, aggregateOpencodeSessions, parseOpencodeModel, resolveOpencodeDbPaths, scanOpencodeUsage, opencodeUsageEmpty } from '../../terminal/usage.js'
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
    const prev = process.env.OPENCODE_DB_PATH
    process.env.OPENCODE_DB_PATH = dbPath
    try {
      // point XDG somewhere empty so only the override survives
      const paths = resolveOpencodeDbPaths(join(tmp, 'fake-home'))
      assert.deepEqual(paths, [dbPath])
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_DB_PATH
      else process.env.OPENCODE_DB_PATH = prev
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
