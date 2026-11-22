/**
 * Public-repo hygiene (owner 2026-11-22 point 11): a tracked file must never
 * carry our real internal deployment addresses, personal filesystem paths,
 * or private comms identifiers — those belong in a *.local file (gitignored)
 * or ~/.config, never in the repo history going forward.
 *
 * Two layers:
 *   1. Unit tests on the detector itself, proving it actually goes red on
 *      the exact violations this cleanup removed (this IS the "inject a bad
 *      value, watch it fail" proof, permanently kept in the suite instead of
 *      a one-off manual step).
 *   2. An integration scan of every git-tracked file's current content.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanTextForHygieneViolations } from '../public-repo-hygiene-patterns.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

describe('scanTextForHygieneViolations (detector unit tests — proves it goes red)', () => {
  it('flags the real internal akari/services host this cleanup removed', () => {
    assert.ok(scanTextForHygieneViolations('serverUrl: http://10.18.8.55:9481').length > 0)
    assert.ok(scanTextForHygieneViolations('win box at 172.30.20.212').length > 0)
  })
  it('flags the personal path this cleanup removed from CLAUDE.md/ONBOARDING.md', () => {
    assert.ok(scanTextForHygieneViolations('cd /storage/home/zhiningjiao/code/nanocode').length > 0)
    assert.ok(scanTextForHygieneViolations('/jfs/home/zhiningjiao/codex_work').length > 0)
  })
  it('flags a real company email', () => {
    assert.ok(scanTextForHygieneViolations('contact: zhiningjiao@meshy.ai').length > 0)
  })
  it('flags the leaked personal ntfy topic', () => {
    assert.ok(scanTextForHygieneViolations("ntfy_topic: 'zhiningwork'").length > 0)
  })
  it('does NOT flag documentation-safe placeholders (no false positives)', () => {
    assert.deepEqual(scanTextForHygieneViolations('host: 203.0.113.11, email: user@example.invalid'), [])
    assert.deepEqual(scanTextForHygieneViolations('akari default http://127.0.0.1:9481'), [])
    assert.deepEqual(scanTextForHygieneViolations('an arbitrary test IP 1.2.3.4 used as an override value'), [])
  })
})

describe('public repo hygiene: full tracked-file scan', () => {
  it('no git-tracked file contains a hygiene violation', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)

    const BINARY_EXT = /\.(png|jpg|jpeg|ico|woff2?|ttf|eot|gif|webp)$/i
    const violations = []
    for (const rel of files) {
      if (BINARY_EXT.test(rel)) continue
      if (rel === 'package-lock.json') continue
      // These two files intentionally contain the violating strings — as test
      // fixtures, and as the literal patterns the detector itself matches on.
      if (rel === 'server/tests/public-repo-hygiene.test.js') continue
      if (rel === 'server/public-repo-hygiene-patterns.js') continue
      let text
      try { text = readFileSync(resolve(REPO_ROOT, rel), 'utf8') } catch { continue }
      const hits = scanTextForHygieneViolations(text)
      if (hits.length) violations.push(`${rel}: ${hits.join(', ')}`)
    }

    assert.deepEqual(violations, [], `hygiene violations found:\n${violations.join('\n')}`)
  })
})
