import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rendererRegistry } from '../../public/js/renderer-registry.js'

// The registry reads `window.__nanocodeState` in a browser; in Node it falls
// back to {} (guarded by try/catch), so we pass settings explicitly to keep
// these tests deterministic and DOM-free.

test('register then getRenderer returns the entry', () => {
  rendererRegistry._reset()
  const factory = () => ({ kind: 'stub' })
  rendererRegistry.register('claude', { name: 'stub', factory })
  const entry = rendererRegistry.getRenderer('claude', {})
  assert.equal(entry.name, 'stub')
  assert.equal(entry.factory, factory)
})

test('register throws when factory is missing', () => {
  rendererRegistry._reset()
  assert.throws(() => rendererRegistry.register('claude', { name: 'x' }), /factory/)
})

test('gate filters eligibility — claude block renderer gated by renderMode', () => {
  rendererRegistry._reset()
  rendererRegistry.register('claude', {
    name: 'block',
    factory: () => ({ kind: 'block' }),
    gate: (s) => (s.renderMode || 'block') !== 'terminal',
    priority: 10,
  })
  rendererRegistry.register('claude', {
    name: 'raw',
    factory: () => ({ kind: 'raw' }),
    priority: 0,
  })
  // default renderMode → block eligible
  assert.equal(rendererRegistry.getRenderer('claude', {}).name, 'block')
  // renderMode=terminal → block gated out, raw wins
  assert.equal(rendererRegistry.getRenderer('claude', { renderMode: 'terminal' }).name, 'raw')
})

test('higher priority wins among eligible entries', () => {
  rendererRegistry._reset()
  rendererRegistry.register('claude', { name: 'low', factory: () => ({}), priority: 1 })
  rendererRegistry.register('claude', { name: 'high', factory: () => ({}), priority: 9 })
  assert.equal(rendererRegistry.getRenderer('claude', {}).name, 'high')
})

test('falls back to "*" universal renderer when typed gate fails', () => {
  rendererRegistry._reset()
  rendererRegistry.register('claude', {
    name: 'block',
    factory: () => ({ kind: 'block' }),
    gate: () => false, // never eligible
    priority: 10,
  })
  rendererRegistry.register('*', { name: 'terminal', factory: () => ({ kind: 'term' }) })
  // claude block gated out → falls back to '*' terminal
  assert.equal(rendererRegistry.getRenderer('claude', {}).name, 'terminal')
  // bash has no typed entry → also falls back to '*' terminal
  assert.equal(rendererRegistry.getRenderer('bash', {}).name, 'terminal')
})

test('returns null when nothing is registered', () => {
  rendererRegistry._reset()
  assert.equal(rendererRegistry.getRenderer('claude', {}), null)
})

test('createPane instantiates via the resolved factory', () => {
  rendererRegistry._reset()
  let called
  rendererRegistry.register('codex', {
    name: 'blk',
    factory: (el, opts) => { called = { el, opts }; return { kind: 'codex-blk' } },
    gate: (s) => s.codexRenderMode === 'block',
  })
  rendererRegistry.register('*', { name: 'term', factory: () => ({ kind: 'term' }) })
  const el = {}, opts = { tabId: 't1' }
  const pane = rendererRegistry.createPane('codex', el, opts, { codexRenderMode: 'block' })
  assert.equal(pane.kind, 'codex-blk')
  assert.equal(called.el, el)
  assert.equal(called.opts.tabId, 't1')
  // gate fails → falls back to terminal
  const pane2 = rendererRegistry.createPane('codex', el, opts, { codexRenderMode: 'terminal' })
  assert.equal(pane2.kind, 'term')
  // returns null when no renderer at all
  rendererRegistry._reset()
  assert.equal(rendererRegistry.createPane('x', el, opts), null)
})

test('re-registering the same name replaces (plugin overrides default)', () => {
  rendererRegistry._reset()
  rendererRegistry.register('claude', { name: 'default', factory: () => ({ a: 1 }), priority: 10 })
  rendererRegistry.register('claude', { name: 'default', factory: () => ({ a: 2 }), priority: 10 })
  const entry = rendererRegistry.getRenderer('claude', {})
  assert.equal(entry.factory().a, 2)
  assert.equal(rendererRegistry.list('claude').length, 1, 'replace, not append')
})

test('unregister removes a specific entry and cleans empty lists', () => {
  rendererRegistry._reset()
  rendererRegistry.register('claude', { name: 'a', factory: () => ({}) })
  rendererRegistry.register('claude', { name: 'b', factory: () => ({}) })
  assert.equal(rendererRegistry.unregister('claude', 'a'), true)
  assert.equal(rendererRegistry.list('claude').length, 1)
  assert.equal(rendererRegistry.getRenderer('claude', {}).name, 'b')
  // unregister last entry → list deleted
  assert.equal(rendererRegistry.unregister('claude', 'b'), true)
  assert.equal(rendererRegistry.list('claude').length, 0)
  // unregister unknown is a no-op (returns false)
  assert.equal(rendererRegistry.unregister('claude', 'ghost'), false)
})

test('list introspection covers all types when no arg', () => {
  rendererRegistry._reset()
  rendererRegistry.register('claude', { name: 'c', factory: () => ({}) })
  rendererRegistry.register('*', { name: 't', factory: () => ({}) })
  const all = rendererRegistry.list()
  assert.equal(all.length, 2)
  const types = all.map((e) => e.sessionType).sort()
  assert.deepEqual(types, ['*', 'claude'])
})
