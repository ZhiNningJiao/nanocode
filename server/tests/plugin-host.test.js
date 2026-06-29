/**
 * Tests for the server plugin host.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createPluginHost, loadPlugins, shutdownPlugins, discoverPlugins, HOST_API_VERSION, isApiCompatible, validatePluginManifest } from '../plugin-host.js'
import { createStore } from '../store.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('plugin-host', () => {
  let app
  let store
  let host
  const notifyMessages = []

  beforeEach(() => {
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    // Keep the monitor plugin from auto-loading in these generic host tests;
    // its fs.watch/interval collectors would prevent the runner from exiting.
    store.setSetting('plugin_monitor_enabled', false)
    notifyMessages.length = 0
    host = createPluginHost({ app, store, broadcastNotify: (msg) => notifyMessages.push(msg) })
  })

  afterEach(() => {
    // Give any enabled plugin (e.g. fleet-term) a chance to tear down timers and
    // ptys so the test runner can exit cleanly.
    try { host.emit('shutdown') } catch {}
  })

  it('emits events to registered listeners', () => {
    const seen = []
    host.on('agent:output', (payload) => seen.push(payload))
    host.emit('agent:output', 'hello')
    host.emit('agent:output', 'world')
    assert.deepEqual(seen, ['hello', 'world'])
  })

  it('registers settings and reads/writes them through the store', () => {
    host.registerSetting({ key: 'plugin_demo_foo', type: 'string', default: 'bar', label: 'Foo' })
    assert.equal(host.getSetting('plugin_demo_foo'), null)
    host.setSetting('plugin_demo_foo', 'baz')
    assert.equal(host.getSetting('plugin_demo_foo'), 'baz')
    assert.equal(store.getSetting('plugin_demo_foo'), 'baz')
  })

  it('registers Express routes under /api', async () => {
    host.registerRoute('get', '/demo', (_req, res) => res.json({ ok: true }))
    const server = app.listen(0)
    try {
      const { port } = server.address()
      const res = await fetch(`http://127.0.0.1:${port}/api/demo`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, { ok: true })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('broadcasts notify messages', () => {
    host.broadcastNotify({ type: 'plugin:x:y', text: 'hi' })
    assert.deepEqual(notifyMessages, [{ type: 'plugin:x:y', text: 'hi' }])
  })

  it('loads only enabled plugins', async () => {
    store.setSetting('plugin_tts_enabled', true)
    const loaded = await loadPlugins(host, { pluginsDir: new URL('../../plugins', import.meta.url).pathname })
    assert.ok(loaded.includes('tts'))
    const defs = host.getAllSettingDefs()
    assert.ok(defs.some((d) => d.key === 'tts_ref_audio'))
  })

  it('does not load disabled plugins', async () => {
    store.setSetting('plugin_tts_enabled', false)
    const loaded = await loadPlugins(host, { pluginsDir: new URL('../../plugins', import.meta.url).pathname })
    assert.ok(!loaded.includes('tts'))
  })

  // ── Lifecycle: registerLifecycle + shutdownPlugins ───────────────────────

  it('runs onStop hooks during shutdownPlugins', async () => {
    let stopped = false
    host.registerLifecycle({ onStop: () => { stopped = true } })
    await shutdownPlugins(host)
    assert.equal(stopped, true)
  })

  it('runs onStop hooks in reverse registration order', async () => {
    const order = []
    host.registerLifecycle({ onStop: () => order.push('first') })
    host.registerLifecycle({ onStop: () => order.push('second') })
    host.registerLifecycle({ onStop: () => order.push('third') })
    await shutdownPlugins(host)
    assert.deepEqual(order, ['third', 'second', 'first'])
  })

  it('continues shutdown when an onStop hook throws', async () => {
    let ranAfterThrow = false
    host.registerLifecycle({ onStop: () => { throw new Error('boom') } })
    host.registerLifecycle({ onStop: () => { ranAfterThrow = true } })
    const errored = await shutdownPlugins(host)
    assert.equal(ranAfterThrow, true)
    assert.deepEqual(errored, ['<anonymous>'])
  })

  it('clears lifecycle hooks after shutdown so re-running is a no-op', async () => {
    let count = 0
    host.registerLifecycle({ onStop: () => { count++ } })
    await shutdownPlugins(host)
    await shutdownPlugins(host)
    assert.equal(count, 1)
  })

  it('emits shutdown event before running onStop hooks', async () => {
    let eventFired = false
    let hookRan = false
    host.on('shutdown', () => { eventFired = true })
    host.registerLifecycle({ onStop: () => { hookRan = eventFired } })
    await shutdownPlugins(host)
    assert.equal(hookRan, true, 'onStop should see the shutdown event already fired')
  })

  // ── Status reporting ────────────────────────────────────────────────────

  it('stores and returns reported statuses', () => {
    host.reportStatus('ok', 'all good', { plugin: 'demo' })
    host.reportStatus('warn', 'degraded', { plugin: 'other' })
    const statuses = host.getStatus()
    const demo = statuses.find((s) => s.plugin === 'demo')
    const other = statuses.find((s) => s.plugin === 'other')
    assert.equal(demo.level, 'ok')
    assert.equal(demo.message, 'all good')
    assert.equal(other.level, 'warn')
    assert.equal(other.message, 'degraded')
  })

  it('normalizes unknown status levels to info', () => {
    host.reportStatus('bogus', 'test', { plugin: 'x' })
    const s = host.getStatus().find((e) => e.plugin === 'x')
    assert.equal(s.level, 'info')
  })

  it('emits plugin:status event on reportStatus', () => {
    const events = []
    host.on('plugin:status', (e) => events.push(e))
    host.reportStatus('error', 'down', { plugin: 'p', detail: 'conn refused' })
    assert.equal(events.length, 1)
    assert.equal(events[0].plugin, 'p')
    assert.equal(events[0].level, 'error')
    assert.equal(events[0].detail, 'conn refused')
  })

  // ── Dependency validation ───────────────────────────────────────────────

  it('skips a plugin whose declared dependency is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-deps-'))
    try {
      // Dependent plugin that requires a non-existent dependency.
      mkdirSync(join(dir, 'dependent'))
      writeFileSync(join(dir, 'dependent', 'plugin.json'), JSON.stringify({
        name: 'dependent', version: '1.0.0', enabledByDefault: true,
        dependencies: ['nonexistent'],
      }))
      writeFileSync(join(dir, 'dependent', 'server.js'),
        'export function register(host) { host._depLoaded = true }')

      const loaded = await loadPlugins(host, { pluginsDir: dir })
      assert.ok(!loaded.includes('dependent'))
      assert.equal(host._depLoaded, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads a plugin when its declared dependency is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-deps-'))
    try {
      // Base plugin (the dependency).
      mkdirSync(join(dir, 'base'))
      writeFileSync(join(dir, 'base', 'plugin.json'), JSON.stringify({
        name: 'base', version: '1.0.0', enabledByDefault: true,
      }))
      writeFileSync(join(dir, 'base', 'server.js'),
        'export function register(host) { host._baseLoaded = true }')

      // Dependent plugin.
      mkdirSync(join(dir, 'dependent'))
      writeFileSync(join(dir, 'dependent', 'plugin.json'), JSON.stringify({
        name: 'dependent', version: '1.0.0', enabledByDefault: true,
        dependencies: ['base'],
      }))
      writeFileSync(join(dir, 'dependent', 'server.js'),
        'export function register(host) { host._depLoaded = true }')

      const loaded = await loadPlugins(host, { pluginsDir: dir })
      assert.ok(loaded.includes('base'))
      assert.ok(loaded.includes('dependent'))
      assert.equal(host._depLoaded, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a plugin whose dependency is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-deps-'))
    try {
      mkdirSync(join(dir, 'base'))
      writeFileSync(join(dir, 'base', 'plugin.json'), JSON.stringify({
        name: 'base', version: '1.0.0', enabledByDefault: false,
      }))
      writeFileSync(join(dir, 'base', 'server.js'),
        'export function register(host) { host._baseLoaded = true }')

      mkdirSync(join(dir, 'dependent'))
      writeFileSync(join(dir, 'dependent', 'plugin.json'), JSON.stringify({
        name: 'dependent', version: '1.0.0', enabledByDefault: true,
        dependencies: ['base'],
      }))
      writeFileSync(join(dir, 'dependent', 'server.js'),
        'export function register(host) { host._depLoaded = true }')

      const loaded = await loadPlugins(host, { pluginsDir: dir })
      assert.ok(!loaded.includes('base'))
      assert.ok(!loaded.includes('dependent'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── API versioning (P1) ─────────────────────────────────────────────────

  it('exposes HOST_API_VERSION as a pre-1.0 string', () => {
    assert.equal(typeof HOST_API_VERSION, 'string')
    assert.equal(HOST_API_VERSION.startsWith('0.'), true, 'pre-1.0 (not yet frozen)')
  })

  it('isApiCompatible: exact match is compatible', () => {
    assert.deepEqual(isApiCompatible('0.9', '0.9'), { compatible: true, reason: '' })
  })

  it('isApiCompatible: patch difference is compatible (pre-1.0)', () => {
    assert.equal(isApiCompatible('0.9.1', '0.9').compatible, true)
    assert.equal(isApiCompatible('0.9', '0.9.3').compatible, true)
  })

  it('isApiCompatible: pre-1.0 minor mismatch is incompatible', () => {
    const r = isApiCompatible('0.8', '0.9')
    assert.equal(r.compatible, false)
    assert.match(r.reason, /minor mismatch/)
  })

  it('isApiCompatible: major mismatch is incompatible', () => {
    const r = isApiCompatible('1.0', '0.9')
    assert.equal(r.compatible, false)
    assert.match(r.reason, /major mismatch/)
  })

  it('isApiCompatible: 1.x minor differences are compatible (additive)', () => {
    assert.equal(isApiCompatible('1.2', '1.0').compatible, true)
    assert.equal(isApiCompatible('1.0', '1.5').compatible, true)
  })

  it('isApiCompatible: missing/invalid version is incompatible (legacy)', () => {
    const r = isApiCompatible(undefined, '0.9')
    assert.equal(r.compatible, false)
    assert.match(r.reason, /unversioned/)
  })

  // ── Manifest validation (P1) ─────────────────────────────────────────────

  it('validatePluginManifest warns on incompatible apiVersion', () => {
    const warns = captureWarns(() => validatePluginManifest('demo', { apiVersion: '0.8' }))
    assert.ok(warns.some((w) => /API version incompatibility/.test(w)))
    assert.ok(warns.some((w) => /demo/.test(w)))
  })

  it('validatePluginManifest does not warn for a compatible manifest', () => {
    const warns = captureWarns(() =>
      validatePluginManifest('demo', { apiVersion: '0.9', extensionPoints: ['host.on', 'host.emit'] }),
    )
    assert.equal(warns.length, 0)
  })

  it('validatePluginManifest warns on a phantom host extension point', () => {
    const warns = captureWarns(() =>
      validatePluginManifest('demo', { apiVersion: '0.9', extensionPoints: ['host.totallyMadeUp'] }),
    )
    assert.ok(warns.some((w) => /unknown extension point "host.totallyMadeUp"/.test(w)))
  })

  it('validatePluginManifest accepts host.registerWebSocket (real, not phantom)', () => {
    const warns = captureWarns(() =>
      validatePluginManifest('fleet-term', { apiVersion: '0.9', extensionPoints: ['host.registerWebSocket'] }),
    )
    assert.equal(warns.length, 0)
  })

  it('validatePluginManifest does not warn on ui.* points (validated client-side)', () => {
    const warns = captureWarns(() =>
      validatePluginManifest('demo', { apiVersion: '0.9', extensionPoints: ['ui.registerPanel', 'ui.registerSetting'] }),
    )
    assert.equal(warns.length, 0)
  })

  it('loadPlugins still loads a plugin whose apiVersion is incompatible (advisory)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-ver-'))
    try {
      mkdirSync(join(dir, 'badver'))
      writeFileSync(join(dir, 'badver', 'plugin.json'), JSON.stringify({
        name: 'badver', version: '1.0.0', apiVersion: '2.0', enabledByDefault: true,
        extensionPoints: ['host.on'],
      }))
      writeFileSync(join(dir, 'badver', 'server.js'),
        'export function register(host) { host._badVerLoaded = true }')
      const loaded = await loadPlugins(host, { pluginsDir: dir })
      assert.ok(loaded.includes('badver'))
      assert.equal(host._badVerLoaded, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadPlugins warns on a phantom extension point during load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-phantom-'))
    try {
      mkdirSync(join(dir, 'phantom'))
      writeFileSync(join(dir, 'phantom', 'plugin.json'), JSON.stringify({
        name: 'phantom', version: '1.0.0', apiVersion: '0.9', enabledByDefault: true,
        extensionPoints: ['host.on', 'host.doesNotExist'],
      }))
      writeFileSync(join(dir, 'phantom', 'server.js'),
        'export function register(host) {}')
      const warns = await captureWarns(async () => { await loadPlugins(host, { pluginsDir: dir }) })
      assert.ok(warns.some((w) => /unknown extension point "host.doesNotExist"/.test(w)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── discoverPlugins metadata (P1) ─────────────────────────────────────────

  it('discoverPlugins returns apiVersion, extensionPoints, and status', async () => {
    host.reportStatus('ok', 'healthy', { plugin: 'tts' })
    store.setSetting('plugin_tts_enabled', true)
    const plugins = await discoverPlugins(host, { pluginsDir: new URL('../../plugins', import.meta.url).pathname })
    const tts = plugins.find((p) => p.name === 'tts')
    assert.ok(tts, 'tts discovered')
    assert.equal(tts.apiVersion, '0.9')
    assert.ok(Array.isArray(tts.extensionPoints))
    assert.ok(tts.extensionPoints.includes('host.on'))
    assert.ok(tts.status, 'status merged from reportStatus')
    assert.equal(tts.status.level, 'ok')
    assert.equal(tts.status.message, 'healthy')
  })

  it('discoverPlugins returns null status for a plugin that never reported', async () => {
    const plugins = await discoverPlugins(host, { pluginsDir: new URL('../../plugins', import.meta.url).pathname })
    const fleet = plugins.find((p) => p.name === 'fleet-term')
    assert.ok(fleet)
    assert.equal(fleet.status, null)
  })
})

/**
 * Run `fn` while capturing console.warn output into a string array. Works for
 * both sync and async fn (awaits a returned promise). Restores console.warn in
 * a finally so a throw cannot leak the spy.
 */
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
