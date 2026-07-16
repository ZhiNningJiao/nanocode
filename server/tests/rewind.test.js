import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildCheckpoints, rewindConversation } from '../../terminal/rewind.js'

// ── fixture helpers ─────────────────────────────────────────────────────────

function userRow(text, ts = '2026-01-01T00:00:00Z') {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

function assistantRow(text, ts = '2026-01-01T00:00:01Z') {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

// A tool_result user row — must NOT start a new turn boundary.
function toolResultUserRow(text, ts = '2026-01-01T00:00:02Z') {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text }] }],
    },
  })
}

function writeFixture(dir, name, rows) {
  const p = join(dir, name)
  // `rows` are already JSON strings (from userRow/assistantRow/...).
  writeFileSync(p, rows.join('\n') + '\n')
  return p
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('rewind (MES-14031 S2 抄 Claude Code checkpointing/rewind)', () => {
  let dir

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rewind-test-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it('buildCheckpoints returns one checkpoint per real user prompt (newest-first order preserved)', () => {
    const p = writeFixture(dir, 'sess.jsonl', [
      userRow('Hello, what is 2+2?'),
      assistantRow('4'),
      userRow('Now what is 3+3?'),
      assistantRow('6'),
      userRow('And 4+4?'),
      assistantRow('8'),
    ])
    const res = buildCheckpoints(p)
    assert.equal(res.error, undefined)
    assert.equal(res.totalTurns, 3)
    assert.equal(res.checkpoints.length, 3)
    assert.equal(res.checkpoints[0].index, 0)
    assert.equal(res.checkpoints[0].preview, 'Hello, what is 2+2?')
    assert.equal(res.checkpoints[1].preview, 'Now what is 3+3?')
    assert.equal(res.checkpoints[2].preview, 'And 4+4?')
  })

  it('tool_result user rows do not create false turn boundaries', () => {
    const p = writeFixture(dir, 'sess.jsonl', [
      userRow('Run the tests'),
      assistantRow('I will run them.'),
      toolResultUserRow('tests passed: 5'),
      assistantRow('All tests passed.'),
      userRow('Great, now lint.'),
    ])
    const res = buildCheckpoints(p)
    assert.equal(res.totalTurns, 2, 'tool_result user row must not start a new turn')
    assert.equal(res.checkpoints[0].preview, 'Run the tests')
    assert.equal(res.checkpoints[1].preview, 'Great, now lint.')
  })

  it('buildCheckpoints returns empty + error for a missing file', () => {
    const res = buildCheckpoints(join(dir, 'nope.jsonl'))
    assert.equal(res.checkpoints.length, 0)
    assert.equal(res.totalTurns, 0)
    assert.ok(res.error, 'missing file must report an error')
  })

  it('rewindConversation dryRun returns the plan without writing', () => {
    const p = writeFixture(dir, 'sess.jsonl', [
      userRow('Turn 0'), assistantRow('a0'),
      userRow('Turn 1'), assistantRow('a1'),
      userRow('Turn 2'), assistantRow('a2'),
    ])
    const before = readFileSync(p, 'utf-8')
    const res = rewindConversation({ jsonlPath: p, toIndex: 0, dryRun: true })
    assert.equal(res.ok, true)
    assert.equal(res.dryRun, true)
    assert.equal(res.toIndex, 0)
    assert.ok(res.keptLines >= 2, 'keptLines should cover turn 0 (user+assistant)')
    assert.ok(res.droppedLines > 0, 'should drop the tail')
    // File untouched on dry run.
    assert.equal(readFileSync(p, 'utf-8'), before)
    // No backup created on dry run.
    assert.equal(readdirSync(dir).length, 1)
  })

  it('rewindConversation keeps turns 0..toIndex and drops the tail', () => {
    const rows = [
      userRow('Turn 0'), assistantRow('a0'),
      userRow('Turn 1'), assistantRow('a1'),
      userRow('Turn 2'), assistantRow('a2'),
    ]
    const p = writeFixture(dir, 'sess.jsonl', rows)
    const res = rewindConversation({ jsonlPath: p, toIndex: 1, dryRun: false })
    assert.equal(res.ok, true)
    assert.equal(res.toIndex, 1)
    // After rewind, buildCheckpoints should now show 2 turns (0 and 1).
    const after = buildCheckpoints(p)
    assert.equal(after.totalTurns, 2)
    assert.equal(after.checkpoints[0].preview, 'Turn 0')
    assert.equal(after.checkpoints[1].preview, 'Turn 1')
  })

  it('rewindConversation backs up the original before writing (never destroys data)', () => {
    const rows = [
      userRow('Turn 0'), assistantRow('a0'),
      userRow('Turn 1'), assistantRow('a1'),
      userRow('Turn 2'), assistantRow('a2'),
    ]
    const p = writeFixture(dir, 'sess.jsonl', rows)
    const original = readFileSync(p, 'utf-8')
    const res = rewindConversation({ jsonlPath: p, toIndex: 0, dryRun: false })
    assert.equal(res.ok, true)
    assert.ok(res.backupPath, 'must report a backup path')
    // The backup must contain the FULL original transcript.
    assert.equal(readFileSync(res.backupPath, 'utf-8'), original)
  })

  it('rewindConversation refuses to rewind to the last turn (no-op)', () => {
    const p = writeFixture(dir, 'sess.jsonl', [
      userRow('Turn 0'), assistantRow('a0'),
      userRow('Turn 1'), assistantRow('a1'),
    ])
    const res = rewindConversation({ jsonlPath: p, toIndex: 1, dryRun: false })
    assert.equal(res.ok, false)
    assert.ok(res.error, 'rewinding to the last turn must error (nothing to drop)')
  })

  it('rewindConversation rejects an out-of-range toIndex', () => {
    const p = writeFixture(dir, 'sess.jsonl', [
      userRow('Turn 0'), assistantRow('a0'),
    ])
    assert.ok(rewindConversation({ jsonlPath: p, toIndex: -1 }).error)
    assert.ok(rewindConversation({ jsonlPath: p, toIndex: 5 }).error)
  })

  it('the kept prefix is byte-identical to the original (no re-serialization drift)', () => {
    // A row with extra spaces inside the JSON (valid, JSON.parse accepts it, but
    // JSON.stringify would compact it). If rewindConversation ever re-serializes
    // the kept rows instead of preserving raw bytes, this prefix would drift.
    const weird = '{ "type" : "user" , "timestamp" : "2026-01-01T00:00:00Z" , "message" : { "role" : "user" , "content" : [ { "type" : "text" , "text" : "spaced out" } ] } , "extra" : true }'
    const rows = [
      weird,
      assistantRow('ok'),
      userRow('Turn 1'), assistantRow('a1'),
      userRow('Turn 2'), assistantRow('a2'),
    ]
    const p = join(dir, 'sess.jsonl')
    writeFileSync(p, rows.join('\n') + '\n')
    const original = readFileSync(p, 'utf-8')
    rewindConversation({ jsonlPath: p, toIndex: 0, dryRun: false })
    const after = readFileSync(p, 'utf-8')
    // The first turn (weird row + assistant) must be byte-identical to the
    // original's prefix up to and including the assistant row.
    const expectedPrefix = rows.slice(0, 2).join('\n') + '\n'
    assert.equal(after, expectedPrefix)
    assert.ok(original.startsWith(expectedPrefix), 'sanity: prefix matches original')
  })
})
