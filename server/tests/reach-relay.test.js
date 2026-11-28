/**
 * tools/reach/relay-forward.mjs + where-server.mjs — the two relay-side
 * services, on real loopback sockets.
 */
import { describe, it } from 'node:test'
import { setupSuite } from './fixtures/suite-hooks.mjs'

import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createForwarder, parseHostPort } from '../../tools/reach/relay-forward.mjs'
import { createWhereServer } from '../../tools/reach/where-server.mjs'

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const close = (server) => new Promise((r) => server.close(() => r()))

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('relay forwarder', () => {
  it('parses host:port and rejects junk', () => {
    assert.deepEqual(parseHostPort('0.0.0.0:9475'), { host: '0.0.0.0', port: 9475 })
    assert.deepEqual(parseHostPort('[::1]:80'), { host: '::1', port: 80 })
    assert.throws(() => parseHostPort('9475'))
    assert.throws(() => parseHostPort('h:70000'))
  })

  it('pipes HTTP through to the upstream while it is up', async () => {
    const upstream = http.createServer((req, res) => res.end(`upstream saw ${req.url}`))
    const upPort = await listen(upstream)
    const fwd = createForwarder({ upstream: { host: '127.0.0.1', port: upPort }, log: () => {} })
    const port = await listen(fwd)
    try {
      const r = await get(port, '/api/health')
      assert.equal(r.status, 200)
      assert.equal(r.body, 'upstream saw /api/health')
    } finally {
      await close(fwd)
      await close(upstream)
    }
  })

  it('upstream down (tunnel gone): the client connection is closed at once, not left hanging', async () => {
    const probe = net.createServer()
    const deadPort = await listen(probe)
    await close(probe)  // nothing listens there now
    const fwd = createForwarder({ upstream: { host: '127.0.0.1', port: deadPort }, log: () => {} })
    const port = await listen(fwd)
    try {
      const t0 = Date.now()
      await assert.rejects(get(port, '/'), /socket hang up|ECONNRESET/)
      assert.ok(Date.now() - t0 < 2000)
    } finally {
      await close(fwd)
    }
  })
})

describe('where.json server', () => {
  let dir
  let server
  let port
  setupSuite(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reach-www-'))
    mkdirSync(join(dir, 'js'))
    writeFileSync(join(dir, 'offline.html'), '<title>find</title>')
    writeFileSync(join(dir, 'js', 'reach-finder.js'), '/*finder*/')
    writeFileSync(join(dir, 'secret.txt'), 'no')
    server = createWhereServer({ www: dir })
    port = await listen(server)
  },
  async () => { if (server) await close(server) },
  () => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('no where.json yet → 404 (never an invented one)', async () => {
    const r = await get(port, '/where.json')
    assert.equal(r.status, 404)
  })

  it('serves where.json fresh on every request, CORS-open, never cached', async () => {
    writeFileSync(join(dir, 'where.json'), '{"v":1}')
    const r1 = await get(port, '/where.json')
    assert.equal(r1.status, 200)
    assert.equal(r1.body, '{"v":1}')
    assert.equal(r1.headers['access-control-allow-origin'], '*')
    assert.equal(r1.headers['cache-control'], 'no-store')
    assert.match(r1.headers['content-type'], /application\/json/)
    writeFileSync(join(dir, 'where.json'), '{"v":2}')
    assert.equal((await get(port, '/where.json')).body, '{"v":2}')
  })

  it('serves the finder page at / and its script; nothing else in the directory', async () => {
    assert.equal((await get(port, '/')).body, '<title>find</title>')
    assert.equal((await get(port, '/js/reach-finder.js')).body, '/*finder*/')
    assert.equal((await get(port, '/secret.txt')).status, 404)
    assert.equal((await get(port, '/../secret.txt')).status, 404)
    assert.equal((await get(port, '/where.json', 'POST')).status, 405)
    assert.equal((await get(port, '/where.json', 'OPTIONS')).status, 204)
  })
})
