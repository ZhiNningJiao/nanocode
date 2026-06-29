/**
 * P5a: header entry registry tests.
 *
 * Plugins register buttons in the top-right header via
 * `ui.registerHeaderEntry({id, icon, label, onClick|panel, order})`. Extracted
 * as a pure module so the registry semantics are unit-testable without a DOM.
 * See public/js/header-entry-registry.js.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { headerEntryRegistry } from '../../public/js/header-entry-registry.js'

beforeEach(() => {
  headerEntryRegistry._reset()
})

test('register + list returns the entry', () => {
  headerEntryRegistry.register({ id: 'agent', icon: '<svg/>', label: 'Agent', onClick: () => {} })
  const list = headerEntryRegistry.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'agent')
  assert.equal(list[0].label, 'Agent')
  assert.equal(list[0].icon, '<svg/>')
  assert.equal(typeof list[0].onClick, 'function')
  assert.equal(list[0].panel, null)
})

test('list returns a snapshot (mutating it does not affect the registry)', () => {
  headerEntryRegistry.register({ id: 'a', label: 'A', onClick: () => {} })
  const list = headerEntryRegistry.list()
  list.length = 0
  assert.equal(headerEntryRegistry.list().length, 1)
})

test('list snapshot omits internal _seq field', () => {
  headerEntryRegistry.register({ id: 'a', label: 'A', onClick: () => {} })
  const list = headerEntryRegistry.list()
  assert.equal('_seq' in list[0], false)
})

test('register with a duplicate id replaces the prior entry', () => {
  const cb1 = () => 'one'
  const cb2 = () => 'two'
  headerEntryRegistry.register({ id: 'act', label: 'First', onClick: cb1 })
  headerEntryRegistry.register({ id: 'act', label: 'Second', onClick: cb2 })
  const list = headerEntryRegistry.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].label, 'Second')
  assert.equal(list[0].onClick, cb2)
})

test('unregister removes the entry by id', () => {
  headerEntryRegistry.register({ id: 'act', label: 'Act', onClick: () => {} })
  assert.equal(headerEntryRegistry.list().length, 1)
  headerEntryRegistry.unregister('act')
  assert.equal(headerEntryRegistry.list().length, 0)
})

test('unregister of a non-existent id is a no-op', () => {
  headerEntryRegistry.unregister('does-not-exist')
  assert.equal(headerEntryRegistry.list().length, 0)
})

test('register throws when id is missing', () => {
  assert.throws(() => headerEntryRegistry.register({ label: 'No ID', onClick: () => {} }), /non-empty id/)
})

test('register throws when id is empty string', () => {
  assert.throws(() => headerEntryRegistry.register({ id: '', label: 'X', onClick: () => {} }), /non-empty id/)
})

test('register throws when neither onClick nor panel is provided', () => {
  assert.throws(() => headerEntryRegistry.register({ id: 'x', label: 'X' }), /requires onClick or panel/)
})

test('register accepts a panel instead of onClick', () => {
  headerEntryRegistry.register({ id: 'fleet', label: 'Fleet', panel: 'fleet-term' })
  const list = headerEntryRegistry.list()
  assert.equal(list[0].panel, 'fleet-term')
  assert.equal(list[0].onClick, null)
})

test('register accepts an empty-string onClick fallback to panel', () => {
  // onClick that is not a function should fall back to panel validation
  headerEntryRegistry.register({ id: 'p', label: 'P', onClick: null, panel: 'mon' })
  assert.equal(headerEntryRegistry.list()[0].panel, 'mon')
})

test('register returns the entry id', () => {
  const id = headerEntryRegistry.register({ id: 'my-entry', label: 'My', onClick: () => {} })
  assert.equal(id, 'my-entry')
})

test('list sorts by order ascending', () => {
  headerEntryRegistry.register({ id: 'c', order: 30, onClick: () => {} })
  headerEntryRegistry.register({ id: 'a', order: 10, onClick: () => {} })
  headerEntryRegistry.register({ id: 'b', order: 20, onClick: () => {} })
  assert.deepEqual(headerEntryRegistry.list().map((e) => e.id), ['a', 'b', 'c'])
})

test('list breaks order ties by insertion order (stable)', () => {
  headerEntryRegistry.register({ id: 'first', order: 5, onClick: () => {} })
  headerEntryRegistry.register({ id: 'second', order: 5, onClick: () => {} })
  headerEntryRegistry.register({ id: 'third', order: 5, onClick: () => {} })
  assert.deepEqual(headerEntryRegistry.list().map((e) => e.id), ['first', 'second', 'third'])
})

test('entries default to order 0 when not specified', () => {
  headerEntryRegistry.register({ id: 'x', onClick: () => {} })
  assert.equal(headerEntryRegistry.list()[0].order, 0)
})

test('re-registering an entry preserves its original sort position', () => {
  headerEntryRegistry.register({ id: 'a', order: 1, onClick: () => {} })
  headerEntryRegistry.register({ id: 'b', order: 1, onClick: () => {} })
  headerEntryRegistry.register({ id: 'c', order: 1, onClick: () => {} })
  // Re-register 'a' with a new callback — it should NOT jump to the end.
  headerEntryRegistry.register({ id: 'a', order: 1, onClick: () => 'updated' })
  assert.deepEqual(headerEntryRegistry.list().map((e) => e.id), ['a', 'b', 'c'])
})

test('deactivate-clear: unregistering every entry a plugin owns removes them all', () => {
  // Simulates what the browser host's unloadClientPlugin does: it tracks the
  // ids a plugin registered and calls unregister(id) for each on unload.
  const owned = ['am-1', 'am-2', 'am-3']
  for (const id of owned) headerEntryRegistry.register({ id, onClick: () => {} })
  headerEntryRegistry.register({ id: 'other', onClick: () => {} })
  assert.equal(headerEntryRegistry.list().length, 4)
  for (const id of owned) headerEntryRegistry.unregister(id)
  const remaining = headerEntryRegistry.list().map((e) => e.id)
  assert.deepEqual(remaining, ['other'])
})

test('_reset clears all entries', () => {
  headerEntryRegistry.register({ id: 'a', onClick: () => {} })
  headerEntryRegistry.register({ id: 'b', onClick: () => {} })
  headerEntryRegistry._reset()
  assert.equal(headerEntryRegistry.list().length, 0)
})
