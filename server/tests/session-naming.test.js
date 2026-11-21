/**
 * One copy of the session naming rules. The wrapper check is the superset the
 * two drifted copies had (6 prefixes, leading whitespace ignored), so the
 * sessions browser now skips the same wrappers the codex history does.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSystemWrapper, relTimeFromMtime, claudeProjectSlugToCwd } from '../../terminal/session-naming.js'

describe('session naming', () => {
  it('isSystemWrapper: all six wrapper kinds, leading whitespace ignored, non-text is a wrapper', () => {
    for (const t of ['<environment_context>x', '<permissions a>', '<system_reminder>', '<recommended_plugins>', '<INSTRUCTIONS>', '<user_instructions>', '  \n<environment_context>']) {
      assert.equal(isSystemWrapper(t), true, t)
    }
    assert.equal(isSystemWrapper('fix the login bug'), false)
    assert.equal(isSystemWrapper(null), true)
  })
  it('relTimeFromMtime', () => {
    const now = 10 * 86400e3
    assert.equal(relTimeFromMtime(now - 30e3, now), 'just now')
    assert.equal(relTimeFromMtime(now - 5 * 60e3, now), '5m ago')
    assert.equal(relTimeFromMtime(now - 3 * 3600e3, now), '3h ago')
    assert.equal(relTimeFromMtime(now - 2 * 86400e3, now), '2d ago')
    assert.equal(relTimeFromMtime(NaN, now), '')
  })
  it('claudeProjectSlugToCwd', () => {
    assert.equal(claudeProjectSlugToCwd('-work-a'), '/work/a')
    assert.equal(claudeProjectSlugToCwd(''), '')
  })
})
