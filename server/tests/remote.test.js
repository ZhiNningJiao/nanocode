/**
 * Tests for the MES-13740 需求10 remote machines plugin data source
 * (terminal/remote.js).
 *
 * Covers:
 *   - sanitizeMachine: alias/peerId/password/relay/note validation + normalisation
 *   - listMachines / addMachine / updateMachine / deleteMachine: CRUD against an
 *     in-memory store mock (mirrors the real store getSetting/setSetting contract)
 *   - buildConnectUri: rustdesk://connect/<id>?password=…&relay=true encoding,
 *     including invalid peerId → '' (never a broken URI)
 *   - persistence round-trip (JSON in the settings key)
 *   - address-book cap (MAX_MACHINES) rejects over-fill
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeMachine,
  listMachines,
  addMachine,
  updateMachine,
  deleteMachine,
  buildConnectUri,
} from '../../terminal/remote.js'

function mockStore() {
  const data = { settings: {} }
  return {
    getSetting(k) { return data.settings[k] ?? null },
    setSetting(k, v) { data.settings[k] = v },
    _data: data,
  }
}

describe('remote machines (MES-13740 需求10)', () => {
  let store
  beforeEach(() => { store = mockStore() })

  describe('sanitizeMachine', () => {
    it('accepts a minimal valid machine', () => {
      const r = sanitizeMachine({ alias: 'gpu-box', peerId: '123456789' })
      assert.ok(r.ok, r.errors.join('; '))
      assert.equal(r.machine.alias, 'gpu-box')
      assert.equal(r.machine.peerId, '123456789')
      assert.equal(r.machine.password, '')
      assert.equal(r.machine.relay, false)
      assert.equal(r.machine.note, '')
    })

    it('accepts password + relay + note', () => {
      const r = sanitizeMachine({ alias: 'a', peerId: 'abc-123', password: 's3cret', relay: true, note: 'lab box' })
      assert.ok(r.ok, r.errors.join('; '))
      assert.equal(r.machine.password, 's3cret')
      assert.equal(r.machine.relay, true)
      assert.equal(r.machine.note, 'lab box')
    })

    it('coerces relay "true" string to boolean', () => {
      const r = sanitizeMachine({ alias: 'a', peerId: 'abc', relay: 'true' })
      assert.ok(r.ok)
      assert.equal(r.machine.relay, true)
    })

    it('rejects empty alias', () => {
      const r = sanitizeMachine({ alias: '', peerId: '123' })
      assert.ok(!r.ok)
      assert.ok(r.errors.some((e) => /alias/.test(e)))
    })

    it('rejects empty peerId', () => {
      const r = sanitizeMachine({ alias: 'a', peerId: '' })
      assert.ok(!r.ok)
      assert.ok(r.errors.some((e) => /peerId/.test(e)))
    })

    it('rejects peerId with disallowed chars (space / slash)', () => {
      assert.ok(!sanitizeMachine({ alias: 'a', peerId: '12 34' }).ok)
      assert.ok(!sanitizeMachine({ alias: 'a', peerId: '12/34' }).ok)
      assert.ok(!sanitizeMachine({ alias: 'a', peerId: '../etc' }).ok)
    })

    it('rejects password with spaces', () => {
      const r = sanitizeMachine({ alias: 'a', peerId: '123', password: 'has space' })
      assert.ok(!r.ok)
      assert.ok(r.errors.some((e) => /password/.test(e)))
    })

    it('rejects non-object input', () => {
      assert.ok(!sanitizeMachine(null).ok)
      assert.ok(!sanitizeMachine([]).ok)
      assert.ok(!sanitizeMachine('x').ok)
    })
  })

  describe('CRUD', () => {
    it('listMachines is empty on a fresh store', () => {
      assert.deepEqual(listMachines(store), [])
    })

    it('addMachine persists and returns a record with an id', () => {
      const r = addMachine(store, { alias: 'gpu1', peerId: '111222333' })
      assert.ok(!r.error, r.error)
      assert.ok(r.machine.id, 'assigned id')
      assert.equal(r.machine.alias, 'gpu1')
      assert.equal(listMachines(store).length, 1)
    })

    it('addMachine rejects invalid input without mutating the store', () => {
      const r = addMachine(store, { alias: '', peerId: '123' })
      assert.ok(r.error)
      assert.equal(listMachines(store).length, 0)
    })

    it('updateMachine mutates the right record', () => {
      const a = addMachine(store, { alias: 'gpu1', peerId: '111' }).machine
      const r = updateMachine(store, a.id, { alias: 'gpu1-renamed', peerId: '222' })
      assert.ok(!r.error, r.error)
      assert.equal(r.machine.alias, 'gpu1-renamed')
      assert.equal(r.machine.peerId, '222')
      // id is stable across update
      assert.equal(r.machine.id, a.id)
    })

    it('updateMachine 404s on unknown id', () => {
      const r = updateMachine(store, 'nope', { alias: 'x', peerId: '1' })
      assert.ok(r.error)
      assert.ok(/not found/.test(r.error))
    })

    it('deleteMachine removes the record', () => {
      const a = addMachine(store, { alias: 'gpu1', peerId: '111' }).machine
      const d = deleteMachine(store, a.id)
      assert.ok(!d.error, d.error)
      assert.equal(listMachines(store).length, 0)
    })

    it('deleteMachine 404s on unknown id', () => {
      const d = deleteMachine(store, 'nope')
      assert.ok(d.error)
      assert.ok(/not found/.test(d.error))
    })

    it('persists across a "restart" (re-read from settings key)', () => {
      addMachine(store, { alias: 'gpu1', peerId: '111' })
      addMachine(store, { alias: 'gpu2', peerId: '222' })
      // Simulate a restart: a new store reading the same settings blob.
      const persisted = store._data.settings.remote_machines
      const store2 = mockStore()
      store2._data.settings.remote_machines = persisted
      const names = listMachines(store2).map((m) => m.alias)
      assert.deepEqual(names.sort(), ['gpu1', 'gpu2'])
    })

    it('caps the address book at MAX_MACHINES (200)', () => {
      for (let i = 0; i < 200; i++) addMachine(store, { alias: `m${i}`, peerId: `p${i}` })
      const over = addMachine(store, { alias: 'over', peerId: 'over' })
      assert.ok(over.error, 'over-fill must be rejected')
      assert.ok(/max 200/.test(over.error))
      assert.equal(listMachines(store).length, 200)
    })

    it('survives a corrupted settings blob (treats as empty)', () => {
      store.setSetting('remote_machines', 'not-json{')
      assert.deepEqual(listMachines(store), [])
      // add still works after corruption
      const r = addMachine(store, { alias: 'gpu1', peerId: '111' })
      assert.ok(!r.error)
    })
  })

  describe('buildConnectUri', () => {
    it('encodes a basic connect link', () => {
      assert.equal(buildConnectUri({ peerId: '123456789' }), 'rustdesk://connect/123456789')
    })

    it('appends password + relay params', () => {
      const uri = buildConnectUri({ peerId: 'abc-123', password: 'p w', relay: true })
      assert.equal(uri, 'rustdesk://connect/abc-123?password=p%20w&relay=true')
    })

    it('appends only password when relay is false', () => {
      assert.equal(buildConnectUri({ peerId: 'abc', password: 'pw' }), 'rustdesk://connect/abc?password=pw')
    })

    it('appends only relay when no password', () => {
      assert.equal(buildConnectUri({ peerId: 'abc', relay: true }), 'rustdesk://connect/abc?relay=true')
    })

    it('returns empty string for an invalid peerId (never a broken URI)', () => {
      assert.equal(buildConnectUri({ peerId: '12 34' }), '')
      assert.equal(buildConnectUri({ peerId: '' }), '')
      assert.equal(buildConnectUri(null), '')
    })

    it('url-encodes special characters in the peerId', () => {
      // peerId regex allows _ and - (no encoding needed), but the encoder is
      // still applied so any future-allowed char stays safe.
      assert.equal(buildConnectUri({ peerId: 'a_b-c' }), 'rustdesk://connect/a_b-c')
    })
  })
})
