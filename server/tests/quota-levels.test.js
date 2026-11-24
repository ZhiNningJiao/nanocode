/**
 * One yellow / red line: the cockpit quota block and the usage summary agree
 * on the same %, because both use public/js/quota-levels.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QUOTA_WARN_PCT, QUOTA_CRIT_PCT, quotaSeverity } from '../../public/js/quota-levels.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('quota levels', () => {
  it('75 / 90, boundaries inclusive', () => {
    assert.equal(QUOTA_WARN_PCT, 75)
    assert.equal(QUOTA_CRIT_PCT, 90)
    assert.equal(quotaSeverity(74.9), 'normal')
    assert.equal(quotaSeverity(75), 'warning')
    assert.equal(quotaSeverity(78), 'warning') // was plain in the cockpit (80), yellow in usage (75)
    assert.equal(quotaSeverity(90), 'critical')
    assert.equal(quotaSeverity(null), null)
    assert.equal(quotaSeverity('x'), null)
  })

  it('no second threshold literal in the quota renderers / usage', () => {
    for (const f of ['public/js/command-center-quota-panel.js', 'public/js/plugins-panel.js', 'terminal/usage.js']) {
      const s = readFileSync(join(root, f), 'utf8')
      assert.match(s, /from '(\.\.\/public\/js|\.)\/quota-levels\.js'/, f)
      assert.doesNotMatch(s, /WARN_PCT = |HOT_PCT = |>= ?(75|80|90|95)\b/, f)
    }
  })
})
