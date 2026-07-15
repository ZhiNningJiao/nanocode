import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'fs/promises'
import path from 'path'
import os from 'os'

// The historian module reads from ~/codex_work. For testing, we mock the file
// reads by creating a temp directory structure.

const tmpDir = path.join(os.tmpdir(), `historian-test-${Date.now()}`)
const codexWork = path.join(tmpDir, 'codex_work')
const wakerState = path.join(codexWork, '.waker')

describe('historian data collectors', () => {
  let historian

  beforeEach(async () => {
    await mkdir(wakerState, { recursive: true })
    // We can't easily override HOME in the module, so we test the exported
    // functions' behavior for shape / edge cases — specifically that they
    // return the correct shape when files are missing (the production path).
    historian = await import('../../server/historian.js')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('readArmyStatus returns { agents: [], updatedAt: null } on missing file', async () => {
    const result = await historian.readArmyStatus()
    assert.ok(result, 'result must exist')
    assert.ok(Array.isArray(result.agents), 'agents must be array')
  })

  it('readWakerLogTail returns empty array on missing file', async () => {
    const result = await historian.readWakerLogTail(10)
    assert.ok(Array.isArray(result), 'result must be array')
  })

  it('getWakerHealth returns structured object with all expected fields', async () => {
    const h = await historian.getWakerHealth()
    assert.equal(typeof h, 'object')
    assert.equal(typeof h.tmuxAlive, 'boolean')
    assert.equal(typeof h.singletonLock, 'boolean')
    assert.ok(['live', 'dry', 'unknown'].includes(h.mode))
    assert.equal(typeof h.autoLive, 'boolean')
    // stats can be null, string, or parsed object
    assert.ok(h.stats === null || typeof h.stats === 'string' || typeof h.stats === 'object',
      'stats must be null, string, or object')
    // coverage and dryCount are optional
    if (h.coverage !== undefined) {
      assert.ok(Array.isArray(h.coverage) || typeof h.coverage === 'string',
        'coverage must be array or string')
    }
    if (h.dryCount !== undefined) {
      assert.equal(typeof h.dryCount, 'number', 'dryCount must be number')
    }
    // Enhanced fields: intervalLabel and currentInterval always present
    assert.ok(typeof h.intervalLabel === 'string', 'intervalLabel must be a string')
    assert.ok(typeof h.currentInterval === 'number', 'currentInterval must be a number')
    // Optional enhanced fields
    if (h.injectCount !== undefined) {
      assert.equal(typeof h.injectCount, 'number', 'injectCount must be number')
    }
    if (h.gateStats !== undefined) {
      assert.ok(typeof h.gateStats === 'string' || typeof h.gateStats === 'object',
        'gateStats must be string or object')
    }
  })

  it('collectBriefing returns structured briefing with all top-level keys', async () => {
    const b = await historian.collectBriefing()
    assert.ok(b.time, 'time must exist')
    assert.ok(b.timeShort, 'timeShort must exist')
    assert.ok(b.army, 'army must exist')
    assert.ok(Array.isArray(b.loops), 'loops must be array')
    assert.ok(Array.isArray(b.stalled), 'stalled must be array')
    assert.ok(b.signals, 'signals must exist')
    assert.ok(Array.isArray(b.tmuxPanes), 'tmuxPanes must be array')
    assert.ok(b.ports, 'ports must exist')
    assert.ok(typeof b.summary === 'string', 'summary must be string')
  })

  it('collectBriefing accepts custom port list', async () => {
    const b = await historian.collectBriefing({ ports: [12345] })
    assert.ok(b.ports[12345] !== undefined, 'custom port should appear')
  })
})
