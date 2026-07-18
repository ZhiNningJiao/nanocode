/**
 * 需求16: session-group favorites — Playwright e2e.
 *
 * Flow (real clicks, no mocks):
 *   1. Create a claude tab (with modelOverride) via the REST API.
 *   2. Star it via a real click on the favorite toggle (★/☆).
 *   3. Reload the page — the favorited tab must still be pinned to the top.
 *   4. Click the tab to resume it.
 *   5. Assert the block renderer mounts (`.cbr-container`) — the per-tab
 *      renderMode=block lock survives reload.
 *   6. Assert the model badge (`.tab-chip-model`) shows the locked model.
 *   7. Screenshot to ~/codex_work/nano_sessiongroups_shots/.
 *
 * Runs under both the desktop (1280×800) and mobile (375×812) projects from
 * playwright.config.js. An additional explicit 390×844 mobile test covers
 * the hard mobile requirement (touch targets ≥44px, star always visible).
 *
 * Prerequisite: a test server must be running on $TEST_PORT (default 9477).
 *   PORT=9477 node /path/to/nanocode/server/index.js &
 */
import { test, expect } from 'playwright/test'
import os from 'node:os'
import path from 'node:path'

const SHOT_DIR = path.join(os.homedir(), 'codex_work', 'nano_sessiongroups_shots')

// Slugify mirrors public/js/router.js slugify() so we can build the hash URL.
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}

// Compute the hash-based workspace URL for a project.
// Route: #/<host>/<project-slug>  (host = 'local' for non-ssh projects)
function workspaceUrl(project, allProjects) {
  const host = project.ssh_host ? slugify(project.ssh_host) : 'local'
  const siblings = allProjects.filter((p) => (p.ssh_host ? slugify(p.ssh_host) : 'local') === host)
  const base = slugify(project.name)
  const sameSlug = siblings.filter((p) => slugify(p.name) === base)
  const slug = sameSlug.length <= 1 ? base : `${base}-${sameSlug.indexOf(project) + 1}`
  return `/#/${host}/${slug}`
}

// Helper: create a unique project + claude tab with modelOverride via the REST API.
async function setupTab(request, label, overrides = {}) {
  const uniqueName = `fav-${label}-${Date.now() % 100000}`
  const projectRes = await request.post('/api/projects', {
    data: { name: uniqueName, cwd: `/tmp/${uniqueName}` },
  })
  const project = await projectRes.json()
  const tabRes = await request.post(`/api/projects/${project.id}/tabs`, {
    data: {
      type: 'claude',
      label: '秘书T1',
      modelOverride: 'claude-fable-5',
      renderMode: 'block',
      ...overrides,
    },
  })
  const tab = await tabRes.json()
  // Fetch all projects so we can compute the dedup-correct hash URL.
  const listRes = await request.get('/api/projects')
  const allProjects = await listRes.json()
  const url = workspaceUrl(project, allProjects)
  return { project, tab, url }
}

// ── Desktop + mobile (config projects) ─────────────────────────────────────

test.describe('session-group favorites — star, reload, pin, resume, block render', () => {
  test('star a tab → reload → pinned to top → resume → block renderer + model badge', async ({ page, request }, testInfo) => {
    // 1. Create the tab via API (with modelOverride + renderMode=block).
    const { tab, url } = await setupTab(request, 'star')

    // 2. Navigate to the project workspace via hash URL.
    await page.goto(url)
    await expect(page.locator('.tab-chip-label', { hasText: '秘书T1' })).toBeVisible({ timeout: 10_000 })

    // 3. Verify the star toggle (☆) is present and not yet favorited.
    const chip = page.locator('.tab-chip', { hasText: '秘书T1' })
    await expect(chip).not.toHaveClass(/is-favorite/)
    const star = chip.locator('.tab-chip-fav')
    await expect(star).toBeVisible()
    await expect(star).toHaveText('☆')

    // 4. Click the star — real click, optimistic flip to ★.
    await star.click()
    await expect(star).toHaveText('★')
    await expect(chip).toHaveClass(/is-favorite/)

    // 5. Verify the model badge shows the locked model.
    const modelBadge = chip.locator('.tab-chip-model')
    await expect(modelBadge).toBeVisible()
    await expect(modelBadge).toHaveText('claude-fable-5')

    // 6. Reload the page — the favorite must survive (pinned to top).
    await page.reload()
    await expect(page.locator('.tab-chip-label', { hasText: '秘书T1' })).toBeVisible({ timeout: 10_000 })

    // After reload, the tab should STILL be favorited AND be the first chip.
    const chips = page.locator('.tab-chip')
    const firstChip = chips.first()
    await expect(firstChip.locator('.tab-chip-label')).toHaveText('秘书T1')
    await expect(firstChip).toHaveClass(/is-favorite/)

    // 7. Click the tab to resume it.
    await firstChip.locator('.tab-chip-label').click()

    // 8. Assert the block renderer mounts (per-tab renderMode=block lock).
    //    ClaudeBlockRenderer adds `.cbr-container` as a CLASS on the pane
    //    element itself (not a child) — so we assert the pane has that class.
    const pane = page.locator(`.pane-terminal.cbr-container[data-tab-id="${tab.id}"]`)
    await expect(pane).toBeAttached({ timeout: 15_000 })

    // 9. Screenshot.
    const vp = testInfo.project.use.viewport
    const label = `${vp.width}x${vp.height}`
    await page.screenshot({
      path: path.join(SHOT_DIR, `favorites-${label}.png`),
      fullPage: false,
    })
  })

  test('unfavorite via star click removes the pin', async ({ page, request }) => {
    const { url } = await setupTab(request, 'unfav', { favorite: true, favoriteOrder: 0 })

    await page.goto(url)
    await expect(page.locator('.tab-chip-label', { hasText: '秘书T1' })).toBeVisible({ timeout: 10_000 })

    const chip = page.locator('.tab-chip', { hasText: '秘书T1' })
    await expect(chip).toHaveClass(/is-favorite/)

    // Click ★ → becomes ☆, is-favorite removed.
    const star = chip.locator('.tab-chip-fav')
    await star.click()
    await expect(star).toHaveText('☆')
    await expect(chip).not.toHaveClass(/is-favorite/)
  })
})

// ── 390×844 mobile hard requirement ─────────────────────────────────────────

test.describe('mobile 390×844 hard requirement', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('star touch target ≥44px and always visible on 390×844', async ({ page, request }) => {
    const { url } = await setupTab(request, 'mobile')

    await page.goto(url)
    await expect(page.locator('.tab-chip-label', { hasText: '秘书T1' })).toBeVisible({ timeout: 10_000 })

    const chip = page.locator('.tab-chip', { hasText: '秘书T1' })
    const star = chip.locator('.tab-chip-fav')

    // Star must be visible (not hidden via opacity:0 hover-gate).
    await expect(star).toBeVisible()

    // Touch target ≥44px (width and height both ≥44).
    const box = await star.boundingBox()
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)

    // Star the tab via real tap.
    await star.click()
    await expect(star).toHaveText('★')
    await expect(chip).toHaveClass(/is-favorite/)

    // Screenshot.
    await page.screenshot({
      path: path.join(SHOT_DIR, 'favorites-390x844.png'),
      fullPage: false,
    })
  })
})
