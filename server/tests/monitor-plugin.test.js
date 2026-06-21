/**
 * Tests for the monitor plugin.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPluginHost, loadPlugins } from '../plugin-host.js'
import { createStore } from '../store.js'

describe('monitor-plugin helpers', () => {
  it('parses the default lanes.json mapping', async () => {
    const { parseLanes } = await import('../../plugins/monitor/server.js')
    const lanes = parseLanes()
    const keys = lanes.map((l) => l.key)
    assert.deepEqual(keys, ['k26', 'k27', 'k49', 'k44', 'ncplugin'])

    const k26 = lanes.find((l) => l.key === 'k26')
    assert.equal(k26.issue, 'MES-13026')
    assert.equal(k26.worktree, 'wt-foot-ik')
    assert.equal(k26.tmux, 'loop-k26')
    assert.equal(k26.markerPrefix, 'k26')

    const ncplugin = lanes.find((l) => l.key === 'ncplugin')
    assert.equal(ncplugin.issue, 'MES-13256')
    assert.equal(ncplugin.worktree, 'nanocode2')
  })

  it('computes milestone % from markdown checkboxes', async () => {
    const { computeMilestonePercent } = await import('../../plugins/monitor/server.js')
    assert.equal(computeMilestonePercent('- [x] done\n- [ ] todo'), 50)
    assert.equal(computeMilestonePercent('- [x] a\n- [x] b\n- [ ] c'), 67)
    assert.equal(computeMilestonePercent('no checkboxes here'), null)
    assert.equal(computeMilestonePercent(''), null)
  })

  it('computes health levels from local signals', async () => {
    const { computeHealth } = await import('../../plugins/monitor/server.js')
    const thresholds = { failcount: 3, gitStale: 30, flagStale: 30 }

    assert.equal(computeHealth({ tmuxAlive: true, failcount: 0, flagExists: false }, thresholds).level, 'green')
    assert.equal(computeHealth({ tmuxAlive: true, failcount: 3, flagExists: false }, thresholds).level, 'red')
    assert.equal(computeHealth({ tmuxAlive: true, failcount: 1, flagExists: false }, thresholds).level, 'yellow')
    assert.equal(computeHealth({ tmuxAlive: false, failcount: 0, flagExists: false }, thresholds).level, 'red')
    assert.equal(
      computeHealth({ tmuxAlive: true, failcount: 0, flagExists: true, flagAgeMin: 60 }, thresholds).level,
      'red',
    )
    assert.equal(
      computeHealth({ tmuxAlive: true, failcount: 0, flagExists: false, lastCommitMin: 20 }, thresholds).level,
      'yellow',
    )
  })

  it('loads local config from a JSON file', async () => {
    const { loadLocalConfig } = await import('../../plugins/monitor/server.js')
    const dir = mkdtempSync(join(tmpdir(), 'monitor-config-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ linearApiKey: 'lin_api_test' }), 'utf8')
    try {
      const cfg = loadLocalConfig(path)
      assert.equal(cfg.linearApiKey, 'lin_api_test')
      assert.deepEqual(loadLocalConfig(join(dir, 'missing.json')), {})
    } finally {
      try { unlinkSync(path) } catch {}
    }
  })

  it('resolves Linear API key with config file precedence over host setting', async () => {
    const { resolveLinearApiKey } = await import('../../plugins/monitor/server.js')
    const host = { getSetting: (k) => (k === 'linear_api_key' ? 'from_host' : null) }

    assert.equal(resolveLinearApiKey({ linearApiKey: 'from_file' }, host), 'from_file')
    assert.equal(resolveLinearApiKey({}, host), 'from_host')
    assert.equal(resolveLinearApiKey(null, host), 'from_host')
    assert.equal(resolveLinearApiKey({}, { getSetting: () => null }), null)
  })
})

describe('monitor-plugin host integration', () => {
  let app
  let store
  let host
  const notifyMessages = []

  beforeEach(() => {
    // Prevent host-integration tests from reading the real local config and
    // making live Linear network calls.
    process.env.MONITOR_CONFIG_PATH = join(tmpdir(), 'monitor-config-missing-' + Date.now() + '.json')
    app = express()
    app.use(express.json())
    store = createStore(':memory:')
    notifyMessages.length = 0
    host = createPluginHost({ app, store, broadcastNotify: (msg) => notifyMessages.push(msg) })
  })

  afterEach(async () => {
    const mod = await import('../../plugins/monitor/server.js')
    mod.stop()
    // Give any in-flight git/tmux child processes time to exit.
    await new Promise((r) => setTimeout(r, 300))
  })

  it('registers /api/monitor routes', async () => {
    const mod = await import('../../plugins/monitor/server.js')
    mod.register(host)

    const routes = app._router.stack
      .filter((layer) => layer.route)
      .map((layer) => Object.keys(layer.route.methods)[0].toUpperCase() + ' ' + layer.route.path)

    assert.ok(routes.some((r) => r === 'GET /api/monitor/snapshot'))
    assert.ok(routes.some((r) => r === 'POST /api/monitor/tmux-focus'))
  })

  it('is loaded by plugin-host when plugin_monitor_enabled is true', async () => {
    store.setSetting('plugin_monitor_enabled', true)
    const loaded = await loadPlugins(host, { pluginsDir: new URL('../../plugins', import.meta.url).pathname })
    assert.ok(loaded.includes('monitor'))
    const defs = host.getAllSettingDefs()
    assert.ok(defs.some((d) => d.key === 'linear_api_key'))
  })

  it('is not loaded when plugin_monitor_enabled is false', async () => {
    store.setSetting('plugin_monitor_enabled', false)
    const loaded = await loadPlugins(host, { pluginsDir: new URL('../../plugins', import.meta.url).pathname })
    assert.ok(!loaded.includes('monitor'))
  })
})
