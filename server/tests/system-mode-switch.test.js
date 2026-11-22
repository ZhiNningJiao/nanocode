/**
 * The multi-user system-mode switch (owner 2026-11-22 point 5): an explicit,
 * default-off gate replacing an implicit env-only check. These tests prove
 * both states end-to-end by spawning the real server/index.js entry point:
 *   - off (default): router-mode.js never mounts, single-user health works.
 *   - on (NANOCODE_SYSTEM=1): router-mode.js mounts and serves (same
 *     upstream behavior as before this change — see with-router.js fixture
 *     used by terminal/tests/system-mode/*).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSystemModeEnabled } from '../system-mode-flag.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = resolve(__dirname, '..', 'index.js')

describe('isSystemModeEnabled (unit)', () => {
  it('is false when NANOCODE_SYSTEM is unset', () => {
    assert.equal(isSystemModeEnabled({}), false)
  })
  it('is false for any value other than the literal string "1"', () => {
    assert.equal(isSystemModeEnabled({ NANOCODE_SYSTEM: 'true' }), false)
    assert.equal(isSystemModeEnabled({ NANOCODE_SYSTEM: '0' }), false)
  })
  it('is true only for "1"', () => {
    assert.equal(isSystemModeEnabled({ NANOCODE_SYSTEM: '1' }), true)
  })
})

function randomHighPort() {
  // This machine is shared by many concurrent agent sessions — low/predictable
  // port ranges collide often (observed: dozens of ports pre-bound in a
  // narrow 41000-41099 range). Spread across the full ephemeral-safe range
  // and retry on collision rather than trusting any one range to be free.
  return 20000 + Math.floor(Math.random() * 40000)
}

async function spawnOnce(extraEnv, port, sockDir) {
  const child = spawn('node', [INDEX_PATH], {
    env: {
      ...process.env,
      ...extraEnv,
      ...(sockDir ? { NANOCODE_TEST_SOCK_DIR: sockDir } : {}),
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (b) => { out += b.toString() })
  child.stderr.on('data', (b) => { out += b.toString() })
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) { ready = true; break }
    } catch {}
    if (/EADDRINUSE/.test(out)) break
    await new Promise((r) => setTimeout(r, 150))
  }
  if (!ready) { child.kill('SIGKILL'); return { ok: false, out } }
  return { ok: true, child }
}

/** Retries on a fresh random port if the chosen one was already bound by some
 * other process on this shared machine (EADDRINUSE), not our own bug. */
async function spawnServer(extraEnv, _unusedPort, sockDir) {
  let lastOut = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = randomHighPort()
    const result = await spawnOnce(extraEnv, port, sockDir)
    if (result.ok) return { child: result.child, port }
    lastOut = result.out
  }
  throw new Error(`server did not become ready after 5 port attempts; last output:\n${lastOut}`)
}

describe('system-mode switch (integration, real server/index.js)', () => {
  it('off by default: router-only test endpoint is absent, single-user health works', async () => {
    const { child, port } = await spawnServer({ NANOCODE_SYSTEM: undefined })
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`)
      assert.equal(health.status, 200)
      // Router-mode-only test backdoor must not exist in single-user mode.
      const routerOnly = await fetch(`http://127.0.0.1:${port}/__test__/issue-session`, { method: 'POST' })
      assert.equal(routerOnly.status, 404)
    } finally {
      child.kill('SIGTERM')
    }
  })

  it('on via NANOCODE_SYSTEM=1: router mounts and serves (same as upstream)', async () => {
    // NANOCODE_TEST_SOCK_DIR, same as terminal/tests/system-mode's with-router
    // fixture: without it the router's control socket defaults to
    // /run/nanocode/router.sock, which needs root and isn't what this test
    // is proving (the HTTP switch, not control-socket privilege handling).
    const sockDir = mkdtempSync(join(tmpdir(), 'nano-system-mode-switch-test-'))
    const { child, port } = await spawnServer({ NANOCODE_SYSTEM: '1', NANOCODE_TEST_MODE: '1' }, undefined, sockDir)
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`)
      assert.equal(health.status, 200)
      // Router-mode test backdoor exists (NANOCODE_TEST_MODE=1), proving the
      // router — not the single-user server — answered.
      const issue = await fetch(`http://127.0.0.1:${port}/__test__/issue-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: 1000, username: 'tester', workerSock: '/nonexistent.sock' }),
      })
      assert.notEqual(issue.status, 404)
    } finally {
      child.kill('SIGTERM')
      rmSync(sockDir, { recursive: true, force: true })
    }
  })
})
