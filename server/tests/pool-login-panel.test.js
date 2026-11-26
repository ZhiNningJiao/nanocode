import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slotHtml } from '../../public/js/pool-login-panel.js'

function pool(extra = {}) {
  return { id: 'team4', label: 'T4', name: 'Team 4', isDutyPool: false, interactiveCred: false, longToken: false, lastRealCall: null, login: null, ...extra }
}

describe('pool-login-panel slotHtml (pure render, no DOM)', () => {
  it('idle: shows a sign-in button and the cred/token/last-call summary line', () => {
    const html = slotHtml(pool())
    assert.match(html, /data-act="signin"/)
    assert.doesNotMatch(html, /ccq-signin-code/)
  })

  it('awaiting_code: shows the auth link, a code box and a submit button', () => {
    const html = slotHtml(pool({ login: { state: 'awaiting_code', url: 'https://claude.com/cai/oauth/authorize?x=1' } }))
    assert.match(html, /href="https:\/\/claude\.com\/cai\/oauth\/authorize\?x=1"/)
    assert.match(html, /ccq-signin-code/)
    assert.match(html, /data-act="submit-code"/)
    assert.match(html, /data-act="cancel"/)
  })

  it('awaiting_code with no url yet (scrape still pending) shows a waiting line, not a dead link', () => {
    const html = slotHtml(pool({ login: { state: 'awaiting_code', url: null } }))
    assert.doesNotMatch(html, /<a /)
    assert.match(html, /ccq-signin-code/)
  })

  it('error: shows the sign-in button again plus the error text', () => {
    const html = slotHtml(pool({ login: { state: 'error', error: 'timed out waiting for the auth link' } }))
    assert.match(html, /data-act="signin"/)
    assert.match(html, /timed out waiting for the auth link/)
  })

  it('done + verify ok: shows the one-word reply', () => {
    const html = slotHtml(pool({ login: { state: 'done', verify: { ok: true, reply: 'ok' } } }))
    assert.match(html, /✓ ok/)
  })

  it('done + verify failed: shows the failure, not a false "done"', () => {
    const html = slotHtml(pool({ login: { state: 'done', verify: { ok: false, error: 'ENOENT' } } }))
    assert.match(html, /✗ ENOENT/)
  })

  it('never renders a token, credential, or email value — only booleans and a short verify reply', () => {
    const html = slotHtml(pool({
      interactiveCred: true,
      longToken: true,
      login: { state: 'done', verify: { ok: true, reply: 'ok' } },
    }))
    assert.doesNotMatch(html, /sk-ant/)
    assert.doesNotMatch(html, /@/)
  })

  it('no info for this pool yet (still loading /api/pool-login/pools): renders nothing', () => {
    assert.equal(slotHtml(null), '')
  })
})
