/**
 * Codex Block render mode — history restoration on refresh (E2E).
 *
 * Anti-fake-pass: this is NOT a renderer-only fixture. It starts a real
 * nanocode server on an isolated port (9485) with a temp store + HOME and a
 * FAKE codex CLI binary (no real API key needed), drives a real browser
 * through a full turn, then reloads the page and asserts the rendered DOM
 * is fully restored in original order with no loss or duplication.
 *
 * What it pins (the contract the server-side + renderer fix must satisfy):
 *   - User blocks: exactly one per turn after refresh (the bug duplicated them
 *     because `› prompt` was appended to scrollback twice and replayed as PTY).
 *   - Agent message: rendered as a structured block (.cbx-block-text with
 *     .cbx-text-md) after refresh, not as flat unstyled PTY text. The live
 *     stream-text deltas are not persisted; the block is reconstructed from
 *     item.completed.item.text.
 *   - Command blocks: exactly one per command after refresh (the bug rendered
 *     them twice — once from scrollback PTY, once from the codex-event replay).
 *   - Order preserved: user → command → agent, matching the live render.
 *
 * Self-contained: spawns its own server in beforeAll, tears it down in afterAll.
 * Never touches 9475/9476.
 */
import { test, expect } from 'playwright/test'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { spawn } from 'node:child_process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_PORT = 9497
const BASE = `http://127.0.0.1:${TEST_PORT}`

function waitUntil(fn, timeoutMs = 15000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    function check() {
      Promise.resolve()
        .then(() => fn())
        .then((value) => {
          if (value) return resolve(value)
          if (Date.now() - startedAt >= timeoutMs) {
            return reject(new Error(`Timed out waiting for ${label}`))
          }
          setTimeout(check, 100)
        })
        .catch(reject)
    }
    check()
  })
}

async function waitForServer() {
  await waitUntil(async () => {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return true
    } catch {}
    return false
  }, 20000, 'server health')
}

function writeFakeCodex(targetPath) {
  const script = `#!/usr/bin/env node
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const prompt = input.trim()
  const slug = prompt.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'x'
  const reply = 'Agent says: ' + prompt
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'e2e-thread-replay' }))
  console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'cmd-' + slug, command: 'echo ' + prompt, status: 'in_progress', aggregated_output: '' } }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd-' + slug, command: 'echo ' + prompt, status: 'completed', aggregated_output: 'out-' + slug, exit_code: 0 } }))
  console.log(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', id: 'msg-' + slug } }))
  const half = reply.slice(0, Math.ceil(reply.length / 2))
  const rest = reply.slice(half.length)
  console.log(JSON.stringify({ type: 'agent_message_content_delta', item_id: 'msg-' + slug, delta: { type: 'text_delta', text: half } }))
  console.log(JSON.stringify({ type: 'agent_message_content_delta', item_id: 'msg-' + slug, delta: { type: 'text_delta', text: rest } }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'msg-' + slug, text: reply } }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }))
})
`
  writeFileSync(targetPath, script, { mode: 0o755 })
  chmodSync(targetPath, 0o755)
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}

function workspaceUrl(project, allProjects) {
  const host = project.ssh_host ? slugify(project.ssh_host) : 'local'
  const siblings = allProjects.filter((p) => (p.ssh_host ? slugify(project.ssh_host) : 'local') === host)
  const base = slugify(project.name)
  const sameSlug = siblings.filter((p) => slugify(p.name) === base)
  const slug = sameSlug.length <= 1 ? base : `${base}-${sameSlug.indexOf(project) + 1}`
  return `/#/${host}/${slug}`
}

test.describe.serial('codex block history — refresh restores full history', () => {
  let serverProc
  let tempHome
  let fakeCodexPath

  test.beforeAll(async () => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'nano-codex-block-e2e-'))
    fakeCodexPath = path.join(tempHome, 'fake-codex')
    writeFakeCodex(fakeCodexPath)

    const serverLogPath = path.join(tempHome, 'server.log')
    serverProc = spawn('node', ['server/index.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tempHome,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        // Avoid the waker/linear side-channels trying to reach the real world.
        NANOCODE_SKIP_WAKER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logChunks = []
    serverProc.stdout.on('data', (c) => { logChunks.push(c) })
    serverProc.stderr.on('data', (c) => { logChunks.push(c) })
    serverProc.on('exit', (code, sig) => {
      const out = Buffer.concat(logChunks).toString('utf8')
      try { writeFileSync(serverLogPath, `exit=${code} sig=${sig}\n${out}`) } catch {}
    })

    try {
      await waitForServer()
    } catch (err) {
      serverProc.kill('SIGKILL')
      const out = Buffer.concat(logChunks).toString('utf8')
      throw new Error(`${err.message}\n--- server.log ---\n${out}`)
    }

    // Configure the temp store: SDK driver + fake codex binary.
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'codex_driver', value: 'sdk' }),
    })
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'codex_path_override', value: fakeCodexPath }),
    })
  })

  test.afterAll(() => {
    if (serverProc) {
      try { serverProc.kill('SIGTERM') } catch {}
      try { serverProc.kill('SIGKILL') } catch {}
    }
    if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  })

  test('user + agent (structured) + command blocks survive reload without duplication', async ({ page, request }) => {
    test.setTimeout(120_000)

    const name = `codex-block-e2e-${Date.now() % 100000}`
    const projectRes = await request.post(`${BASE}/api/projects`, {
      data: { name, cwd: path.join(tempHome, 'workspace') },
    })
    const project = await projectRes.json()
    const tabRes = await request.post(`${BASE}/api/projects/${project.id}/tabs`, {
      data: { type: 'codex', label: 'codex block', renderMode: 'block' },
    })
    const tab = await tabRes.json()
    const listRes = await request.get(`${BASE}/api/projects`)
    const allProjects = await listRes.json()
    const url = BASE + workspaceUrl(project, allProjects)

    await page.goto(url)
    await expect(page.locator('.tab-chip-label', { hasText: tab.label })).toBeVisible({ timeout: 10_000 })
    await page.locator('.tab-chip', { hasText: tab.label }).click()

    const pane = page.locator(`.pane-terminal.cbx-container[data-tab-id="${tab.id}"]`)
    await expect(pane).toBeAttached({ timeout: 15_000 })

    const prompt = 'turn one refresh test'
    const chatInput = page.locator('#chat-input')
    await chatInput.fill(prompt)
    await chatInput.press('Enter')

    // Wait for the live agent block to render with the full reply text.
    const liveAgentText = `Agent says: ${prompt}`
    await expect(
      pane.locator('.cbx-block-text .cbx-text-md', { hasText: liveAgentText })
    ).toBeVisible({ timeout: 30_000 })

    // Live evidence: user block (exactly one), command block (exactly one), agent block.
    await expect(pane.locator('.cbx-block-user', { hasText: prompt })).toHaveCount(1)
    await expect(pane.locator('.cbx-block-bash', { hasText: `echo ${prompt}` })).toHaveCount(1)

    // ── Reload (simulates browser refresh) ──────────────────────────────────
    await page.reload()
    await expect(page.locator('.tab-chip-label', { hasText: tab.label })).toBeVisible({ timeout: 10_000 })
    await page.locator('.tab-chip', { hasText: tab.label }).click()
    await expect(pane).toBeAttached({ timeout: 15_000 })

    // After refresh: user block restored (NOT duplicated — the bug rendered 2).
    await expect(pane.locator('.cbx-block-user', { hasText: prompt })).toHaveCount(1)

    // After refresh: agent message restored as a structured block with the
    // full text (NOT flat PTY text). This is the core of the fix — stream-text
    // deltas are live-only, so the block is reconstructed from item.completed.
    await expect(
      pane.locator('.cbx-block-text .cbx-text-md', { hasText: liveAgentText })
    ).toBeVisible({ timeout: 15_000 })

    // After refresh: command block restored exactly once (NOT duplicated — the
    // bug rendered it twice, once from scrollback PTY and once from the event).
    await expect(pane.locator('.cbx-block-bash', { hasText: `echo ${prompt}` })).toHaveCount(1)

    // Order preserved: the user block must appear before the agent block in the
    // DOM order (original turn order: user → command → agent).
    const userIdx = await pane.locator('.cbx-block-user').first().evaluate((el) => {
      const container = el.closest('.cbx-scroll')
      const blocks = Array.from(container.children)
      return blocks.indexOf(el)
    })
    const agentIdx = await pane.locator('.cbx-block-text').first().evaluate((el) => {
      const container = el.closest('.cbx-scroll')
      const blocks = Array.from(container.children)
      return blocks.indexOf(el)
    })
    expect(userIdx).toBeLessThan(agentIdx)
  })

  test('two codex tabs do not cross-contaminate history after reload', async ({ page, request }) => {
    test.setTimeout(120_000)

    // Two codex block tabs in the same project, each with a distinct prompt.
    const name = `codex-block-2tab-${Date.now() % 100000}`
    const projectRes = await request.post(`${BASE}/api/projects`, {
      data: { name, cwd: path.join(tempHome, 'workspace2') },
    })
    const project = await projectRes.json()
    const tabARes = await request.post(`${BASE}/api/projects/${project.id}/tabs`, {
      data: { type: 'codex', label: 'tabA', renderMode: 'block' },
    })
    const tabA = await tabARes.json()
    const tabBRes = await request.post(`${BASE}/api/projects/${project.id}/tabs`, {
      data: { type: 'codex', label: 'tabB', renderMode: 'block' },
    })
    const tabB = await tabBRes.json()
    const listRes = await request.get(`${BASE}/api/projects`)
    const allProjects = await listRes.json()
    const url = BASE + workspaceUrl(project, allProjects)

    const promptA = 'alpha tab message'
    const promptB = 'bravo tab message'

    // Drive a turn in tab A.
    await page.goto(url)
    await expect(page.locator('.tab-chip-label', { hasText: 'tabA' })).toBeVisible({ timeout: 10_000 })
    await page.locator('.tab-chip', { hasText: 'tabA' }).click()
    const paneA = page.locator(`.pane-terminal.cbx-container[data-tab-id="${tabA.id}"]`)
    await expect(paneA).toBeAttached({ timeout: 15_000 })
    await page.locator('#chat-input').fill(promptA)
    await page.locator('#chat-input').press('Enter')
    await expect(paneA.locator('.cbx-block-text .cbx-text-md', { hasText: `Agent says: ${promptA}` })).toBeVisible({ timeout: 30_000 })

    // Switch to tab B and drive a turn with a DIFFERENT prompt.
    await page.locator('.tab-chip', { hasText: 'tabB' }).click()
    const paneB = page.locator(`.pane-terminal.cbx-container[data-tab-id="${tabB.id}"]`)
    await expect(paneB).toBeAttached({ timeout: 15_000 })
    await page.locator('#chat-input').fill(promptB)
    await page.locator('#chat-input').press('Enter')
    await expect(paneB.locator('.cbx-block-text .cbx-text-md', { hasText: `Agent says: ${promptB}` })).toBeVisible({ timeout: 30_000 })

    // Reload. Each pane must contain ONLY its own prompt — no cross-tab bleed.
    await page.reload()
    await expect(page.locator('.tab-chip-label', { hasText: 'tabA' })).toBeVisible({ timeout: 10_000 })

    await page.locator('.tab-chip', { hasText: 'tabA' }).click()
    await expect(paneA).toBeAttached({ timeout: 15_000 })
    await expect(paneA.locator('.cbx-block-user', { hasText: promptA })).toHaveCount(1)
    // Tab A must NOT contain tab B's prompt.
    await expect(paneA.locator('.cbx-block-user', { hasText: promptB })).toHaveCount(0)
    await expect(paneA.locator('.cbx-block-text .cbx-text-md', { hasText: `Agent says: ${promptA}` })).toBeVisible({ timeout: 15_000 })

    await page.locator('.tab-chip', { hasText: 'tabB' }).click()
    await expect(paneB).toBeAttached({ timeout: 15_000 })
    await expect(paneB.locator('.cbx-block-user', { hasText: promptB })).toHaveCount(1)
    // Tab B must NOT contain tab A's prompt.
    await expect(paneB.locator('.cbx-block-user', { hasText: promptA })).toHaveCount(0)
    await expect(paneB.locator('.cbx-block-text .cbx-text-md', { hasText: `Agent says: ${promptB}` })).toBeVisible({ timeout: 15_000 })
  })
})
