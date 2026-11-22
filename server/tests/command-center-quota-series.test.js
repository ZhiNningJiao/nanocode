// Six-pool available-quota curve: series from usage_snap.log lines
// (server/command-center-quota-series.js) + its route.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { parseUsageSnapLine } from '../command-center-quota.js'
import { buildQuotaSeries, createQuotaSeriesSource } from '../command-center-quota-series.js'
import { createCommandCenterRoutes } from '../command-center.js'

// Fixture files live in a gitignored dir inside this worktree — never host /tmp.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, '.fixtures-tmp', 'command-center-quota-series')

const NOW = Date.parse('2026-11-22T21:10:00+08:00')

function line(md, hm, team, h5, d7, r5, r7, tail = ' src=hdr') {
  return `${md} ${hm} .claude-team${team}: 5h=${h5}% 7d=${d7}% fable=? reset5h=${r5} reset7d=${r7} resetfb= extra=?${tail}`
}

const LOG = [
  line('11-20', '10:00', 1, 10, 90, '11-20T12:00', '11-21T09:00'),
  line('11-20', '10:00', 2, 0, 40, '11-20T14:00', '11-26T14:00'),
  '11-20 10:30 .claude-team1: AUTH_EXPIRED(last=5h=10.0%)',
  line('11-20', '10:30', 2, 5, 42, '11-20T14:00', '11-26T14:00'),
  // weekly reset of T1: 7d used 90 → 2
  line('11-21', '09:30', 1, 0, 2, '11-21T14:00', '11-28T09:00'),
  // no src= tag (usage-API lines end after extra=) — still a reading
  line('11-22', '21:00', 2, 10, 38, '11-22T23:30', '11-26T14:00', ''),
  line('11-22', '21:00', 1, 0, 35, '11-23T01:00', '11-24T09:00'),
  // too old: 8 days back
  line('11-14', '10:00', 1, 50, 50, '11-14T12:00', '11-20T09:00'),
]

function readings(lines = LOG) {
  return lines.map((l) => parseUsageSnapLine(l, NOW)).filter(Boolean)
}

describe('quota series: parse + build (pure)', () => {
  it('error / logged-out lines are skipped; lines without src= are read', () => {
    const r = readings()
    assert.equal(r.length, 7)
    assert.equal(parseUsageSnapLine(LOG[2], NOW), null)
    assert.equal(parseUsageSnapLine(LOG[5], NOW).raw.util_7d, 0.38)
  })
  it('time axis = union of snapshot times in the last 7 days; gaps carry the previous value', () => {
    const s = buildQuotaSeries(readings(), { nowMs: NOW })
    assert.deepEqual(s.pools, ['T1', 'T2'])
    assert.equal(s.points.length, 4) // 11-20 10:00, 10:30, 11-21 09:30, 11-22 21:00 (11-14 dropped)
    const at1030 = s.points[1]
    assert.deepEqual(at1030.pools.T1, { r7: 10, r5: 90 }) // carried from 10:00 (the 10:30 T1 line is an error)
    assert.deepEqual(at1030.pools.T2, { r7: 58, r5: 95 })
    assert.equal(at1030.total7d, 0.68)
    assert.equal(at1030.counted, 2)
  })
  it('a 7-day used drop of ≥ 15 points is one weekly reset (the spike)', () => {
    const s = buildQuotaSeries(readings(), { nowMs: NOW })
    assert.equal(s.resets.length, 1)
    assert.equal(s.resets[0].pool, 'T1')
    assert.equal(s.resets[0].beforeR7, 10)
    assert.equal(s.resets[0].afterR7, 98)
    // a smaller drop is not a reset
    const small = buildQuotaSeries(readings([line('11-21', '10:00', 3, 0, 50, '', ''), line('11-21', '10:30', 3, 0, 40, '', '')]), { nowMs: NOW })
    assert.equal(small.resets.length, 0)
  })
  it('upcoming resets come from each pool\'s latest reading, inside the next 7 days, gain = used now', () => {
    const s = buildQuotaSeries(readings(), { nowMs: NOW })
    const at = (pool, kind) => s.upcoming.find((u) => u.pool === pool && u.kind === kind)
    assert.equal(at('T1', '7d').at, new Date('2026-11-24T09:00:00+08:00').toISOString())
    assert.equal(at('T1', '7d').gainPct, 35)
    assert.equal(at('T2', '5h').gainPct, 10)
    assert.deepEqual(s.upcoming.map((u) => u.at), [...s.upcoming.map((u) => u.at)].sort())
    assert.deepEqual(s.latest.T2, { fetchedAt: new Date('2026-11-22T21:00:00+08:00').toISOString(), r7: 62, r5: 90 })
  })
  it('needs an explicit now; empty input → empty series', () => {
    assert.throws(() => buildQuotaSeries([], {}), /nowMs/)
    const s = buildQuotaSeries([], { nowMs: NOW })
    assert.deepEqual(s.points, [])
    assert.deepEqual(s.pools, [])
  })
})

describe('quota series: source + route', () => {
  let server
  let base
  before(async () => {
    await mkdir(FIXTURE_DIR, { recursive: true })
    await writeFile(path.join(FIXTURE_DIR, 'usage_snap.log'), `${LOG.join('\n')}\n`)
    await writeFile(path.join(FIXTURE_DIR, 'cfg.json'), JSON.stringify({
      linear: { rootIssue: 'T-1', graphqlUrl: 'https://tracker.example/graphql' }, carsExport: { path: path.join(FIXTURE_DIR, 'cars.json') },
      quota: { usageSnapLogPath: path.join(FIXTURE_DIR, 'usage_snap.log') },
    }))
    await writeFile(path.join(FIXTURE_DIR, 'cfg-noquota.json'), JSON.stringify({
      linear: { rootIssue: 'T-1', graphqlUrl: 'https://tracker.example/graphql' }, carsExport: { path: path.join(FIXTURE_DIR, 'cars.json') },
    }))
    const app = express()
    const quotaSeriesSource = createQuotaSeriesSource({ now: () => NOW })
    app.use(createCommandCenterRoutes({ configPath: path.join(FIXTURE_DIR, 'cfg.json'), quotaSeriesSource }))
    app.use('/off', createCommandCenterRoutes({ configPath: path.join(FIXTURE_DIR, 'cfg-noquota.json') }))
    await new Promise((r) => { server = app.listen(0, 'localhost', r) })
    base = `http://localhost:${server.address().port}`
  })
  after(async () => {
    await new Promise((r) => server.close(r))
    await rm(FIXTURE_DIR, { recursive: true, force: true })
  })

  it('GET /api/command-center/quota/series returns the series + source, no local paths', async () => {
    const d = await (await fetch(`${base}/api/command-center/quota/series`)).json()
    assert.equal(d.configured, true)
    assert.equal(d.source.ok, true)
    assert.equal(d.points.length, 4)
    assert.equal(d.resets.length, 1)
    assert.ok(!JSON.stringify(d).includes(FIXTURE_DIR))
  })
  it('no log configured → says so (never an empty curve posing as "no quota")', async () => {
    const d = await (await fetch(`${base}/off/api/command-center/quota/series`)).json()
    assert.equal(d.source.ok, false)
    assert.match(d.source.error, /usageSnapLogPath not configured/)
    assert.equal(d.points, undefined)
  })
  it('unreadable log → error, not a crash', async () => {
    const src = createQuotaSeriesSource({ now: () => NOW })
    const r = await src.get(path.join(FIXTURE_DIR, 'missing.log'))
    assert.equal(r.ok, false)
    assert.match(r.error, /unreadable/)
  })
})
