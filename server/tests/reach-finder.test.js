/**
 * public/js/reach-finder.js — the offline page's lookup: read the relays'
 * where.json, probe every known entry, list the reachable ones.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', 'reach-finder.js'), 'utf8')

function loadFinder() {
  const ctx = { URL, AbortController, setTimeout, clearTimeout, Promise, JSON }
  ctx.globalThis = ctx
  vm.runInNewContext(SRC, ctx)
  // Results are re-made as this realm's plain objects (vm arrays have another
  // Array.prototype, which deepStrictEqual rejects).
  const plain = (x) => JSON.parse(JSON.stringify(x))
  const R = ctx.NanocodeReach
  return { findEntries: async (o) => plain(await R.findEntries(o)), validWhere: (d) => plain(R.validWhere(d)) }
}

const WHERE = {
  schema: 'nanocode-reach/v1',
  direct: 'http://192.0.2.99:9475',
  relays: [{ name: 'a', url: 'http://relay-a.example:9475' }, { name: 'b', url: 'http://relay-b.example:9475' }],
  where: ['http://relay-a.example:9495/where.json', 'http://relay-b.example:9495/where.json'],
  updated_at: '2026-01-02T05:00:00.000Z',
}

/** Fake network: `docs` url → where.json body (or undefined = unreachable); `up` = set of reachable origins. */
function net({ docs = {}, up = [] }) {
  return async (url) => {
    const u = new URL(url)
    if (u.pathname === '/api/health') {
      if (up.includes(u.origin)) return new Response('', { status: 200 })
      throw new TypeError('Failed to fetch')
    }
    if (url in docs) return new Response(JSON.stringify(docs[url]), { status: 200 })
    throw new TypeError('Failed to fetch')
  }
}

describe('reach finder (offline page)', () => {
  const R = loadFinder()

  it('relay a is down: reads where.json from relay b and lists relay b + the direct address as reachable', async () => {
    const r = await R.findEntries({
      fetch: net({ docs: { [WHERE.where[1]]: WHERE }, up: ['http://relay-b.example:9475', 'http://192.0.2.99:9475'] }),
      whereUrls: WHERE.where,
    })
    assert.equal(r.stale, false)
    assert.deepEqual(r.sources.map((s) => s.ok), [false, true])
    assert.deepEqual(
      r.entries.map((e) => [e.url, e.reachable]),
      [['http://relay-a.example:9475', false], ['http://relay-b.example:9475', true], ['http://192.0.2.99:9475', true]],
    )
  })

  it('two answers: the newer address book wins', async () => {
    const older = { ...WHERE, direct: 'http://192.0.2.7:9475', updated_at: '2026-01-01T00:00:00.000Z' }
    const r = await R.findEntries({ fetch: net({ docs: { [WHERE.where[0]]: older, [WHERE.where[1]]: WHERE } }), whereUrls: WHERE.where })
    assert.equal(r.doc.direct, 'http://192.0.2.99:9475')
  })

  it('no where.json readable and nothing remembered: no entries, no invented address', async () => {
    const r = await R.findEntries({ fetch: net({}), whereUrls: WHERE.where })
    assert.equal(r.doc, null)
    assert.deepEqual(r.entries, [])
    assert.deepEqual(r.sources.map((s) => s.ok), [false, false])
  })

  it('no where.json readable: falls back to the last remembered address book, marked stale', async () => {
    const r = await R.findEntries({ fetch: net({ up: ['http://relay-b.example:9475'] }), whereUrls: WHERE.where, stored: WHERE })
    assert.equal(r.stale, true)
    assert.deepEqual(r.entries.filter((e) => e.reachable).map((e) => e.url), ['http://relay-b.example:9475'])
  })

  it('a hanging fetch times out instead of blocking the page', async () => {
    const hang = () => new Promise(() => {})
    const t0 = Date.now()
    const r = await R.findEntries({ fetch: hang, whereUrls: WHERE.where, timeoutMs: 50 })
    assert.equal(r.doc, null)
    assert.ok(Date.now() - t0 < 2000)
  })

  it('never links anything but http(s), and rejects a foreign schema', async () => {
    const evil = { ...WHERE, direct: 'javascript:alert(1)', relays: [{ name: 'x', url: 'javascript:alert(2)' }, { name: 'b', url: 'http://relay-b.example:9475' }] }
    const r = await R.findEntries({ fetch: net({ docs: { [WHERE.where[0]]: evil } }), whereUrls: [WHERE.where[0]] })
    assert.deepEqual(r.entries.map((e) => e.url), ['http://relay-b.example:9475'])
    assert.equal(R.validWhere({ ...WHERE, schema: 'other/v1' }), null)
  })
})
