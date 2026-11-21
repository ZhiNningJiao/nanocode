import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createScanCache, mapLimit, readTailLines } from '../../terminal/bounded-scan.js'

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

describe('bounded-scan', () => {
  it('mapLimit never runs more than `limit` tasks at once and honours the stop signal', async () => {
    let running = 0
    let peak = 0
    const seen = []
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
      running++; peak = Math.max(peak, running)
      await tick(5)
      seen.push(x)
      running--
    })
    assert.equal(peak, 2)
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6])
    let stop = false
    const done = []
    await mapLimit([1, 2, 3, 4, 5, 6], 1, async (x) => { done.push(x); if (x === 2) stop = true }, () => stop)
    assert.deepEqual(done, [1, 2])
  })

  it('concurrent requests share one scan (single-flight) and the result is cached', async () => {
    let scans = 0
    const cache = createScanCache({
      ttlMs: 60_000, scanTimeoutMs: 5_000,
      scan: async (_k, p) => { scans++; await tick(20); p.items.push('a', 'b') },
    })
    const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => cache.get('pool', { deadlineMs: 1_000 })))
    assert.equal(scans, 1)
    for (const r of [r1, r2, r3]) assert.deepEqual(r.items, ['a', 'b'])
    const again = await cache.get('pool', { deadlineMs: 1_000 })
    assert.equal(scans, 1, 'fresh cache hit must not rescan')
    assert.equal(again.stale, false)
    assert.equal(again.partial, false)
  })

  it('caches per key (pool)', async () => {
    const scanned = []
    const cache = createScanCache({ ttlMs: 60_000, scanTimeoutMs: 5_000, scan: async (k, p) => { scanned.push(k); p.items.push(k) } })
    assert.deepEqual((await cache.get('p1', { deadlineMs: 100 })).items, ['p1'])
    assert.deepEqual((await cache.get('p2', { deadlineMs: 100 })).items, ['p2'])
    await cache.get('p1', { deadlineMs: 100 })
    assert.deepEqual(scanned, ['p1', 'p2'])
  })

  it('deadline: returns the progress so far marked partial, the scan finishes in the background', async () => {
    const cache = createScanCache({
      ttlMs: 60_000, scanTimeoutMs: 5_000,
      scan: async (_k, p) => { p.items.push('first'); await tick(80); p.items.push('second') },
    })
    const t0 = Date.now()
    const early = await cache.get('pool', { deadlineMs: 20 })
    assert.ok(Date.now() - t0 < 70, 'request must return at the deadline, not after the scan')
    assert.equal(early.partial, true)
    assert.match(early.partialReason, /still running/)
    assert.deepEqual(early.items, ['first'])
    await cache.settle('pool')
    const full = await cache.get('pool', { deadlineMs: 20 })
    assert.equal(full.partial, false)
    assert.deepEqual(full.items, ['first', 'second'])
  })

  it('expired entry: serves the old result immediately (stale) and refreshes in the background', async () => {
    let clock = 0
    let gen = 0
    const cache = createScanCache({
      ttlMs: 1_000, scanTimeoutMs: 5_000, now: () => clock,
      scan: async (_k, p) => { gen++; await tick(30); p.items.push(`gen${gen}`) },
    })
    await cache.get('pool', { deadlineMs: 1_000 })
    clock = 2_000
    const t0 = Date.now()
    const stale = await cache.get('pool', { deadlineMs: 1_000 })
    assert.ok(Date.now() - t0 < 25, 'stale hit must not wait for the refresh')
    assert.equal(stale.stale, true)
    assert.deepEqual(stale.items, ['gen1'])
    await cache.settle('pool')
    assert.deepEqual((await cache.get('pool', { deadlineMs: 1_000 })).items, ['gen2'])
  })

  it('a hung scan is cut off by scanTimeoutMs and the single-flight slot is released', async () => {
    let calls = 0
    const cache = createScanCache({
      ttlMs: 60_000, scanTimeoutMs: 30,
      scan: (_k, p) => { calls++; p.items.push('got-one'); return new Promise(() => {}) },
    })
    const r = await cache.get('pool', { deadlineMs: 200 })
    assert.equal(r.partial, true)
    assert.match(r.partialReason, /scan exceeded 30 ms/)
    assert.deepEqual(r.items, ['got-one'])
    await cache.get('pool', { deadlineMs: 200 })
    assert.equal(calls, 2, 'a partial result is not treated as fresh; next request rescans')
  })

  it('a throwing scan is reported, not swallowed', async () => {
    const cache = createScanCache({ ttlMs: 60_000, scanTimeoutMs: 1_000, scan: async () => { throw new Error('EIO') } })
    const r = await cache.get('pool', { deadlineMs: 200 })
    assert.equal(r.partial, true)
    assert.match(r.partialReason, /scan failed: EIO/)
  })

  it('readTailLines reads only the tail window and drops the cut first line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nanocode-bounded-scan-'))
    try {
      const f = join(dir, 'a.jsonl')
      const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}`)
      writeFileSync(f, lines.join('\n') + '\n')
      const tail = await readTailLines(f, 50)
      assert.equal(tail.truncated, true)
      assert.equal(tail.ok, true)
      assert.equal(tail.lines.at(-1), 'line-099')
      assert.ok(tail.lines.every((l) => /^line-\d{3}$/.test(l)))
      assert.ok(tail.lines.length < 10)
      const whole = await readTailLines(f, 1 << 20)
      assert.equal(whole.truncated, false)
      assert.equal(whole.lines.length, 100)
      const missing = await readTailLines(join(dir, 'nope.jsonl'), 50)
      assert.equal(missing.ok, false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
