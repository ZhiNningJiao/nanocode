/**
 * Playwright smoke test for the historian plugin panel.
 * Runs against a test server on $TEST_PORT (default 9477).
 *
 * Covers desktop (1280x800) and mobile (375x812) viewports via
 * playwright.config.js projects.
 */
import { test, expect } from 'playwright/test'

// ── API smoke ────────────────────────────────────────────────────────────────

test('GET /api/health returns 200', async ({ request }) => {
  const r = await request.get('/api/health')
  expect(r.status()).toBe(200)
})

test('GET /api/historian/state returns JSON with expected keys', async ({ request }) => {
  const r = await request.get('/api/historian/state')
  expect(r.status()).toBe(200)
  const body = await r.json()
  expect(body).toHaveProperty('army')
  expect(body).toHaveProperty('logTail')
  expect(body).toHaveProperty('wakerHealth')
  expect(body).toHaveProperty('akariUp')
})

test('GET /api/historian/state wakerHealth includes enhanced fields', async ({ request }) => {
  const r = await request.get('/api/historian/state')
  const body = await r.json()
  const h = body.wakerHealth
  expect(h).toHaveProperty('tmuxAlive')
  expect(h).toHaveProperty('singletonLock')
  expect(h).toHaveProperty('mode')
  expect(h).toHaveProperty('autoLive')
  // New enhanced fields — present even if null/0
  expect(h).toHaveProperty('intervalLabel')
  expect(h).toHaveProperty('currentInterval')
})

test('GET /api/historian/briefing returns JSON with summary', async ({ request }) => {
  const r = await request.get('/api/historian/briefing')
  expect(r.status()).toBe(200)
  const body = await r.json()
  expect(body).toHaveProperty('summary')
  expect(body).toHaveProperty('time')
})

test('GET /api/historian/waker/control returns JSON', async ({ request }) => {
  const r = await request.get('/api/historian/waker/control')
  expect(r.status()).toBe(200)
  const body = await r.json()
  expect(body).toHaveProperty('tmuxAlive')
})

test('POST /api/historian/waker/interval accepts seconds param', async ({ request }) => {
  const r = await request.post('/api/historian/waker/interval', {
    data: { seconds: 0 },
  })
  expect(r.status()).toBe(200)
  const body = await r.json()
  expect(body).toHaveProperty('ok')
  expect(body).toHaveProperty('interval')
})

// ── UI smoke ─────────────────────────────────────────────────────────────────

test('homepage loads with nanocode title', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/nano/i)
})

test('historian-panel.js is served', async ({ request }) => {
  const r = await request.get('/js/historian-panel.js')
  expect(r.status()).toBe(200)
  const text = await r.text()
  expect(text).toContain('renderHistorianPane')
})

test('style.css contains historian styles including active button', async ({ request }) => {
  const r = await request.get('/style.css')
  expect(r.status()).toBe(200)
  const text = await r.text()
  expect(text).toContain('.historian-head')
  expect(text).toContain('.historian-table')
  expect(text).toContain('.historian-controls')
  expect(text).toContain('.rp-btn-active')
})

test('right panel plugin registry includes historian', async ({ request }) => {
  const r = await request.get('/js/plugins-registry.js')
  expect(r.status()).toBe(200)
  const text = await r.text()
  expect(text).toContain("name: 'historian'")
})

test('historian-panel.js contains enhanced usage features', async ({ request }) => {
  const r = await request.get('/js/historian-panel.js')
  const text = await r.text()
  expect(text).toContain('injectCount')
  expect(text).toContain('gateStats')
  expect(text).toContain('intervalLabel')
  expect(text).toContain('rp-btn-active')
})
