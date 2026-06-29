/**
 * P4d: explorer context-menu action registry tests.
 *
 * Plugins register actions that appear in the file explorer's right-click
 * context menu. Extracted as a pure module so the registry semantics are
 * unit-testable without a DOM. See public/js/explorer-action-registry.js.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { explorerActionRegistry } from '../../public/js/explorer-action-registry.js'

beforeEach(() => {
  explorerActionRegistry._reset()
})

test('register + list returns the action', () => {
  explorerActionRegistry.register({ id: 'copy-path', label: 'Copy Path', run: () => {} })
  const list = explorerActionRegistry.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'copy-path')
  assert.equal(list[0].label, 'Copy Path')
  assert.equal(typeof list[0].run, 'function')
})

test('list returns a snapshot (mutating it does not affect the registry)', () => {
  explorerActionRegistry.register({ id: 'a', label: 'A', run: () => {} })
  const list = explorerActionRegistry.list()
  list.length = 0
  assert.equal(explorerActionRegistry.list().length, 1)
})

test('register with a duplicate id replaces the prior entry', () => {
  const run1 = () => 'one'
  const run2 = () => 'two'
  explorerActionRegistry.register({ id: 'act', label: 'First', run: run1 })
  explorerActionRegistry.register({ id: 'act', label: 'Second', run: run2 })
  const list = explorerActionRegistry.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].label, 'Second')
  assert.equal(list[0].run, run2)
})

test('unregister removes the action by id', () => {
  explorerActionRegistry.register({ id: 'act', label: 'Act', run: () => {} })
  assert.equal(explorerActionRegistry.list().length, 1)
  explorerActionRegistry.unregister('act')
  assert.equal(explorerActionRegistry.list().length, 0)
})

test('unregister of a non-existent id is a no-op', () => {
  explorerActionRegistry.unregister('does-not-exist')
  assert.equal(explorerActionRegistry.list().length, 0)
})

test('register throws when id is missing', () => {
  assert.throws(() => explorerActionRegistry.register({ label: 'No ID', run: () => {} }), /non-empty id/)
})

test('register throws when id is empty string', () => {
  assert.throws(() => explorerActionRegistry.register({ id: '', label: 'X', run: () => {} }), /non-empty id/)
})

test('register throws when label is missing', () => {
  assert.throws(() => explorerActionRegistry.register({ id: 'x', run: () => {} }), /requires a label/)
})

test('register throws when run is missing', () => {
  assert.throws(() => explorerActionRegistry.register({ id: 'x', label: 'X' }), /requires a run\(\) function/)
})

test('register returns the action id', () => {
  const id = explorerActionRegistry.register({ id: 'my-act', label: 'My', run: () => {} })
  assert.equal(id, 'my-act')
})

test('list preserves insertion order across multiple registrations', () => {
  explorerActionRegistry.register({ id: 'a', label: 'A', run: () => {} })
  explorerActionRegistry.register({ id: 'b', label: 'B', run: () => {} })
  explorerActionRegistry.register({ id: 'c', label: 'C', run: () => {} })
  const list = explorerActionRegistry.list()
  assert.deepEqual(list.map((a) => a.id), ['a', 'b', 'c'])
})

test('_reset clears all actions', () => {
  explorerActionRegistry.register({ id: 'a', label: 'A', run: () => {} })
  explorerActionRegistry.register({ id: 'b', label: 'B', run: () => {} })
  explorerActionRegistry._reset()
  assert.equal(explorerActionRegistry.list().length, 0)
})
