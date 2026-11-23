/**
 * Token auth — the ONE trust rule shared by HTTP routes, WebSocket upgrades
 * and the localhost-only endpoints (terminal/routes.js).
 *
 *   main port, loopback source       → trusted, no token (local scripts:
 *                                      waker, inject, export, self-check)
 *   main port, non-loopback source   → token required (LAN via port forward)
 *   remote entry port (any source)   → token required, ALWAYS — an ssh
 *                                      reverse tunnel arrives from 127.0.0.1,
 *                                      so the source address proves nothing
 *   token not configured             → every request that needs a token is
 *                                      refused (403 token_not_configured):
 *                                      no token means no remote access, never
 *                                      "auth disabled"
 *
 * A token is accepted from the `X-Nanocode-Token` header, the `?token=` query
 * param, or the login cookie. The cookie never holds the token itself: it holds
 * HMAC(token), so rotating the token invalidates every issued cookie.
 *
 * The remote entry is a second listener on the same app (NANOCODE_REMOTE_PORT,
 * bound to 127.0.0.1); its sockets are tagged with markRemoteEntrySocket() on
 * 'connection', which is what isRemoteEntry() reads.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const AUTH_SETTING_KEY = 'nanocode_auth_token'
export const AUTH_COOKIE = 'nanocode_auth'
export const AUTH_COOKIE_MAX_AGE_SEC = 180 * 24 * 3600
export const LOGIN_PATH = '/login'
export const LOGIN_API_PATH = '/api/login'
export const MIN_TOKEN_LENGTH = 32

const REMOTE_ENTRY = Symbol('nanocode.remoteEntry')
const COOKIE_HMAC_LABEL = 'nanocode-auth-cookie-v1'
// Paths reachable without a token (static assets are served before the gate).
const PUBLIC_PATHS = new Set(['/api/health', LOGIN_PATH, LOGIN_API_PATH])

export function markRemoteEntrySocket(socket) {
  socket[REMOTE_ENTRY] = true
}

export function isRemoteEntry(req) {
  return req?.socket?.[REMOTE_ENTRY] === true
}

export function isLoopbackAddress(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/** Loopback source on the main port — the only origin trusted without a token. */
export function isLocalOrigin(req) {
  return !isRemoteEntry(req) && isLoopbackAddress(req?.socket?.remoteAddress || '')
}

export function cookieValueForToken(token) {
  return createHmac('sha256', token).update(COOKIE_HMAC_LABEL).digest('base64url')
}

/** Constant-time string compare; hashing first makes unequal lengths safe too. */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim()
  }
  return out
}

function requestUrl(req) {
  return new URL(req.originalUrl || req.url || '/', 'http://nanocode.invalid')
}

/**
 * Decide one request (HTTP or WebSocket upgrade). Pure apart from reading
 * req; `token` is the configured token ('' = not configured).
 * → { ok: true, via } | { ok: false, status, code, error }
 */
export function authorizeRequest(req, token) {
  if (isLocalOrigin(req)) return { ok: true, via: 'local' }
  if (!token) {
    return {
      ok: false,
      status: 403,
      code: 'token_not_configured',
      error: '未配置令牌：远程访问已关闭。请在本机运行 tools/set-auth-token.mjs 设置令牌。',
    }
  }
  const header = req.headers?.['x-nanocode-token']
  if (typeof header === 'string' && header && safeEqual(header, token)) return { ok: true, via: 'header' }
  const query = requestUrl(req).searchParams.get('token')
  if (query && safeEqual(query, token)) return { ok: true, via: 'query' }
  const cookie = parseCookies(req.headers?.cookie)[AUTH_COOKIE]
  if (cookie && safeEqual(cookie, cookieValueForToken(token))) return { ok: true, via: 'cookie' }
  return { ok: false, status: 401, code: 'unauthorized', error: '未授权：缺少或错误的令牌' }
}

function wantsHtml(req) {
  return req.method === 'GET' && !requestUrl(req).pathname.startsWith('/api/') &&
    /text\/html/.test(String(req.headers?.accept || ''))
}

/**
 * @param {object} opts
 * @param {() => string} opts.getToken  current configured token ('' = none)
 * @param {(token: string) => void} [opts.setToken]  persist a new token
 * @param {number} [opts.loginMaxPerWindow=10]
 * @param {number} [opts.loginWindowMs=60000]
 * @param {() => number} [opts.now]
 */
export function createTokenAuth({ getToken, setToken, loginMaxPerWindow = 10, loginWindowMs = 60_000, now = Date.now }) {
  const currentToken = () => String(getToken() || '')

  /** Express middleware; mount after static assets so they stay public. */
  function httpGate(req, res, next) {
    if (PUBLIC_PATHS.has(req.path)) return next()
    const decision = authorizeRequest(req, currentToken())
    if (decision.ok) return next()
    if (decision.status === 401 && wantsHtml(req)) {
      const u = requestUrl(req)
      return res.redirect(302, `${LOGIN_PATH}?next=${encodeURIComponent(u.pathname + u.search)}`)
    }
    return res.status(decision.status).json({ error: decision.error, code: decision.code })
  }

  /** WebSocket upgrade check → same decision object as authorizeRequest. */
  function checkUpgrade(req) {
    return authorizeRequest(req, currentToken())
  }

  // Login rate limit: fixed window per (entry, source address). Behind the
  // tunnel every caller is 127.0.0.1, so remote-entry callers share a bucket.
  const attempts = new Map()
  function takeLoginAttempt(req) {
    const key = `${isRemoteEntry(req) ? 'remote' : 'main'}|${req.socket?.remoteAddress || ''}`
    const t = now()
    if (attempts.size > 1000) {
      for (const [k, v] of attempts) if (t - v.start >= loginWindowMs) attempts.delete(k)
    }
    let slot = attempts.get(key)
    if (!slot || t - slot.start >= loginWindowMs) {
      slot = { start: t, count: 0 }
      attempts.set(key, slot)
    }
    slot.count += 1
    return slot.count <= loginMaxPerWindow
  }

  /** POST /api/login { token } → sets the HMAC cookie on success. */
  function loginHandler(req, res) {
    if (!takeLoginAttempt(req)) {
      res.setHeader('Retry-After', String(Math.ceil(loginWindowMs / 1000)))
      return res.status(429).json({ error: '尝试过于频繁，请一分钟后再试', code: 'rate_limited' })
    }
    const token = currentToken()
    if (!token) {
      return res.status(403).json({
        error: '未配置令牌：远程访问已关闭。请在本机运行 tools/set-auth-token.mjs 设置令牌。',
        code: 'token_not_configured',
      })
    }
    const provided = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
    if (!provided || !safeEqual(provided, token)) {
      return res.status(401).json({ error: '令牌不正确', code: 'unauthorized' })
    }
    const attrs = [
      `${AUTH_COOKIE}=${cookieValueForToken(token)}`,
      'Path=/',
      `Max-Age=${AUTH_COOKIE_MAX_AGE_SEC}`,
      'HttpOnly',
      'SameSite=Lax',
    ]
    if (req.secure) attrs.push('Secure')
    res.setHeader('Set-Cookie', attrs.join('; '))
    res.setHeader('Cache-Control', 'no-store')
    return res.json({ ok: true })
  }

  /**
   * POST /api/auth/token { token } | { clear: true } — local origin only, even
   * with a valid token (tools/set-auth-token.mjs is the caller). Goes through
   * the running process because each process holds its settings in memory.
   * Clearing turns remote access off (everything non-local refused); it is the
   * step before rolling back to a build where an empty token meant "open".
   */
  function setTokenHandler(req, res) {
    if (!isLocalOrigin(req)) {
      return res.status(403).json({ error: 'forbidden: localhost only', code: 'local_only' })
    }
    if (req.body?.clear === true) {
      setToken('')
      return res.json({ ok: true, cleared: true })
    }
    const token = typeof req.body?.token === 'string' ? req.body.token : ''
    if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
      return res.status(400).json({ error: `token must be >= ${MIN_TOKEN_LENGTH} chars, no whitespace` })
    }
    setToken(token)
    return res.json({ ok: true, prefix: token.slice(0, 4) })
  }

  return { httpGate, checkUpgrade, loginHandler, setTokenHandler }
}
