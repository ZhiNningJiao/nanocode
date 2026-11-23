/*
 * Nanocode service worker — only what an installable desktop / home-screen app
 * needs (PWA, owner 11-22): the page shell opens offline with a clear
 * "server unreachable" state instead of the browser's error page.
 *
 * Network first, always: the server's cache-busting (index.html ?v=<sha>)
 * stays in charge; a cached copy is used only when the network fails. API,
 * WebSocket and non-GET requests are never touched.
 *
 * Token auth: /login is never intercepted, and only a real 200 for "/" (not a
 * redirect to /login) may become the cached shell — the login page must never
 * be served offline as the app.
 *
 * Offline page (tools/reach/): a navigation that fails on the network gets
 * /offline.html, which reads the relays' where.json and lists the entries that
 * answer right now. It needs the relays' where.json URLs; those come from
 * /api/reach (behind the same auth as every API) after each successful load of
 * the app shell, and are kept under the synthetic key /offline-reach.json —
 * only a 200 JSON body with a `where` list is kept, never the API response
 * itself, a 401, or a redirect to a login page.
 */
const SHELL_CACHE = 'nanocode-shell-v2'
const OFFLINE_PAGE = '/offline.html'
const OFFLINE_KIT = [OFFLINE_PAGE, '/js/reach-finder.js']
const REACH_KEY = '/offline-reach.json'

async function refreshOfflineKit() {
  const cache = await caches.open(SHELL_CACHE)
  await Promise.all(OFFLINE_KIT.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (res.ok && !res.redirected) await cache.put(url, res)
    } catch { /* offline: keep what we have */ }
  }))
}

async function refreshReach() {
  try {
    const res = await fetch('/api/reach', { cache: 'no-store', credentials: 'same-origin' })
    if (!res.ok || res.redirected || !(res.headers.get('content-type') || '').includes('application/json')) return
    const body = await res.json()
    if (!Array.isArray(body?.where)) return
    const where = body.where.filter((u) => typeof u === 'string')
    const cache = await caches.open(SHELL_CACHE)
    await cache.put(REACH_KEY, new Response(JSON.stringify({ where }), { headers: { 'Content-Type': 'application/json' } }))
  } catch { /* offline or not JSON: keep the last good list */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(refreshOfflineKit().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL_CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname === '/login') return
  if (url.pathname === REACH_KEY) {
    event.respondWith(caches.match(REACH_KEY).then((hit) => hit || new Response('{"where":[]}', { status: 404, headers: { 'Content-Type': 'application/json' } })))
    return
  }
  event.respondWith((async () => {
    try {
      const res = await fetch(req)
      const isShell = req.mode === 'navigate' && url.pathname === '/' && !res.redirected
      if (res.ok && (isShell || /\.(css|js|svg|png|woff2?)$/.test(url.pathname))) {
        const copy = res.clone()
        caches.open(SHELL_CACHE).then((c) => c.put(isShell ? '/' : req, copy)).catch(() => {})
      }
      if (res.ok && isShell) event.waitUntil(Promise.all([refreshReach(), refreshOfflineKit()]))
      return res
    } catch (err) {
      const hit = req.mode === 'navigate'
        ? (await caches.match(OFFLINE_PAGE)) || (await caches.match('/'))
        : await caches.match(req)
      if (hit) return hit
      throw err
    }
  })())
})
