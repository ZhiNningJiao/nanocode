import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { listSessions, previewSession, resetSessionsCache } from '../../terminal/sessions-browser.js'

describe('sessions-browser (MES-14031 抄 codex resume/fork)', () => {
  it('listSessions returns newest-first sessions with total count', () => {
    resetSessionsCache()
    const data = listSessions({ limit: 10 })
    assert.ok(Array.isArray(data.sessions), 'sessions must be an array')
    assert.equal(typeof data.total, 'number')
    assert.ok(data.total >= 0)
    if (data.sessions.length >= 2) {
      for (let i = 1; i < data.sessions.length; i++) {
        const a = data.sessions[i - 1].timestamp || ''
        const b = data.sessions[i].timestamp || ''
        assert.ok(a >= b, `sessions must be newest-first: ${a} < ${b}`)
      }
    }
  })

  it('each session has the required fields', () => {
    const data = listSessions({ limit: 5 })
    for (const s of data.sessions) {
      assert.ok(s.id, 'session must have an id')
      assert.ok(s.source === 'codex' || s.source === 'claude', `bad source: ${s.source}`)
      assert.equal(typeof s.cwd, 'string')
      assert.equal(typeof s.timestamp, 'string')
      assert.equal(typeof s.firstMessage, 'string')
      assert.equal(typeof s.lines, 'number')
    }
  })

  it('listSessions respects the source filter (codex only)', () => {
    const data = listSessions({ source: 'codex', limit: 50 })
    for (const s of data.sessions) assert.equal(s.source, 'codex')
  })

  it('listSessions respects the source filter (claude only)', () => {
    const data = listSessions({ source: 'claude', limit: 50 })
    for (const s of data.sessions) assert.equal(s.source, 'claude')
  })

  it('listSessions clamps the limit', () => {
    const data = listSessions({ limit: 5 })
    assert.ok(data.sessions.length <= 5)
  })

  it('previewSession returns turns for a real codex session', () => {
    const list = listSessions({ source: 'codex', limit: 20 })
    const codex = list.sessions.find((s) => s.source === 'codex')
    if (!codex) return // no codex sessions on this machine — skip
    const p = previewSession({ source: 'codex', id: codex.id, file: codex.file })
    assert.ok(!p.error, `preview should not error: ${p.error}`)
    assert.equal(p.source, 'codex')
    assert.ok(Array.isArray(p.turns))
  })

  it('previewSession returns error for unknown id', () => {
    const p = previewSession({ source: 'codex', id: 'nonexistent-id-xyz' })
    assert.ok(p.error)
  })

  it('previewSession returns error for unknown source', () => {
    const p = previewSession({ source: 'unknown', id: 'x' })
    assert.ok(p.error)
  })

  it('claude session cwd preserves the leading slash (MES-14031 regression)', () => {
    // Claude Code encodes an absolute cwd "/jfs/home/x" as slug "-jfs-home-x".
    // The cwd must round-trip back to "/jfs/home/x" (leading slash intact), not
    // "jfs/home/x" — otherwise the Sessions list shows a wrong path and the
    // fork flow can never match an existing project by cwd.
    const data = listSessions({ source: 'claude', limit: 50 })
    for (const s of data.sessions) {
      if (!s.cwd) continue
      assert.ok(
        s.cwd.startsWith('/'),
        `claude cwd must be absolute (start with '/'), got: ${JSON.stringify(s.cwd)}`,
      )
    }
  })
})
