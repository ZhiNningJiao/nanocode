// Tests for the opencode session-list normaliser (MES-13740 需求15 item1).
// Only the PURE normaliser is tested here — listOpencodeSessions (execFile
// wrapper) is a thin shell over the opencode CLI and is exercised live on 9476.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOpencodeSessions } from '../../terminal/opencode-sessions.js'

describe('normalizeOpencodeSessions', () => {
  it('parses a CLI JSON array into a most-recent-first conversation list', () => {
    const now = 1_000_000_000_000
    // Deliberately out of order to verify the defensive sort.
    const stdout = JSON.stringify([
      {
        id: 'ses_old',
        title: 'older session',
        updated: now - 60 * 60 * 1000, // 1h ago
        created: now - 2 * 60 * 60 * 1000,
        projectId: 'p1',
        directory: '/home/x/work/proj',
      },
      {
        id: 'ses_new',
        title: 'newer session',
        updated: now - 5 * 60 * 1000, // 5m ago
        created: now - 10 * 60 * 1000,
        projectId: 'p1',
        directory: '/home/x/work/proj',
      },
    ])
    const out = normalizeOpencodeSessions(stdout, now)
    assert.equal(out.conversations.length, 2)
    assert.equal(out.conversations[0].sessionId, 'ses_new') // most-recent-first
    assert.equal(out.conversations[1].sessionId, 'ses_old')
    assert.equal(out.conversations[0].relTime, '5m ago')
    assert.equal(out.conversations[1].relTime, '1h ago')
    assert.equal(out.conversations[0].directory, '/home/x/work/proj')
  })

  it('falls back to (untitled) for sessions missing a title', () => {
    const now = 5_000_000
    const out = normalizeOpencodeSessions(
      JSON.stringify([{ id: 'ses_x', updated: now - 1000, created: now - 2000, directory: '/d' }]),
      now,
    )
    assert.equal(out.conversations[0].title, '(untitled)')
  })

  it('drops entries without a string id', () => {
    const out = normalizeOpencodeSessions(
      JSON.stringify([
        { id: 'ses_ok', title: 'a', updated: 100, created: 50 },
        { title: 'no id', updated: 200, created: 100 },
        { id: 123, title: 'numeric id', updated: 300 },
        null,
      ]),
      9999,
    )
    assert.equal(out.conversations.length, 1)
    assert.equal(out.conversations[0].sessionId, 'ses_ok')
  })

  it('returns an empty list (not a throw) on unparseable input', () => {
    assert.deepEqual(normalizeOpencodeSessions('not json'), { conversations: [] })
    assert.deepEqual(normalizeOpencodeSessions(''), { conversations: [] })
    assert.deepEqual(normalizeOpencodeSessions(undefined), { conversations: [] })
  })

  it('returns an empty list when the CLI yields a non-array JSON value', () => {
    assert.deepEqual(normalizeOpencodeSessions(JSON.stringify({ not: 'array' })), { conversations: [] })
    assert.deepEqual(normalizeOpencodeSessions(JSON.stringify('a string')), { conversations: [] })
  })

  it('computes relTime buckets (just now / m / h / d)', () => {
    const now = 10_000_000_000
    const mk = (ago) => JSON.stringify([{ id: `ses_${ago}`, title: 't', updated: now - ago, created: now - ago }])
    assert.equal(normalizeOpencodeSessions(mk(30 * 1000), now).conversations[0].relTime, 'just now')
    assert.equal(normalizeOpencodeSessions(mk(12 * 60 * 1000), now).conversations[0].relTime, '12m ago')
    assert.equal(normalizeOpencodeSessions(mk(3 * 60 * 60 * 1000), now).conversations[0].relTime, '3h ago')
    assert.equal(normalizeOpencodeSessions(mk(2 * 24 * 60 * 60 * 1000), now).conversations[0].relTime, '2d ago')
  })

  it('leaves relTime blank when updated is missing/non-finite', () => {
    const out = normalizeOpencodeSessions(
      JSON.stringify([{ id: 'ses_n', title: 't', created: 100 }]),
      9999,
    )
    assert.equal(out.conversations[0].relTime, '')
    assert.equal(out.conversations[0].updated, null)
  })
})
