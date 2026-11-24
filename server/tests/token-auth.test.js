/**
 * Token auth — the trust matrix for HTTP and WebSocket, the login
 * flow, and the real server/index.js wiring.
 *
 *   main port, loopback          → open, no token
 *   main port, non-loopback      → 401 without a token; header / query / cookie each pass
 *   remote entry, loopback       → 401 without a token (the tunnel case)
 *   token not configured         → non-loopback + remote entry refused (403)
 *   remote entry, cookie         → pass
 *
 * "Non-loopback" is a real TCP connection to this host's first non-internal
 * IPv4 address (the server sees that address as remoteAddress), plus pure
 * unit cases with an injected remoteAddress.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import WebSocket, { WebSocketServer } from 'ws'
import {
  AUTH_COOKIE,
  authorizeRequest,
  cookieValueForToken,
  createTokenAuth,
  isLocalOrigin,
  markRemoteEntrySocket,
  parseCookies,
  safeEqual,
} from '../token-auth.js'
import { clearAuthToken, parseArgs, setAuthToken } from '../../tools/set-auth-token.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TOKEN = 'T'.repeat(16) + 'synthetic-test-token-0123456789'

function nonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}
const LAN_IP = nonLoopbackIPv4()

function fakeReq({ ip = '127.0.0.1', remote = false, headers = {}, url = '/api/x' } = {}) {
  const socket = { remoteAddress: ip }
  if (remote) markRemoteEntrySocket(socket)
  return { socket, headers, url, originalUrl: url, method: 'GET' }
}

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)))
}

/** Upgrade outcome: 'open' or the HTTP status the server answered with. */
function wsOutcome(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate() })
    ws.on('error', (err) => resolve(`error:${err.message}`))
  })
}

// ─── Pure decision ──────────────────────────────────────────────────────────

describe('authorizeRequest (pure, injected remoteAddress)', () => {
  it('main port loopback needs no token, even with a token configured', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal(authorizeRequest(fakeReq({ ip }), TOKEN).ok, true, ip)
      assert.equal(authorizeRequest(fakeReq({ ip }), '').ok, true, ip)
    }
  })
  it('main port non-loopback: 401 without token; header / query / cookie each pass', () => {
    assert.equal(authorizeRequest(fakeReq({ ip: '203.0.113.7' }), TOKEN).status, 401)
    assert.equal(authorizeRequest(fakeReq({ ip: '203.0.113.7', headers: { 'x-nanocode-token': TOKEN } }), TOKEN).via, 'header')
    assert.equal(authorizeRequest(fakeReq({ ip: '203.0.113.7', url: `/api/x?token=${TOKEN}` }), TOKEN).via, 'query')
    const cookie = `a=b; ${AUTH_COOKIE}=${cookieValueForToken(TOKEN)}`
    assert.equal(authorizeRequest(fakeReq({ ip: '203.0.113.7', headers: { cookie } }), TOKEN).via, 'cookie')
  })
  it('wrong token / raw token in the cookie are rejected', () => {
    assert.equal(authorizeRequest(fakeReq({ ip: '203.0.113.7', headers: { 'x-nanocode-token': TOKEN + 'x' } }), TOKEN).status, 401)
    assert.equal(authorizeRequest(fakeReq({ ip: '203.0.113.7', headers: { cookie: `${AUTH_COOKIE}=${TOKEN}` } }), TOKEN).status, 401)
  })
  it('remote entry from loopback still needs the token', () => {
    assert.equal(authorizeRequest(fakeReq({ remote: true }), TOKEN).status, 401)
    assert.equal(authorizeRequest(fakeReq({ remote: true, headers: { 'x-nanocode-token': TOKEN } }), TOKEN).ok, true)
  })
  it('token not configured: non-loopback and remote entry are refused with token_not_configured', () => {
    for (const req of [fakeReq({ ip: '203.0.113.7' }), fakeReq({ remote: true }), fakeReq({ remote: true, headers: { 'x-nanocode-token': '' } })]) {
      const d = authorizeRequest(req, '')
      assert.equal(d.ok, false)
      assert.equal(d.status, 403)
      assert.equal(d.code, 'token_not_configured')
      assert.match(d.error, /未配置令牌/)
    }
  })
  it('isLocalOrigin (used by the localhost-only routes) excludes the remote entry', () => {
    assert.equal(isLocalOrigin(fakeReq()), true)
    assert.equal(isLocalOrigin(fakeReq({ remote: true })), false)
    assert.equal(isLocalOrigin(fakeReq({ ip: '203.0.113.7' })), false)
  })
  it('cookie value is HMAC(token): not the token, and changes when the token changes', () => {
    const v = cookieValueForToken(TOKEN)
    assert.notEqual(v, TOKEN)
    assert.ok(!v.includes(TOKEN.slice(0, 8)))
    assert.notEqual(cookieValueForToken(TOKEN + '2'), v)
  })
  it('safeEqual handles unequal lengths and is backed by crypto.timingSafeEqual', () => {
    assert.equal(safeEqual('abc', 'abc'), true)
    assert.equal(safeEqual('abc', 'abcd'), false)
    assert.equal(safeEqual('', 'a'), false)
    assert.match(readFileSync(path.join(REPO_ROOT, 'server', 'token-auth.js'), 'utf8'), /timingSafeEqual\(ha, hb\)/)
  })
  it('parseCookies keeps the first value of a repeated name', () => {
    assert.deepEqual(parseCookies('a=1; b=2; a=3'), { a: '1', b: '2' })
  })
})

// ─── Real sockets: module wired to a main + remote listener ─────────────────

describe('trust matrix over real sockets (HTTP + WebSocket)', () => {
  let token = TOKEN
  let clock = 0
  let mainServer, remoteServer, mainPort, remotePort
  before(async () => {
    const auth = createTokenAuth({ getToken: () => token, setToken: (t) => { token = t }, now: () => clock })
    const app = express()
    app.use(express.json())
    app.use(auth.httpGate)
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
    app.post('/api/login', auth.loginHandler)
    app.post('/api/auth/token', auth.setTokenHandler)
    app.get('/api/ping', (_req, res) => res.json({ ok: true }))
    app.get('/', (_req, res) => res.send('<html>shell</html>'))
    const wss = new WebSocketServer({ noServer: true })
    const onUpgrade = (req, socket, head) => {
      const d = auth.checkUpgrade(req)
      if (!d.ok) { socket.write(`HTTP/1.1 ${d.status} No\r\nConnection: close\r\n\r\n`); socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, () => {})
    }
    mainServer = createServer(app)
    mainServer.on('upgrade', onUpgrade)
    remoteServer = createServer(app)
    remoteServer.on('connection', markRemoteEntrySocket)
    remoteServer.on('upgrade', onUpgrade)
    mainPort = await listen(mainServer, '0.0.0.0')
    remotePort = await listen(remoteServer, '127.0.0.1')
  })
  after(() => { mainServer?.close(); remoteServer?.close() })

  const loop = () => `http://127.0.0.1:${mainPort}`
  const lan = () => `http://${LAN_IP}:${mainPort}`
  const remote = () => `http://127.0.0.1:${remotePort}`
  const cookie = () => `${AUTH_COOKIE}=${cookieValueForToken(token)}`

  it('has a non-loopback address to test from', () => assert.ok(LAN_IP, 'no non-internal IPv4 interface on this host'))

  it('HTTP: main loopback, no token → 200', async () => {
    assert.equal((await fetch(`${loop()}/api/ping`)).status, 200)
  })
  it('HTTP: main non-loopback, no token → 401 JSON', async () => {
    const r = await fetch(`${lan()}/api/ping`)
    assert.equal(r.status, 401)
    assert.equal((await r.json()).code, 'unauthorized')
  })
  it('HTTP: main non-loopback with header / cookie / query → 200', async () => {
    assert.equal((await fetch(`${lan()}/api/ping`, { headers: { 'X-Nanocode-Token': token } })).status, 200)
    assert.equal((await fetch(`${lan()}/api/ping`, { headers: { cookie: cookie() } })).status, 200)
    assert.equal((await fetch(`${lan()}/api/ping?token=${encodeURIComponent(token)}`)).status, 200)
  })
  it('HTTP: remote entry from loopback, no token → 401; with cookie → 200', async () => {
    assert.equal((await fetch(`${remote()}/api/ping`)).status, 401)
    assert.equal((await fetch(`${remote()}/api/ping`, { headers: { cookie: cookie() } })).status, 200)
  })
  it('HTTP: browser navigation without a token → 302 /login?next=…', async () => {
    const r = await fetch(`${remote()}/?x=1`, { redirect: 'manual', headers: { accept: 'text/html' } })
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), `/login?next=${encodeURIComponent('/?x=1')}`)
  })
  it('HTTP: /api/health and /login stay open on the remote entry', async () => {
    assert.equal((await fetch(`${remote()}/api/health`)).status, 200)
    assert.notEqual((await fetch(`${remote()}/login`)).status, 401)
  })

  it('WS: main loopback → open; main non-loopback → 401; non-loopback with ?token / cookie → open', async () => {
    assert.equal(await wsOutcome(`ws://127.0.0.1:${mainPort}/ws/terminal`), 'open')
    assert.equal(await wsOutcome(`ws://${LAN_IP}:${mainPort}/ws/terminal`), 401)
    assert.equal(await wsOutcome(`ws://${LAN_IP}:${mainPort}/ws/terminal?token=${encodeURIComponent(token)}`), 'open')
    assert.equal(await wsOutcome(`ws://${LAN_IP}:${mainPort}/ws/terminal`, { cookie: cookie() }), 'open')
  })
  it('WS: remote entry from loopback → 401; with cookie → open', async () => {
    assert.equal(await wsOutcome(`ws://127.0.0.1:${remotePort}/ws/terminal`), 401)
    assert.equal(await wsOutcome(`ws://127.0.0.1:${remotePort}/ws/terminal`, { cookie: cookie() }), 'open')
  })

  it('login: wrong token → 401, right token → HttpOnly + SameSite=Lax HMAC cookie that authenticates', async () => {
    clock += 120_000
    const bad = await fetch(`${remote()}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) })
    assert.equal(bad.status, 401)
    assert.equal(bad.headers.get('set-cookie'), null)
    const ok = await fetch(`${remote()}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    assert.equal(ok.status, 200)
    const setCookie = ok.headers.get('set-cookie')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Lax/)
    assert.match(setCookie, /Max-Age=15552000/)
    assert.ok(!setCookie.includes(token), 'cookie must not carry the raw token')
    const pair = setCookie.split(';')[0]
    assert.equal((await fetch(`${remote()}/api/ping`, { headers: { cookie: pair } })).status, 200)
  })
  it('login: rate limited to 10 attempts per source per minute (429), resets next window', async () => {
    clock += 120_000
    const post = () => fetch(`${remote()}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) })
    for (let i = 0; i < 10; i++) assert.equal((await post()).status, 401, `attempt ${i + 1}`)
    const limited = await post()
    assert.equal(limited.status, 429)
    assert.ok(limited.headers.get('retry-after'))
    // A correct token is rate limited too (no free oracle once over the limit).
    assert.equal((await fetch(`${remote()}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status, 429)
    clock += 60_000
    assert.equal((await post()).status, 401)
  })
  it('rotating the token invalidates old cookies (HTTP and WS)', async () => {
    const oldCookie = cookie()
    const r = await fetch(`${loop()}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN + '-rotated' }) })
    assert.equal(r.status, 200)
    assert.equal(token, TOKEN + '-rotated')
    assert.equal((await fetch(`${remote()}/api/ping`, { headers: { cookie: oldCookie } })).status, 401)
    assert.equal(await wsOutcome(`ws://127.0.0.1:${remotePort}/ws/terminal`, { cookie: oldCookie }), 401)
    assert.equal((await fetch(`${remote()}/api/ping`, { headers: { cookie: cookie() } })).status, 200)
  })
  it('/api/auth/token { clear: true } (tools --clear) turns remote access off; loopback stays open', async () => {
    const saved = token
    try {
      const { results } = await clearAuthToken({ ports: [mainPort] })
      assert.ok(results[0].ok)
      assert.equal(token, '')
      assert.equal((await fetch(`${remote()}/api/ping`)).status, 403)
      assert.equal((await fetch(`${loop()}/api/ping`)).status, 200)
      const viaRemote = await fetch(`${remote()}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) })
      assert.equal(viaRemote.status, 403)
    } finally {
      token = saved
    }
  })
  it('/api/auth/token is local-only: remote entry with a valid token → 403', async () => {
    const r = await fetch(`${remote()}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nanocode-Token': token }, body: JSON.stringify({ token: 'x'.repeat(40) }) })
    assert.equal(r.status, 403)
    assert.notEqual(token, 'x'.repeat(40))
  })
  it('token not configured: remote entry and non-loopback refused (HTTP + WS + login), loopback still open', async () => {
    const saved = token
    token = ''
    try {
      clock += 120_000
      const r = await fetch(`${remote()}/api/ping`)
      assert.equal(r.status, 403)
      assert.equal((await r.json()).code, 'token_not_configured')
      assert.equal((await fetch(`${lan()}/api/ping`)).status, 403)
      assert.equal((await fetch(`${remote()}/api/ping?token=`)).status, 403)
      assert.equal(await wsOutcome(`ws://127.0.0.1:${remotePort}/ws/terminal`), 403)
      assert.equal(await wsOutcome(`ws://${LAN_IP}:${mainPort}/ws/terminal`), 403)
      const login = await fetch(`${remote()}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: '' }) })
      assert.equal(login.status, 403)
      assert.equal((await fetch(`${loop()}/api/ping`)).status, 200)
    } finally {
      token = saved
    }
  })
})

// ─── tools/set-auth-token.mjs ───────────────────────────────────────────────

describe('tools/set-auth-token.mjs', () => {
  const dirs = []
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  it('generates a 32-byte token, writes it mode 600, pushes it to every port', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nanoauth-tool-'))
    dirs.push(dir)
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }) }
    const out = path.join(dir, 'sub', 'token')
    const { token, results } = await setAuthToken({ out, ports: [9475, 9476], fetchImpl })
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.equal(readFileSync(out, 'utf8').trim(), token)
    assert.equal(statSync(out).mode & 0o777, 0o600)
    assert.deepEqual(calls.map((c) => c.url), ['http://127.0.0.1:9475/api/auth/token', 'http://127.0.0.1:9476/api/auth/token'])
    assert.ok(calls.every((c) => c.body.token === token))
    assert.ok(results.every((r) => r.ok))
    const again = await setAuthToken({ out, ports: [9476], reuse: true, fetchImpl })
    assert.equal(again.token, token)
  })
  it('reports a port that refused', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nanoauth-tool-'))
    dirs.push(dir)
    const fetchImpl = async () => new Response('{"error":"forbidden: localhost only"}', { status: 403 })
    const { results } = await setAuthToken({ out: path.join(dir, 't'), ports: [1], fetchImpl })
    assert.equal(results[0].ok, false)
    assert.match(results[0].error, /403/)
  })
  it('parseArgs requires --out and --port', () => {
    assert.throws(() => parseArgs(['--port', '9475']), /--out/)
    assert.throws(() => parseArgs(['--out', 'x']), /--port/)
    assert.deepEqual(parseArgs(['--out', 'x', '--port', '9475', '--port', '9476', '--reuse']), { out: 'x', ports: [9475, 9476], reuse: true, clear: false })
    assert.deepEqual(parseArgs(['--clear', '--port', '9475']), { out: '', ports: [9475], reuse: false, clear: true })
    assert.throws(() => parseArgs(['--clear', '--out', 'x', '--port', '9475']), /--clear takes only --port/)
  })
})

// ─── Real server/index.js wiring ────────────────────────────────────────────

async function freePort() {
  const s = createServer()
  const port = await listen(s, '127.0.0.1')
  await new Promise((r) => s.close(r))
  return port
}

async function waitHealthy(url, child, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`)
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timeout waiting for ${url}`)
}

describe('server/index.js wiring (spawned real server, main + remote entry)', () => {
  let child, dir, port, rport
  let log = ''
  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nanoauth-srv-'))
    const home = path.join(dir, 'home')
    mkdirSync(home, { recursive: true })
    mkdirSync(path.join(dir, 'data'), { recursive: true })
    writeFileSync(path.join(dir, 'data', 'nanocode.json'), JSON.stringify({ projects: [], settings: { nanocode_auth_token: TOKEN }, tabs: {} }))
    port = await freePort()
    rport = await freePort()
    child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.js')], {
      cwd: dir,
      // Own HOME and tmux socket dir: never touch the shared per-user runtime dir.
      env: {
        ...process.env, XDG_RUNTIME_DIR: '', NANOCODE_TMUX_SOCKET_DIR: path.join(dir, 'tmux'),
        HOME: home, PORT: String(port), HOST: '0.0.0.0', NANOCODE_REMOTE_PORT: String(rport),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    await waitHealthy(`http://127.0.0.1:${port}/api/health`, child)
    await waitHealthy(`http://127.0.0.1:${rport}/api/health`, child)
  })
  after(() => {
    child?.kill('SIGTERM')
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('logs the remote entry listener', () => assert.match(log, /remote entry \(token always required\)/))
  it('main loopback: /api/projects 200 and / serves the shell, no token', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects`)).status, 200)
    const r = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    assert.equal(r.status, 200)
    assert.match(await r.text(), /auth-redirect\.js/)
  })
  it('main non-loopback: /api/projects 401, with header 200', async () => {
    assert.equal((await fetch(`http://${LAN_IP}:${port}/api/projects`)).status, 401)
    assert.equal((await fetch(`http://${LAN_IP}:${port}/api/projects`, { headers: { 'X-Nanocode-Token': TOKEN } })).status, 200)
  })
  it('remote entry: / → 302 /login; /login is the Chinese token page; API 401; cookie 200', async () => {
    const nav = await fetch(`http://127.0.0.1:${rport}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    assert.equal(nav.status, 302)
    assert.match(nav.headers.get('location'), /^\/login\?next=/)
    const page = await fetch(`http://127.0.0.1:${rport}/login`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /访问令牌/)
    assert.equal((await fetch(`http://127.0.0.1:${rport}/api/projects`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${rport}/api/projects`, { headers: { cookie: `${AUTH_COOKIE}=${cookieValueForToken(TOKEN)}` } })).status, 200)
  })
  it('remote entry: PWA assets are public (manifest, sw.js, icon, js, css)', async () => {
    for (const p of ['/manifest.json', '/sw.js', '/icons/icon-192.png', '/js/auth-redirect.js', '/style.css', '/favicon.svg']) {
      assert.equal((await fetch(`http://127.0.0.1:${rport}${p}`)).status, 200, p)
    }
  })
  it('remote entry: localhost-only routes stay 403 even with the token', async () => {
    const r = await fetch(`http://127.0.0.1:${rport}/api/sessions`, { headers: { 'X-Nanocode-Token': TOKEN } })
    assert.equal(r.status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions`)).status, 200)
  })
  it('WS /ws/notify: main loopback open, remote 401, remote with cookie open', async () => {
    assert.equal(await wsOutcome(`ws://127.0.0.1:${port}/ws/notify`), 'open')
    assert.equal(await wsOutcome(`ws://127.0.0.1:${rport}/ws/notify`), 401)
    assert.equal(await wsOutcome(`ws://127.0.0.1:${rport}/ws/notify`, { cookie: `${AUTH_COOKIE}=${cookieValueForToken(TOKEN)}` }), 'open')
  })
  it('settings never expose or accept the token over /api/settings', async () => {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()
    assert.equal('nanocode_auth_token' in s, false)
    const put = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'nanocode_auth_token', value: '' }) })
    assert.equal(put.status, 400)
    assert.equal((await fetch(`http://127.0.0.1:${rport}/api/projects`)).status, 401, 'token still in force')
  })
})
