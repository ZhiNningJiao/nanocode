import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

// Same invokeRoute helper shape as codex-models-route.test.js /
// tab-model-override.test.js / claude-interrupt-route.
function invokeRoute(router, method, url, body = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, body, query: {}, headers: {} }
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this },
      json(payload) { resolve({ statusCode: this.statusCode, payload }) },
      send(payload) { resolve({ statusCode: this.statusCode, payload }) },
      end(payload) { resolve({ statusCode: this.statusCode, payload }) },
    }
    router.handle(req, res, (err) => {
      if (err) reject(err)
      else resolve({ statusCode: res.statusCode, payload: undefined })
    })
  })
}

describe('GET /api/claude/models — authoritative source (SDK supportedModels())', () => {
  it('serves the live probe, whitelists fields, and carries sdk_version', async () => {
    const home = makeTempDir('nanocode-claude-models-')
    const probeCalls = []
    // Mirrors the real 0.3.220 probe output: aliases + versioned ids + effort
    // metadata. `opus[1m]` and `claude-fable-5[1m]` carry the [1m] suffix that
    // the SDK uses internally — the route MUST pass these through unchanged.
    const claudeModelProbe = async () => {
      probeCalls.push(1)
      return [
        { value: 'default', displayName: 'Default (Opus 5, 1M)', description: 'Opus 5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
        { value: 'opus[1m]', displayName: 'Opus 5 (1M)', description: 'Opus 5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
        { value: 'sonnet', displayName: 'Sonnet 5', description: 'Claude Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
        { value: 'haiku', displayName: 'Haiku 4.5', description: 'Claude Haiku 4.5', supportsEffort: false, supportedEffortLevels: [] },
      ]
    }

    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home, claudeModelProbe })

    const res = await invokeRoute(router, 'GET', '/api/claude/models')
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.fallback, false, 'a live probe must not be flagged as fallback')
    assert.equal(typeof res.payload.sdk_version, 'string')

    const values = res.payload.models.map((m) => m.value)
    assert.deepEqual(values, ['default', 'opus[1m]', 'sonnet', 'haiku'], 'order preserved; [1m] suffix passed through')
    assert.ok(values.includes('opus[1m]'), 'Opus 5 (1M) must be selectable')

    const opus = res.payload.models[1]
    assert.equal(opus.displayName, 'Opus 5 (1M)')
    assert.equal(opus.description, 'Opus 5 with 1M context')
    assert.equal(opus.supportsEffort, true)
    assert.deepEqual(opus.supportedEffortLevels, ['low', 'medium', 'high', 'max'])

    const haiku = res.payload.models[3]
    assert.equal(haiku.supportsEffort, false)
    assert.deepEqual(haiku.supportedEffortLevels, [], 'haiku has no effort levels')
  })

  it('drops entries with missing/non-string/blank value so the picker never sees escapeHtml(undefined)', async () => {
    // A single malformed entry (value undefined / number / whitespace) must
    // NOT take down the whole picker. The route drops it; the good entries
    // still come through with safe, non-empty string values. Display fields
    // are also coerced so a non-string sibling can't make escapeHtml throw on
    // the surviving entries — the exact F1 failure the codex side hit.
    const claudeModelProbe = async () => [
      { value: 'sonnet', displayName: 'Sonnet 5', description: 'Claude Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
      { displayName: 'No Value', supportsEffort: true }, // dropped: value missing
      { value: 123, displayName: 'Num Value' }, // dropped: non-string value
      { value: '   ', displayName: 'Blank Value' }, // dropped: whitespace value
      { value: '', displayName: 'Empty Value' }, // dropped: empty value
      { value: 'opus[1m]', description: 'Opus 5' }, // valid; displayName missing → falls back to value
      { value: 'haiku', displayName: 42, description: 99, supportsEffort: 'yes', supportedEffortLevels: ['low', null, 7, ''] }, // valid value; non-string displayName → value; non-string description → ''
    ]

    const home = makeTempDir('nanocode-claude-models-slug-')
    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home, claudeModelProbe })

    const res = await invokeRoute(router, 'GET', '/api/claude/models')
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.fallback, false, 'a valid probe with some bad entries is not a fallback')

    const values = res.payload.models.map((m) => m.value)
    assert.deepEqual(values, ['sonnet', 'opus[1m]', 'haiku'], 'only non-empty-string-value entries survive, in order')
    // Every served value is a non-empty trimmed string → escapeHtml never sees undefined.
    for (const m of res.payload.models) {
      assert.equal(typeof m.value, 'string')
      assert.ok(m.value.trim().length > 0, 'value must be a non-empty trimmed string')
      assert.equal(typeof m.displayName, 'string')
      assert.equal(typeof m.description, 'string')
      assert.equal(typeof m.supportsEffort, 'boolean')
      assert.ok(Array.isArray(m.supportedEffortLevels))
    }
    // displayName falls back to value when missing or non-string.
    assert.equal(res.payload.models[1].displayName, 'opus[1m]', 'missing displayName → value')
    assert.equal(res.payload.models[2].displayName, 'haiku', 'non-string displayName → value')
    // non-string description is coerced to '' (not passed through to escapeHtml).
    assert.equal(res.payload.models[2].description, '', 'non-string description → empty string')
    // supportsEffort coerced to boolean.
    assert.equal(res.payload.models[2].supportsEffort, false, 'non-boolean supportsEffort → false')
    // mixed-type supportedEffortLevels keeps only non-empty string efforts.
    assert.deepEqual(res.payload.models[2].supportedEffortLevels, ['low'], 'mixed effort list keeps only non-empty strings')
  })

  it('returns fallback:true with an empty model list when the probe throws', async () => {
    const claudeModelProbe = async () => { throw new Error('claude model probe timed out') }

    const home = makeTempDir('nanocode-claude-models-throw-')
    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home, claudeModelProbe })

    const res = await invokeRoute(router, 'GET', '/api/claude/models')
    assert.equal(res.statusCode, 200, 'must never 500 — a probe failure degrades to fallback')
    assert.equal(res.payload.fallback, true)
    assert.deepEqual(res.payload.models, [])
    assert.equal(typeof res.payload.sdk_version, 'string')
  })

  it('returns fallback:true when the probe returns a non-array', async () => {
    const claudeModelProbe = async () => null

    const home = makeTempDir('nanocode-claude-models-null-')
    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home, claudeModelProbe })

    const res = await invokeRoute(router, 'GET', '/api/claude/models')
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.fallback, false, 'a non-array probe is treated as an empty list, not a failure')
    assert.deepEqual(res.payload.models, [])
  })

  it('returns fallback:true with an empty list when the probe returns []', async () => {
    const claudeModelProbe = async () => []

    const home = makeTempDir('nanocode-claude-models-empty-')
    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home, claudeModelProbe })

    const res = await invokeRoute(router, 'GET', '/api/claude/models')
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.fallback, false, 'a valid probe with zero models is not a fallback')
    assert.deepEqual(res.payload.models, [])
  })

  it('uses the injected probe and never spawns the real SDK (sandbox isolation)', async () => {
    let called = 0
    const claudeModelProbe = async () => {
      called++
      return [{ value: 'sonnet', displayName: 'Sonnet 5', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }]
    }

    const home = makeTempDir('nanocode-claude-models-iso-')
    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home, claudeModelProbe })

    const res = await invokeRoute(router, 'GET', '/api/claude/models')
    assert.equal(called, 1, 'injected probe is called exactly once (cache bypassed for injected probes)')
    assert.equal(res.payload.models.length, 1)
    assert.equal(res.payload.models[0].value, 'sonnet')
  })
})
