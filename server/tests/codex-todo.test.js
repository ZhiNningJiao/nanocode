import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { extractCodexTodos } from '../../public/js/codex-block-renderer.js'

// MES-14031 S5 codex fix: the @openai/codex-sdk ThreadItem union includes
// TodoListItem = { id, type: 'todo_list', items: [{ text, completed }] }
// (index.d.ts:90-102). It arrives inside item.started/updated/completed events
// as `event.item.items` — NOT `event.item.todos`. The previous
// _maybeDispatchTodoUpdate read `.todos` and so never dispatched for codex;
// extractCodexTodos now reads the real `.items` field. These tests pin the SDK
// shape so the codex tasks panel actually lights up.
describe('extractCodexTodos (MES-14031 S5 codex todo_list event extraction)', () => {
  it('extracts items from item.started with a todo_list item (real SDK shape)', () => {
    const event = {
      type: 'item.started',
      item: { id: 't1', type: 'todo_list', items: [
        { text: 'Step one', completed: false },
        { text: 'Step two', completed: true },
      ] },
    }
    const todos = extractCodexTodos(event)
    assert.deepEqual(todos, [
      { text: 'Step one', completed: false },
      { text: 'Step two', completed: true },
    ])
  })

  it('extracts items from item.completed with a todo_list item', () => {
    const event = {
      type: 'item.completed',
      item: { id: 't1', type: 'todo_list', items: [{ text: 'Done', completed: true }] },
    }
    const todos = extractCodexTodos(event)
    assert.deepEqual(todos, [{ text: 'Done', completed: true }])
  })

  it('extracts items from item.updated with a todo_list item', () => {
    const event = {
      type: 'item.updated',
      item: { id: 't1', type: 'todo_list', items: [{ text: 'Updated', completed: false }] },
    }
    assert.deepEqual(extractCodexTodos(event), [{ text: 'Updated', completed: false }])
  })

  it('extracts items from a standalone todo_list event', () => {
    const event = { type: 'todo_list', items: [{ text: 'A', completed: true }] }
    assert.deepEqual(extractCodexTodos(event), [{ text: 'A', completed: true }])
  })

  it('returns null for a non-todo_list item event (e.g. agent_message)', () => {
    const event = { type: 'item.started', item: { id: 'm1', type: 'agent_message', text: 'hi' } }
    assert.equal(extractCodexTodos(event), null)
  })

  it('returns null for a file_change event', () => {
    const event = { type: 'item.completed', item: { type: 'file_change', changes: [] } }
    assert.equal(extractCodexTodos(event), null)
  })

  it('returns null for turn.completed / thread.started / other events', () => {
    assert.equal(extractCodexTodos({ type: 'turn.completed', usage: {} }), null)
    assert.equal(extractCodexTodos({ type: 'thread.started', thread_id: 'x' }), null)
  })

  it('returns null for null / undefined / missing item', () => {
    assert.equal(extractCodexTodos(null), null)
    assert.equal(extractCodexTodos(undefined), null)
    assert.equal(extractCodexTodos({}), null)
    assert.equal(extractCodexTodos({ type: 'item.started' }), null)
  })

  it('returns null when item.type is todo_list but the items field is missing', () => {
    assert.equal(extractCodexTodos({ type: 'item.started', item: { type: 'todo_list' } }), null)
  })

  it('returns an empty array (to clear the panel) when items is []', () => {
    // An empty todo list is a real state — dispatch [] so normalizeTodos([])
    // clears the panel (empty array is truthy, so _maybeDispatchTodoUpdate fires).
    assert.deepEqual(extractCodexTodos({ type: 'item.started', item: { type: 'todo_list', items: [] } }), [])
  })

  it('still accepts the legacy .todos field name (robustness)', () => {
    const event = { type: 'item.completed', item: { type: 'todo_list', todos: [{ text: 'A', completed: true }] } }
    assert.deepEqual(extractCodexTodos(event), [{ text: 'A', completed: true }])
  })
})
