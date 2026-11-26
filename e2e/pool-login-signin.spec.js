/**
 * One-click pool login (nanologin_2250) — Playwright e2e.
 *
 * Exercises the REAL cockpit quota page, the REAL pool-login-panel.js sign-in
 * widget and the REAL backend driver (terminal/pool-login.js) spawning a REAL
 * `claude auth login --claudeai --sso --email ...` process — all unmodified
 * production code. The only thing this test fakes is WHICH pool the button
 * targets: `page.route()` intercepts /api/pool-login/** and substitutes one
 * synthetic "E2E" pool whose CLAUDE_CONFIG_DIR is an empty scratch directory
 * (never a real `~/.claude*` team pool), so the real CLI really runs but can
 * never touch — let alone log into — any real team's credentials.
 *
 * Flow (real clicks, no mocks of the UI/driver code):
 *   1. Open the cockpit, go to the 额度 (quota) page — a quota-dir fixture
 *      (config/command-center.local.json, gitignored) seeds one pool card
 *      labelled "E2E" via the existing, unmodified quota feature.
 *   2. The sign-in slot nanocode-login adds under that card shows a "Sign in"
 *      button plus the cred/token/last-call summary line.
 *   3. Click it → POST .../start spawns the real CLI against the scratch
 *      CLAUDE_CONFIG_DIR. Poll until the driver reaches `awaiting_code` (a
 *      real Okta/claude.com authorize URL was scraped from real CLI output).
 *   4. Assert the UI now shows the "Open Okta login" link and a code input
 *      box — exactly the two things the owner asked for ("前端直接在新标签页
 *      打开…页面给输入框").
 *   5. Cancel (never submits a code — that would need a live owner clicking
 *      through Okta, out of scope) and kill the spawned process.
 *
 * Prerequisite: a test server on $TEST_PORT (default 9477) with
 *   - config/command-center.local.json pointing quota.dir at a fixture
 *     directory containing one `E2E.json` pool reading (see
 *     REPORT_nanologin_2250.md for the exact fixture used), and
 *   - `claude` on PATH and `git config --global user.email` set (same
 *     requirement the real feature has).
 *   PORT=9477 HOST=127.0.0.1 node /path/to/nanocode/server/index.js &
 */
import { test, expect } from 'playwright/test'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createPoolLoginDriver } from '../terminal/pool-login.js'

const SHOT_DIR = path.join(os.homedir(), 'codex_work', 'nanologin_2250', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const FAKE_POOL = { id: 'e2e-test-pool', label: 'E2E', name: 'E2E Test Pool' }

test('one-click sign-in reaches the Okta auth link for a scratch CLAUDE_CONFIG_DIR', async ({ page }) => {
  test.setTimeout(120_000)

  // A throwaway, never-a-real-pool CLAUDE_CONFIG_DIR — this is the directory
  // the real `claude auth login --sso` process below actually runs against.
  const scratchConfigDir = mkdtempSync(path.join(os.tmpdir(), 'nanologin-2250-e2e-'))
  const driver = createPoolLoginDriver() // the real driver — no fakes here
  const pool = { id: FAKE_POOL.id, configDir: scratchConfigDir }

  // Intercept only the pool-login API; everything else (static assets, the
  // real /api/command-center/quota reading) hits the real test server.
  await page.route('**/api/pool-login/**', async (route) => {
    const url = new URL(route.request().url())
    const m = url.pathname.match(/^\/api\/pool-login\/([^/]+)\/(start|code|cancel|status)$/)
    if (url.pathname === '/api/pool-login/pools') {
      return route.fulfill({ json: { pools: [{ ...FAKE_POOL, isDutyPool: false, interactiveCred: false, longToken: false, lastRealCall: null, login: driver.get(pool.id) }] } })
    }
    if (m && m[1] === FAKE_POOL.id) {
      const action = m[2]
      if (action === 'start') return route.fulfill({ json: await driver.start(pool) })
      if (action === 'status') return route.fulfill({ json: driver.get(pool.id) })
      if (action === 'cancel') { driver.cancel(pool.id); return route.fulfill({ json: { ok: true } }) }
      if (action === 'code') {
        const body = JSON.parse(route.request().postData() || '{}')
        const r = driver.submitCode(pool.id, body.code)
        return route.fulfill({ status: r.ok ? 200 : 409, json: r.ok ? driver.get(pool.id) : r })
      }
    }
    return route.continue()
  })

  try {
    await page.goto('/')
    await expect(page.locator('.ck-rail-btn[data-page="quota"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('.ck-rail-btn[data-page="quota"]').click()

    const card = page.locator('.ccq-card', { has: page.locator('.ccq-pool', { hasText: 'E2E' }) })
    await expect(card).toBeVisible({ timeout: 15_000 })
    const signinBtn = card.locator('[data-act="signin"]')
    await expect(signinBtn).toBeVisible()
    await expect(card.locator('text=interactive login').or(card.locator('text=交互登录'))).toBeVisible()

    await page.screenshot({ path: path.join(SHOT_DIR, '01-pool-card-with-signin-button.png') })

    await signinBtn.click()

    // Poll via the real driver's own state (same thing the UI is polling
    // through the intercepted /status call) until the real CLI either shows
    // the auth link or gives up — never sleep-and-hope for a real subprocess.
    const deadline = Date.now() + 100_000
    let st = driver.get(pool.id)
    while (st.state !== 'awaiting_code' && st.state !== 'error' && Date.now() < deadline) {
      await page.waitForTimeout(500)
      st = driver.get(pool.id)
    }
    expect(st.state, `driver never reached awaiting_code (last state: ${JSON.stringify(st)})`).toBe('awaiting_code')
    expect(st.url, 'no auth URL scraped from the real CLI output').toBeTruthy()

    const openLink = card.locator('a[target="_blank"]')
    await expect(openLink).toBeVisible({ timeout: 15_000 })
    await expect(openLink).toHaveAttribute('href', st.url)
    await expect(card.locator('.ccq-signin-code')).toBeVisible()

    await page.screenshot({ path: path.join(SHOT_DIR, '02-awaiting-code-link-and-input.png') })
  } finally {
    driver.cancel(pool.id)
    rmSync(scratchConfigDir, { recursive: true, force: true })
  }
})

test('signing in to the on-duty secretary\'s pool asks for confirmation first, and a Dismiss never starts a login', async ({ page }) => {
  const driver = createPoolLoginDriver()
  const dutyPool = { ...FAKE_POOL, id: 'e2e-duty-pool' }
  let startCalls = 0

  await page.route('**/api/pool-login/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/pool-login/pools') {
      return route.fulfill({ json: { pools: [{ ...dutyPool, isDutyPool: true, interactiveCred: true, longToken: true, lastRealCall: { ok: true, at: new Date().toISOString() }, login: driver.get(dutyPool.id) }] } })
    }
    if (url.pathname === `/api/pool-login/${dutyPool.id}/start`) {
      startCalls++
      return route.fulfill({ json: { state: 'starting' } }) // never actually spawns anything in this test
    }
    return route.continue()
  })

  let dialogSeen = null
  page.on('dialog', async (dialog) => {
    dialogSeen = dialog.message()
    await dialog.dismiss()
  })

  await page.goto('/')
  await page.locator('.ck-rail-btn[data-page="quota"]').click()
  const card = page.locator('.ccq-card', { has: page.locator('.ccq-pool', { hasText: 'E2E' }) })
  await expect(card.locator('[data-act="signin"]')).toBeVisible({ timeout: 15_000 })
  await card.locator('[data-act="signin"]').click()

  expect(dialogSeen, 'duty-pool sign-in must ask for confirmation before starting a login').toBeTruthy()
  expect(startCalls, 'dismissing the confirm dialog must never call /start').toBe(0)
})
