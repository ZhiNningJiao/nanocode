import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  getWakerControlState,
  setInterval as setWakerInterval,
} from '../../server/waker-control.js'

describe('waker-control', () => {
  it('getWakerControlState returns structured object', async () => {
    const state = await getWakerControlState()
    assert.equal(typeof state, 'object')
    assert.equal(typeof state.tmuxAlive, 'boolean')
    assert.equal(typeof state.autoLive, 'boolean')
    assert.ok(state.wakerShPath, 'wakerShPath must be set')
  })

  it('setInterval with 0 returns dynamic', async () => {
    const result = await setWakerInterval(0)
    assert.equal(typeof result, 'object')
    // ok may be true or false depending on whether ~/code/.waker_env is writable
    assert.ok('ok' in result, 'result must have ok field')
    if (result.ok) {
      assert.equal(result.interval, 'dynamic')
    }
  })

  it('setInterval with positive number returns that value', async () => {
    const result = await setWakerInterval(300)
    assert.ok('ok' in result)
    if (result.ok) {
      assert.equal(result.interval, 300)
    }
  })

  it('exports are functions', () => {
    const mod = { getWakerControlState, setWakerInterval }
    assert.equal(typeof mod.getWakerControlState, 'function')
    assert.equal(typeof mod.setWakerInterval, 'function')
  })
})
