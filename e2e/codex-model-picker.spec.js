/**
 * Codex tab model picker — Playwright e2e.
 *
 * Flow (real clicks, no mocks):
 *   A. Badge + two-step picker + persistence
 *      1. Create a codex tab via REST API (no override).
 *      2. Open the workspace, activate the codex tab → block renderer mounts.
 *      3. The #model-badge shows "model" (no override yet) → click opens the
 *         codex picker (step 1 of 2: model list + Custom…).
 *      4. Pick "gpt-5.5" → step 2 of 2 (reasoning effort list).
 *      5. Pick "medium" → picker closes, badge updates to "gpt-5.5".
 *      6. Reload → badge still "gpt-5.5" (persisted); API confirms
 *         modelOverride="gpt-5.5", effortOverride="medium".
 *
 *   B. /model <name> command
 *      7. Type "/model gpt-5.6" + Enter → badge updates to "gpt-5.6".
 *      8. API confirms modelOverride="gpt-5.6" (effortOverride preserved).
 *
 *   C. Real codex turn → session-info header shows the resolved model+effort
 *      9. Set gpt-5.5 + high via the picker, send "Reply with exactly: hi".
 *     10. The codex driver emits a nanocode:session-info event at thread
 *         creation; the renderer's session-info bar must show
 *         "gpt-5.5" and "effort: high" (selection visibly effective on the
 *         next turn — the SDK's own events don't carry the model, so the
 *         driver surfaces it).
 *
 * Prerequisite: a test server on $TEST_PORT (default 9477) with codex_driver=sdk
 * and a working OPENAI_API_KEY (test C runs a real codex turn).
 *   PORT=9493 node /path/to/nanocode/server/index.js &
 */
import { test, expect } from 'playwright/test'
import os from 'node:os'
import path from 'node:path'

const SHOT_DIR = path.join(os.homedir(), 'codex_work', 'nano_codex_model_picker_shots')

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

async function setupCodexTab(request, label, overrides = {}) {
  const uniqueName = `codex-mp-${label}-${Date.now() % 100000}`
  const projectRes = await request.post('/api/projects', {
    data: { name: uniqueName, cwd: `/tmp/${uniqueName}` },
  })
  const project = await projectRes.json()
  const tabRes = await request.post(`/api/projects/${project.id}/tabs`, {
    data: { type: 'codex', label, renderMode: 'block', ...overrides },
  })
  const tab = await tabRes.json()
  const listRes = await request.get('/api/projects')
  const allProjects = await listRes.json()
  const url = workspaceUrl(project, allProjects)
  return { project, tab, url }
}

async function getTab(request, projectId, tabId) {
  const tabs = await (await request.get(`/api/projects/${projectId}/tabs`)).json()
  return tabs.find((t) => t.id === tabId)
}

// Click a codex picker button by its exact label (the .cbr-model-picker-name
// span text), so "high" doesn't collide with "xhigh" (substring match).
async function pickBtn(page, label) {
  await page.locator('.cbr-model-picker--codex .cbr-model-picker-btn', {
    has: page.locator('.cbr-model-picker-name', { hasText: new RegExp(`^${label}$`) }),
  }).click()
}

test.describe('codex tab model picker — badge, two-step picker, /model, session-info', () => {
  test('badge → picker → persist → /model → real turn shows session-info', async ({ page, request }, testInfo) => {
    test.setTimeout(120_000)
    const { project, tab, url } = await setupCodexTab(request, 'main')

    // ── A. Badge + two-step picker + persistence ───────────────────────────
    await page.goto(url)
    await expect(page.locator('.tab-chip-label', { hasText: tab.label })).toBeVisible({ timeout: 10_000 })
    await page.locator('.tab-chip', { hasText: tab.label }).click()

    // Codex block renderer mounts (codexRenderMode=block on 9493). The
    // renderer adds `.cbx-container` as a CLASS on the pane element itself
    // (not a child) — same pattern as claude's `.cbr-container`.
    const pane = page.locator(`.pane-terminal.cbx-container[data-tab-id="${tab.id}"]`)
    await expect(pane).toBeAttached({ timeout: 15_000 })

    // Badge shows "model" (no override yet).
    const badge = page.locator('#model-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('model')

    // Open the picker via the badge.
    await badge.click()
    const picker = page.locator('.cbr-model-picker--codex')
    await expect(picker).toBeVisible()
    await expect(picker.locator('.cbr-model-picker-header')).toContainText('step 1 of 2')

    // Step 1: pick "gpt-5.5".
    await pickBtn(page, 'gpt-5.5')
    await expect(picker.locator('.cbr-model-picker-header')).toContainText('step 2 of 2')
    await expect(picker.locator('.cbr-model-picker-header')).toContainText('gpt-5.5')

    // Step 2: pick "medium".
    await pickBtn(page, 'medium')
    await expect(picker).not.toBeVisible()
    await expect(badge).toHaveText('gpt-5.5')

    // Screenshot after picker selection.
    await page.screenshot({ path: path.join(SHOT_DIR, 'codex-picker-after-select.png') })

    // Reload → persisted.
    await page.reload()
    await expect(page.locator('.tab-chip-label', { hasText: tab.label })).toBeVisible({ timeout: 10_000 })
    await page.locator('.tab-chip', { hasText: tab.label }).click()
    await expect(page.locator(`.pane-terminal.cbx-container[data-tab-id="${tab.id}"]`)).toBeAttached({ timeout: 15_000 })
    await expect(badge).toHaveText('gpt-5.5')

    // API confirms persistence.
    const tabAfter = await getTab(request, project.id, tab.id)
    expect(tabAfter.modelOverride).toBe('gpt-5.5')
    expect(tabAfter.effortOverride).toBe('medium')

    // ── B. /model <name> command ──────────────────────────────────────────
    const chatInput = page.locator('#chat-input')
    await chatInput.fill('/model gpt-5.6')
    await chatInput.press('Enter')
    await expect(badge).toHaveText('gpt-5.6')
    const tabAfterCmd = await getTab(request, project.id, tab.id)
    expect(tabAfterCmd.modelOverride).toBe('gpt-5.6')
    expect(tabAfterCmd.effortOverride).toBe('medium') // preserved

    // ── C. Real codex turn → session-info header ──────────────────────────
    // Re-select gpt-5.5 + high so the session-info bar shows a known pair.
    await badge.click()
    await pickBtn(page, 'gpt-5.5')
    await pickBtn(page, 'high')
    await expect(badge).toHaveText('gpt-5.5')

    await chatInput.fill('Reply with exactly: hi')
    await chatInput.press('Enter')

    // The driver emits nanocode:session-info at thread creation (before turn
    // completion), so the session-info bar appears within a few seconds.
    const sessionInfo = page.locator(`.pane-terminal[data-tab-id="${tab.id}"] .cbx-session-info`)
    await expect(sessionInfo).toBeVisible({ timeout: 60_000 })
    await expect(sessionInfo.locator('.cbx-si-model')).toHaveText('gpt-5.5', { timeout: 30_000 })
    await expect(sessionInfo.locator('.cbx-si-effort')).toContainText('high', { timeout: 30_000 })

    await page.screenshot({ path: path.join(SHOT_DIR, 'codex-session-info.png') })
  })
})
