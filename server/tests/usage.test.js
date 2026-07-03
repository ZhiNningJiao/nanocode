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
import { aggregateJsonlUsage, scanClaudeUsage, effectiveClaudeConfigDir, claudeProjectsDir, listTeams } from '../../terminal/usage.js'
import { createStore } from '../store.js'

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
