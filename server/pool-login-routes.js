/**
 * HTTP layer for the one-click pool login (nanologin_2250) — parse → call →
 * respond only; the state machine and all process IO live in
 * terminal/pool-login.js (layering: this file never imports node-pty or
 * child_process directly).
 */
import express from 'express'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CC_CONFIG_PATH, loadCommandCenterConfig } from './command-center.js'
import { createQuotaSnapshotSource } from './command-center-quota.js'
import { buildPoolLoginView, createPoolLoginDriver, discoverLoginPools } from '../terminal/pool-login.js'

export const DUTY_STATUS_PATH = join(homedir(), 'code', 'duty-status.json')

async function quotaByLabel(quotaSnapshotSource, configPath) {
  const { config, error } = loadCommandCenterConfig(configPath)
  if (error) return new Map()
  const q = await quotaSnapshotSource.get(config.quotaDir, config.quotaStaleSec, {
    usageSnapLogPath: config.quotaUsageSnapLogPath,
    dispatchLogDirs: config.quotaDispatchLogDirs,
  })
  return new Map((q.data?.pools || []).map((p) => [p.pool, { ok: p.loggedIn, error: p.error, at: p.fetchedAt }]))
}

export function createPoolLoginRoutes({
  driver = createPoolLoginDriver(),
  quotaSnapshotSource = createQuotaSnapshotSource(),
  configPath = CC_CONFIG_PATH,
  dutyStatusPath = DUTY_STATUS_PATH,
  discover = discoverLoginPools,
} = {}) {
  const router = express.Router()

  async function resolvePool(id) {
    const pools = await discover({})
    return pools.find((p) => p.id === id) || null
  }

  router.get('/api/pool-login/pools', async (_req, res, next) => {
    try {
      const byLabel = await quotaByLabel(quotaSnapshotSource, configPath)
      const pools = await buildPoolLoginView({ dutyStatusPath, quotaByLabel: byLabel, discover })
      res.json({ pools: pools.map((p) => ({ ...p, login: driver.get(p.id) })) })
    } catch (err) { next(err) }
  })

  router.post('/api/pool-login/:id/start', async (req, res, next) => {
    try {
      const pool = await resolvePool(req.params.id)
      if (!pool) return res.status(404).json({ error: 'unknown pool' })
      res.json(await driver.start(pool))
    } catch (err) { next(err) }
  })

  router.get('/api/pool-login/:id/status', (req, res) => {
    res.json(driver.get(req.params.id))
  })

  router.post('/api/pool-login/:id/code', (req, res) => {
    const r = driver.submitCode(req.params.id, req.body?.code)
    if (!r.ok) return res.status(409).json(r)
    res.json(driver.get(req.params.id))
  })

  router.post('/api/pool-login/:id/cancel', (req, res) => {
    driver.cancel(req.params.id)
    res.json({ ok: true })
  })

  return router
}
