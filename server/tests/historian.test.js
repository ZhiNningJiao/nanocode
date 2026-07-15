import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collectBriefing } from '../historian.js'

describe('historian: collectBriefing', () => {
  it('returns structured briefing with required fields', async () => {
    const b = await collectBriefing({ ports: [] })
    assert.ok(b.time, 'has time')
    assert.ok(b.timeShort, 'has timeShort')
    assert.ok(Array.isArray(b.loops), 'loops is array')
    assert.ok(Array.isArray(b.stalled), 'stalled is array')
    assert.ok(b.signals, 'has signals')
    assert.ok(Array.isArray(b.signals.flags), 'signals.flags is array')
    assert.ok(Array.isArray(b.signals.failsigs), 'signals.failsigs is array')
    assert.ok(Array.isArray(b.tmuxPanes), 'tmuxPanes is array')
    assert.ok(typeof b.ports === 'object', 'ports is object')
    assert.ok(typeof b.summary === 'string', 'summary is string')
    assert.ok(b.summary.includes('[historian'), 'summary starts with [historian')
  })
})
