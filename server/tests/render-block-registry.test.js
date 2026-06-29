/**
 * P4a: render:block hook registry tests.
 *
 * The render-block registry lets plugins register custom renderers for
 * specific block types (text, tool_use, tool_result, thinking, …) with a
 * priority + gate, mirroring the renderer-registry selection model. The
 * block renderers (ClaudeBlockRenderer, CodexBlockRenderer) consult this
 * registry before falling back to their default rendering.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBlockRegistry } from '../../public/js/render-block-registry.js'

test('register + getHandler returns the handler for a block type', () => {
  renderBlockRegistry._reset()
  const handler = (block, container) => { container.textContent = 'custom' }
  renderBlockRegistry.register('tool_use', { name: 'my-tool', render: handler })
  const entry = renderBlockRegistry.getHandler('tool_use', {})
  assert.equal(entry.name, 'my-tool')
  assert.equal(entry.render, handler)
})

test('register throws when render is missing', () => {
  renderBlockRegistry._reset()
  assert.throws(() => renderBlockRegistry.register('text', { name: 'x' }), /render/)
})

test('higher priority wins among eligible handlers', () => {
  renderBlockRegistry._reset()
  renderBlockRegistry.register('text', { name: 'low', render: () => {}, priority: 5 })
  renderBlockRegistry.register('text', { name: 'high', render: () => {}, priority: 20 })
  const entry = renderBlockRegistry.getHandler('text', {})
  assert.equal(entry.name, 'high')
})

test('gate filters eligibility — only passing handlers are considered', () => {
  renderBlockRegistry._reset()
  renderBlockRegistry.register('text', {
    name: 'gated',
    render: () => {},
    gate: (s) => s.verbose === true,
    priority: 20,
  })
  renderBlockRegistry.register('text', {
    name: 'fallback',
    render: () => {},
    priority: 5,
  })
  // gate passes → gated wins
  assert.equal(renderBlockRegistry.getHandler('text', { verbose: true }).name, 'gated')
  // gate fails → fallback wins
  assert.equal(renderBlockRegistry.getHandler('text', { verbose: false }).name, 'fallback')
})

test('returns null when no handler is registered for a block type', () => {
  renderBlockRegistry._reset()
  renderBlockRegistry.register('text', { name: 'x', render: () => {} })
  assert.equal(renderBlockRegistry.getHandler('tool_result', {}), null)
})

test('returns null when all handlers are gated out', () => {
  renderBlockRegistry._reset()
  renderBlockRegistry.register('text', {
    name: 'gated',
    render: () => {},
    gate: () => false,
  })
  assert.equal(renderBlockRegistry.getHandler('text', {}), null)
})

test('re-registering the same name replaces the entry', () => {
  renderBlockRegistry._reset()
  const r1 = () => {}
  const r2 = () => {}
  renderBlockRegistry.register('text', { name: 'plug', render: r1, priority: 1 })
  renderBlockRegistry.register('text', { name: 'plug', render: r2, priority: 99 })
  const entry = renderBlockRegistry.getHandler('text', {})
  assert.equal(entry.render, r2)
  assert.equal(entry.priority, 99)
})

test('unregister removes a specific handler by name', () => {
  renderBlockRegistry._reset()
  renderBlockRegistry.register('text', { name: 'a', render: () => {}, priority: 10 })
  renderBlockRegistry.register('text', { name: 'b', render: () => {}, priority: 5 })
  assert.equal(renderBlockRegistry.unregister('text', 'a'), true)
  assert.equal(renderBlockRegistry.getHandler('text', {}).name, 'b')
  // unregister again → false (already gone)
  assert.equal(renderBlockRegistry.unregister('text', 'a'), false)
})

test('list returns introspection info for debugging', () => {
  renderBlockRegistry._reset()
  renderBlockRegistry.register('text', { name: 'a', render: () => {}, priority: 10 })
  renderBlockRegistry.register('tool_use', { name: 'b', render: () => {}, gate: () => true, priority: 5 })
  const all = renderBlockRegistry.list()
  assert.equal(all.length, 2)
  const textEntry = all.find((e) => e.blockType === 'text')
  assert.equal(textEntry.name, 'a')
  assert.equal(textEntry.hasGate, false)
  assert.equal(textEntry.priority, 10)
  const toolEntry = all.find((e) => e.blockType === 'tool_use')
  assert.equal(toolEntry.hasGate, true)
})

test('demo: a plugin can register a custom tool_use renderer that intercepts', () => {
  renderBlockRegistry._reset()
  const calls = []
  renderBlockRegistry.register('tool_use', {
    name: 'pretty-tool',
    render: (block, container) => {
      calls.push(block.name)
      container.innerHTML = `<div class="custom-tool">${block.name}</div>`
      return true // handled
    },
    priority: 100,
  })
  const entry = renderBlockRegistry.getHandler('tool_use', {})
  assert.ok(entry, 'handler registered')
  const container = { innerHTML: '' }
  const result = entry.render({ name: 'Bash' }, container)
  assert.equal(result, true, 'should return true (handled)')
  assert.equal(calls[0], 'Bash')
  assert.match(container.innerHTML, /custom-tool/)
})
