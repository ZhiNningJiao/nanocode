import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { poolHtml } from '../../public/js/command-center-quota-panel.js'

function pool(extra = {}) {
  return { pool: 'T3', source: 'official_headers', fetchedAt: '2026-11-21T05:29:14.000Z', ageSec: 10, stale: false, loggedIn: true, status: null, overage: null, error: null, windows: [], ...extra }
}

describe('quota pool card: login badge (nanolink_0950 — no more "login unknown")', () => {
  it('fresh, error-free reading (any source) shows no login badge', () => {
    for (const source of ['official_headers', 'usage_snap', 'quota_hdr_dispatch_log']) {
      const html = poolHtml(pool({ source, stale: false, loggedIn: true }))
      assert.doesNotMatch(html, /ccq-login/, source)
      assert.doesNotMatch(html, /login unknown/i, source)
    }
  })
  it('a real logged-out error shows "logged out" with the re-login hint, even if also stale', () => {
    const html = poolHtml(pool({ loggedIn: false, stale: true, error: 'HTTP 401 Unauthorized' }))
    assert.match(html, /class="ccq-login ccq-login-no"/)
    assert.match(html, /logged out/)
    assert.match(html, /title="Re-login needed/)
    assert.doesNotMatch(html, /reading expired/)
  })
  it('a stale (but not logged-out) reading says "reading expired", not "login unknown"', () => {
    const html = poolHtml(pool({ loggedIn: true, stale: true }))
    assert.match(html, /class="ccq-stale"/)
    assert.match(html, /reading expired/)
    assert.doesNotMatch(html, /ccq-login/)
  })
  it('loggedIn === null (no reading at all) and not stale is impossible, but the renderer still degrades to no badge, never "unknown"', () => {
    const html = poolHtml(pool({ loggedIn: null, stale: false, error: null }))
    assert.doesNotMatch(html, /ccq-login/)
    assert.doesNotMatch(html, /login unknown/i)
  })
})
