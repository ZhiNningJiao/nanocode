/**
 * The historian briefing (waker → secretary) counts new signals with the
 * command center's rule: an accepted FLAG_<tag>.accepted-HHMM is not new.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanSignals } from '../historian.js'

describe('historian scanSignals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nanocode-signals-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('counts un-accepted FLAGs and FAILSIGs only', async () => {
    for (const f of ['FLAG_car_a', 'FLAG_car_b.accepted-0101', 'FAILSIG_car_c', 'NEEDSIG_car_d', 'STEP_car_a.md']) {
      writeFileSync(join(dir, f), '')
    }
    const s = await scanSignals(dir)
    assert.deepEqual(s.flags, ['car_a'])
    assert.deepEqual(s.failsigs, ['car_c'])
  })
})
