/**
 * Tests for the fleet-term plugin server side.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { register } from '../../plugins/fleet-term/server.js'
import { createStore } from '../store.js'
import { createPluginHost } from '../plugin-host.js'

describe('fleet-term plugin', () => {
  let app
  let store
  let host
  let server
  let port

  beforeEach(async () => {
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    host = createPluginHost({ app, store, broadcastNotify: () => {} })
    await register(host)
    server = createServer(app)
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', (err) => {
        if (err) return reject(err)
        port = server.address().port
        resolve()
      })
    })
  })

  afterEach(async () => {
    host.emit('shutdown')
    await new Promise((resolve) => server.close(resolve))
  })

  it('registers the /api/fleet-term/sessions route', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/fleet-term/sessions`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.sessions))
  })

  it('registers a WebSocket handler for /ws/fleet-term', () => {
    const handler = host.getWebSocketHandler('/ws/fleet-term/loop-test')
    assert.ok(handler)
    assert.equal(handler.prefix, '/ws/fleet-term')
    assert.equal(typeof handler.handler, 'function')
  })
})
