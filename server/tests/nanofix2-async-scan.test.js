/**
 * nanofix2_0120 — async twins of the request-time scan paths that were
 * still synchronous after nanofreeze_2350 (REPORT_nanofreeze_2350.md "没改的"):
 * history load, /api/projects/:id/recent-conversations, /api/teams,
 * /api/memory/tree. Each twin must behave like its existing sync function
 * (same inputs -> same shape of output) while routing every disk touch
 * through bounded-scan.js (fs/promises) instead of node:fs sync calls.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import {
  listTeams,
  listTeamsAsync,
  listMemoryTree,
  listMemoryTreeAsync,
} from '../../terminal/usage.js'
import {
  findNewestJsonl,
  findNewestJsonlAsync,
  parseJsonlHistory,
  parseJsonlHistoryAsync,
  parseJsonlHistoryTail,
  parseJsonlHistoryTailAsync,
  countUserMessages,
  countUserMessagesAsync,
  scanRecentConversationsMulti,
  scanRecentConversationsMultiAsync,
  resolveSessionJsonl,
  resolveSessionJsonlAsync,
} from '../../terminal/claude-history.js'

function memDir(configDir, slug) {
  return join(configDir, 'projects', slug, 'memory')
}
function writeMem(configDir, slug, file, content) {
  const dir = memDir(configDir, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content, 'utf8')
}

// Same fixture shape as claude-cross-team.test.js: >=200 bytes (the 200-byte
// skip in _scanProjectDirEntries) with a `cwd` field and one real user turn.
function makeJsonl(cwd, text) {
  const userRow = JSON.stringify({
    type: 'user',
    uuid: 'u-' + Math.random().toString(36).slice(2),
    cwd,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  const assistantRow = JSON.stringify({
    type: 'assistant',
    uuid: 'a-' + Math.random().toString(36).slice(2),
    cwd,
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply'.repeat(60) }] },
  })
  return userRow + '\n' + assistantRow + '\n'
}

describe('usage: listTeamsAsync parity with listTeams', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-teams-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('discovers ~/.claude + ~/.claude-team* identically to the sync version', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true })
    mkdirSync(join(tmp, '.claude-team2'), { recursive: true })
    const store = createStore(':memory:')
    const sync = listTeams(tmp, store)
    const async_ = await listTeamsAsync(tmp, store)
    assert.deepEqual(async_.teams.map((t) => t.id).sort(), sync.teams.map((t) => t.id).sort())
    assert.deepEqual(async_.teams.map((t) => t.exists).sort(), sync.teams.map((t) => t.exists).sort())
    assert.equal(async_.activePath, sync.activePath)
  })

  it('a non-existent team path has exists:false, same as sync', async () => {
    mkdirSync(join(tmp, '.claude-team2'), { recursive: true })
    // team1 (~/.claude) is never created -> exists:false in both
    const async_ = await listTeamsAsync(tmp, null)
    const team1 = async_.teams.find((t) => t.id === 'team1')
    assert.equal(team1.exists, false)
    const team2 = async_.teams.find((t) => t.id === 'team2')
    assert.equal(team2.exists, true)
  })
})

describe('usage: listMemoryTreeAsync parity with listMemoryTree', () => {
  let tmp, claudeDir, team2Dir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-memasync-'))
    claudeDir = join(tmp, '.claude')
    team2Dir = join(tmp, '.claude-team2')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(team2Dir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('aggregates the same teams/projects/fileCount as the sync version', async () => {
    writeMem(claudeDir, '-a', 'MEMORY.md', 'a\n')
    writeMem(claudeDir, '-a', 'feedback_x.md', 'x\n')
    writeMem(team2Dir, '-b', 'MEMORY.md', 'b\n')
    const store = createStore(':memory:')
    const sync = listMemoryTree(tmp, store)
    const async_ = await listMemoryTreeAsync(tmp, store)
    const shape = (teams) => teams.map((t) => ({
      id: t.id,
      slugs: t.projects.map((p) => p.slug).sort(),
      counts: t.projects.map((p) => [p.slug, p.fileCount]).sort(),
    })).sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(shape(async_), shape(sync))
  })

  it('returns [] for a home with no claude dirs at all', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'nano-memasync-empty-'))
    try {
      const teams = await listMemoryTreeAsync(empty, createStore(':memory:'))
      assert.equal(teams.length, 0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('claude-history: findNewestJsonlAsync / parseJsonlHistoryAsync / parseJsonlHistoryTailAsync parity', () => {
  let tmp, projectDir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-hist-'))
    projectDir = join(tmp, 'projects', '-home-proj')
    mkdirSync(projectDir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('findNewestJsonlAsync picks the same newest-mtime file as the sync version', async () => {
    writeFileSync(join(projectDir, 'old.jsonl'), makeJsonl('/home/proj', 'old'))
    utimesSync(join(projectDir, 'old.jsonl'), new Date(Date.now() - 10_000), new Date(Date.now() - 10_000))
    writeFileSync(join(projectDir, 'new.jsonl'), makeJsonl('/home/proj', 'new'))
    const sync = findNewestJsonl(projectDir)
    const async_ = await findNewestJsonlAsync(projectDir)
    assert.equal(async_.sessionId, 'new')
    assert.equal(async_.sessionId, sync.sessionId)
    assert.equal(async_.path, sync.path)
  })

  it('findNewestJsonlAsync returns null for a missing directory, same as sync', async () => {
    const missing = join(tmp, 'projects', '-does-not-exist')
    assert.equal(findNewestJsonl(missing), null)
    assert.equal(await findNewestJsonlAsync(missing), null)
  })

  it('parseJsonlHistoryAsync matches parseJsonlHistory for a small file (dedup logic shared via _rawRowsToEvents)', async () => {
    const p = join(projectDir, 's.jsonl')
    writeFileSync(p, makeJsonl('/home/proj', 'hello world'))
    const sync = parseJsonlHistory(p)
    const async_ = await parseJsonlHistoryAsync(p)
    assert.deepEqual(async_, sync)
    assert.equal(sync.length, 2)
  })

  it('parseJsonlHistoryTailAsync matches parseJsonlHistoryTail for a file above TAIL_BYTES', async () => {
    const p = join(projectDir, 'big.jsonl')
    // Build a file well past the 4 MB tail window with many small turns.
    let content = ''
    for (let i = 0; i < 1200; i++) content += makeJsonl('/home/proj', `turn ${i} `.repeat(50))
    writeFileSync(p, content)
    const sync = parseJsonlHistoryTail(p)
    const async_ = await parseJsonlHistoryTailAsync(p)
    assert.ok(sync.length > 0)
    assert.equal(async_.length, sync.length)
    assert.deepEqual(async_[async_.length - 1], sync[sync.length - 1])
  })

  it('parseJsonlHistoryTailAsync falls back to the full parser for small files, same as sync', async () => {
    const p = join(projectDir, 'small.jsonl')
    writeFileSync(p, makeJsonl('/home/proj', 'tiny'))
    const sync = parseJsonlHistoryTail(p)
    const async_ = await parseJsonlHistoryTailAsync(p)
    assert.deepEqual(async_, sync)
  })
})

describe('claude-history: countUserMessagesAsync parity with countUserMessages', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'nano-count-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('counts the same number of user rows as the sync byte-scan version', async () => {
    const p = join(tmp, 's.jsonl')
    let content = ''
    for (let i = 0; i < 7; i++) content += makeJsonl('/home/proj', `turn ${i}`)
    writeFileSync(p, content)
    assert.equal(await countUserMessagesAsync(p), countUserMessages(p))
    assert.equal(await countUserMessagesAsync(p), 7)
  })

  it('returns 0 for a missing file, same as sync', async () => {
    const missing = join(tmp, 'nope.jsonl')
    assert.equal(countUserMessages(missing), 0)
    assert.equal(await countUserMessagesAsync(missing), 0)
  })
})

describe('claude-history: scanRecentConversationsMultiAsync parity with scanRecentConversationsMulti', () => {
  let tmp, claudeDir, team2Dir, projCwd
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-recent-'))
    claudeDir = join(tmp, '.claude')
    team2Dir = join(tmp, '.claude-team2')
    projCwd = join(tmp, 'proj')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(team2Dir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('returns the same sessions (sorted, enriched) as the sync version across teams', async () => {
    const slug = projCwd.replace(/\//g, '-')
    const dir1 = join(claudeDir, 'projects', slug)
    const dir2 = join(team2Dir, 'projects', slug)
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })
    writeFileSync(join(dir1, 's1.jsonl'), makeJsonl(projCwd, 'first conversation'))
    writeFileSync(join(dir2, 's2.jsonl'), makeJsonl(projCwd, 'second conversation'))

    const store = createStore(':memory:')
    const sync = scanRecentConversationsMulti(tmp, projCwd, store, 5)
    const async_ = await scanRecentConversationsMultiAsync(tmp, projCwd, store, 5)
    const shape = (list) => list.map((e) => ({
      sessionId: e.sessionId, summary: e.summary, messageCount: e.messageCount,
      teamId: e.teamId, isCrossTeam: e.isCrossTeam, isHome: e.isHome,
    })).sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    assert.deepEqual(shape(async_), shape(sync))
    assert.equal(async_.length, 2)
  })

  it('returns [] when no jsonl exists anywhere, same as sync', async () => {
    const store = createStore(':memory:')
    const sync = scanRecentConversationsMulti(tmp, projCwd, store, 5)
    const async_ = await scanRecentConversationsMultiAsync(tmp, projCwd, store, 5)
    assert.deepEqual(async_, sync)
    assert.deepEqual(async_, [])
  })
})

describe('claude-history: resolveSessionJsonlAsync parity with resolveSessionJsonl', () => {
  let tmp, claudeDir, projCwd, store
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-resolve-'))
    claudeDir = join(tmp, '.claude')
    projCwd = join(tmp, 'proj')
    mkdirSync(claudeDir, { recursive: true })
    store = createStore(':memory:')
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('CASE A: explicit sessionId with an existing jsonl resolves the same path', async () => {
    const slug = projCwd.replace(/\//g, '-')
    const dir = join(claudeDir, 'projects', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'abc.jsonl'), makeJsonl(projCwd, 'hi'))
    const project = { cwd: projCwd }
    const tab = { claudeSessionId: 'abc' }
    const sync = resolveSessionJsonl({ store, home: tmp, project, tab })
    const async_ = await resolveSessionJsonlAsync({ store, home: tmp, project, tab })
    assert.deepEqual(async_, sync)
    assert.equal(async_.fallback, false)
    assert.ok(async_.resolvedPath.endsWith('abc.jsonl'))
  })

  it('CASE B: no sessionId falls back to the newest jsonl in the project dir, same as sync', async () => {
    const slug = projCwd.replace(/\//g, '-')
    const dir = join(claudeDir, 'projects', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old.jsonl'), makeJsonl(projCwd, 'old'))
    utimesSync(join(dir, 'old.jsonl'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const project = { cwd: projCwd }
    const tab = {}
    const sync = resolveSessionJsonl({ store, home: tmp, project, tab })
    const async_ = await resolveSessionJsonlAsync({ store, home: tmp, project, tab })
    assert.deepEqual(async_, sync)
    assert.equal(async_.fallback, true)
    assert.equal(async_.resolvedSessionId, 'old')
  })

  it('no jsonl anywhere resolves to null path on both, no crash', async () => {
    const project = { cwd: projCwd }
    const tab = {}
    const sync = resolveSessionJsonl({ store, home: tmp, project, tab })
    const async_ = await resolveSessionJsonlAsync({ store, home: tmp, project, tab })
    assert.deepEqual(async_, sync)
    assert.equal(async_.resolvedPath, null)
  })
})
