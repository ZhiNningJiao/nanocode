/**
 * Tests for the MES-13740 需求14 compare plugin data source (terminal/compare.js).
 *
 * Covers (against a throwaway temp git repo with real branches + diffs):
 *   - listBranches: newest-first order, current branch, default base/head, worktree
 *   - diffOverview: numstat file list + summary (+n/-m, files:k)
 *   - fileDiff: unified diff for a single file
 *   - read-only safety: base/head validated against the real branch list
 *   - path safety: `..` / leading `/` in the file pathspec rejected
 *   - non-git cwd → { error } (never throws)
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBranches, diffOverview, fileDiff } from '../../terminal/compare.js'

function git(repo, args, opts = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts })
}

/** Create a temp git repo: main with a.txt + b.txt, then a feature branch
 *  that adds c.txt and modifies a.txt. Produces a real, parseable diff. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'nano-cmp-'))
  // init on `main` explicitly (git versions differ on the default branch name)
  try { git(repo, ['init', '-q', '-b', 'main']) } catch { git(repo, ['init', '-q']); git(repo, ['branch', '-m', 'main']) }
  git(repo, ['config', 'user.email', 't@t.test'])
  git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'line1\n')
  writeFileSync(join(repo, 'b.txt'), 'b1\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'main: initial'])
  // feature branch
  git(repo, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n')
  writeFileSync(join(repo, 'c.txt'), 'c1\n')
  mkdirSync(join(repo, 'sub'), { recursive: true })
  writeFileSync(join(repo, 'sub', 'd.txt'), 'd1\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'feature: add c + sub/d, modify a'])
  git(repo, ['checkout', '-q', 'main'])
  return repo
}

describe('compare: listBranches', () => {
  let repo
  beforeEach(() => { repo = makeRepo() })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch {} })

  it('lists newest-first, marks current, picks default base=head', async () => {
    const r = await listBranches(repo, 10)
    assert.ok(!r.error, r.error)
    const names = r.branches.map((b) => b.name)
    // feature (newer commit) should sort before main
    assert.equal(names[0], 'feature')
    assert.ok(names.includes('main'))
    assert.equal(r.current, 'main') // we left it on main
    assert.equal(r.defaultHead, 'feature') // newest
    assert.equal(r.defaultBase, 'main') // main exists
  })

  it('respects the limit cap (newest-N window) but always keeps main', async () => {
    const r = await listBranches(repo, 1)
    const names = r.branches.map((b) => b.name)
    // newest-1 window = [feature], but main is always kept so "vs main" works
    assert.ok(names.includes('feature'))
    assert.ok(names.includes('main'))
    assert.equal(r.branches.length, 2)
  })

  it('caps limit into [1,50]', async () => {
    const r1 = await listBranches(repo, 0)
    assert.ok(r1.branches.length >= 1) // 0 clamps to 1
    const r2 = await listBranches(repo, 9999)
    assert.ok(r2.branches.length <= 52) // 50 cap + up to 2 always-kept defaults
  })

  it('returns { error } for a non-git cwd (never throws)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'nano-nogit-'))
    try {
      const r = await listBranches(tmp, 10)
      assert.ok(r.error)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('compare: diffOverview', () => {
  let repo
  beforeEach(() => { repo = makeRepo() })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch {} })

  it('returns the numstat file list + summary for main..feature', async () => {
    const r = await diffOverview(repo, 'main', 'feature')
    assert.ok(!r.error, r.error)
    const paths = r.files.map((f) => f.path).sort()
    assert.deepEqual(paths, ['a.txt', 'c.txt', 'sub/d.txt'])
    const a = r.files.find((f) => f.path === 'a.txt')
    assert.equal(a.additions, 1)
    assert.equal(a.deletions, 0)
    assert.equal(a.binary, false)
    assert.ok(r.summary.files >= 3)
    assert.ok(r.summary.insertions >= 3) // a:+1, c:+1, sub/d:+1
  })

  it('returns empty files + zero summary for identical branches', async () => {
    const r = await diffOverview(repo, 'main', 'main')
    assert.deepEqual(r.files, [])
    assert.equal(r.summary.files, 0)
  })

  it('rejects unknown branch names (membership validation)', async () => {
    const r = await diffOverview(repo, 'main', 'no-such-branch')
    assert.ok(r.error)
    assert.match(r.error, /unknown branch/)
  })

  it('rejects missing base/head', async () => {
    const r = await diffOverview(repo, '', 'feature')
    assert.ok(r.error)
  })
})

describe('compare: fileDiff', () => {
  let repo
  beforeEach(() => { repo = makeRepo() })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch {} })

  it('returns a unified diff for a single file', async () => {
    const r = await fileDiff(repo, 'main', 'feature', 'a.txt')
    assert.ok(!r.error, r.error)
    assert.match(r.diff, /diff --git a\/a\.txt b\/a\.txt/)
    assert.match(r.diff, /\+line2/)
  })

  it('returns a diff for a nested file path', async () => {
    const r = await fileDiff(repo, 'main', 'feature', 'sub/d.txt')
    assert.ok(!r.error, r.error)
    assert.match(r.diff, /diff --git a\/sub\/d\.txt b\/sub\/d\.txt/)
  })

  it('rejects `..` path traversal', async () => {
    const r = await fileDiff(repo, 'main', 'feature', '../a.txt')
    assert.ok(r.error)
    assert.match(r.error, /invalid file path/)
  })

  it('rejects an absolute path', async () => {
    const r = await fileDiff(repo, 'main', 'feature', '/etc/passwd')
    assert.ok(r.error)
  })

  it('rejects unknown branches', async () => {
    const r = await fileDiff(repo, 'main', 'ghost', 'a.txt')
    assert.ok(r.error)
    assert.match(r.error, /unknown branch/)
  })

  it('returns empty diff for identical branches', async () => {
    const r = await fileDiff(repo, 'main', 'main', 'a.txt')
    assert.equal(r.diff, '')
  })
})
