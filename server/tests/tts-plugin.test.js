/**
 * Tests for the TTS plugin server-side extraction logic.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createPluginHost } from '../plugin-host.js'
import { createStore } from '../store.js'

describe('tts-plugin', () => {
  let app
  let store
  let host
  const notifyMessages = []

  beforeEach(() => {
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    notifyMessages.length = 0
    host = createPluginHost({ app, store, broadcastNotify: (msg) => notifyMessages.push(msg) })
  })

  it('extracts [TTS_START]...[TTS_END] from agent output and broadcasts enqueue', async () => {
    const mod = await import('../../plugins/tts/server.js')
    mod.register(host)

    host.emit('agent:output', 'some prefix [TTS_START]hello world[TTS_END] suffix')

    // Wait for debounce flush.
    await new Promise((r) => setTimeout(r, 1800))

    assert.equal(notifyMessages.length, 1)
    assert.equal(notifyMessages[0].type, 'plugin:tts:enqueue')
    assert.equal(notifyMessages[0].text, 'hello world')
  })

  it('deduplicates repeated TTS text', async () => {
    const mod = await import('../../plugins/tts/server.js')
    mod.register(host)

    host.emit('agent:output', '[TTS_START]repeat me[TTS_END]')
    await new Promise((r) => setTimeout(r, 1800))
    const firstCount = notifyMessages.length

    host.emit('agent:output', '[TTS_START]repeat me[TTS_END]')
    await new Promise((r) => setTimeout(r, 1800))

    assert.equal(notifyMessages.length, firstCount)
  })

  it('registers the /api/tts proxy route', async () => {
    const mod = await import('../../plugins/tts/server.js')
    mod.register(host)

    const routes = app._router.stack
      .filter((layer) => layer.route)
      .map((layer) => Object.keys(layer.route.methods)[0].toUpperCase() + ' ' + layer.route.path)
    assert.ok(routes.some((r) => r === 'POST /api/tts'))
    assert.ok(routes.some((r) => r === 'GET /api/tts/stream'))
    assert.ok(routes.some((r) => r === 'POST /api/tts/voice'))
    assert.ok(routes.some((r) => r === 'GET /api/tts/status'))
  })
})
