import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { setNtfyStore, isNtfyConfigured, pushNtfyMessage } from '../qa-watcher.js'

function fakeStore(settings = {}) {
  return {
    getSetting: (k) => settings[k] ?? null,
    setSetting: (k, v) => { settings[k] = v },
  }
}

let _origFetch
let _fetchCalls
function mockFetch(handler) {
  _fetchCalls = []
  _origFetch = global.fetch
  global.fetch = async (url, opts) => {
    _fetchCalls.push({ url, opts })
    return handler(url, opts)
  }
}
function restoreFetch() {
  if (_origFetch) global.fetch = _origFetch
}

describe('qa-watcher ntfy AI-hook plumbing (MES-13740 需求13 Initialize + AI hook)', () => {
  beforeEach(() => { setNtfyStore(null); restoreFetch(); _fetchCalls = null })
  afterEach(() => { setNtfyStore(null); restoreFetch() })

  it('isNtfyConfigured() is false when store is null', () => {
    setNtfyStore(null)
    assert.equal(isNtfyConfigured(), false)
  })

  it('isNtfyConfigured() is false when url or topic missing', () => {
    setNtfyStore(fakeStore({ ntfy_url: 'http://host' }))
    assert.equal(isNtfyConfigured(), false)
    setNtfyStore(fakeStore({ ntfy_topic: 't' }))
    assert.equal(isNtfyConfigured(), false)
  })

  it('isNtfyConfigured() is true when both url+topic set', () => {
    setNtfyStore(fakeStore({ ntfy_url: 'http://host', ntfy_topic: 't' }))
    assert.equal(isNtfyConfigured(), true)
  })

  it('pushNtfyMessage returns not-configured and does NOT call fetch when unconfigured', async () => {
    let called = false
    mockFetch(() => { called = true; return { ok: true } })
    setNtfyStore(null)
    const r = await pushNtfyMessage({ message: 'hi' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /not-configured/)
    assert.equal(called, false, 'must not hit network when unconfigured')
    assert.equal(_fetchCalls.length, 0)
  })

  it('pushNtfyMessage posts to <base>/<topic> with Title/Priority/Tags headers and returns ok', async () => {
    mockFetch(async (url, opts) => {
      assert.equal(url, 'http://10.18.8.55/zhiningwork')
      assert.equal(opts.method, 'POST')
      assert.equal(opts.headers.Title, 'Nanocode AI')
      assert.equal(opts.headers.Priority, '3')
      assert.equal(opts.body, 'task done')
      return { ok: true, status: 200 }
    })
    setNtfyStore(fakeStore({ ntfy_url: 'http://10.18.8.55', ntfy_topic: 'zhiningwork' }))
    const r = await pushNtfyMessage({ message: 'task done', title: 'Nanocode AI', tags: ['robot', 'bell'] })
    assert.equal(r.ok, true)
    assert.equal(_fetchCalls.length, 1)
  })

  it('pushNtfyMessage strips trailing slash from base url', async () => {
    let seen
    mockFetch(async (url) => { seen = url; return { ok: true } })
    setNtfyStore(fakeStore({ ntfy_url: 'http://host/', ntfy_topic: 't' }))
    const r = await pushNtfyMessage({ message: 'm' })
    assert.equal(r.ok, true)
    assert.equal(seen, 'http://host/t')
  })

  it('pushNtfyMessage returns HTTP <status> reason when ntfy responds non-OK', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }))
    setNtfyStore(fakeStore({ ntfy_url: 'http://host', ntfy_topic: 't' }))
    const r = await pushNtfyMessage({ message: 'm' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /HTTP 500/)
  })

  it('pushNtfyMessage returns the error message when fetch throws', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED') })
    setNtfyStore(fakeStore({ ntfy_url: 'http://host', ntfy_topic: 't' }))
    const r = await pushNtfyMessage({ message: 'm' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /ECONNREFUSED/)
  })

  it('pushNtfyMessage defaults title to Nanocode + priority 3 when omitted', async () => {
    let opts
    mockFetch(async (_url, o) => { opts = o; return { ok: true } })
    setNtfyStore(fakeStore({ ntfy_url: 'http://host', ntfy_topic: 't' }))
    await pushNtfyMessage({ message: 'm' })
    assert.equal(opts.headers.Title, 'Nanocode')
    assert.equal(opts.headers.Priority, '3')
  })
})
