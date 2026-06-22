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

  it('detects team configuration from credentials file presence only', async () => {
    const { isTeamConfigured } = await import('../../plugins/monitor/server.js')
    const dir = mkdtempSync(join(tmpdir(), 'monitor-team-'))
    assert.equal(isTeamConfigured(dir), false)
    writeFileSync(join(dir, '.credentials.json'), '{}', 'utf8')
    assert.equal(isTeamConfigured(dir), true)
  })

  it('classifies claude processes into teams', async () => {
    const { classifyClaudeProcess } = await import('../../plugins/monitor/server.js')
    assert.equal(classifyClaudeProcess('bash -lc claude --skip'), 'team1')
    assert.equal(classifyClaudeProcess('/usr/bin/claude --resume abc'), 'team1')
    assert.equal(classifyClaudeProcess('/usr/bin/codex --resume abc'), null)
    assert.equal(classifyClaudeProcess('/usr/bin/claude --resume abc', '/home/u/.claude-team2'), 'team2')
    assert.equal(classifyClaudeProcess('CLAUDE_CONFIG_DIR=/home/u/.claude-team2 /usr/bin/claude'), 'team2')
  })

  it('parses ps output into structured records', async () => {
    const { parsePsLines } = await import('../../plugins/monitor/server.js')
    const sample = `  PID COMMAND         ELAPSED ARGS
 1234 claude             1234 /usr/bin/claude --resume abc
 5678 bash                999 bash -lc claude --skip
 9012 codex               100 /usr/bin/codex do thing
`
    const recs = parsePsLines(sample)
    assert.equal(recs.length, 3)
    assert.deepEqual(recs[0], { pid: 1234, comm: 'claude', etimes: 1234, args: '/usr/bin/claude --resume abc' })
  })

  it('detects rate-limit/usage-limit/429 signals in recent log text', async () => {
    const { parseRateLimitSignals } = await import('../../plugins/monitor/server.js')
    assert.deepEqual(parseRateLimitSignals('all good here'), { limited: false, resetAt: null, reason: null })

    const rate = parseRateLimitSignals('error: rate-limit exceeded, reset at 14:32:10')
    assert.equal(rate.limited, true)
    assert.equal(rate.reason, 'rate limit')
    assert.ok(rate.resetAt)

    const usage = parseRateLimitSignals('usage-limit hit, resets in 15m')
    assert.equal(usage.limited, true)
    assert.equal(usage.reason, 'usage limit')
    assert.ok(usage.resetAt)

    const four29 = parseRateLimitSignals('received 429 Too Many Requests')
    assert.equal(four29.limited, true)
    assert.equal(four29.reason, '429')
  })

  it('computes team health from rate-limit signals', async () => {
    const { computeTeamHealth } = await import('../../plugins/monitor/server.js')
    assert.deepEqual(computeTeamHealth({ limited: false }, 1), { emoji: '🟢', level: 'green', reason: 'active' })
    assert.deepEqual(computeTeamHealth({ limited: true, reason: '429' }, 1), { emoji: '🟡', level: 'yellow', reason: '429' })
    assert.deepEqual(computeTeamHealth({ limited: false }, 0), { emoji: '🟢', level: 'green', reason: 'idle' })
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

  it('snapshot includes teams array', async () => {
    const mod = await import('../../plugins/monitor/server.js')
    mod.register(host)

    // Wait for the first local refresh (which also collects teams).
    await new Promise((r) => setTimeout(r, 1200))

    const res = await new Promise((resolve, reject) => {
      const req = { method: 'GET', url: '/api/monitor/snapshot' }
      const res = { json: (body) => resolve({ statusCode: 200, body }) }
      const route = app._router.stack.find((layer) => layer.route && layer.route.path === '/api/monitor/snapshot')
      if (!route) return reject(new Error('snapshot route not found'))
      route.route.stack[0].handle(req, res)
    })

    assert.equal(res.statusCode, 200)
    assert.ok(Array.isArray(res.body.teams))
    assert.equal(res.body.teams.length, 2)
    assert.ok(res.body.teams.some((t) => t.key === 'team1'))
    assert.ok(res.body.teams.some((t) => t.key === 'team2'))
    for (const team of res.body.teams) {
      assert.equal(typeof team.configured, 'boolean')
      assert.equal(typeof team.activeCount, 'number')
      assert.ok(team.rateLimit)
      assert.equal(typeof team.rateLimit.emoji, 'string')
    }
  })
})
