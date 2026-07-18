/**
 * 需求16增补: tab strip horizontal scroll + always-visible "+" new-tab button.
 *
 * Verifies (real browser, no mocks), for BOTH mobile 390×844 and desktop 1280:
 *   1. With 10+ tabs the strip overflows (the last tab is off-screen).
 *   2. The scroll region can be scrolled so ANY tab (incl. the last) is visible.
 *   3. The "+" new-tab button is ALWAYS visible & within the viewport — it is a
 *      sibling of the scroll region, so it never scrolls away.
 *   4. Activating an off-screen tab auto-scrolls it into view (scrollIntoView).
 *   5. Mobile: the "+" touch target is ≥44px.
 *   6. Screenshots saved to ~/codex_work/nano_tabstrip_shots/.
 *
 * Prerequisite: a test server on $TEST_PORT (default 9477).
 *   PORT=9477 node /path/to/nanocode/server/index.js &
 */
import { test, expect } from 'playwright/test'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const SHOT_DIR = path.join(os.homedir(), 'codex_work', 'nano_tabstrip_shots')

// Slugify mirrors public/js/router.js slugify() so we can build the hash URL.
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

// Create a project with `count` long-labeled bash tabs so the strip overflows
// on both 390px and 1280px viewports.
async function makeProjectWithTabs(request, count) {
  const name = `tabstrip-${Date.now() % 100000}-${Math.floor(Math.random() * 1000)}`
  const projectRes = await request.post('/api/projects', { data: { name, cwd: `/tmp/${name}` } })
  const project = await projectRes.json()
  const labels = []
  for (let i = 0; i < count; i++) {
    const label = `Tab${String(i + 1).padStart(2, '0')}-somelongname`
    labels.push(label)
    await request.post(`/api/projects/${project.id}/tabs`, { data: { type: 'bash', label } })
  }
  const listRes = await request.get('/api/projects')
  const allProjects = await listRes.json()
  return { project, url: workspaceUrl(project, allProjects), labels }
}

const TAB_COUNT = 12

// A box is "in view" horizontally when it fits inside the viewport width.
function inViewHorizontally(box, vpWidth) {
  return box.x >= -1 && box.x + box.width <= vpWidth + 1
}

// Shared scenario run by both the mobile and desktop tests.
async function runScenario({ page, request, vpWidth, vpHeight, shotName }) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const { url, labels } = await makeProjectWithTabs(request, TAB_COUNT)
  const lastLabel = labels[labels.length - 1]
  const firstLabel = labels[0]

  await page.goto(url)
  await expect(page.locator('.tab-chip-label', { hasText: firstLabel })).toBeVisible({ timeout: 10_000 })

  const scroll = page.locator('#terminal-tab-scroll')
  const addBtn = page.locator('.tab-chip-add')
  const lastChip = page.locator('.tab-chip', { hasText: lastLabel })
  const firstChip = page.locator('.tab-chip', { hasText: firstLabel })

  // (a) The scroll region exists and the "+" is a sibling of it (not inside).
  await expect(scroll).toBeVisible()
  await expect(addBtn).toBeVisible()
  const addParentId = await addBtn.evaluate((el) => el.parentElement?.id)
  expect(addParentId).toBe('terminal-tab-strip')
  const scrollParentId = await scroll.evaluate((el) => el.parentElement?.id)
  expect(scrollParentId).toBe('terminal-tab-strip')

  // (b) The "+" is within the viewport right away.
  let addBox = await addBtn.boundingBox()
  expect(inViewHorizontally(addBox, vpWidth)).toBeTruthy()

  // (c) With 12 long tabs the strip overflows: the last chip starts off-screen.
  let lastBox = await lastChip.boundingBox()
  expect(lastBox.x + lastBox.width).toBeGreaterThan(vpWidth)

  // (d) Scroll the region to its end — the last tab becomes visible.
  await scroll.evaluate((el) => { el.scrollLeft = el.scrollWidth })
  await page.waitForTimeout(120)
  lastBox = await lastChip.boundingBox()
  expect(inViewHorizontally(lastBox, vpWidth)).toBeTruthy()

  // (e) THE key assertion: the "+" is STILL within the viewport after scrolling
  // to the very end (it never scrolled away).
  addBox = await addBtn.boundingBox()
  expect(inViewHorizontally(addBox, vpWidth)).toBeTruthy()

  // (f) scrollIntoView: reset to the start, then activate the (off-screen)
  // last tab via a DOM .click() (no Playwright auto-scroll) — our handler must
  // bring it into view.
  await scroll.evaluate((el) => { el.scrollLeft = 0 })
  await page.waitForTimeout(120)
  // Confirm the last tab is off-screen again after resetting to start.
  lastBox = await lastChip.boundingBox()
  expect(lastBox.x + lastBox.width).toBeGreaterThan(vpWidth)
  // Activate it without Playwright scrolling: dispatch a raw click on the chip.
  await lastChip.evaluate((el) => el.click())
  await expect(lastChip).toHaveClass(/\bactive\b/)
  await page.waitForTimeout(120)
  lastBox = await lastChip.boundingBox()
  expect(inViewHorizontally(lastBox, vpWidth)).toBeTruthy()

  // (g) Now activate the first tab (off-screen to the left after the last is
  // centered) — scrollIntoView must bring it back into view.
  await firstChip.evaluate((el) => el.click())
  await expect(firstChip).toHaveClass(/\bactive\b/)
  await page.waitForTimeout(120)
  const firstBox = await firstChip.boundingBox()
  expect(inViewHorizontally(firstBox, vpWidth)).toBeTruthy()

  // (h) The "+" is still visible after all the scrolling/activating.
  addBox = await addBtn.boundingBox()
  expect(inViewHorizontally(addBox, vpWidth)).toBeTruthy()

  // (i) Mobile: "+" touch target ≥44px (only asserted for the 390-wide run).
  if (vpWidth <= 480) {
    expect(addBox.width).toBeGreaterThanOrEqual(44)
    expect(addBox.height).toBeGreaterThanOrEqual(44)
  }

  // (j) Screenshot.
  await page.screenshot({ path: path.join(SHOT_DIR, shotName), fullPage: false })
}

test.describe('nano_tabstrip (req16增补) — desktop 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('12 tabs: scroll to any tab, "+" always visible, active scrollIntoView', async ({ page, request }) => {
    await runScenario({ page, request, vpWidth: 1280, vpHeight: 800, shotName: 'tabstrip-1280x800.png' })
  })
})

test.describe('nano_tabstrip (req16增补) — mobile 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('12 tabs: scroll to any tab, "+" always visible & ≥44px, active scrollIntoView', async ({ page, request }) => {
    await runScenario({ page, request, vpWidth: 390, vpHeight: 844, shotName: 'tabstrip-390x844.png' })
  })
})
