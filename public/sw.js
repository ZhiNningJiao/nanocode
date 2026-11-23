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
 */
const SHELL_CACHE = 'nanocode-shell-v2'

self.addEventListener('install', () => self.skipWaiting())

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
  event.respondWith((async () => {
    try {
      const res = await fetch(req)
      const isShell = req.mode === 'navigate' && url.pathname === '/' && !res.redirected
      if (res.ok && (isShell || /\.(css|js|svg|png|woff2?)$/.test(url.pathname))) {
        const copy = res.clone()
        caches.open(SHELL_CACHE).then((c) => c.put(isShell ? '/' : req, copy)).catch(() => {})
      }
      return res
    } catch (err) {
      const hit = await caches.match(req.mode === 'navigate' ? '/' : req)
      if (hit) return hit
      throw err
    }
  })())
})
