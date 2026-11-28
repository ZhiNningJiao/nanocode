/**
 * nanoquota_1340 — /api/command-center/quota used to scan the shared (sshfs)
 * quota-readings dir inline on every request: a stalled mount turned a ~1ms
 * endpoint into 5–30s (REPORT_nanoquota_1340.md). createQuotaSnapshotSource
 * (command-center-quota.js) now serves a background-refreshed snapshot
 * instead. This test reproduces the stall the same way home-fs-stall.test.js
 * does: a FIFO with no writer makes `readFile` hang exactly like a stuck
 * sshfs read, then proves the route keeps answering fast anyway.
 */
import { describe, it } from 'node:test'
import { setupSuite } from './fixtures/suite-hooks.mjs'

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { open as fsOpen } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { createCommandCenterRoutes } from '../command-center.js'
import { createQuotaSnapshotSource } from '../command-center-quota.js'

const hasMkfifo = spawnSync('mkfifo', ['--version'], { stdio: 'ignore' }).status === 0
const BUDGET_MS = 200

describe('quota route survives a stalled quota-dir read', { skip: !hasMkfifo && 'mkfifo not available' }, () => {
  let root, dir, server, base

  setupSuite(async () => {
    root = mkdtempSync(join(tmpdir(), 'nano-quotastall-'))
    dir = join(root, 'quota')
    mkdirSync(dir, { recursive: true })
    const fresh = {
      pool: 'T1', fetched_at: new Date().toISOString(), util_5h: 0.42,
      reset_5h_bjt: new Date(Date.now() + 3600e3).toISOString(), util_7d: 0.1,
      reset_7d_bjt: new Date(Date.now() + 86400e3).toISOString(),
      status: 'allowed', overage_status: 'allowed', error: null,
    }
    writeFileSync(join(dir, 'T1.json'), JSON.stringify(fresh))
    const carsPath = join(root, 'cars.json')
    writeFileSync(carsPath, JSON.stringify({ schema: 1, exported_at: new Date().toISOString(), ok: true, gantt: { bars: [] } }))
    const configPath = join(root, 'cfg.json')
    writeFileSync(configPath, JSON.stringify({
      linear: { rootIssue: 'T-1', graphqlUrl: 'https://tracker.example/graphql' },
      carsExport: { path: carsPath },
      quota: { dir },
    }))
    const app = express()
    // ttlMs small on purpose: forces a background rescan (and so the FIFO
    // hang) within the test's polling window, instead of waiting out the
    // production 10s cadence. scanTimeoutMs stays at the real (very large)
    // default — the point of this test is that the stall must NOT wipe the
    // last good snapshot.
    app.use(createCommandCenterRoutes({ configPath, quotaSnapshotSource: createQuotaSnapshotSource({ ttlMs: 150 }) }))
    await new Promise((r) => { server = app.listen(0, 'localhost', r) })
    base = `http://localhost:${server.address().port}`
  },
  async () => { if (server) await new Promise((r) => server.close(r)) },
  // Unblock the FIFO's pending open() (a writer appearing lets the stuck
  // read see EOF) before removing the directory, so no libuv worker / home-fs
  // slot (bounded-scan.js HOME_FS_CONCURRENCY) stays pinned after this test.
  async () => { if (dir) { try { const fh = await fsOpen(join(dir, 'T2.json'), 'w'); await fh.close() } catch {} } },
  () => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('keeps responding under budget once a file added to the quota dir hangs on read', async () => {
    // Wait for the first real snapshot (must show T1, not a "pending" row).
    const until0 = Date.now() + 2000
    let d
    while (Date.now() < until0) {
      d = await (await fetch(`${base}/api/command-center/quota`)).json()
      if (d.source?.ok) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(d.source?.ok, true, 'must produce a real snapshot before the stall starts')
    assert.equal(d.pools[0]?.pool, 'T1')

    // Introduce the stall: a FIFO with no writer never finishes `readFile` —
    // the next background rescan (ttlMs=150ms) hangs on it forever.
    assert.equal(spawnSync('mkfifo', [join(dir, 'T2.json')]).status, 0)

    const worst = { ms: 0 }
    const failures = []
    const until = Date.now() + 1500
    while (Date.now() < until) {
      const t0 = Date.now()
      const res = await fetch(`${base}/api/command-center/quota`, { signal: AbortSignal.timeout(2000) })
      const body = await res.json()
      const ms = Date.now() - t0
      worst.ms = Math.max(worst.ms, ms)
      if (res.status !== 200) failures.push(`status ${res.status} after ${ms}ms`)
      else if (ms >= BUDGET_MS) failures.push(`took ${ms}ms`)
      // the stalled scan must never wipe the last good T1 reading either.
      if (body.source?.ok && body.pools?.[0]?.pool !== 'T1') failures.push(`snapshot lost its pool row: ${JSON.stringify(body.pools)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.deepEqual(failures, [], `every quota request must answer within ${BUDGET_MS}ms while the dir scan hangs (worst ${worst.ms}ms)`)
  })
})

describe('quota route: true cold start (no snapshot has ever completed)', () => {
  let root, dir, server, base

  setupSuite(async () => {
    root = mkdtempSync(join(tmpdir(), 'nano-quotacold-'))
    dir = join(root, 'quota')
    mkdirSync(dir, { recursive: true })
    if (hasMkfifo) assert.equal(spawnSync('mkfifo', [join(dir, 'T1.json')]).status, 0)
    const carsPath = join(root, 'cars.json')
    writeFileSync(carsPath, JSON.stringify({ schema: 1, exported_at: new Date().toISOString(), ok: true, gantt: { bars: [] } }))
    const configPath = join(root, 'cfg.json')
    writeFileSync(configPath, JSON.stringify({
      linear: { rootIssue: 'T-1', graphqlUrl: 'https://tracker.example/graphql' },
      carsExport: { path: carsPath },
      quota: { dir },
    }))
    const app = express()
    app.use(createCommandCenterRoutes({ configPath }))
    await new Promise((r) => { server = app.listen(0, 'localhost', r) })
    base = `http://localhost:${server.address().port}`
  },
  async () => { if (server) await new Promise((r) => server.close(r)) },
  async () => { if (hasMkfifo && dir) { try { const fh = await fsOpen(join(dir, 'T1.json'), 'w'); await fh.close() } catch {} } },
  () => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('the very first request (quota dir unreadable from the start) answers fast with "reading in progress", not a hang', { skip: !hasMkfifo && 'mkfifo not available' }, async () => {
    const t0 = Date.now()
    const res = await fetch(`${base}/api/command-center/quota`, { signal: AbortSignal.timeout(2000) })
    const body = await res.json()
    const ms = Date.now() - t0
    assert.equal(res.status, 200)
    assert.ok(ms < BUDGET_MS, `first-ever request took ${ms}ms (budget ${BUDGET_MS}ms)`)
    assert.equal(body.source.ok, false)
    assert.equal(body.source.pending, true)
    assert.deepEqual(body.pools, [])
  })
})
