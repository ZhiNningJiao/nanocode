/**
 * GET /api/reach — the relays' where.json URLs for the PWA offline page, read
 * from the personal config (never from the repo). Parsing is unit-tested on
 * loadPersonalConfig; the route on a real server process.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { loadPersonalConfig, resetPersonalConfigCache } from '../../terminal/personal-config.js'
import { OWNED_NODE_ARGS, ownerEnvRemoving } from './fixtures/owner-watch.mjs'
import { setupSuite } from './fixtures/suite-hooks.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) })
  })
}

describe('personal config: reach.where', () => {
  let dir
  setupSuite(() => { dir = mkdtempSync(join(tmpdir(), 'reach-cfg-')) },
    () => { if (dir) rmSync(dir, { recursive: true, force: true }) },
    resetPersonalConfigCache)

  function load(obj) {
    resetPersonalConfigCache()
    const p = join(dir, `p-${Math.random()}.json`)
    writeFileSync(p, JSON.stringify(obj))
    return loadPersonalConfig({ home: dir, configPath: p })
  }

  it('absent → empty list', () => {
    assert.deepEqual([...load({}).reach.where], [])
  })

  it('keeps http(s) URLs in order, drops junk and duplicates', () => {
    const cfg = load({ reach: { where: ['http://relay-a.example:9495/where.json', 'javascript:alert(1)', 42, 'not a url', 'https://relay-b.example/where.json', 'http://relay-a.example:9495/where.json'] } })
    assert.deepEqual([...cfg.reach.where], ['http://relay-a.example:9495/where.json', 'https://relay-b.example/where.json'])
  })
})

describe('GET /api/reach (real server)', () => {
  let dir
  let child
  let port
  const logs = []
  setupSuite(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reach-api-'))
    const home = join(dir, 'home')
    mkdirSync(home)
    const personal = join(dir, 'personal.json')
    writeFileSync(personal, JSON.stringify({ reach: { where: ['http://relay-a.example:9495/where.json', 'http://relay-b.example:9495/where.json'] } }))
    port = await freePort()
    const env = { ...process.env, ...ownerEnvRemoving(dir), HOME: home, PORT: String(port), HOST: '127.0.0.1', NANOCODE_PERSONAL_CONFIG: personal }
    for (const k of ['CLAUDE_CONFIG_DIR', 'TMUX', 'NANOCODE_REMOTE_PORT']) delete env[k]
    // The server exits with this process (and removes dir) even if it is killed before teardown.
    child = spawn(process.execPath, [...OWNED_NODE_ARGS, join(REPO, 'server', 'index.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => logs.push(String(d)))
    child.stderr.on('data', (d) => logs.push(String(d)))
    const end = Date.now() + 20000
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break } catch { /* not up yet */ }
      await sleep(100)
    }
  },
  () => { if (child) child.kill('SIGKILL') },
  () => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('returns the configured where.json URLs as JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/reach`)
    assert.equal(res.status, 200, logs.join(''))
    assert.match(res.headers.get('content-type'), /application\/json/)
    assert.deepEqual(await res.json(), { where: ['http://relay-a.example:9495/where.json', 'http://relay-b.example:9495/where.json'] })
  })

  it('serves the offline page and its script as static files', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/offline.html`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /reach-finder\.js/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/js/reach-finder.js`)).status, 200)
  })
})
