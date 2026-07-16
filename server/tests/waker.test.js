import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getWakerStatus, getWakerConfig, setWakerConfig, wakerTick } from '../waker.js'

describe('waker: status and config', () => {
  it('getWakerStatus returns expected shape', () => {
    const s = getWakerStatus()
    assert.strictEqual(typeof s.enabled, 'boolean')
    assert.strictEqual(typeof s.hourlyCount, 'number')
    assert.strictEqual(s.hourlyCap, 15)
    assert.strictEqual(s.minGapSeconds, 270)
  })

  it('setWakerConfig merges partial config', () => {
    const before = getWakerConfig()
    assert.strictEqual(before.enabled, false)
    setWakerConfig({ enabled: true })
    const after = getWakerConfig()
    assert.strictEqual(after.enabled, true)
    setWakerConfig({ enabled: false }) // reset
  })

  it('wakerTick returns skipped when disabled', async () => {
    setWakerConfig({ enabled: false })
    const result = await wakerTick()
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.action, 'skipped')
    assert.ok(result.reason.includes('disabled'))
  })
})
