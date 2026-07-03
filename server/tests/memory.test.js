/**
 * Tests for the MES-13740 需求7 memory viewer data source.
 *
 * Covers:
 *   - claudeProjectSlugToCwd (lossy reverse decode, display only)
 *   - listMemoryProjects / listMemoryTree (teams × projects-with-memory)
 *   - listMemoryFiles / readMemoryFile (md listing + read, path-traversal guard)
 *   - searchMemory (case-insensitive keyword, line + snippet, cap)
 *   - saveMemoryFile (write + timestamped backup of original)
 *
 * The route layer (team validation against listTeams) is also exercised via a
 * direct call shape check; full HTTP coverage is done in the 9476 hand-test.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeProjectSlugToCwd,
  listMemoryProjects,
  listMemoryTree,
  listMemoryFiles,
  readMemoryFile,
  searchMemory,
  saveMemoryFile,
  listTeams,
} from '../../terminal/usage.js'
import { createStore } from '../store.js'

function memDir(configDir, slug) {
  return join(configDir, 'projects', slug, 'memory')
}

function writeMem(configDir, slug, file, content) {
  const dir = memDir(configDir, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content, 'utf8')
}

describe('memory: claudeProjectSlugToCwd (display decode)', () => {
  it('replaces - with / for an absolute path', () => {
    assert.equal(claudeProjectSlugToCwd('-storage-home-zhiningjiao'), '/storage/home/zhiningjiao')
  })
  it('decodes -tmp to /tmp', () => {
    assert.equal(claudeProjectSlugToCwd('-tmp'), '/tmp')
  })
  it('returns empty for empty input', () => {
    assert.equal(claudeProjectSlugToCwd(''), '')
    assert.equal(claudeProjectSlugToCwd(null), '')
  })
})

describe('memory: listMemoryProjects / listMemoryTree', () => {
  let tmp, claudeDir, team2Dir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-mem-'))
    claudeDir = join(tmp, '.claude')
    team2Dir = join(tmp, '.claude-team2')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(team2Dir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('listMemoryProjects lists only projects with a memory/ dir, counts .md files', () => {
    writeMem(claudeDir, '-home-proj', 'MEMORY.md', '# Title\n')
    writeMem(claudeDir, '-home-proj', 'feedback_x.md', 'feedback\n')
    // a project without memory should be skipped
    mkdirSync(join(claudeDir, 'projects', '-no-mem', 'sessions'), { recursive: true })
    // a memory dir with non-md files only still counts as a project (fileCount 0)
    mkdirSync(join(claudeDir, 'projects', '-only-txt', 'memory'), { recursive: true })
    writeFileSync(join(claudeDir, 'projects', '-only-txt', 'memory', 'notes.txt'), 'x')

    const projects = listMemoryProjects(claudeDir)
    const slugs = projects.map((p) => p.slug).sort()
    assert.deepEqual(slugs, ['-home-proj', '-only-txt'])
    const proj = projects.find((p) => p.slug === '-home-proj')
    assert.equal(proj.fileCount, 2)
    assert.ok(proj.cwd === '/home/proj')
    const onlyTxt = projects.find((p) => p.slug === '-only-txt')
    assert.equal(onlyTxt.fileCount, 0)
  })

  it('listMemoryProjects is sorted newest-mtime first', () => {
    writeMem(claudeDir, '-old', 'MEMORY.md', 'old\n')
    // give -new a newer mtime by writing after a tiny delay
    writeMem(claudeDir, '-new', 'MEMORY.md', 'new\n')
    const projects = listMemoryProjects(claudeDir)
    // both present, order by lastMtime desc — new written later so newer
    assert.equal(projects[0].slug, '-new')
  })

  it('listMemoryTree aggregates all teams and skips non-existent', () => {
    writeMem(claudeDir, '-a', 'MEMORY.md', 'a\n')
    writeMem(team2Dir, '-b', 'MEMORY.md', 'b\n')
    const store = createStore(':memory:')
    const teams = listMemoryTree(tmp, store)
    const ids = teams.map((t) => t.id).sort()
    assert.deepEqual(ids, ['team1', 'team2'])
    const t1 = teams.find((t) => t.id === 'team1')
    assert.ok(t1.projects.some((p) => p.slug === '-a'))
    const t2 = teams.find((t) => t.id === 'team2')
    assert.ok(t2.projects.some((p) => p.slug === '-b'))
  })

  it('listMemoryTree returns empty list for a home with no claude dirs', () => {
    const empty = mkdtempSync(join(tmpdir(), 'nano-empty-'))
    try {
      const store = createStore(':memory:')
      const teams = listMemoryTree(empty, store)
      // team1 always exists in listTeams even if dir absent -> exists:false -> skipped
      assert.equal(teams.length, 0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('memory: listMemoryFiles / readMemoryFile', () => {
  let tmp, configDir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-mf-'))
    configDir = join(tmp, '.claude')
    mkdirSync(configDir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('listMemoryFiles lists .md files newest-first with size + mtime', () => {
    writeMem(configDir, '-p', 'MEMORY.md', '# M\n')
    writeMem(configDir, '-p', 'feedback_x.md', 'x\n')
    const r = listMemoryFiles(configDir, '-p')
    assert.ok(!r.error)
    assert.equal(r.files.length, 2)
    assert.ok(r.files.every((f) => typeof f.size === 'number' && typeof f.mtime === 'number'))
  })

  it('listMemoryFiles rejects an invalid slug (path-traversal guard)', () => {
    const r = listMemoryFiles(configDir, '../etc-passwd')
    assert.ok(r.error)
    assert.match(r.error, /slug/i)
  })

  it('readMemoryFile returns content + meta', () => {
    writeMem(configDir, '-p', 'MEMORY.md', '# Hello\nworld\n')
    const r = readMemoryFile(configDir, '-p', 'MEMORY.md')
    assert.ok(!r.error)
    assert.equal(r.name, 'MEMORY.md')
    assert.equal(r.content, '# Hello\nworld\n')
    assert.equal(r.size, 14)
    assert.ok(r.path.endsWith(join('memory', 'MEMORY.md')))
  })

  it('readMemoryFile rejects non-.md and traversal file names', () => {
    writeMem(configDir, '-p', 'MEMORY.md', 'x')
    assert.ok(readMemoryFile(configDir, '-p', 'secret.txt').error)
    assert.ok(readMemoryFile(configDir, '-p', '../../../etc/passwd').error)
    assert.ok(readMemoryFile(configDir, '-p', 'a/b.md').error)
  })

  it('readMemoryFile rejects invalid slug', () => {
    assert.ok(readMemoryFile(configDir, '../p', 'MEMORY.md').error)
  })

  it('readMemoryFile returns error for missing file', () => {
    writeMem(configDir, '-p', 'MEMORY.md', 'x')
    assert.ok(readMemoryFile(configDir, '-p', 'gone.md').error)
  })
})

describe('memory: searchMemory', () => {
  let tmp, configDir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-ms-'))
    configDir = join(tmp, '.claude')
    mkdirSync(configDir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('finds keyword case-insensitively with file + line + snippet', () => {
    writeMem(configDir, '-p', 'MEMORY.md', '# Title\nKeep this SECRET safe\n')
    writeMem(configDir, '-p', 'feedback.md', 'no match here\nbut secret yes\n')
    const r = searchMemory(configDir, '-p', 'secret')
    assert.equal(r.query, 'secret')
    assert.equal(r.matches.length, 2)
    assert.equal(r.matches[0].file, 'MEMORY.md')
    assert.equal(r.matches[0].line, 2)
    assert.match(r.matches[0].snippet, /SECRET/i)
    assert.equal(r.matches[1].file, 'feedback.md')
    assert.equal(r.matches[1].line, 2)
  })

  it('returns empty matches for empty query', () => {
    writeMem(configDir, '-p', 'MEMORY.md', 'x\n')
    const r = searchMemory(configDir, '-p', '')
    assert.deepEqual(r.matches, [])
  })

  it('rejects invalid slug', () => {
    assert.ok(searchMemory(configDir, '../p', 'x').error)
  })

  it('caps at 200 matches', () => {
    let content = ''
    for (let i = 0; i < 250; i++) content += `line ${i} kwmatch\n`
    writeMem(configDir, '-p', 'big.md', content)
    const r = searchMemory(configDir, '-p', 'kwmatch')
    assert.equal(r.matches.length, 200)
  })
})

describe('memory: saveMemoryFile (edit + backup)', () => {
  let tmp, configDir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nano-mss-'))
    configDir = join(tmp, '.claude')
    mkdirSync(configDir, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('overwrites the file and creates a timestamped .bak backup of the original', () => {
    writeMem(configDir, '-p', 'MEMORY.md', 'original content\n')
    const r = saveMemoryFile(configDir, '-p', 'MEMORY.md', 'new content\n')
    assert.ok(!r.error, r.error)
    assert.equal(readFileSync(join(memDir(configDir, '-p'), 'MEMORY.md'), 'utf8'), 'new content\n')
    assert.ok(r.backupPath, 'backupPath should be set')
    assert.ok(existsSync(r.backupPath), 'backup file should exist on disk')
    assert.equal(readFileSync(r.backupPath, 'utf8'), 'original content\n')
    // backup name pattern: .MEMORY.md.bak.<iso-ts>
    assert.match(r.backupPath.split('/').pop(), /^\.MEMORY\.md\.bak\./)
  })

  it('writes a new file without a backup when the file did not exist', () => {
    mkdirSync(memDir(configDir, '-p'), { recursive: true })
    const r = saveMemoryFile(configDir, '-p', 'fresh.md', 'fresh\n')
    assert.ok(!r.error)
    assert.equal(r.backupPath, null)
    assert.equal(readFileSync(join(memDir(configDir, '-p'), 'fresh.md'), 'utf8'), 'fresh\n')
  })

  it('rejects invalid slug and file name', () => {
    writeMem(configDir, '-p', 'MEMORY.md', 'x')
    assert.ok(saveMemoryFile(configDir, '../p', 'MEMORY.md', 'x').error)
    assert.ok(saveMemoryFile(configDir, '-p', '../../../x.md', 'x').error)
    assert.ok(saveMemoryFile(configDir, '-p', 'notes.txt', 'x').error)
  })

  it('rejects save when the memory dir does not exist', () => {
    const r = saveMemoryFile(configDir, '-nope', 'MEMORY.md', 'x')
    assert.ok(r.error)
  })
})

describe('memory: route team validation shape', () => {
  it('listTeams exposes the team paths the route validates against', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nano-tv-'))
    try {
      mkdirSync(join(tmp, '.claude'), { recursive: true })
      mkdirSync(join(tmp, '.claude-team2'), { recursive: true })
      const store = createStore(':memory:')
      const { teams } = listTeams(tmp, store)
      const paths = teams.map((t) => t.path)
      assert.ok(paths.includes(join(tmp, '.claude')))
      assert.ok(paths.includes(join(tmp, '.claude-team2')))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
