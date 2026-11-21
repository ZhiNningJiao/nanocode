/**
 * nanofix2_0120 — "freshest reading per pool" for the Command Center quota
 * block. Covers the three parsers (cache-dir JSON already covered in
 * command-center-phase2.test.js's "quota mapping" suite; this file adds
 * usage_snap.log lines and dispatch-log QUOTA_HDR lines) and the merge in
 * createQuotaSource.get() that picks, per pool, whichever of the three
 * sources has the newest fetched_at — so a pool stuck in a stale cache file
 * (or missing from the cache dir entirely) still shows the freshest reading
 * that exists anywhere, labelled with its real source and time.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseUsageSnapLine,
  parseQuotaHdrLine,
  createQuotaSource,
} from '../command-center-quota.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, '.fixtures-tmp', 'command-center-quota-freshest')
after(async () => { await rm(FIXTURE_DIR, { recursive: true, force: true }) })

describe('parseUsageSnapLine', () => {
  const NOW = Date.parse('2026-11-22T01:00:00+08:00')

  it('parses a real-shaped line (src=hdr) into the cache-file JSON shape', () => {
    const line = '11-22 00:30 .claude-team2: 5h=16.0% 7d=29.0% fable=? reset5h=11-22T03:20 reset7d=11-26T14:00 resetfb= extra=? src=hdr'
    const r = parseUsageSnapLine(line, NOW)
    assert.equal(r.pool, 'T2')
    assert.equal(r.raw.pool, 'T2')
    assert.equal(r.raw.fetched_at, new Date(Date.parse('2026-11-22T00:30:00+08:00')).toISOString())
    assert.equal(r.raw.util_5h, 0.16)
    assert.equal(r.raw.util_7d, 0.29)
    assert.equal(r.raw.reset_5h_bjt, new Date(Date.parse('2026-11-22T03:20:00+08:00')).toISOString())
    assert.equal(r.raw.reset_7d_bjt, new Date(Date.parse('2026-11-26T14:00:00+08:00')).toISOString())
    assert.equal(r.raw.status, null)
    assert.equal(r.raw.error, null)
  })

  it('parses src=usage lines the same way (the src label itself is not carried into raw)', () => {
    const line = '11-22 00:30 .claude-team5: 5h=27.0% 7d=39.0% fable=0% reset5h=11-22T01:40 reset7d=11-25T01:00 resetfb=11-25T01:00 extra=None src=usage'
    const r = parseUsageSnapLine(line, NOW)
    assert.equal(r.pool, 'T5')
    assert.equal(r.raw.util_5h, 0.27)
    assert.equal(r.raw.util_7d, 0.39)
  })

  it('a blank reset field parses to null (e.g. .claude-team6 reset5h= with no value)', () => {
    const line = '11-22 00:30 .claude-team6: 5h=0.0% 7d=96.0% fable=4% reset5h= reset7d=11-23T12:59 resetfb=11-23T12:59 extra=None src=usage'
    const r = parseUsageSnapLine(line, NOW)
    assert.equal(r.pool, 'T6')
    assert.equal(r.raw.reset_5h_bjt, null)
    assert.ok(r.raw.reset_7d_bjt)
  })

  it('reconstructs the omitted year across a year boundary (reset falls in January, fetched in December)', () => {
    const decNow = Date.parse('2026-12-31T23:00:00+08:00')
    const line = '12-31 22:30 .claude-team1: 5h=10.0% 7d=20.0% fable=? reset5h=01-01T02:00 reset7d=01-03T09:00 resetfb= extra=? src=hdr'
    const r = parseUsageSnapLine(line, decNow)
    assert.equal(r.raw.fetched_at, new Date(Date.parse('2026-12-31T22:30:00+08:00')).toISOString())
    // resets land in the *next* calendar year, not 2026-01-01/03 (BJT instants
    // just after local midnight — compare epochs directly, not getUTCFullYear(),
    // since e.g. 2027-01-01T02:00+08:00 is still 2026-12-31T18:00Z in UTC)
    assert.equal(r.raw.reset_5h_bjt, new Date(Date.parse('2027-01-01T02:00:00+08:00')).toISOString())
    assert.equal(r.raw.reset_7d_bjt, new Date(Date.parse('2027-01-03T09:00:00+08:00')).toISOString())
  })

  it('returns null for a line that does not match the format', () => {
    assert.equal(parseUsageSnapLine('not a usage_snap line', NOW), null)
    assert.equal(parseUsageSnapLine('', NOW), null)
  })
})

describe('parseQuotaHdrLine', () => {
  it('extracts pool + the embedded reading JSON verbatim (no remapping needed)', () => {
    const line = '[2026-11-21 23:51:40] QUOTA_HDR stage=POST pool=T1 {"pool": "T1", "fetched_at": "2026-11-21 23:51:40+08:00", "util_5h": 0.32, "reset_5h_bjt": "2026-11-22 00:00:00+08:00", "util_7d": 0.24, "reset_7d_bjt": "2026-11-24 09:00:00+08:00", "status": "allowed", "overage_status": "allowed", "error": null}'
    const r = parseQuotaHdrLine(line)
    assert.equal(r.pool, 'T1')
    assert.equal(r.raw.pool, 'T1')
    assert.equal(r.raw.fetched_at, '2026-11-21 23:51:40+08:00')
    assert.equal(r.raw.util_5h, 0.32)
  })

  it('works for stage=PRE too, and returns null for unrelated lines', () => {
    const line = '[2026-11-21 23:51:29] QUOTA_HDR stage=PRE pool=T6 {"pool": "T6", "fetched_at": "2026-11-21 23:51:29+08:00", "util_5h": 0.0, "reset_5h_bjt": null, "util_7d": 0.95, "reset_7d_bjt": "2026-11-23 13:00:00+08:00", "status": "allowed", "overage_status": "allowed", "error": null}'
    assert.equal(parseQuotaHdrLine(line).pool, 'T6')
    assert.equal(parseQuotaHdrLine('[2026-11-21 23:51:29] some other dispatch line'), null)
  })

  it('returns null when the embedded JSON is malformed', () => {
    assert.equal(parseQuotaHdrLine('QUOTA_HDR stage=POST pool=T1 {broken'), null)
  })
})

describe('createQuotaSource: freshest-of-three merge', () => {
  const dir = path.join(FIXTURE_DIR, 'quota')
  const snapLog = path.join(FIXTURE_DIR, 'usage_snap.log')
  const logDir = path.join(FIXTURE_DIR, 'dispatch-logs')

  it('a pool missing from the cache dir still shows up via usage_snap.log, labelled "usage_snap"', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'T3.json'), JSON.stringify({ pool: 'T3', fetched_at: '2026-11-21 13:29:14+08:00', util_5h: 0.03, reset_5h_bjt: null, util_7d: 0.97, reset_7d_bjt: null, status: 'allowed', overage_status: null, error: null }))
    await writeFile(snapLog, '11-22 00:30 .claude-team1: 5h=10.0% 7d=26.0% fable=0% reset5h=11-22T05:00 reset7d=11-24T09:00 resetfb=11-24T09:00 extra=0.0 src=usage\n')
    const nowMs = Date.parse('2026-11-22T01:00:00+08:00')
    const src = createQuotaSource({ now: () => nowMs })
    const r = await src.get(dir, 900, { usageSnapLogPath: snapLog })
    assert.equal(r.ok, true)
    const pools = Object.fromEntries(r.data.pools.map((p) => [p.pool, p]))
    assert.ok(pools.T1, 'T1 (not in the cache dir) is present via usage_snap')
    assert.equal(pools.T1.source, 'usage_snap')
    assert.equal(pools.T3.source, 'official_headers')
  })

  it('cache file is stale but usage_snap has a fresher reading for the SAME pool — usage_snap wins', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'T3.json'), JSON.stringify({ pool: 'T3', fetched_at: '2026-11-21 13:29:14+08:00', util_5h: 0.03, reset_5h_bjt: null, util_7d: 0.97, reset_7d_bjt: null, status: 'allowed', overage_status: null, error: null }))
    await writeFile(snapLog, '11-22 00:30 .claude-team3: 5h=1.0% 7d=99.0% fable=? reset5h= reset7d=11-22T02:00 resetfb= extra=? src=hdr\n')
    const nowMs = Date.parse('2026-11-22T01:00:00+08:00')
    const src = createQuotaSource({ now: () => nowMs })
    const r = await src.get(dir, 900, { usageSnapLogPath: snapLog })
    const t3 = r.data.pools.find((p) => p.pool === 'T3')
    assert.equal(t3.source, 'usage_snap')
    assert.equal(t3.windows.find((w) => w.key === '7d').pct, 99)
  })

  it('a dispatch-log QUOTA_HDR line newer than both the cache file and usage_snap wins', async () => {
    await mkdir(dir, { recursive: true })
    await mkdir(logDir, { recursive: true })
    await writeFile(path.join(dir, 'T1.json'), JSON.stringify({ pool: 'T1', fetched_at: '2026-11-21 23:00:00+08:00', util_5h: 0.1, reset_5h_bjt: null, util_7d: 0.2, reset_7d_bjt: null, status: 'allowed', overage_status: null, error: null }))
    await writeFile(snapLog, '11-21 23:30 .claude-team1: 5h=12.0% 7d=22.0% fable=0% reset5h=11-22T05:00 reset7d=11-24T09:00 resetfb= extra=0.0 src=usage\n')
    await writeFile(path.join(logDir, 'dispatch_x.log'), `[2026-11-21 23:51:40] QUOTA_HDR stage=POST pool=T1 {"pool": "T1", "fetched_at": "2026-11-21 23:51:40+08:00", "util_5h": 0.32, "reset_5h_bjt": "2026-11-22 00:00:00+08:00", "util_7d": 0.24, "reset_7d_bjt": "2026-11-24 09:00:00+08:00", "status": "allowed", "overage_status": "allowed", "error": null}\n`)
    const nowMs = Date.parse('2026-11-22T01:00:00+08:00')
    const src = createQuotaSource({ now: () => nowMs })
    const r = await src.get(dir, 900, { usageSnapLogPath: snapLog, dispatchLogDirs: [logDir] })
    const t1 = r.data.pools.find((p) => p.pool === 'T1')
    assert.equal(t1.source, 'quota_hdr_dispatch_log')
    // 7d (reset 11-24, still live at nowMs=11-22 01:00) carries the dispatch
    // log's number; 5h's own reset (11-22 00:00) has already passed by nowMs,
    // so that window is correctly void regardless of which source won.
    assert.equal(t1.windows.find((w) => w.key === '7d').pct, 24)
  })

  it('a broken cache-dir JSON file does not hide a pool that has a usage_snap reading', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'T4.json'), '{not valid json')
    await writeFile(snapLog, '11-22 00:30 .claude-team4: 5h=4.0% 7d=26.0% fable=? reset5h=11-22T04:00 reset7d=11-25T17:00 resetfb= extra=? src=hdr\n')
    const nowMs = Date.parse('2026-11-22T01:00:00+08:00')
    const src = createQuotaSource({ now: () => nowMs })
    const r = await src.get(dir, 900, { usageSnapLogPath: snapLog })
    const t4 = r.data.pools.find((p) => p.pool === 'T4')
    assert.equal(t4.error, null)
    assert.equal(t4.source, 'usage_snap')
  })

  it('still reports the broken-file error row when NO other source has that pool', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'T9.json'), '{not valid json')
    const nowMs = Date.parse('2026-11-22T01:00:00+08:00')
    const src = createQuotaSource({ now: () => nowMs })
    const r = await src.get(dir, 900, {})
    const t9 = r.data.pools.find((p) => p.pool === 'T9')
    assert.match(t9.error, /not valid JSON/)
  })

  it('all six pools (T1-T6) show up when usage_snap.log covers all six, cache dir covers none', async () => {
    const emptyDir = path.join(FIXTURE_DIR, 'quota-empty')
    await mkdir(emptyDir, { recursive: true })
    const lines = [1, 2, 3, 4, 5, 6].map((n) =>
      `11-22 00:30 .claude-team${n}: 5h=${n}.0% 7d=${n}0.0% fable=? reset5h= reset7d= resetfb= extra=? src=hdr`
    ).join('\n') + '\n'
    const allSnap = path.join(FIXTURE_DIR, 'usage_snap_all.log')
    await writeFile(allSnap, lines)
    const nowMs = Date.parse('2026-11-22T01:00:00+08:00')
    const src = createQuotaSource({ now: () => nowMs })
    const r = await src.get(emptyDir, 900, { usageSnapLogPath: allSnap })
    assert.deepEqual(r.data.pools.map((p) => p.pool).sort(), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
  })

  it('log sources are cached for a short window — a line appended after get() is not picked up until the cache expires', async () => {
    const cDir = path.join(FIXTURE_DIR, 'quota-cache-test')
    await mkdir(cDir, { recursive: true })
    const cLog = path.join(FIXTURE_DIR, 'usage_snap_cache.log')
    await writeFile(cLog, '11-22 00:30 .claude-team2: 5h=1.0% 7d=1.0% fable=? reset5h= reset7d= resetfb= extra=? src=hdr\n')
    let nowMs = Date.parse('2026-11-22T01:00:00+08:00')
    const src = createQuotaSource({ now: () => nowMs })
    const r1 = await src.get(cDir, 900, { usageSnapLogPath: cLog })
    assert.equal(r1.data.pools.find((p) => p.pool === 'T2').windows.find((w) => w.key === '5h').pct, 1)
    // append a fresher line, but stay inside the log-scan cache window
    await appendFile(cLog, '11-22 00:59 .claude-team2: 5h=50.0% 7d=50.0% fable=? reset5h= reset7d= resetfb= extra=? src=hdr\n')
    nowMs += 5000 // +5s, inside the 20s log-scan cache
    const r2 = await src.get(cDir, 900, { usageSnapLogPath: cLog })
    assert.equal(r2.data.pools.find((p) => p.pool === 'T2').windows.find((w) => w.key === '5h').pct, 1, 'still the cached reading')
    nowMs += 20_000 // past the cache window now
    const r3 = await src.get(cDir, 900, { usageSnapLogPath: cLog })
    assert.equal(r3.data.pools.find((p) => p.pool === 'T2').windows.find((w) => w.key === '5h').pct, 50, 'cache expired — sees the appended line')
  })
})
