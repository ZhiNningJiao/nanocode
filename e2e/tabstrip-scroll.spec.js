/**
 * 需求16增补 + 打回第2轮: tab strip horizontal scroll, always-visible "+", and
 * ≥44px touch hit areas for star/close/+. Verifies (real browser, no mocks),
 * for BOTH mobile 390×844 and desktop 1280:
 *   1. 4 secretary favorites (秘书T1/T2/Codex秘书/生活小助手) pin to the front
 *      with the gold-border is-favorite style, followed by a divider, then
 *      regular tabs — the 置顶排序 is visible at a glance.
 *   2. With 12 tabs the strip overflows (the last tab is off-screen).
 *   3. The scroll region can be scrolled so ANY tab (incl. the last) is visible.
 *   4. The "+" new-tab button is ALWAYS visible & within the viewport — it is a
 *      sibling of the scroll region, so it never scrolls away.
 *   5. Activating an off-screen tab auto-scrolls it into view (scrollIntoView).
 *   6. Mobile (≤480px): the "+", star, and active-tab close × touch targets are
 *      all ≥44px (effective hit area). Star is always visible (not hover-gated).
 *   7. Screenshots saved to ~/codex_work/nano_tabstrip_shots/ — at least one
 *      mobile shot shows the 4 gold-bordered favorites + divider + regular tabs
 *      in the same frame (打回第2轮 #8 evidence requirement).
 *
 * Prerequisite: a test server on $TEST_PORT (default 9477).
 *   PORT=9477 node /path/to/nanocode/server/index.js &
 */
import { test, expect } from 'playwright/test'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const SHOT_DIR = path.join(os.homedir(), 'codex_work', 'nano_tabstrip_shots')

// Slugify + projectSlug mirror public/js/router.js EXACTLY so the hash URL we
// build resolves to the right project in the frontend router. The project
// returned by POST /api/projects is a different object reference than the one
// in the GET /api/projects list, so we look it up by id in the list and pass
// THAT reference to projectSlug — otherwise indexOf(project) === -1 and the
// dedupe suffix is computed wrong (bogus "-0"), which the router can't resolve.
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}
function hostSlug(p) {
  return p.ssh_host ? slugify(p.ssh_host) : 'local'
}
function projectSlug(project, allProjects) {
  const host = hostSlug(project)
  const siblings = allProjects.filter((p) => hostSlug(p) === host)
  const base = slugify(project.name)
  const sameSlug = siblings.filter((p) => slugify(p.name) === base)
  if (sameSlug.length <= 1) return base
  const idx = sameSlug.indexOf(project)
  return idx <= 0 ? base : `${base}-${idx + 1}`
}
function workspaceUrl(project, allProjects) {
  const inList = allProjects.find((p) => p.id === project.id) || project
  return `/#/${hostSlug(inList)}/${projectSlug(inList, allProjects)}`
}

// The four resident secretary favorites (mirrors store.seedSecretaryFavorites
// spec order) + a set of long-labeled regular bash tabs so the strip overflows
// on both 390px and 1280px viewports. Favorites are created via the REST API
// with favorite:true + favoriteOrder so they pin to the front on first load.
const FAVORITE_TABS = [
  { label: '秘书T1', type: 'claude', favoriteOrder: 0 },
  { label: '秘书T2', type: 'claude', favoriteOrder: 1 },
  { label: 'Codex秘书', type: 'codex', favoriteOrder: 2 },
  { label: '生活小助手', type: 'claude', favoriteOrder: 3 },
]
const REGULAR_TAB_COUNT = 8

async function makeProjectWithTabs(request) {
  const name = `tabstrip-${Date.now() % 100000}-${Math.floor(Math.random() * 1000)}`
  const projectRes = await request.post('/api/projects', { data: { name, cwd: `/tmp/${name}` } })
  const project = await projectRes.json()
  const favLabels = []
  for (const f of FAVORITE_TABS) {
    favLabels.push(f.label)
    await request.post(`/api/projects/${project.id}/tabs`, {
      data: { type: f.type, label: f.label, favorite: true, favoriteOrder: f.favoriteOrder },
    })
  }
  const regLabels = []
  for (let i = 0; i < REGULAR_TAB_COUNT; i++) {
    const label = `Tab${String(i + 1).padStart(2, '0')}-somelongname`
    regLabels.push(label)
    await request.post(`/api/projects/${project.id}/tabs`, { data: { type: 'bash', label } })
  }
  const listRes = await request.get('/api/projects')
  const allProjects = await listRes.json()
  return { project, url: workspaceUrl(project, allProjects), favLabels, regLabels }
}

// A box is "in view" horizontally when it fits inside the viewport width.
function inViewHorizontally(box, vpWidth) {
  return box.x >= -1 && box.x + box.width <= vpWidth + 1
}

// Shared scenario run by both the mobile and desktop tests.
async function runScenario({ page, request, vpWidth, vpHeight, shotName, isMobile }) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const { url, favLabels, regLabels } = await makeProjectWithTabs(request)
  const lastRegLabel = regLabels[regLabels.length - 1]
  const firstRegLabel = regLabels[0]

  await page.goto(url)
  await expect(page.locator('.tab-chip-label', { hasText: favLabels[0] })).toBeVisible({ timeout: 10_000 })

  const scroll = page.locator('#terminal-tab-scroll')
  const addBtn = page.locator('.tab-chip-add')
  const lastChip = page.locator('.tab-chip', { hasText: lastRegLabel })
  const firstRegChip = page.locator('.tab-chip', { hasText: firstRegLabel })
  const chips = page.locator('.tab-chip')
  const divider = page.locator('.tab-strip-divider')

  // (a) The scroll region exists and the "+" is a sibling of it (not inside).
  await expect(scroll).toBeVisible()
  await expect(addBtn).toBeVisible()
  const addParentId = await addBtn.evaluate((el) => el.parentElement?.id)
  expect(addParentId).toBe('terminal-tab-strip')
  const scrollParentId = await scroll.evaluate((el) => el.parentElement?.id)
  expect(scrollParentId).toBe('terminal-tab-strip')

  // (b) 打回第2轮 #8: the 4 secretary favorites are pinned to the FRONT of the
  // strip (first 4 chips) with the is-favorite class (gold border). A divider
  // separates them from the regular tabs — the 置顶排序 reads at a glance.
  await expect(divider).toBeVisible()
  expect(await chips.count()).toBe(FAVORITE_TABS.length + REGULAR_TAB_COUNT)
  for (let i = 0; i < FAVORITE_TABS.length; i++) {
    const chip = chips.nth(i)
    await expect(chip).toHaveClass(/\bis-favorite\b/)
    await expect(chip.locator('.tab-chip-label')).toHaveText(favLabels[i])
    await expect(chip.locator('.tab-chip-fav')).toHaveText('★')
  }
  // The chip right after the favorites is a regular (non-favorite) tab.
  await expect(chips.nth(FAVORITE_TABS.length)).not.toHaveClass(/\bis-favorite\b/)

  // (c) The "+" is within the viewport right away.
  let addBox = await addBtn.boundingBox()
  expect(inViewHorizontally(addBox, vpWidth)).toBeTruthy()

  // (d) With 12 long tabs the strip overflows: the last regular chip is off-screen.
  let lastBox = await lastChip.boundingBox()
  expect(lastBox.x + lastBox.width).toBeGreaterThan(vpWidth)

  // (e) Scroll the region to its end — the last tab becomes visible.
  await scroll.evaluate((el) => { el.scrollLeft = el.scrollWidth })
  await page.waitForTimeout(120)
  lastBox = await lastChip.boundingBox()
  expect(inViewHorizontally(lastBox, vpWidth)).toBeTruthy()

  // (f) THE key assertion: the "+" is STILL within the viewport after scrolling
  // to the very end (it never scrolled away).
  addBox = await addBtn.boundingBox()
  expect(inViewHorizontally(addBox, vpWidth)).toBeTruthy()

  // (g) scrollIntoView: reset to the start, then activate the (off-screen) last
  // regular tab via a DOM .click() (no Playwright auto-scroll) — our handler must
  // bring it into view.
  await scroll.evaluate((el) => { el.scrollLeft = 0 })
  await page.waitForTimeout(120)
  lastBox = await lastChip.boundingBox()
  expect(lastBox.x + lastBox.width).toBeGreaterThan(vpWidth)
  await lastChip.evaluate((el) => el.click())
  await expect(lastChip).toHaveClass(/\bactive\b/)
  await page.waitForTimeout(120)
  lastBox = await lastChip.boundingBox()
  expect(inViewHorizontally(lastBox, vpWidth)).toBeTruthy()

  // (h) Now activate the first regular tab (off-screen to the left after the last
  // is centered) — scrollIntoView must bring it back into view.
  await firstRegChip.evaluate((el) => el.click())
  await expect(firstRegChip).toHaveClass(/\bactive\b/)
  await page.waitForTimeout(120)
  const firstRegBox = await firstRegChip.boundingBox()
  expect(inViewHorizontally(firstRegBox, vpWidth)).toBeTruthy()

  // (i) The "+" is still visible after all the scrolling/activating.
  addBox = await addBtn.boundingBox()
  expect(inViewHorizontally(addBox, vpWidth)).toBeTruthy()

  // (j) 打回第2轮 #8 screenshot #1: reset to the start so the 4 gold-bordered
  // favorites + divider + first regular tabs are all in frame (置顶排序 visible).
  await scroll.evaluate((el) => { el.scrollLeft = 0 })
  await page.waitForTimeout(120)
  // Activate the first favorite so the active-tab close × is also in the shot.
  await chips.nth(0).evaluate((el) => el.click())
  await page.waitForTimeout(120)
  await page.screenshot({ path: path.join(SHOT_DIR, shotName), fullPage: false })

  // (k) Mobile-only hard requirements (≤480px): ≥44px touch hit areas + star
  // always visible. Desktop (fine pointer, >480px) keeps the compact 16px
  // controls — the 44px band is a touch/narrow-viewport requirement, not desktop.
  if (isMobile) {
    // "+" ≥44px.
    addBox = await addBtn.boundingBox()
    expect(addBox.width).toBeGreaterThanOrEqual(44)
    expect(addBox.height).toBeGreaterThanOrEqual(44)

    // Star ≥44px on EVERY chip (favorite or not) and always visible. 打回第2轮
    // #6: a non-favorite star must NOT be opacity:0 (hover-gated) on touch —
    // toBeVisible() alone can't catch opacity:0, so also assert computed opacity.
    for (let i = 0; i < FAVORITE_TABS.length + REGULAR_TAB_COUNT; i++) {
      const chip = chips.nth(i)
      const star = chip.locator('.tab-chip-fav')
      await expect(star).toBeVisible()
      const starBox = await star.boundingBox()
      expect(starBox.width).toBeGreaterThanOrEqual(44)
      expect(starBox.height).toBeGreaterThanOrEqual(44)
      const opacity = await star.evaluate((el) => getComputedStyle(el).opacity)
      expect(Number(opacity)).toBeGreaterThan(0)
    }
    // A non-favorite (regular) chip's star must be fully visible (opacity '1')
    // on ≤480px, not hover-gated — the hard requirement so a phone can favorite.
    const regStarOpacity = await chips.nth(FAVORITE_TABS.length).locator('.tab-chip-fav')
      .evaluate((el) => getComputedStyle(el).opacity)
    expect(regStarOpacity).toBe('1')

    // Active-tab close × ≥44px (the close is only visible on the active tab;
    // the 44px band applies to that visible, tappable close). The first favorite
    // is active. Click the × — it must actually close the tab (functional hit).
    const activeChip = page.locator('.tab-chip.active')
    await expect(activeChip).toHaveClass(/\bis-favorite\b/)
    const activeClose = activeChip.locator('.tab-chip-close')
    await expect(activeClose).toBeVisible()
    const closeBox = await activeClose.boundingBox()
    expect(closeBox.width).toBeGreaterThanOrEqual(44)
    expect(closeBox.height).toBeGreaterThanOrEqual(44)
    const countBefore = await chips.count()
    await activeClose.click()
    await expect.poll(async () => chips.count(), { timeout: 5_000 }).toBe(countBefore - 1)
  }
}

test.describe('nano_tabstrip (req16增补 + 打回第2轮) — desktop 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('4 favorites pinned + divider, 12 tabs scroll, "+" always visible, active scrollIntoView', async ({ page, request }) => {
    await runScenario({ page, request, vpWidth: 1280, vpHeight: 800, shotName: 'tabstrip-1280x800.png', isMobile: false })
  })
})

test.describe('nano_tabstrip (req16增补 + 打回第2轮) — mobile 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('4 favorites + divider in frame, scroll to any tab, "+" always visible & ≥44px, star/close ≥44px', async ({ page, request }) => {
    await runScenario({ page, request, vpWidth: 390, vpHeight: 844, shotName: 'tabstrip-390x844.png', isMobile: true })
  })
})
