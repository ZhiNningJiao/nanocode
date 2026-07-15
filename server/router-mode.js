/**
 * System-mode router.
 *
 * - Auth middleware on every HTTP request.
 * - /login (claim code → session cookie), /logout, /api/auth/whoami.
 * - All other paths proxy to the authenticated user's worker over a Unix socket.
 * - WS upgrade authenticates via the same cookie, then proxies to worker.
 * - A control Unix socket accepts worker registrations.
 *
 * Test-mode backdoors (NANOCODE_TEST_MODE=1):
 *   POST /__test__/issue-session       — mint a cookie without going through claims
 *   GET  /__test__/last-claim?uid=     — read the most-recent mint for a uid
 *   POST /__test__/mint-claim?uid=     — mint a fresh code for a uid
 *   GET  /__test__/issue-expired-claim?uid=  — mint then expire
 *   GET  /__test__/registry            — dump the worker registry
 *   POST /__test__/force-register      — direct registry.register() with arbitrary peerCredUid
 *
 * These endpoints only respond when NANOCODE_TEST_MODE=1.
 */

import express from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SessionStore } from './auth/session.js'
import { ClaimStore } from './auth/claim.js'
import { WorkerRegistry } from './auth/worker-registry.js'
import { createAuthMiddleware, authenticateWsUpgrade, parseCookie } from './middleware/auth.js'
import { startControlSocket } from './auth/control.js'
import { proxyHttp, proxyWsUpgrade } from './proxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const COOKIE_NAME = 'nano_sid'

export function startRouterMode({
  host = '0.0.0.0',
  port = 2333,
  sessionTtlMs,
  idleEvictMs = 7 * 24 * 60 * 60 * 1000, // workers idle-evict at 7d; sessions are 3d
  controlSockPath = '/run/nanocode/router.sock',
  // Default persistence path used by the systemd unit (StateDirectory=nanocode).
  // Set to null to disable persistence (tests + single-user mode).
  sessionStatePath = process.env.NANOCODE_STATE_DIR
    ? `${process.env.NANOCODE_STATE_DIR}/sessions.json`
    : '/var/lib/nanocode/sessions.json',
  testMode = process.env.NANOCODE_TEST_MODE === '1',
  testIdleEvictMs = Number(process.env.NANOCODE_TEST_IDLE_EVICT_MS) || undefined,
} = {}) {
  const sessions = new SessionStore({
    ttlMs: sessionTtlMs,
    path: testMode ? null : sessionStatePath,
  })
  const claims = new ClaimStore()
  const registry = new WorkerRegistry({ idleEvictMs: testIdleEvictMs || idleEvictMs })

  /** Last claim minted per uid (test-mode introspection). */
  const lastClaimByUid = new Map()
  const origMint = claims.mint.bind(claims)
  claims.mint = function ({ uid, username }) {
    const result = origMint({ uid, username })
    lastClaimByUid.set(uid, result)
    return result
  }

  const app = express()
  // NOTE: do NOT mount express.json() globally — the proxy needs the
  // body stream intact to re-pipe it to the user worker. Apply JSON
  // parsing only to the router-local endpoints below.
  const jsonParser = express.json({ limit: '1mb' })

  // Serve the akari-themed login page assets directly (bypass auth).
  app.use('/login.css', express.static(path.join(ROOT, 'public', 'style.css')))
  app.get('/login', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'login.html'))
  })

  // Public auth endpoints — must come BEFORE the auth middleware.
  app.post('/login', jsonParser, (req, res) => {
    const code = req.body?.code
    const consumed = claims.consume(code)
    if (!consumed) return res.status(401).json({ error: 'invalid or expired code' })
    const worker = registry.get(consumed.uid)
    if (!worker) return res.status(503).json({ error: 'worker not registered' })
    const { sid } = sessions.create({
      uid: consumed.uid,
      username: consumed.username,
      workerSock: worker.sock,
    })
    res.setHeader('set-cookie', cookieValue(sid))
    res.status(302).setHeader('location', '/').end()
  })

  app.post('/logout', (req, res) => {
    const sid = parseCookie(req.headers['cookie'])
    if (sid) sessions.revoke(sid)
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
    res.status(204).end()
  })

  // Test-mode backdoors
  if (testMode) {
    app.post('/__test__/issue-session', jsonParser, (req, res) => {
      const { uid, username, workerSock } = req.body || {}
      if (typeof uid !== 'number' || !username || !workerSock) {
        return res.status(400).json({ error: 'uid, username, workerSock required' })
      }
      // Forcibly register if missing (test convenience)
      if (!registry.has(uid)) {
        registry.register({ uid, sock: workerSock, peerCredUid: uid })
      }
      const { sid } = sessions.create({ uid, username, workerSock })
      res.json({ sid })
    })
    app.get('/__test__/last-claim', (req, res) => {
      const uid = Number(req.query.uid)
      const entry = lastClaimByUid.get(uid)
      if (!entry) return res.status(404).json({ error: 'no claim' })
      res.json({ code: entry.code, expiresAt: entry.expiresAt })
    })
    app.post('/__test__/mint-claim', (req, res) => {
      const uid = Number(req.query.uid)
      const worker = registry.get(uid)
      const username = req.query.username || (worker ? `u${uid}` : 'unknown')
      const { code, expiresAt } = claims.mint({ uid, username })
      res.json({ code, expiresAt })
    })
    app.get('/__test__/issue-expired-claim', (req, res) => {
      const uid = Number(req.query.uid)
      const { code } = claims.mint({ uid, username: `u${uid}` })
      // Expire it immediately
      claims._claims.get(code).expiresAt = 0
      res.json({ code })
    })
    app.get('/__test__/registry', (_req, res) => {
      res.json(registry.entries())
    })
    app.post('/__test__/force-register', jsonParser, (req, res) => {
      const { claimedUid, peerCredUid, sock } = req.body || {}
      const ok = registry.register({ uid: claimedUid, sock, peerCredUid })
      res.status(ok ? 200 : 403).json({ ok })
    })
  }

  // Health check is unauthenticated.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

  // Public-by-design assets — served by the router itself, BEFORE
  // auth, because the browser fetches them without credentials:
  //   - <link rel="manifest"> is no-cors per spec (no cookie sent)
  //   - <link rel="icon">  also no-cors
  //   - @font-face URLs skip cookies on cross-origin and some same-
  //     origin paths depending on the browser
  // Without this, those fetches hit the auth middleware, get 302 →
  // HTML body of /login, and the browser surfaces "Manifest: Syntax
  // error" / font-load failures / 502 in the console. These files
  // are intentionally public — none of them leak session state.
  const PUBLIC_DIR = path.join(ROOT, 'public')
  const publicAssetOpts = { maxAge: '7d', fallthrough: false }
  for (const file of ['manifest.json', 'favicon.svg', 'favicon.ico']) {
    app.get('/' + file, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file)))
  }
  app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts'), publicAssetOpts))

  // Auth middleware for everything else.
  const auth = createAuthMiddleware({
    sessionStore: sessions,
    bypass: ['/login', '/logout', '/api/health'],
  })
  app.use(auth)

  // Roll the browser-side cookie expiry forward on every authenticated
  // request. Without this the cookie is only Set-Cookie'd on /login and
  // its Max-Age ages out exactly N days after that login moment —
  // even if the user has been visiting daily and the server-side
  // session's expiresAt has been touched on every request. Refreshing
  // here keeps the cookie's Max-Age and the session's expiresAt
  // moving forward in lockstep.
  app.use((req, res, next) => {
    if (req.sid) res.setHeader('set-cookie', cookieValue(req.sid))
    next()
  })

  // /api/auth/whoami after auth
  app.get('/api/auth/whoami', (req, res) => {
    res.json({ uid: req.user.uid, username: req.user.username })
  })

  // Static client assets — served by the router directly, after auth,
  // BEFORE the worker proxy. Critical for resilience: when a worker
  // process is overloaded (e.g. PTYs streaming heavy TUI redraws),
  // its accept queue stalls and any proxied request gets 502. By
  // serving every static file from the router we keep the cold-load
  // shape (HTML, CSS, JS, vendor libs, fonts, images) decoupled from
  // worker health — a stuck worker no longer means "markdown lost"
  // or "xterm.js failed to load" or any other LCP-blocking 502.
  //
  // The worker only needs to handle /api/* and /ws/* from here on.
  const ASSET_DIR = path.join(ROOT, 'public')

  // One-shot HTTP-cache flush. Browsers that fetched assets during
  // the v1.3.4 window have them pinned with max-age=604800 (7 days)
  // and ignore the no-cache header on already-cached entries.
  // Clear-Site-Data: "cache" tells the browser to drop its HTTP
  // cache for this origin on the next response. Gated by a cookie
  // so each browser sees it exactly once — next load is fresh,
  // every subsequent load is normal. Only fires on the index.html
  // load (else we'd loop the bust on every asset fetch).
  // Cookie name bumped (v2 → v3) because some browsers ignored the
  // no-cache header on assets pinned before the v2 flush — re-firing
  // Clear-Site-Data once on the next page load gives every browser
  // a clean slate for the v1.3.0 mobile-composer fixes.
  const CACHE_BUST_COOKIE = 'nano_cache_bust_v8'
  // Fire on any URL that LOOKS like an HTML page — not just `/`. SPA
  // deep-links such as /local/<projectId> are how users actually open
  // nanocode; restricting the bust to `/` left those users stranded on
  // pre-fix CSS forever. Asset URLs (.css/.js/.woff2/etc.) are skipped
  // so Clear-Site-Data fires at most once per page load.
  const ASSET_EXT_RE = /\.(css|js|mjs|json|map|svg|ico|png|jpg|jpeg|gif|webp|avif|woff2?|ttf|otf|eot|wasm|mp3|wav|webmanifest)$/i
  app.use((req, res, next) => {
    const urlPath = (req.url || '').split('?')[0]
    if (ASSET_EXT_RE.test(urlPath)) return next()
    const cookies = String(req.headers['cookie'] || '')
    if (cookies.includes(`${CACHE_BUST_COOKIE}=1`)) return next()
    res.setHeader('Clear-Site-Data', '"cache"')
    const prior = res.getHeader('set-cookie')
    const priorArr = Array.isArray(prior) ? prior : prior ? [prior] : []
    res.setHeader('set-cookie', [
      ...priorArr,
      `${CACHE_BUST_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`,
    ])
    next()
  })

  // App code (/js/*, /style.css, /index.html) must NEVER be served from
  // the browser cache while we're iterating on mobile-composer / xterm
  // fixes — `no-cache, must-revalidate` was supposed to force ETag
  // revalidation but at least one browser-cache layer in the user's
  // path keeps serving stale assets anyway. `no-store` is the nuclear
  // option: the browser is forbidden to cache the response at all,
  // each page load fetches fresh bytes. Cost is one extra network
  // round-trip per asset; over a fast tailnet it's measured in ms.
  // Once the UX is stable we can downgrade back to no-cache+ETag.
  app.use(express.static(ASSET_DIR, {
    etag: true,
    lastModified: true,
    cacheControl: true,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    },
  }))
  // Vendor libs (node_modules/* and public/vendor/*) are content-
  // versioned by package.json — no revalidation needed; cache hard.
  const VENDOR_MAP = {
    '/vendor/xterm': 'node_modules/@xterm/xterm',
    '/vendor/xterm-addon-fit': 'node_modules/@xterm/addon-fit',
    '/vendor/xterm-addon-web-links': 'node_modules/@xterm/addon-web-links',
    '/vendor/marked': 'node_modules/marked/lib',
    '/vendor/dompurify': 'node_modules/dompurify/dist',
    '/vendor/highlight': 'public/vendor/highlight',
    '/vendor/three': 'node_modules/three',
  }
  for (const [route, sub] of Object.entries(VENDOR_MAP)) {
    app.use(route, express.static(path.join(ROOT, sub), { maxAge: '365d', immutable: true }))
  }

  // All remaining traffic proxies to the user's worker.
  // Static files have been consumed above; only /api/*, dynamic routes
  // and anything not on disk reaches here.
  app.use((req, res) => {
    // Treat every proxied request as activity for the worker idle reaper,
    // so an in-use worker doesn't get evicted on a fixed wall-clock timer.
    registry.touch(req.user.uid)
    proxyHttp(req, res, req.user.workerSock, req.user)
  })

  const server = createServer(app)

  server.on('upgrade', (req, socket, head) => {
    const user = authenticateWsUpgrade(req, sessions)
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    registry.touch(user.uid)
    proxyWsUpgrade({ req, socket, head, workerSock: user.workerSock, user })
  })

  // Control socket for worker registration
  const controlPath = testMode && process.env.NANOCODE_TEST_SOCK_DIR
    ? path.join(process.env.NANOCODE_TEST_SOCK_DIR, 'router.sock')
    : controlSockPath
  const control = startControlSocket({ path: controlPath, registry, claimStore: claims })

  server.listen(port, host, () => {
    console.log(`Nanocode router (system mode) on http://${host}:${port}`)
    console.log(`  control socket: ${controlPath}`)
  })

  // Periodic reaper for expired sessions + idle workers. Run at
  // min(idleEvictMs / 4, 60s) so short test-mode timeouts work.
  const reaperInterval = Math.max(50, Math.min(60_000,
    (testIdleEvictMs || idleEvictMs || 60_000) / 4))
  const reaperTimer = setInterval(() => {
    sessions.reapExpired()
    const evicted = registry.reapIdle()
    if (evicted.length) {
      console.log(`[router] evicted idle workers: ${evicted.join(', ')}`)
      // Revoke any active sessions for evicted uids so subsequent requests
      // see 401 → user re-runs `nanocode login`.
      for (const uid of evicted) sessions.revokeAllForUid(uid)
    }
  }, reaperInterval).unref()

  return {
    server,
    sessions,
    claims,
    registry,
    close() {
      clearInterval(reaperTimer)
      server.close()
      control.close()
    },
  }
}

// Match the server-side session TTL (3 days). Without Max-Age the
// cookie is "session-scoped" — browsers (especially mobile ones)
// discard it on app close or under memory pressure. That makes the
// login feel transient even though the server-side session is still
// valid. With Max-Age the cookie persists across browser restarts
// until the server-side session also expires, and the rolling
// refresh middleware below keeps extending both in lockstep on
// every authenticated request.
//
// SameSite=Lax (not Strict):
// Strict makes the browser drop the cookie on ANY top-level
// navigation that originates from another site — opening a
// bookmark, clicking a nanocode link from Slack/email, even
// pasting a URL into a fresh tab in some browsers. The user
// then sees /login even though the cookie is still stored, and
// after they re-login the OLD cookie just gets overwritten by the
// new one. Lax keeps the same XSRF protection for cross-site POSTs
// but allows the cookie on top-level GET navigations, which is the
// behavior users intuitively expect.
//
// Note: not adding `Secure` because nanocode is reached over plain
// HTTP by default (port 2333). If you front it with TLS, append
// `Secure` here so the cookie is never sent in clear.
const COOKIE_MAX_AGE_S = 3 * 24 * 60 * 60

function cookieValue(sid) {
  return `${COOKIE_NAME}=${sid}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`
}
