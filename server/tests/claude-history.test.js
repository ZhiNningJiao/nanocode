import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseJsonlHistory, parseJsonlHistoryBefore } from '../../terminal/claude-history.js'

const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('parseJsonlHistory', () => {
  it('keeps distinct assistant content types while deduplicating progressive rows of the same type', () => {
    const tempDir = makeTempDir('nanocode-claude-history-')
    const jsonlPath = path.join(tempDir, 'session.jsonl')

    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: { role: 'user', content: 'prompt' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-text-old',
          requestId: 'req-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-text-new',
          requestId: 'req-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'final text' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-tool',
          requestId: 'req-1',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-no-request',
          message: { role: 'assistant', content: [{ type: 'text', text: 'standalone' }] },
        }),
      ].join('\n') + '\n'
    )

    const events = parseJsonlHistory(jsonlPath)

    assert.equal(events.length, 4)
    assert.deepEqual(
      events.map((event) => ({ type: event.type, uuid: event.uuid, firstPart: event.message.content?.[0]?.type || typeof event.message.content })),
      [
        { type: 'user', uuid: 'user-1', firstPart: 'string' },
        { type: 'assistant', uuid: 'assistant-text-new', firstPart: 'text' },
        { type: 'assistant', uuid: 'assistant-tool', firstPart: 'tool_use' },
        { type: 'assistant', uuid: 'assistant-no-request', firstPart: 'text' },
      ]
    )
  })

  it('assigns stable replay ids to repeated user text rows', () => {
    const tempDir = makeTempDir('nanocode-claude-history-')
    const jsonlPath = path.join(tempDir, 'session-replay.jsonl')

    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: { role: 'user', content: 'repeat me' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-2',
          message: { role: 'user', content: 'repeat me' },
        }),
      ].join('\n') + '\n'
    )

    const events = parseJsonlHistory(jsonlPath)

    assert.match(events[0].replay_id, /^user:[0-9a-f]{16}:1$/)
    assert.equal(events[1].replay_id, events[0].replay_id.replace(/:1$/, ':2'))
  })
})

describe('parseJsonlHistoryBefore (history pagination, async)', () => {
  it('returns the events older than the given uuid, oldest first', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nano-before-'))
    try {
      const file = path.join(dir, 's.jsonl')
      const rows = []
      for (let i = 0; i < 6; i++) {
        rows.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `q${i}` } }))
        rows.push(JSON.stringify({ type: 'assistant', uuid: `a${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `r${i}` }] } }))
      }
      writeFileSync(file, rows.join('\n') + '\n')
      const page = await parseJsonlHistoryBefore(file, 'u3')
      assert.equal(page.hasMore, false)
      const uuids = page.events.map((e) => e.uuid)
      assert.deepEqual(uuids, ['u0', 'a0', 'u1', 'a1', 'u2', 'a2'])
      assert.equal(page.firstUuid, 'u0')
      assert.deepEqual(await parseJsonlHistoryBefore(file, 'nope'), { events: [], hasMore: false })
      assert.deepEqual(await parseJsonlHistoryBefore(path.join(dir, 'missing.jsonl'), 'u3'), { events: [], hasMore: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
