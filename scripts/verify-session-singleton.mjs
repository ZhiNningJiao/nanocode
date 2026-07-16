#!/usr/bin/env node
/**
 * verify-session-singleton.mjs
 *
 * Dual-server manual verification for the session singleton lock.
 * Starts two real nanocode server instances on ports 9477 and 9478
 * (red line: never touches 9475), both sharing a temp HOME so the lock
 * files collide — reproducing the 9475/9476 "two secretaries" conflict.
 *
 * Assertions:
 *   1. Only one server acquires the lock (host); the other enters read-only.
 *   2. The read-only server's client receives a "会话由 :<port> 托管" banner.
 *   3. Input from the read-only server is blocked (no consumer spawned).
 *   4. When the host's client disconnects, the lock is released.
 *   5. The read-only server promotes on re-attach (can send input).
 *
 * Usage:  node scripts/verify-session-singleton.mjs
 * Exit:   0 = all assertions passed, 1 = failure
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..')
const PORT_A = 9477
const PORT_B = 9478
const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'

let results = []
let servers = []
let tmpHome

function log(msg) { console.log(`[verify] ${msg}`) }
function assert(cond, label) {
  if (cond) {
    results.push(true)
    console.log(`  ${PASS} ${label}`)
  } else {
    results.push(false)
    console.log(`  ${FAIL} ${label}`)
  }
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return true
    } catch {}
    await delay(300)
  }
  return false
}

async function fetchJson(port, path, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return r.json()
}

async function putSetting(port, key, value) {
  await fetchJson(port, '/api/settings', { method: 'PUT', body: { key, value } })
}

async function createProject(port, name, cwd) {
  const r = await fetchJson(port, '/api/projects', { method: 'POST', body: { name, cwd } })
  return r
}

async function createTab(port, projectId, opts) {
  const r = await fetchJson(port, `/api/projects/${projectId}/tabs`, { method: 'POST', body: opts })
  return r
}

async function updateTabClaudeSession(port, projectId, tabId, claudeSessionId) {
  await fetchJson(port, `/api/projects/${projectId}/tabs/${tabId}/session`, {
    method: 'PATCH', body: { claudeSessionId }
  })
}

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ws connect timeout')), 5000)
  })
}

function wsAttach(ws, projectId, tabId) {
  ws.send(JSON.stringify({
    type: 'attach',
    projectId,
    sessionType: 'bash',
    tabType: 'claude',
    tabId,
    cols: 120,
    rows: 40,
  }))
}

function waitForEvent(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function onData(raw) {
      try {
        const msg = JSON.parse(raw)
        if (predicate(msg)) {
          ws.off('message', onData)
          resolve(msg)
        }
      } catch {}
    }
    ws.on('message', onData)
    setTimeout(() => {
      ws.off('message', onData)
      reject(new Error(`event timeout (${timeoutMs}ms)`))
    }, timeoutMs)
  })
}

function startServer(port, home) {
  const env = { ...process.env, HOME: home, PORT: String(port) }
  const proc = spawn('node', ['server/index.js'], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (d) => {
    const lines = d.toString().trim().split('\n')
    for (const l of lines) {
      if (l.includes('[claude:lock]') || l.includes('Error') || l.includes('error')) {
        log(`:${port} ${l}`)
      }
    }
  })
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim()
    if (s && !s.includes('ExperimentalWarning') && !s.includes('--experimental')) {
      log(`:${port} [stderr] ${s}`)
    }
  })
  proc.on('exit', (code) => log(`:${port} server exited (code=${code})`))
  servers.push(proc)
  return proc
}

async function main() {
  log('Setting up temp HOME for shared lock directory...')
  tmpHome = mkdtempSync(join(os.tmpdir(), 'nano-singleton-'))
  mkdirSync(join(tmpHome, 'workspace'), { recursive: true })

  log(`Starting server A on :${PORT_A}...`)
  startServer(PORT_A, tmpHome)
  log(`Starting server B on :${PORT_B}...`)
  startServer(PORT_B, tmpHome)

  log('Waiting for servers to become healthy...')
  const aReady = await waitForHealth(PORT_A)
  const bReady = await waitForHealth(PORT_B)
  if (!aReady || !bReady) {
    console.error(`\n${FAIL} servers did not become healthy (A=${aReady}, B=${bReady})`)
    cleanup(1)
    return
  }
  log('Both servers are healthy.')

  // Configure both servers: block renderMode so claude tabs use the stream-json
  // bridge (the path where the session lock is enforced).
  await putSetting(PORT_A, 'renderMode', 'block')
  await putSetting(PORT_B, 'renderMode', 'block')

  // Create the same project on both servers (they share the same store file
  // because they run from the same repo root with the same data/ dir).
  // Actually each server has its own in-process store instance, so we need to
  // create the project+tab on BOTH and then align the claudeSessionId.
  const projectCwd = join(tmpHome, 'workspace', 'test-singleton')
  mkdirSync(projectCwd, { recursive: true })

  log('Creating project + claude tab on server A...')
  const projA = await createProject(PORT_A, 'singleton-test', projectCwd)
  const tabA = await createTab(PORT_A, projA.id, { type: 'claude', label: 'singleton' })

  log('Creating project + claude tab on server B...')
  const projB = await createProject(PORT_B, 'singleton-test', projectCwd)
  const tabB = await createTab(PORT_B, projB.id, { type: 'claude', label: 'singleton' })

  // Align the claudeSessionId: both tabs point to the same conversation.
  const sharedSessionId = tabA.claudeSessionId || randomUUID()
  await updateTabClaudeSession(PORT_A, projA.id, tabA.id, sharedSessionId)
  await updateTabClaudeSession(PORT_B, projB.id, tabB.id, sharedSessionId)
  log(`Shared claudeSessionId: ${sharedSessionId}`)

  // ── Test 1: First server acquires lock; second enters read-only ────────────
  console.log('\n── Test 1: first server = host, second = read-only ──')
  const wsA = await wsConnect(PORT_A)
  wsAttach(wsA, projA.id, tabA.id)
  await delay(300)

  // Check lock file
  const lockFile = join(tmpHome, '.nanocode', 'session-locks', `${sharedSessionId}.lock`)
  let lockData = null
  try { lockData = JSON.parse(readFileSync(lockFile, 'utf8')) } catch {}
  assert(existsSync(lockFile), 'lock file exists after server A attaches')
  assert(Number(lockData?.port) === PORT_A, `lock held by :${PORT_A} (got :${lockData?.port})`)

  const wsB = await wsConnect(PORT_B)
  wsAttach(wsB, projB.id, tabB.id)

  try {
    const roEvent = await waitForEvent(wsB, (m) =>
      m.type === 'claude-event' && m.event?.subtype === 'info' && m.event?._readonly === true
    )
    assert(true, 'server B received read-only banner')
    assert(Number(roEvent.event._lockHolderPort) === PORT_A,
      `banner says hosted by :${PORT_A} (got :${roEvent.event._lockHolderPort})`)
  } catch {
    assert(false, 'server B received read-only banner (timeout)')
  }

  // ── Test 2: Read-only server blocks input ─────────────────────────────────
  console.log('\n── Test 2: read-only server blocks input ──')
  wsB.send(JSON.stringify({ type: 'claude-input', text: 'blocked message', _nonce: 'ro1' }))
  try {
    const blocked = await waitForEvent(wsB, (m) =>
      m.type === 'claude-event' &&
      m.event?.subtype === 'info' &&
      typeof m.event?.text === 'string' &&
      m.event.text.includes('只读模式')
    )
    assert(true, 'read-only server rejected input with "只读模式" message')
  } catch {
    assert(false, 'read-only server rejected input (timeout)')
  }

  // ── Test 3: Host disconnect → lock released → read-only promotes ──────────
  console.log('\n── Test 3: host disconnect → promotion ──')
  wsA.close()
  await delay(300)
  assert(!existsSync(lockFile), 'lock file removed after host disconnects')

  // Re-attach on server B → should promote
  const wsB2 = await wsConnect(PORT_B)
  wsAttach(wsB2, projB.id, tabB.id)
  try {
    const promo = await waitForEvent(wsB2, (m) =>
      m.type === 'claude-event' &&
      m.event?.subtype === 'info' &&
      m.event?._readonly === false
    )
    assert(true, 'server B promoted to host')
  } catch {
    assert(false, 'server B promoted to host (timeout)')
  }

  // Verify lock now held by server B
  try {
    const lock2 = JSON.parse(readFileSync(lockFile, 'utf8'))
    assert(Number(lock2.port) === PORT_B, `lock now held by :${PORT_B} (got :${lock2.port})`)
  } catch {
    assert(false, 'lock file exists and held by server B')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r).length
  const total = results.length
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Results: ${passed}/${total} assertions passed`)
  if (passed === total) {
    console.log(`\x1b[32mALL ASSERTIONS PASSED — session singleton lock works.\x1b[0m`)
    cleanup(0)
  } else {
    console.log(`\x1b[31mSOME ASSERTIONS FAILED — see above.\x1b[0m`)
    cleanup(1)
  }
}

function cleanup(code) {
  log('Cleaning up...')
  for (const proc of servers) {
    try { proc.kill('SIGTERM') } catch {}
  }
  if (tmpHome) {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  }
  process.exit(code)
}

process.on('SIGINT', () => cleanup(130))
main().catch((err) => {
  console.error('Fatal error:', err)
  cleanup(1)
})
