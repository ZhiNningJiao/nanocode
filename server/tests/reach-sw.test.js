/**
 * public/sw.js — offline page + relay list caching. The worker script runs in
 * a vm context with a fake `self`, Cache Storage and network.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SW_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'sw.js'), 'utf8')
const ORIGIN = 'https://relay-a.example:9475'

function html(body, init = {}) {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' }, ...init })
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}
/** A Response whose `redirected` flag is set (fetch followed a 302). */
function redirected(res) {
  Object.defineProperty(res, 'redirected', { value: true })
  return res
}

function makeWorker(network) {
  const store = new Map()  // cacheName -> Map(url -> Response)
  const key = (k) => new URL(typeof k === 'string' ? k : k.url, ORIGIN).href
  const openCache = (name) => {
    if (!store.has(name)) store.set(name, new Map())
    const m = store.get(name)
    return {
      put: async (k, res) => { m.set(key(k), res) },
      match: async (k) => m.get(key(k))?.clone(),
    }
  }
  const caches = {
    open: async (name) => openCache(name),
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (k) => {
      for (const m of store.values()) if (m.has(key(k))) return m.get(key(k)).clone()
      return undefined
    },
  }
  const handlers = {}
  const self = {
    location: new URL(ORIGIN + '/sw.js'),
    addEventListener: (type, fn) => { handlers[type] = fn },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  const fetchLog = []
  const fetchFn = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN)
    fetchLog.push(url.pathname)
    return network(url, init)
  }
  vm.runInNewContext(SW_SRC, { self, caches, fetch: fetchFn, Response, URL, Promise, JSON, Array })
  const pending = []
  const ev = (extra) => ({ ...extra, waitUntil: (p) => pending.push(p) })
  return {
    store, fetchLog,
    async install() { const e = ev({}); handlers.install(e); await Promise.all(pending) },
    async activate() { const e = ev({}); handlers.activate(e); await Promise.all(pending) },
    /** Dispatch a fetch event; resolves the response, undefined (not intercepted), or rejects. */
    async request(path, { mode = 'navigate', method = 'GET' } = {}) {
      let responded = null
      const e = ev({ request: { url: ORIGIN + path, method, mode }, respondWith: (p) => { responded = p } })
      handlers.fetch(e)
      if (!responded) return undefined
      const res = await responded
      await Promise.all(pending)
      await new Promise((r) => setTimeout(r, 0))  // let fire-and-forget cache puts land
      return res
    },
    cached: (path) => store.get('nanocode-shell-v2')?.get(new URL(path, ORIGIN).href),
  }
}

const OFFLINE_HTML = '<title>Nanocode 连不上 — 找入口</title>'

/** Online network: app shell, offline kit, /api/reach. */
function online({ reach = () => json({ where: ['https://relay-b.example:9495/where.json'] }), root = () => html('<title>app</title>') } = {}) {
  return (url) => {
    if (url.pathname === '/') return root()
    if (url.pathname === '/offline.html') return html(OFFLINE_HTML)
    if (url.pathname === '/js/reach-finder.js') return new Response('/*finder*/', { headers: { 'Content-Type': 'text/javascript' } })
    if (url.pathname === '/api/reach') return reach()
    return new Response('nf', { status: 404 })
  }
}
const offline = () => { throw new TypeError('Failed to fetch') }

describe('service worker offline page (reach)', () => {
  it('install precaches the offline page and its script', async () => {
    const w = makeWorker(online())
    await w.install()
    assert.ok(w.cached('/offline.html'))
    assert.ok(w.cached('/js/reach-finder.js'))
  })

  it('a navigation that fails on the network gets the cached offline page', async () => {
    let net = online()
    const w = makeWorker((u, i) => net(u, i))
    await w.install()
    net = offline
    const res = await w.request('/')
    assert.equal(await res.text(), OFFLINE_HTML)
    const deep = await w.request('/some/deep/link')
    assert.equal(await deep.text(), OFFLINE_HTML)
  })

  it('a successful shell load caches the relay list from /api/reach; the offline page reads it at /offline-reach.json', async () => {
    let net = online()
    const w = makeWorker((u, i) => net(u, i))
    await w.install()
    await w.request('/')
    assert.ok(w.fetchLog.includes('/api/reach'))
    net = offline
    const res = await w.request('/offline-reach.json', { mode: 'cors' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { where: ['https://relay-b.example:9495/where.json'] })
  })

  it('no relay list cached yet → /offline-reach.json is a 404 with an empty list (no network call)', async () => {
    const w = makeWorker(online())
    const res = await w.request('/offline-reach.json', { mode: 'cors' })
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { where: [] })
    assert.ok(!w.fetchLog.includes('/offline-reach.json'))
  })

  it('a 401 from /api/reach is never cached and keeps the previous good list', async () => {
    let reach = () => json({ where: ['https://relay-b.example:9495/where.json'] })
    const w = makeWorker(online({ reach: () => reach() }))
    await w.request('/')
    // where-shaped on purpose: only the status check may keep it out
    reach = () => json({ where: ['https://evil.example/where.json'] }, 401)
    await w.request('/')
    const res = await w.request('/offline-reach.json', { mode: 'cors' })
    assert.deepEqual(await res.json(), { where: ['https://relay-b.example:9495/where.json'] })
  })

  it('a login page (redirected navigation or redirected /api/reach) is never cached as the shell or the list', async () => {
    const login = () => redirected(html('<title>login</title>'))
    const w = makeWorker(online({ root: login, reach: () => redirected(json({ where: ['https://evil.example/where.json'] })) }))
    await w.request('/')
    assert.equal(w.cached('/'), undefined)
    assert.equal(w.cached('/offline-reach.json'), undefined)
  })

  it('API, WebSocket and non-GET requests are never intercepted (so never cached)', async () => {
    const w = makeWorker(online())
    assert.equal(await w.request('/api/reach', { mode: 'cors' }), undefined)
    assert.equal(await w.request('/ws/terminal', { mode: 'cors' }), undefined)
    assert.equal(await w.request('/', { method: 'POST' }), undefined)
    for (const k of w.store.get('nanocode-shell-v2')?.keys() || []) assert.ok(!new URL(k).pathname.startsWith('/api/'), k)
  })

  it('offline with nothing cached: the navigation fails like before (no fake page)', async () => {
    const w = makeWorker(offline)
    await assert.rejects(w.request('/'), /Failed to fetch/)
  })
})
