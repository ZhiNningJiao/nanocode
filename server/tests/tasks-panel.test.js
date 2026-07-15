import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeTodos, summarizeTodos } from '../../public/js/tasks-panel.js'

describe('tasks-panel (MES-14031 S5 agent task list / TODO panel)', () => {
  describe('normalizeTodos', () => {
    it('returns empty array for non-array input', () => {
      assert.deepEqual(normalizeTodos(null), [])
      assert.deepEqual(normalizeTodos(undefined), [])
      assert.deepEqual(normalizeTodos({}), [])
      assert.deepEqual(normalizeTodos('foo'), [])
    })

    it('maps Claude TodoWrite shape (content + status + priority)', () => {
      const raw = [
        { content: 'Read files', status: 'completed', priority: 'high' },
        { content: 'Write code', status: 'in_progress', priority: 'medium' },
        { content: 'Run tests', status: 'pending', priority: 'low' },
      ]
      const out = normalizeTodos(raw)
      assert.equal(out.length, 3)
      assert.deepEqual(out[0], { content: 'Read files', status: 'completed', priority: 'high' })
      assert.deepEqual(out[1], { content: 'Write code', status: 'in_progress', priority: 'medium' })
      assert.deepEqual(out[2], { content: 'Run tests', status: 'pending', priority: 'low' })
    })

    it('maps Codex shape using title/subject/text fallbacks', () => {
      const raw = [
        { title: 'Task A', status: 'done' },
        { subject: 'Task B', state: 'in-progress' },
        { text: 'Task C', status: 'pending' },
      ]
      const out = normalizeTodos(raw)
      assert.equal(out[0].content, 'Task A')
      assert.equal(out[0].status, 'completed')
      assert.equal(out[1].content, 'Task B')
      assert.equal(out[1].status, 'in_progress')
      assert.equal(out[2].content, 'Task C')
      assert.equal(out[2].status, 'pending')
    })

    it('normalizes status variants (done → completed, finished → completed)', () => {
      const raw = [
        { content: 'A', status: 'done' },
        { content: 'B', status: 'finished' },
        { content: 'C', status: 'finish' },
        { content: 'D', status: 'in-progress' },
        { content: 'E', status: 'blocked' },
      ]
      const out = normalizeTodos(raw)
      assert.equal(out[0].status, 'completed')
      assert.equal(out[1].status, 'completed')
      assert.equal(out[2].status, 'completed')
      assert.equal(out[3].status, 'in_progress')
      assert.equal(out[4].status, 'blocked')
    })

    it('defaults unknown status to pending', () => {
      const out = normalizeTodos([{ content: 'X', status: 'wat' }])
      assert.equal(out[0].status, 'pending')
    })

    it('defaults missing status to pending', () => {
      const out = normalizeTodos([{ content: 'X' }])
      assert.equal(out[0].status, 'pending')
    })

    it('handles missing priority gracefully (empty string)', () => {
      const out = normalizeTodos([{ content: 'X', status: 'pending' }])
      assert.equal(out[0].priority, '')
    })

    it('filters out null/undefined entries', () => {
      const raw = [null, undefined, { content: 'OK', status: 'pending' }, null]
      const out = normalizeTodos(raw)
      assert.equal(out.length, 1)
      assert.equal(out[0].content, 'OK')
    })

    it('coerces content to string', () => {
      const out = normalizeTodos([{ content: 42, status: 'pending' }])
      assert.equal(out[0].content, '42')
    })

    it('uses task fallback when content/title/subject/text all missing', () => {
      const out = normalizeTodos([{ task: 'from task field', status: 'pending' }])
      assert.equal(out[0].content, 'from task field')
    })
  })

  describe('summarizeTodos', () => {
    it('counts each status correctly', () => {
      const todos = [
        { content: 'A', status: 'completed', priority: '' },
        { content: 'B', status: 'completed', priority: '' },
        { content: 'C', status: 'in_progress', priority: '' },
        { content: 'D', status: 'pending', priority: '' },
        { content: 'E', status: 'pending', priority: '' },
        { content: 'F', status: 'pending', priority: '' },
        { content: 'G', status: 'blocked', priority: '' },
      ]
      const counts = summarizeTodos(todos)
      assert.equal(counts.completed, 2)
      assert.equal(counts.in_progress, 1)
      assert.equal(counts.pending, 3)
      assert.equal(counts.blocked, 1)
    })

    it('returns zeros for empty array', () => {
      const counts = summarizeTodos([])
      assert.deepEqual(counts, { completed: 0, in_progress: 0, pending: 0, blocked: 0 })
    })
  })
})
