/**
 * Claude (block) tab model badge — Playwright e2e for the badge-fix.
 *
 * Root bug being fixed: after picking a model in the claude picker, the
 * #model-badge stayed on "model" (and stayed "model" after a page reload) — the
 * user could not see that their selection took effect. The old _updateModelBadge
 * only read the reported reply model (_modelByTab), so a tab with a modelOverride
 * but no turn yet always rendered the bare "model" affordance, and the picker
 * never notified the badge live.
 *
 * Flow (real clicks, no mocks, NO claude turn — saves API quota):
 *   1. Create a claude block tab via REST API (no override).
 *   2. Open the workspace, activate the tab → ClaudeBlockRenderer mounts.
 *   3. #model-badge shows "model" (no override, no reply yet).
 *   4. Click the badge → the claude two-step picker mounts (step 1 of 2:
 *      live /api/claude/models list + Custom…).
 *   5. Pick "Opus (1M context)" (value opus[1m]) → step 2 of 2 (effort).
 *   6. Pick "high" → picker closes, badge updates LIVE to contain "opus".
 *   7. Reload → badge STILL contains "opus" (persisted; root-fix path).
 *   8. GET /api/projects/:id/tabs confirms modelOverride="opus[1m]",
 *      effortOverride="high".
 *
 * Prerequisite: a test server on $TEST_PORT (default 9477) in single-user mode
 * with the Claude Agent SDK installed (so /api/claude/models returns the live
 * Opus 5 list). No claude message is sent in this test.
 *   PORT=9496 HOST=127.0.0.1 node /path/to/nanocode/server/index.js &
 */
import { test, expect } from 'playwright/test'
import os from 'node:os'
import path from 'node:path'

const SHOT_DIR = path.join(os.homedir(), 'codex_work', 'nano_claude_badge_shots')

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}

function workspaceUrl(project, allProjects) {
  const host = project.ssh_host ? slugify(project.ssh_host) : 'local'
  const siblings = allProjects.filter((p) => (project.ssh_host ? slugify(project.ssh_host) : 'local') === host)
  const base = slugify(project.name)
  const sameSlug = siblings.filter((p) => slugify(p.name) === base)
  const slug = sameSlug.length <= 1 ? base : `${base}-${sameSlug.indexOf(project) + 1}`
  return `/#/${host}/${slug}`
}

async function setupClaudeTab(request, label, overrides = {}) {
  const uniqueName = `claude-badge-${label}-${Date.now() % 100000}`
  const projectRes = await request.post('/api/projects', {
    data: { name: uniqueName, cwd: `/tmp/${uniqueName}` },
  })
  const project = await projectRes.json()
  const tabRes = await request.post(`/api/projects/${project.id}/tabs`, {
    data: { type: 'claude', label, renderMode: 'block', ...overrides },
  })
  const tab = await tabRes.json()
  const listRes = await request.get('/api/projects')
  const allProjects = await listRes.json()
  return { project, tab, url: workspaceUrl(project, allProjects) }
}

async function getTab(request, projectId, tabId) {
  const tabs = await (await request.get(`/api/projects/${projectId}/tabs`)).json()
  return tabs.find((t) => t.id === tabId)
}

// Click a claude picker button by its exact .cbr-model-picker-name label, so
// "high" never collides with "xhigh" and "Opus (1M context)" is unambiguous
// (the live list also has "Default (recommended)" — different exact label).
async function pickBtn(page, label) {
  await page.locator('.cbr-model-picker:not(.cbr-model-picker--codex) .cbr-model-picker-btn', {
    has: page.locator('.cbr-model-picker-name', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  }).click()
}

test.describe('claude block badge — picker selection updates badge live + persists', () => {
  test('badge "model" → pick Opus (1M) + high → badge shows opus live → reload persists', async ({ page, request }, testInfo) => {
    test.setTimeout(120_000)
    const { project, tab, url } = await setupClaudeTab(request, 'main')

    // 1–2. Navigate + activate the claude block tab → renderer mounts.
    await page.goto(url)
    await expect(page.locator('.tab-chip-label', { hasText: tab.label })).toBeVisible({ timeout: 10_000 })
    await page.locator('.tab-chip', { hasText: tab.label }).click()
    const pane = page.locator(`.pane-terminal.cbr-container[data-tab-id="${tab.id}"]`)
    await expect(pane).toBeAttached({ timeout: 15_000 })

    // 3. Badge shows "model" (no override, no reply yet).
    const badge = page.locator('#model-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('model')

    // 4. Open the picker via the badge → step 1 of 2 (model list).
    await badge.click()
    const picker = page.locator('.cbr-model-picker:not(.cbr-model-picker--codex)')
    await expect(picker).toBeVisible()
    await expect(picker.locator('.cbr-model-picker-header')).toContainText('step 1 of 2')

    // 5. Pick "Opus (1M context)" → step 2 of 2 (effort).
    await pickBtn(page, 'Opus (1M context)')
    await expect(picker.locator('.cbr-model-picker-header')).toContainText('step 2 of 2')
    await expect(picker.locator('.cbr-model-picker-header')).toContainText('Opus (1M context)')

    // 6. Pick "high" → picker closes, badge updates LIVE to contain "opus".
    await pickBtn(page, 'high')
    await expect(picker).not.toBeVisible()
    // The badge text is the model id with a leading "claude-" stripped; opus[1m]
    // has no such prefix so it shows verbatim. Assert it contains "opus".
    await expect(badge).toContainText('opus')
    await page.screenshot({ path: path.join(SHOT_DIR, 'claude-badge-after-select.png') })

    // 7. Reload → badge STILL shows the picked model (root-fix path: the old
    //    code read _modelByTab only, so a fresh page load with no turn yet
    //    always fell back to "model", hiding the persisted override).
    await page.reload()
    await expect(page.locator('.tab-chip-label', { hasText: tab.label })).toBeVisible({ timeout: 10_000 })
    await page.locator('.tab-chip', { hasText: tab.label }).click()
    await expect(page.locator(`.pane-terminal.cbr-container[data-tab-id="${tab.id}"]`)).toBeAttached({ timeout: 15_000 })
    await expect(badge).toContainText('opus')
    await page.screenshot({ path: path.join(SHOT_DIR, 'claude-badge-after-reload.png') })

    // 8. API confirms persistence.
    const tabAfter = await getTab(request, project.id, tab.id)
    expect(tabAfter.modelOverride).toBe('opus[1m]')
    expect(tabAfter.effortOverride).toBe('high')
  })
})
