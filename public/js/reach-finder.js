/*
 * Reach finder — the logic behind public/offline.html ("nanocode is not
 * reachable here — where is it now?").
 *
 * Address book sources, tried together, newest valid one wins:
 *   - ./where.json, when this page is served by a relay's where-server;
 *   - the relays' where.json URLs the service worker cached from /api/reach
 *     while online (served by the SW at /offline-reach.json, never fetched
 *     from the network).
 * No source answers → the last good address book this browser saw
 * (localStorage), marked stale. Every entry in it (relay entries + the direct
 * LAN address) is probed with /api/health (no-cors: reachable = a response of
 * any kind) and listed with its result; only http(s) URLs are ever linked.
 *
 * Plain script (no module): the page loads it with <script src>, tests load
 * it into a vm context and call NanocodeReach.findEntries with fakes.
 */
(function (root) {
  'use strict'

  var SCHEMA = 'nanocode-reach/v1'
  var STORE_KEY = 'nanocode-reach-last'

  function httpUrl(s) {
    try {
      var u = new URL(String(s))
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href.replace(/\/$/, '') : ''
    } catch (_e) {
      return ''
    }
  }

  function validWhere(doc) {
    if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.relays)) return null
    return {
      direct: httpUrl(doc.direct),
      relays: doc.relays.map(function (r) { return { name: String((r && r.name) || ''), url: httpUrl(r && r.url) } })
        .filter(function (r) { return r.url }),
      where: Array.isArray(doc.where) ? doc.where.map(httpUrl).filter(Boolean) : [],
      updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : '',
    }
  }

  function withTimeout(fetchImpl, url, init, ms) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null
    var timer
    var t = new Promise(function (_r, reject) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); reject(new Error('timeout')) }, ms)
    })
    var opts = Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {})
    return Promise.race([fetchImpl(url, opts), t]).finally(function () { clearTimeout(timer) })
  }

  async function readJson(fetchImpl, url, ms) {
    try {
      var res = await withTimeout(fetchImpl, url, { cache: 'no-store' }, ms)
      if (!res.ok) return null
      return await res.json()
    } catch (_e) {
      return null
    }
  }

  async function probe(fetchImpl, url, ms) {
    try {
      await withTimeout(fetchImpl, url + '/api/health', { mode: 'no-cors', cache: 'no-store' }, ms)
      return true
    } catch (_e) {
      return false
    }
  }

  /**
   * @param {object} o
   * @param {Function} o.fetch
   * @param {string[]} o.whereUrls  where.json URLs to read (in order)
   * @param {object|null} [o.stored] last good address book (already parsed)
   * @param {number} [o.timeoutMs]
   * @returns {Promise<{doc, stale, sources, entries}>}
   */
  async function findEntries(o) {
    var ms = o.timeoutMs || 4000
    var urls = []
    ;(o.whereUrls || []).forEach(function (u) { if (u && urls.indexOf(u) < 0) urls.push(u) })
    var docs = await Promise.all(urls.map(function (u) { return readJson(o.fetch, u, ms).then(validWhere) }))
    var sources = urls.map(function (u, i) { return { url: u, ok: !!docs[i] } })
    var doc = null
    docs.forEach(function (d) { if (d && (!doc || d.updated_at > doc.updated_at)) doc = d })
    var stale = false
    if (!doc && o.stored) { doc = validWhere(o.stored); stale = !!doc }
    if (!doc) return { doc: null, stale: false, sources: sources, entries: [] }

    var cands = doc.relays.map(function (r) { return { label: '中转 ' + r.name, url: r.url } })
    if (doc.direct) cands.push({ label: '直连（局域网地址）', url: doc.direct })
    var seen = {}
    cands = cands.filter(function (c) { if (seen[c.url]) return false; seen[c.url] = 1; return true })
    var up = await Promise.all(cands.map(function (c) { return probe(o.fetch, c.url, ms) }))
    var entries = cands.map(function (c, i) { return { label: c.label, url: c.url, reachable: up[i] } })
    return { doc: doc, stale: stale, sources: sources, entries: entries }
  }

  // ── page rendering (browser only) ────────────────────────────────────────
  function el(tag, text, cls) {
    var e = document.createElement(tag)
    if (text) e.textContent = text
    if (cls) e.className = cls
    return e
  }

  async function render() {
    var list = document.getElementById('reach-list')
    var status = document.getElementById('reach-status')
    var whereUrls = [new URL('where.json', location.href).href]
    try {
      var cached = await fetch('/offline-reach.json', { cache: 'no-store' })
      if (cached.ok) {
        var j = await cached.json()
        if (j && Array.isArray(j.where)) whereUrls = whereUrls.concat(j.where)
      }
    } catch (_e) { /* not served by the SW here */ }
    var stored = null
    try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') } catch (_e) { stored = null }

    var r = await findEntries({ fetch: fetch.bind(root), whereUrls: whereUrls, stored: stored })
    if (r.doc && !r.stale) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({ schema: SCHEMA }, r.doc))) } catch (_e) { /* quota */ }
    }
    list.textContent = ''
    if (!r.doc) {
      status.textContent = '两台中转机的地址簿都读不到，这个浏览器也没有记过地址。等网络恢复后再试。'
      return
    }
    var ok = r.entries.filter(function (e) { return e.reachable })
    status.textContent = (ok.length ? '下面这些入口现在能连上，点一下就过去：' : '暂时一个入口都连不上，下面是已知的全部入口：') +
      (r.stale ? '（地址簿是这个浏览器上次记下的，可能已过期）' : '') +
      (r.doc.updated_at ? ' 地址簿更新于 ' + new Date(r.doc.updated_at).toLocaleString() : '')
    ;(ok.length ? ok : r.entries).forEach(function (e) {
      var li = el('li', '', e.reachable ? 'up' : 'down')
      var a = el('a', e.label + '：' + e.url)
      a.href = e.url
      li.appendChild(a)
      if (!e.reachable) li.appendChild(el('span', '（连不上）'))
      list.appendChild(li)
    })
  }

  root.NanocodeReach = { findEntries: findEntries, validWhere: validWhere, SCHEMA: SCHEMA }
  if (typeof document !== 'undefined' && document.getElementById('reach-list')) {
    var retry = document.getElementById('reach-retry')
    if (retry) retry.addEventListener('click', function () { render() })
    render()
  }
})(globalThis)
