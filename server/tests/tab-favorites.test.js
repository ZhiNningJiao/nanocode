/**
 * 需求16: session-group favorites — store, route, and seed tests.
 *
 * Covers:
 *  - store round-trips favorite / favoriteOrder / renderMode (+ modelOverride)
 *  - backward compat: legacy tabs without favorite fields do not crash
 *  - PATCH /api/projects/:id/tabs/:tabId/favorite toggles + assigns order +
 *    broadcasts tabs:update; 404 for unknown tab
 *  - POST /api/projects/:id/tabs creates a tab already favorited + locked
 *  - seedSecretaryFavorites: seed-into-home, reconcile-by-label (no dup),
 *    idempotent (flag-gated), non-home project untouched, no-op when home
 *    project absent (flag stays unset so a later startup can retry)
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

// ---- HTTP route harness (mirrors tab-model-override.test.js) ----

class MockWs extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
}

function invokeRoute(router, method, url, body = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, body, query: {}, headers: {} }
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
      end() {
        resolve({ statusCode: this.statusCode, payload: undefined })
      },
    }
    router.handle(req, res, (err) => {
      if (err) reject(err)
      else resolve({ statusCode: res.statusCode, payload: undefined })
    })
  })
}

// ===========================================================================

describe('tab favorites — store round-trip', () => {
  it('createTab persists favorite / favoriteOrder / renderMode / modelOverride', () => {
    const store = createStore(':memory:')
    const project = store.createProject('P', '/tmp/p')
    const tab = store.createTab(project.id, {
      type: 'claude',
      label: '秘书T1',
      favorite: true,
      favoriteOrder: 0,
      renderMode: 'block',
      modelOverride: 'claude-fable-5',
    })
    assert.equal(tab.favorite, true)
    assert.equal(tab.favoriteOrder, 0)
    assert.equal(tab.renderMode, 'block')
    assert.equal(tab.modelOverride, 'claude-fable-5')

    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.favorite, true)
    assert.equal(fetched.renderMode, 'block')
    assert.equal(fetched.modelOverride, 'claude-fable-5')

    const listed = store.listTabs(project.id).find((t) => t.id === tab.id)
    assert.equal(listed.favorite, true)
    assert.equal(listed.modelOverride, 'claude-fable-5')
  })

  it('updateTabMetadata round-trips favorite / favoriteOrder / renderMode', () => {
    const store = createStore(':memory:')
    const project = store.createProject('P', '/tmp/p')
    const tab = store.createTab(project.id, { type: 'claude', label: 'c1' })

    const updated = store.updateTabMetadata(project.id, tab.id, {
      favorite: true,
      favoriteOrder: 2,
      renderMode: 'block',
    })
    assert.equal(updated.favorite, true)
    assert.equal(updated.favoriteOrder, 2)
    assert.equal(updated.renderMode, 'block')

    // Clear favorite → favorite:false (still present, order left in place).
    const cleared = store.updateTabMetadata(project.id, tab.id, { favorite: false })
    assert.equal(cleared.favorite, false)
    // favoriteOrder stays (the route/strip ignores it once favorite is false).
    assert.equal(cleared.favoriteOrder, 2)
  })

  it('legacy tabs (no favorite fields) do not crash and stay undefined', () => {
    const store = createStore(':memory:')
    const project = store.createProject('P', '/tmp/p')
    const tab = store.createTab(project.id, { type: 'bash', label: 'bash 1' })
    // A plain bash tab has no favorite / renderMode / modelOverride at all.
    assert.equal(tab.favorite, undefined)
    assert.equal(tab.renderMode, undefined)
    assert.equal(tab.modelOverride, undefined)
    // Listing still works and the fields are simply absent (not crashing the
    // frontend's `tab.favorite === true` / `tab.modelOverride || global` reads).
    const listed = store.listTabs(project.id)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].favorite, undefined)
  })
})

describe('PATCH /api/projects/:id/tabs/:tabId/favorite', () => {
  it('pins a tab (favorite=true) and assigns a favoriteOrder past the existing pins', async () => {
    const tempRoot = makeTempDir('nano-fav-route-')
    const cwd = path.join(tempRoot, 'ws')
    mkdirSync(cwd, { recursive: true })
    const store = createStore(':memory:')
    const project = store.createProject('P', cwd)
    const first = store.createTab(project.id, { type: 'claude', label: 'A', favorite: true, favoriteOrder: 0 })
    const second = store.createTab(project.id, { type: 'claude', label: 'B' })

    const { router } = createTerminalRoutes(store)
    const res = await invokeRoute(router, 'PATCH', `/api/projects/${project.id}/tabs/${second.id}/favorite`, { favorite: true })
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.favorite, true)
    // Newly-pinned tab lands AFTER the already-pinned first (order 1, not 0).
    assert.equal(res.payload.favoriteOrder, 1)
    // The previously-pinned tab is untouched.
    assert.equal(store.getTab(project.id, first.id).favoriteOrder, 0)
  })

  it('unpins a tab (favorite=false)', async () => {
    const tempRoot = makeTempDir('nano-fav-route-')
    const cwd = path.join(tempRoot, 'ws')
    mkdirSync(cwd, { recursive: true })
    const store = createStore(':memory:')
    const project = store.createProject('P', cwd)
    const tab = store.createTab(project.id, { type: 'claude', label: 'A', favorite: true, favoriteOrder: 0 })

    const { router } = createTerminalRoutes(store)
    const res = await invokeRoute(router, 'PATCH', `/api/projects/${project.id}/tabs/${tab.id}/favorite`, { favorite: false })
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.favorite, false)
    assert.equal(store.getTab(project.id, tab.id).favorite, false)
  })

  it('returns 404 for an unknown tab', async () => {
    const tempRoot = makeTempDir('nano-fav-route-')
    const cwd = path.join(tempRoot, 'ws')
    mkdirSync(cwd, { recursive: true })
    const store = createStore(':memory:')
    const project = store.createProject('P', cwd)
    const { router } = createTerminalRoutes(store)
    const res = await invokeRoute(router, 'PATCH', `/api/projects/${project.id}/tabs/nope/favorite`, { favorite: true })
    assert.equal(res.statusCode, 404)
  })

  it('broadcasts tabs:update with the new favorite flag', async () => {
    const tempRoot = makeTempDir('nano-fav-route-')
    const cwd = path.join(tempRoot, 'ws')
    mkdirSync(cwd, { recursive: true })
    const store = createStore(':memory:')
    const project = store.createProject('P', cwd)
    const tab = store.createTab(project.id, { type: 'claude', label: 'c1' })

    const { router, handleTabsWs } = createTerminalRoutes(store)
    const ws = new MockWs()
    handleTabsWs(ws)
    ws.emit('message', JSON.stringify({ type: 'subscribe', projectId: project.id }))

    await invokeRoute(router, 'PATCH', `/api/projects/${project.id}/tabs/${tab.id}/favorite`, { favorite: true })

    const updates = ws.sent.filter((m) => m.type === 'tabs:update')
    assert.ok(updates.length >= 2, 'expected subscribe snapshot + PATCH broadcast')
    const last = updates[updates.length - 1]
    const broadcasted = (last.tabs || []).find((t) => t.id === tab.id)
    assert.ok(broadcasted, 'patched tab must appear in the broadcast')
    assert.equal(broadcasted.favorite, true)
  })
})

describe('POST /api/projects/:id/tabs creates a favorited + locked tab', () => {
  it('passes favorite / renderMode / modelOverride through to createTab', async () => {
    const tempRoot = makeTempDir('nano-fav-post-')
    const cwd = path.join(tempRoot, 'ws')
    mkdirSync(cwd, { recursive: true })
    const store = createStore(':memory:')
    const project = store.createProject('P', cwd)

    const { router } = createTerminalRoutes(store)
    const res = await invokeRoute(router, 'POST', `/api/projects/${project.id}/tabs`, {
      type: 'claude',
      label: '生活小助手',
      favorite: true,
      favoriteOrder: 3,
      renderMode: 'block',
      modelOverride: 'claude-sonnet-4-6',
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.payload.favorite, true)
    assert.equal(res.payload.renderMode, 'block')
    assert.equal(res.payload.modelOverride, 'claude-sonnet-4-6')
    assert.equal(res.payload.favoriteOrder, 3)
    assert.equal(store.getTab(project.id, res.payload.id).modelOverride, 'claude-sonnet-4-6')
  })
})

describe('seedSecretaryFavorites', () => {
  it('creates all four favorites in the home project when none exist', () => {
    const store = createStore(':memory:')
    const home = '/tmp/home-seed-fresh'
    store.createProject('zhiningjiao', home)

    const changed = store.seedSecretaryFavorites(home)
    assert.equal(changed, true)
    const tabs = store.listTabs(store.listProjects().find((p) => p.cwd === home).id)
    assert.equal(tabs.length, 4)
    const byLabel = Object.fromEntries(tabs.map((t) => [t.label, t]))
    assert.equal(byLabel['秘书T1'].favorite, true)
    assert.equal(byLabel['秘书T1'].modelOverride, 'claude-fable-5')
    assert.equal(byLabel['秘书T1'].renderMode, 'block')
    assert.equal(byLabel['秘书T2'].modelOverride, 'claude-fable-5')
    assert.equal(byLabel['Codex秘书'].type, 'codex')
    assert.equal(byLabel['Codex秘书'].modelOverride, 'gpt-5.6')
    assert.equal(byLabel['生活小助手'].modelOverride, 'claude-sonnet-4-6')
    // favoriteOrder 0..3 in spec order so the strip pins them predictably.
    assert.deepEqual(tabs.map((t) => t.favoriteOrder).sort((a, b) => a - b), [0, 1, 2, 3])
    // The flag is set so a second startup does not re-seed.
    assert.equal(store.getSetting('secretary_favorites_seeded_v1'), '1')
  })

  it('reconciles by label (no duplicate) and only fills ABSENT fields', () => {
    const store = createStore(':memory:')
    const home = '/tmp/home-seed-reconcile'
    const project = store.createProject('zhiningjiao', home)
    // Master already has 秘书T1 (claude) with a model they chose themselves —
    // the seed must NOT overwrite that model, only pin + block where absent.
    store.createTab(project.id, { type: 'claude', label: '秘书T1', modelOverride: 'claude-opus-4-8' })
    // And a plain bash tab that must be left alone (not a favorite candidate).
    store.createTab(project.id, { type: 'bash', label: 'bash 1' })

    const changed = store.seedSecretaryFavorites(home)
    assert.equal(changed, true)
    const tabs = store.listTabs(project.id)
    // 1 pre-existing 秘书T1 + 1 bash + 3 newly created (秘书T2/Codex秘书/生活小助手) = 5.
    assert.equal(tabs.length, 5)
    const t1 = tabs.find((t) => t.label === '秘书T1' && t.type === 'claude')
    assert.equal(t1.favorite, true)
    assert.equal(t1.renderMode, 'block')
    // The master's own model choice is preserved (NOT overwritten with fable-5).
    assert.equal(t1.modelOverride, 'claude-opus-4-8')
    const bash = tabs.find((t) => t.label === 'bash 1' && t.type === 'bash')
    assert.equal(bash.favorite, undefined)
  })

  it('is idempotent — a second call is a no-op once the flag is set', () => {
    const store = createStore(':memory:')
    const home = '/tmp/home-seed-idem'
    store.createProject('zhiningjiao', home)
    store.seedSecretaryFavorites(home)
    const before = store.listTabs(store.listProjects().find((p) => p.cwd === home).id).length
    const changed = store.seedSecretaryFavorites(home)
    assert.equal(changed, false)
    const after = store.listTabs(store.listProjects().find((p) => p.cwd === home).id).length
    assert.equal(after, before)
  })

  it('does not touch a non-home project', () => {
    const store = createStore(':memory:')
    store.createProject('other', '/tmp/other-cwd')
    store.seedSecretaryFavorites('/tmp/home-different')
    // No home project at /tmp/home-different → no seeding, flag NOT set.
    assert.equal(store.getSetting('secretary_favorites_seeded_v1'), null)
    const other = store.listProjects().find((p) => p.cwd === '/tmp/other-cwd')
    assert.equal(store.listTabs(other.id).length, 0)
  })

  it('returns false (and does not set the flag) when the home project is absent', () => {
    const store = createStore(':memory:')
    store.createProject('other', '/tmp/other-cwd')
    const changed = store.seedSecretaryFavorites('/tmp/no-such-home')
    assert.equal(changed, false)
    // Flag stays unset so a later startup (once the home project is created)
    // can still seed.
    assert.equal(store.getSetting('secretary_favorites_seeded_v1'), null)
  })
})
