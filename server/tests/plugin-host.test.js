/**
 * Tests for the server plugin host.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createPluginHost, loadPlugins } from '../plugin-host.js'
import { createStore } from '../store.js'

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
})
