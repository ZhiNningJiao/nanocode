import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
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

// Same invokeRoute helper shape as tab-model-override.test.js / claude-interrupt-route.
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

function makeCache(models, extra = {}) {
  return JSON.stringify({
    fetched_at: '2026-07-25T06:23:36.802774521Z',
    etag: 'W/"abc"',
    client_version: '0.144.3',
    models,
    ...extra,
  })
}

describe('GET /api/codex/models — authoritative source (~/.codex/models_cache.json)', () => {
  it('serves the live cache, drops visibility:"hide", flattens effort objects to strings, and carries configModel', async () => {
    const home = makeTempDir('nanocode-codex-models-')
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(
      path.join(home, '.codex', 'models_cache.json'),
      makeCache([
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6-Sol',
          description: 'Latest frontier agentic coding model.',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast' },
            { effort: 'medium', description: 'Balanced' },
            { effort: 'high', description: 'Greater' },
            { effort: 'xhigh', description: 'Extra' },
            { effort: 'max', description: 'Maximum' },
            { effort: 'ultra', description: 'Max + delegation' },
          ],
          shell_type: 'shell_command',
          visibility: 'list',
          supported_in_api: true,
          priority: 1,
        },
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          description: 'Prev gen.',
          default_reasoning_level: 'xhigh',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast' },
            { effort: 'high', description: 'Extended' },
          ],
          visibility: 'list',
          supported_in_api: true,
          priority: 2,
        },
        {
          slug: 'codex-auto-review',
          display_name: 'Codex Auto Review',
          description: 'Internal review model — must NOT appear in the picker.',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
          visibility: 'hide',
          supported_in_api: true,
          priority: 99,
        },
      ])
    )
    writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n')

    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home })

    const res = await invokeRoute(router, 'GET', '/api/codex/models')
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.fallback, false, 'live cache must not be flagged as fallback')
    assert.equal(res.payload.client_version, '0.144.3')
    assert.equal(res.payload.fetched_at, '2026-07-25T06:23:36.802774521Z')
    assert.equal(res.payload.configModel, 'gpt-5.6-sol', 'configModel must come from config.toml')

    const slugs = res.payload.models.map((m) => m.slug)
    assert.deepEqual(slugs, ['gpt-5.6-sol', 'gpt-5.5'], 'hidden models must be filtered; order preserved')
    assert.ok(!slugs.includes('codex-auto-review'), 'the internal auto-review model must never reach the picker')

    const sol = res.payload.models[0]
    assert.equal(sol.display_name, 'GPT-5.6-Sol')
    assert.equal(sol.default_reasoning_level, 'medium')
    assert.deepEqual(
      sol.supported_reasoning_levels,
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'supported_reasoning_levels objects must be flattened to their effort strings'
    )

    const five = res.payload.models[1]
    assert.deepEqual(five.supported_reasoning_levels, ['low', 'high'])
  })

  it('returns fallback:true with an empty model list when models_cache.json is missing', async () => {
    const home = makeTempDir('nanocode-codex-models-missing-')
    // .codex exists but no models_cache.json
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\n')

    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home })

    const res = await invokeRoute(router, 'GET', '/api/codex/models')
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.fallback, true)
    assert.deepEqual(res.payload.models, [])
    assert.equal(res.payload.configModel, 'gpt-5.5', 'configModel is still parsed from config.toml')
    assert.equal(res.payload.fetched_at, null)
    assert.equal(res.payload.client_version, null)
  })

  it('returns fallback:true when models_cache.json is malformed JSON', async () => {
    const home = makeTempDir('nanocode-codex-models-bad-')
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(path.join(home, '.codex', 'models_cache.json'), '{ not valid json,,,')
    writeFileSync(path.join(home, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n')

    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home })

    const res = await invokeRoute(router, 'GET', '/api/codex/models')
    assert.equal(res.statusCode, 200, 'must never 500 — a bad cache degrades to fallback')
    assert.equal(res.payload.fallback, true)
    assert.deepEqual(res.payload.models, [])
    assert.equal(res.payload.configModel, null, 'no model= line in config.toml → null')
  })

  it('handles a cache with an empty models array (fallback:false, models:[])', async () => {
    const home = makeTempDir('nanocode-codex-models-empty-')
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(path.join(home, '.codex', 'models_cache.json'), makeCache([]))
    writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.6-terra"\n')

    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home })

    const res = await invokeRoute(router, 'GET', '/api/codex/models')
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.fallback, false, 'a valid cache with zero models is not a fallback')
    assert.deepEqual(res.payload.models, [])
    assert.equal(res.payload.configModel, 'gpt-5.6-terra')
  })

  it('tolerates supported_reasoning_levels already being strings (defensive)', async () => {
    const home = makeTempDir('nanocode-codex-models-str-')
    mkdirSync(path.join(home, '.codex'), { recursive: true })
    writeFileSync(
      path.join(home, '.codex', 'models_cache.json'),
      makeCache([
        {
          slug: 'gpt-5.4',
          display_name: 'GPT-5.4',
          description: '',
          default_reasoning_level: 'medium',
          // Older caches may store plain strings instead of {effort,description}.
          supported_reasoning_levels: ['low', 'medium', 'high'],
          visibility: 'list',
        },
      ])
    )

    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home })

    const res = await invokeRoute(router, 'GET', '/api/codex/models')
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.payload.models[0].supported_reasoning_levels, ['low', 'medium', 'high'])
  })

  it('uses the injected home, never the real ~/.codex (sandbox isolation)', async () => {
    // A temp home with NO .codex at all → fallback, empty. This also proves the
    // route does not accidentally read the worker's real ~/.codex/models_cache.json.
    const home = makeTempDir('nanocode-codex-models-iso-')

    const store = createStore(':memory:')
    const { router } = createTerminalRoutes(store, { home })

    const res = await invokeRoute(router, 'GET', '/api/codex/models')
    assert.equal(res.payload.fallback, true)
    assert.deepEqual(res.payload.models, [])
    assert.equal(res.payload.configModel, null)
  })
})
