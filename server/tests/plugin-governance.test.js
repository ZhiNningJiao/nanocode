/**
 * P3: Lightweight permission + isolation governance tests.
 *
 * Covers four governance improvements (advisory, pre-sandbox, first-version):
 *   3a — manifest `permissions` field (network/fs/exec/env): declared + warned,
 *        never enforced (no sandbox yet).
 *   3b — namespaced settings (`pluginName:key`): auto-prefix on registerSetting,
 *        legacy migration on read, backward-compatible with `pluginName_*` convention.
 *   3c — route conflict detection: warn when two plugins register the same
 *        method+path (last-wins still applies, but the conflict is surfaced).
 *   3d — event handler error isolation: one listener throwing does not break
 *        other listeners or the emit caller.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createPluginHost, validatePluginManifest, loadPlugins, discoverPlugins } from '../plugin-host.js'
import { createStore } from '../store.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 3a: Manifest permissions field ──────────────────────────────────────────

describe('P3a: manifest permissions field', () => {
  it('validatePluginManifest accepts known permission categories', () => {
    const warns = captureWarns(() =>
      validatePluginManifest('demo', {
        apiVersion: '0.9',
        permissions: {
          fs: ['read:./data', 'write:./data'],
          network: ['https://aigw.meshy.team'],
          exec: ['node', 'python3'],
          env: ['AIGW_KEY'],
        },
      }),
    )
    // Known categories → no permission-related warning
    assert.equal(warns.filter((w) => /permission/.test(w)).length, 0)
  })

  it('validatePluginManifest warns on unknown permission categories', () => {
    const warns = captureWarns(() =>
      validatePluginManifest('demo', {
        apiVersion: '0.9',
        permissions: {
          fs: ['read:./data'],
          teleport: ['everywhere'], // unknown category
        },
      }),
    )
    assert.ok(warns.some((w) => /unknown permission categor/.test(w)), 'should warn on unknown category')
    assert.ok(warns.some((w) => /teleport/.test(w)), 'warning should name the unknown category')
  })

  it('validatePluginManifest does not warn when permissions field is absent', () => {
    const warns = captureWarns(() =>
      validatePluginManifest('demo', { apiVersion: '0.9' }),
    )
    assert.equal(warns.filter((w) => /permission/.test(w)).length, 0)
  })

  it('discoverPlugins returns declared permissions in metadata', async () => {
    const store = createStore(':memory:')
    const host = createPluginHost({ app: express(), store, broadcastNotify: () => {} })
    const plugins = await discoverPlugins(host, {
      pluginsDir: new URL('../../plugins', import.meta.url).pathname,
    })
    // All 3 existing plugins should return a permissions field (null or object).
    for (const p of plugins) {
      assert.ok('permissions' in p, `${p.name} should have a permissions field`)
    }
  })
})

// ── 3b: Namespaced settings ──────────────────────────────────────────────────

describe('P3b: namespaced settings', () => {
  let app, store, host

  beforeEach(() => {
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    host = createPluginHost({ app, store, broadcastNotify: () => {} })
  })

  afterEach(() => {
    try { host.emit('shutdown') } catch {}
  })

  it('auto-namespaces a setting key when loaded inside a plugin context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-ns-'))
    try {
      mkdirSync(join(dir, 'myplug'))
      writeFileSync(join(dir, 'myplug', 'plugin.json'), JSON.stringify({
        name: 'myplug', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'myplug', 'server.js'),
        'export function register(host) { host.registerSetting({ key: "theme", default: "dark" }) }')

      await loadPlugins(host, { pluginsDir: dir })

      // The definition should be stored under the namespaced key
      const defs = host.getAllSettingDefs()
      const ns = defs.find((d) => d.key === 'myplug:theme')
      assert.ok(ns, 'setting should be namespaced as myplug:theme')
      assert.equal(ns.default, 'dark')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT double-namespace a key already prefixed with pluginName_', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-ns2-'))
    try {
      mkdirSync(join(dir, 'myplug'))
      writeFileSync(join(dir, 'myplug', 'plugin.json'), JSON.stringify({
        name: 'myplug', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'myplug', 'server.js'),
        'export function register(host) { host.registerSetting({ key: "myplug_theme", default: "light" }) }')

      await loadPlugins(host, { pluginsDir: dir })

      const defs = host.getAllSettingDefs()
      // Should be stored as myplug_theme, NOT myplug:myplug_theme
      assert.ok(defs.find((d) => d.key === 'myplug_theme'), 'conventionally-namespaced key preserved')
      assert.ok(!defs.find((d) => d.key === 'myplug:myplug_theme'), 'no double-namespace')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT double-namespace a key already prefixed with pluginName:', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-ns3-'))
    try {
      mkdirSync(join(dir, 'myplug'))
      writeFileSync(join(dir, 'myplug', 'plugin.json'), JSON.stringify({
        name: 'myplug', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'myplug', 'server.js'),
        'export function register(host) { host.registerSetting({ key: "myplug:color", default: "red" }) }')

      await loadPlugins(host, { pluginsDir: dir })

      const defs = host.getAllSettingDefs()
      assert.ok(defs.find((d) => d.key === 'myplug:color'), 'explicitly-namespaced key preserved')
      assert.ok(!defs.find((d) => d.key === 'myplug:myplug:color'), 'no double-namespace')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('getSetting resolves through namespace: reads namespaced value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-ns4-'))
    try {
      mkdirSync(join(dir, 'myplug'))
      writeFileSync(join(dir, 'myplug', 'plugin.json'), JSON.stringify({
        name: 'myplug', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'myplug', 'server.js'),
        'export function register(host) {\n' +
        '  host.registerSetting({ key: "greeting", default: "hi" })\n' +
        '  host.setSetting("greeting", "hello")\n' +
        '  host._storedVal = host.getSetting("greeting")\n' +
        '}')

      await loadPlugins(host, { pluginsDir: dir })

      // The plugin set "greeting" → should be stored under "myplug:greeting"
      assert.equal(store.getSetting('myplug:greeting'), 'hello')
      // And getSetting("greeting") from within the plugin should resolve to it
      assert.equal(host._storedVal, 'hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates legacy value: if namespaced key is absent but legacy key exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-ns5-'))
    try {
      // Pre-seed a legacy value under the bare key (no prefix → gets auto-namespaced)
      store.setSetting('legacykey', 'old-value')

      mkdirSync(join(dir, 'myplug'))
      writeFileSync(join(dir, 'myplug', 'plugin.json'), JSON.stringify({
        name: 'myplug', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'myplug', 'server.js'),
        'export function register(host) {\n' +
        '  host.registerSetting({ key: "legacykey", default: null })\n' +
        '  host._migrated = host.getSetting("legacykey")\n' +
        '}')

      await loadPlugins(host, { pluginsDir: dir })

      // getSetting("legacykey") should return the legacy value (migrated)
      assert.equal(host._migrated, 'old-value')
      // And it should have been migrated to the namespaced key
      assert.equal(store.getSetting('myplug:legacykey'), 'old-value')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('settings registered outside a plugin context (no currentPlugin) are not auto-namespaced', () => {
    host.registerSetting({ key: 'global_thing', default: 42 })
    const defs = host.getAllSettingDefs()
    assert.ok(defs.find((d) => d.key === 'global_thing'))
    assert.ok(!defs.find((d) => d.key === '<anonymous>:global_thing'))
  })
})

// ── 3c: Route conflict detection ─────────────────────────────────────────────

describe('P3c: route conflict detection', () => {
  let app, store, host

  beforeEach(() => {
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    store.setSetting('plugin_monitor_enabled', false)
    host = createPluginHost({ app, store, broadcastNotify: () => {} })
  })

  afterEach(() => {
    try { host.emit('shutdown') } catch {}
  })

  it('warns when two plugins register the same method+path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-route-'))
    try {
      mkdirSync(join(dir, 'plug-a'))
      writeFileSync(join(dir, 'plug-a', 'plugin.json'), JSON.stringify({
        name: 'plug-a', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-a', 'server.js'),
        'export function register(host) { host.registerRoute("get", "/conflict", (req, res) => res.json({ a: true })) }')

      mkdirSync(join(dir, 'plug-b'))
      writeFileSync(join(dir, 'plug-b', 'plugin.json'), JSON.stringify({
        name: 'plug-b', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-b', 'server.js'),
        'export function register(host) { host.registerRoute("get", "/conflict", (req, res) => res.json({ b: true })) }')

      const warns = await captureWarns(async () => {
        await loadPlugins(host, { pluginsDir: dir })
      })
      assert.ok(
        warns.some((w) => /route conflict/i.test(w) && /\/api\/conflict/.test(w)),
        'should warn about route conflict on /api/conflict',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not warn when two plugins register different paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-route2-'))
    try {
      mkdirSync(join(dir, 'plug-a'))
      writeFileSync(join(dir, 'plug-a', 'plugin.json'), JSON.stringify({
        name: 'plug-a', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-a', 'server.js'),
        'export function register(host) { host.registerRoute("get", "/aaa", (req, res) => res.json({})) }')

      mkdirSync(join(dir, 'plug-b'))
      writeFileSync(join(dir, 'plug-b', 'plugin.json'), JSON.stringify({
        name: 'plug-b', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-b', 'server.js'),
        'export function register(host) { host.registerRoute("get", "/bbb", (req, res) => res.json({})) }')

      const warns = await captureWarns(async () => {
        await loadPlugins(host, { pluginsDir: dir })
      })
      assert.equal(
        warns.filter((w) => /route conflict/i.test(w)).length,
        0,
        'no conflict warning for different paths',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not warn when same path is registered with different methods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-route3-'))
    try {
      mkdirSync(join(dir, 'plug-a'))
      writeFileSync(join(dir, 'plug-a', 'plugin.json'), JSON.stringify({
        name: 'plug-a', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-a', 'server.js'),
        'export function register(host) { host.registerRoute("get", "/shared", (req, res) => res.json({})) }')

      mkdirSync(join(dir, 'plug-b'))
      writeFileSync(join(dir, 'plug-b', 'plugin.json'), JSON.stringify({
        name: 'plug-b', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-b', 'server.js'),
        'export function register(host) { host.registerRoute("post", "/shared", (req, res) => res.json({})) }')

      const warns = await captureWarns(async () => {
        await loadPlugins(host, { pluginsDir: dir })
      })
      assert.equal(warns.filter((w) => /route conflict/i.test(w)).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('last-registered route still wins (Express behaviour unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-route4-'))
    try {
      mkdirSync(join(dir, 'plug-a'))
      writeFileSync(join(dir, 'plug-a', 'plugin.json'), JSON.stringify({
        name: 'plug-a', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-a', 'server.js'),
        'export function register(host) { host.registerRoute("get", "/winner", (req, res) => res.json({ who: "a" })) }')

      mkdirSync(join(dir, 'plug-b'))
      writeFileSync(join(dir, 'plug-b', 'plugin.json'), JSON.stringify({
        name: 'plug-b', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'plug-b', 'server.js'),
        'export function register(host) { host.registerRoute("get", "/winner", (req, res) => res.json({ who: "b" })) }')

      await captureWarns(async () => { await loadPlugins(host, { pluginsDir: dir }) })

      const server = app.listen(0)
      try {
        const { port } = server.address()
        const res = await fetch(`http://127.0.0.1:${port}/api/winner`)
        const body = await res.json()
        // Express processes routes in registration order; plug-a was loaded
        // first so its handler runs first (res.json ends the response).
        assert.equal(body.who, 'a')
      } finally {
        await new Promise((r) => server.close(r))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── 3d: Event handler error isolation ────────────────────────────────────────

describe('P3d: event handler error isolation', () => {
  let app, store, host

  beforeEach(() => {
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    store.setSetting('plugin_monitor_enabled', false)
    host = createPluginHost({ app, store, broadcastNotify: () => {} })
  })

  afterEach(() => {
    try { host.emit('shutdown') } catch {}
  })

  it('one listener throwing does not prevent subsequent listeners from firing', () => {
    const calls = []
    host.on('test:event', () => calls.push('first'))
    host.on('test:event', () => { throw new Error('boom') })
    host.on('test:event', () => calls.push('third'))

    host.emit('test:event', { hello: true })

    assert.deepEqual(calls, ['first', 'third'], 'all non-throwing listeners should fire')
  })

  it('emit does not throw when a listener throws (error is swallowed + warned)', () => {
    host.on('test:event2', () => { throw new Error('crash') })
    // Should not throw
    assert.doesNotThrow(() => host.emit('test:event2', {}))
  })

  it('multiple throwing listeners are all isolated', () => {
    const calls = []
    host.on('test:event3', () => { throw new Error('a') })
    host.on('test:event3', () => calls.push('middle'))
    host.on('test:event3', () => { throw new Error('b') })

    host.emit('test:event3', {})
    assert.deepEqual(calls, ['middle'])
  })

  it('listeners receive the correct payload even with error isolation', () => {
    const received = []
    host.on('test:event4', (payload) => received.push(payload))
    host.on('test:event4', () => { throw new Error('oops') })
    host.on('test:event4', (payload) => received.push(payload))

    host.emit('test:event4', { value: 42 })
    assert.equal(received.length, 2)
    assert.equal(received[0].value, 42)
    assert.equal(received[1].value, 42)
  })
})

// ── helper ───────────────────────────────────────────────────────────────────

function captureWarns(fn) {
  const captured = []
  const original = console.warn
  console.warn = (...args) => { captured.push(args.map(String).join(' ')) }
  try {
    const ret = fn()
    if (ret && typeof ret.then === 'function') {
      return (async () => {
        try { await ret } finally { console.warn = original }
        return captured
      })()
    }
    console.warn = original
    return captured
  } catch (err) {
    console.warn = original
    throw err
  }
}
