/**
 * codex-history.js — reconstruct codex tab transcript from a CLI rollout jsonl.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveCodexRolloutPath,
  reconstructCodexScrollback,
  loadCodexScrollback,
} from '../../terminal/codex-history.js'

const tempDirs = []
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true }) })

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'codex-hist-'))
  tempDirs.push(home)
  return home
}

function writeRollout(home, dateParts, threadId, lines) {
  const [y, m, d] = dateParts
  const dir = join(home, '.codex', 'sessions', y, m, d)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-${y}-${m}-${d}T10-00-00-${threadId}.jsonl`)
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}

describe('codex-history', () => {
  it('resolves the rollout path by threadId', () => {
    const home = makeHome()
    const tid = '019fabcd-1111-2222-3333-444455556666'
    const path = writeRollout(home, ['2026', '07', '28'], tid, [
      { type: 'session_meta', payload: { id: tid } },
    ])
    assert.equal(resolveCodexRolloutPath(home, tid), path)
    assert.equal(resolveCodexRolloutPath(home, 'no-such-thread'), null)
    assert.equal(resolveCodexRolloutPath(home, ''), null)
  })

  it('reconstructs scrollback text: user, command, output, agent, separator', () => {
    const home = makeHome()
    const tid = 'aaaa-bbbb'
    const path = writeRollout(home, ['2026', '07', '28'], tid, [
      { type: 'session_meta', payload: { id: tid } },
      // first user msg often bundles a system wrapper block — must be skipped
      { type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>\ncwd=/x\n</environment_context>' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'list the files' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'ls -la' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: x\nProcess exited with code 0\nOutput:\nfile-a\nfile-b' } },
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'OPAQUE', summary: [] } },
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'final', message: 'There are two files.' } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'There are two files.' } },
    ])

    const s = reconstructCodexScrollback(path)
    assert.match(s, /^› list the files$/m)
    assert.doesNotMatch(s, /environment_context/, 'system wrapper user block must be skipped')
    assert.match(s, /^Running: ls -la$/m)
    assert.match(s, /^file-a$/m)
    assert.match(s, /^file-b$/m)
    assert.doesNotMatch(s, /Chunk ID|Process exited/, 'command-output preamble must be stripped')
    assert.doesNotMatch(s, /OPAQUE/, 'encrypted reasoning must be skipped')
    assert.match(s, /There are two files\./)
    assert.match(s, /────────────/, 'task_complete must emit a turn separator')
  })

  it('handles array-form function_call_output', () => {
    const home = makeHome()
    const tid = 'arr-out'
    const path = writeRollout(home, ['2026', '07', '28'], tid, [
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'echo hi' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.1 s\nOutput:\n' },
        { type: 'input_text', text: 'hi there' },
      ] } },
    ])
    const s = reconstructCodexScrollback(path)
    assert.match(s, /^Running: echo hi$/m)
    assert.match(s, /^hi there$/m)
    assert.doesNotMatch(s, /Wall time/, 'array-output preamble must be stripped')
  })

  it('caps output length per command', () => {
    const home = makeHome()
    const tid = 'big-out'
    const big = 'x'.repeat(5000)
    const path = writeRollout(home, ['2026', '07', '28'], tid, [
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'cat big' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: `Output:\n${big}` } },
    ])
    const s = reconstructCodexScrollback(path)
    assert.match(s, /output truncated/)
    assert.ok(s.length < 4000, 'huge output must be capped')
  })

  it('loadCodexScrollback returns empty string when no rollout exists', () => {
    const home = makeHome()
    assert.equal(loadCodexScrollback(home, 'missing'), '')
  })
})
