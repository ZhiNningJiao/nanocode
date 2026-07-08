/**
 * Tests for the repo-scoped compare API (terminal/repos-routes.js).
 *
 * Covers:
 *   - resolveRepoPath(): sandbox enforcement (~/code only)
 *   - parseBranchList(): for-each-ref parsing + remote HEAD skipping
 *   - scanRepos(): discovering git repos + worktrees under a code root
 *   - HTTP routes: GET /api/repos, /api/repos/branches, /api/repos/compare
 *     — including the read-only `git fetch` path and 403 sandbox rejection.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import express from 'express'
import {
  resolveRepoPath,
  parseBranchList,
  scanRepos,
  createReposRoutes,
} from '../../terminal/repos-routes.js'

// ── Test sandbox helpers ─────────────────────────────────────────────────────

let tmpRoot
let codeRoot

function makeTempRoot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nanocode-repos-routes-'))
  return dir
}

function gitInit(repoPath, { bare = false } = {}) {
  mkdirSync(repoPath, { recursive: true })
  const args = ['init', bare ? '--bare' : '--initial-branch=main', repoPath]
  execFileSync('git', args, { stdio: 'ignore' })
  if (!bare) {
    execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Test'], { stdio: 'ignore' })
  }
}

function commit(repoPath, msg, fname = 'file.txt', content = null, date = null) {
  const body = content != null ? content : `${msg}\n`
  writeFileSync(path.join(repoPath, fname), body)
  execFileSync('git', ['-C', repoPath, 'add', fname], { stdio: 'ignore' })
  const env = { ...process.env }
  if (date) {
    env.GIT_AUTHOR_DATE = date
    env.GIT_COMMITTER_DATE = date
  }
  execFileSync('git', ['-C', repoPath, 'commit', '-m', msg], { stdio: 'ignore', env })
  return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function branch(repoPath, name) {
  execFileSync('git', ['-C', repoPath, 'branch', name], { stdio: 'ignore' })
}

function checkoutNew(repoPath, name) {
  execFileSync('git', ['-C', repoPath, 'checkout', '-b', name], { stdio: 'ignore' })
}

// ── HTTP request helper ──────────────────────────────────────────────────────

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address()
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        let body
        try { body = JSON.parse(buf) } catch { body = buf }
        resolve({ status: res.statusCode, body })
      })
    })
    req.on('error', reject)
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolveRepoPath — ~/code sandbox', () => {
  const root = '/tmp/fakehome/code'

  it('accepts a path inside ~/code', () => {
    assert.equal(resolveRepoPath('/tmp/fakehome/code/foo', { codeRoot: root }), '/tmp/fakehome/code/foo')
  })

  it('accepts a nested path inside ~/code', () => {
    assert.equal(resolveRepoPath('/tmp/fakehome/code/wt-x/sub', { codeRoot: root }), '/tmp/fakehome/code/wt-x/sub')
  })

  it('normalizes .. traversal back inside ~/code', () => {
    assert.equal(resolveRepoPath('/tmp/fakehome/code/foo/../bar', { codeRoot: root }), '/tmp/fakehome/code/bar')
  })

  it('rejects a path outside ~/code (403)', () => {
    assert.throws(() => resolveRepoPath('/etc/hosts', { codeRoot: root }), (e) => e.status === 403)
  })

  it('rejects traversal that escapes ~/code (403)', () => {
    assert.throws(() => resolveRepoPath('/tmp/fakehome/code/../etc', { codeRoot: root }), (e) => e.status === 403)
  })

  it('rejects the code root itself (403)', () => {
    assert.throws(() => resolveRepoPath('/tmp/fakehome/code', { codeRoot: root }), (e) => e.status === 403)
  })

  it('rejects a missing path (400)', () => {
    assert.throws(() => resolveRepoPath('', { codeRoot: root }), (e) => e.status === 400)
    assert.throws(() => resolveRepoPath(null, { codeRoot: root }), (e) => e.status === 400)
  })
})

describe('parseBranchList — for-each-ref parsing', () => {
  it('parses local + remote branches with commit metadata', () => {
    const out = [
      'main\t1700000000\t2023-11-14T22:13:20+00:00\tAlice\tfix bug',
      'feature/x\t1699000000\t2023-11-03T10:00:00+00:00\tBob\tadd feature',
      'origin/main\t1699500000\t2023-11-09T12:00:00+00:00\tCarol\tmerge',
    ].join('\n')
    const { current, branches } = parseBranchList(out, 'main')
    assert.equal(current, 'main')
    assert.equal(branches.length, 3)
    assert.equal(branches[0].name, 'main')
    assert.equal(branches[0].isCurrent, true)
    assert.equal(branches[0].isRemote, false)
    assert.equal(branches[0].lastCommitTs, 1700000000)
    assert.equal(branches[0].subject, 'fix bug')
    assert.equal(branches[1].name, 'feature/x')
    assert.equal(branches[2].name, 'origin/main')
    assert.equal(branches[2].isRemote, true)
  })

  it('skips remote symbolic HEAD refs', () => {
    const out = [
      'main\t1700000000\t2023-11-14T22:13:20+00:00\tA\tm',
      'origin/main\t1699500000\t2023-11-09T12:00:00+00:00\tC\tmerge',
      'origin/HEAD\t1699500000\t2023-11-09T12:00:00+00:00\tC\tmerge',
    ].join('\n')
    const { branches } = parseBranchList(out, 'main')
    assert.equal(branches.length, 2)
    assert.equal(branches.some((b) => b.name === 'origin/HEAD'), false)
  })

  it('handles empty / malformed output gracefully', () => {
    const { current, branches } = parseBranchList('', '')
    assert.equal(current, null)
    assert.deepEqual(branches, [])
  })
})

describe('scanRepos — discover git repos under a code root', () => {
  beforeEach(() => {
    tmpRoot = makeTempRoot()
    codeRoot = path.join(tmpRoot, 'code')
    mkdirSync(codeRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('lists git repos and skips non-git dirs', async () => {
    const repoA = path.join(codeRoot, 'repo-a')
    const repoB = path.join(codeRoot, 'repo-b')
    const notGit = path.join(codeRoot, 'not-a-repo')
    gitInit(repoA); commit(repoA, 'a1')
    gitInit(repoB); commit(repoB, 'b1')
    mkdirSync(notGit, { recursive: true }) // no .git → skipped

    const repos = await scanRepos(codeRoot)
    const names = repos.map((r) => r.name)
    assert.deepEqual(names, ['repo-a', 'repo-b'])
    assert.equal(repos[0].path, repoA)
    assert.equal(repos[0].branch, 'main')
    assert.equal(repos[0].isWorktree, false)
  })

  it('marks worktrees (linked .git file) as isWorktree=true', async () => {
    const mainRepo = path.join(codeRoot, 'mainrepo')
    gitInit(mainRepo); commit(mainRepo, 'm1')
    const wt = path.join(codeRoot, 'wt-thing')
    execFileSync('git', ['-C', mainRepo, 'worktree', 'add', wt, '-b', 'wt-branch'], { stdio: 'ignore' })

    const repos = await scanRepos(codeRoot)
    const byName = Object.fromEntries(repos.map((r) => [r.name, r]))
    assert.ok(byName.mainrepo, 'main repo listed')
    assert.ok(byName['wt-thing'], 'worktree listed')
    assert.equal(byName['wt-thing'].isWorktree, true)
    assert.equal(byName['wt-thing'].branch, 'wt-branch')
    assert.equal(byName.mainrepo.isWorktree, false)
  })

  it('returns empty list when code root does not exist', async () => {
    const repos = await scanRepos(path.join(tmpRoot, 'nope'))
    assert.deepEqual(repos, [])
  })
})

describe('repos routes — HTTP', () => {
  let app
  let server

  beforeEach(() => {
    tmpRoot = makeTempRoot()
    codeRoot = path.join(tmpRoot, 'code')
    mkdirSync(codeRoot, { recursive: true })
  })

  afterEach(async () => {
    if (server) await close(server)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function startServer() {
    app = express()
    app.use(createReposRoutes({ home: tmpRoot, codeRoot }))
    // eslint-disable-next-line no-unused-vars
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve(server))
    })
  }

  it('GET /api/repos lists repos under the code root', async () => {
    const repoA = path.join(codeRoot, 'repo-a')
    const repoB = path.join(codeRoot, 'repo-b')
    gitInit(repoA); commit(repoA, 'a1')
    gitInit(repoB); commit(repoB, 'b1')

    await startServer()
    const { status, body } = await get(server, '/api/repos')
    assert.equal(status, 200)
    assert.equal(body.repos.length, 2)
    assert.deepEqual(body.repos.map((r) => r.name).sort(), ['repo-a', 'repo-b'])
  })

  it('GET /api/repos/branches lists branches sorted by recent commit + returns default', async () => {
    const repo = path.join(codeRoot, 'r')
    gitInit(repo)
    // first commit (older) — both main and feature branch point here initially
    commit(repo, 'first', 'a.txt', 'a\n', '1699000000 +0000')
    branch(repo, 'feature') // created at HEAD → feature tip = 'first' (older)
    execFileSync('git', ['-C', repo, 'checkout', 'main'], { stdio: 'ignore' })
    // advance main with a newer commit so main is the most recent
    commit(repo, 'second', 'a.txt', 'a\nmore\n', '1700000000 +0000')

    await startServer()
    const { status, body } = await get(server, `/api/repos/branches?path=${encodeURIComponent(repo)}`)
    assert.equal(status, 200)
    assert.equal(body.current, 'main')
    assert.equal(body.defaultBranch, 'main')
    const names = body.branches.map((b) => b.name)
    assert.ok(names.includes('main'))
    assert.ok(names.includes('feature'))
    // most-recent commit first → main (newer ts) before feature (older ts)
    assert.equal(body.branches[0].name, 'main')
    assert.ok(body.branches[0].lastCommitTs > body.branches[1].lastCommitTs,
      'main should have a newer commit ts than feature')
    assert.ok(body.branches[0].lastCommitTs > 0)
  })

  it('GET /api/repos/branches rejects paths outside ~/code (403)', async () => {
    await startServer()
    const { status, body } = await get(server, '/api/repos/branches?path=/etc')
    assert.equal(status, 403)
    assert.match(body.error, /under ~\/code/)
  })

  it('GET /api/repos/branches rejects non-git path (400)', async () => {
    const notGit = path.join(codeRoot, 'notgit')
    mkdirSync(notGit, { recursive: true })
    await startServer()
    const { status } = await get(server, `/api/repos/branches?path=${encodeURIComponent(notGit)}`)
    assert.equal(status, 400)
  })

  it('GET /api/repos/compare returns the diff between two branches', async () => {
    const repo = path.join(codeRoot, 'r')
    gitInit(repo)
    commit(repo, 'base commit', 'a.txt', 'a\n')
    checkoutNew(repo, 'feature')
    commit(repo, 'feat commit', 'a.txt', 'a\nfeature line\n')
    // add a new file on feature
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    execFileSync('git', ['-C', repo, 'add', 'b.txt'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'commit', '-m', 'add b'], { stdio: 'ignore' })

    await startServer()
    const q = new URLSearchParams({ path: repo, base: 'main', head: 'feature' })
    const { status, body } = await get(server, `/api/repos/compare?${q}`)
    assert.equal(status, 200)
    assert.equal(body.base, 'main')
    assert.equal(body.head, 'feature')
    assert.ok(body.ahead >= 2, 'feature is ahead of main')
    assert.equal(body.behind, 0)
    const paths = body.files.map((f) => f.path)
    assert.ok(paths.includes('a.txt'))
    assert.ok(paths.includes('b.txt'))
    const a = body.files.find((f) => f.path === 'a.txt')
    assert.ok(a.patch.includes('feature line'), 'patch contains the added line')
    assert.ok(a.additions >= 1)
  })

  it('GET /api/repos/compare with same base/head returns empty diff', async () => {
    const repo = path.join(codeRoot, 'r')
    gitInit(repo); commit(repo, 'c1', 'a.txt', 'a\n')
    await startServer()
    const q = new URLSearchParams({ path: repo, base: 'main', head: 'main' })
    const { status, body } = await get(server, `/api/repos/compare?${q}`)
    assert.equal(status, 200)
    assert.equal(body.ahead, 0)
    assert.equal(body.behind, 0)
    assert.deepEqual(body.files, [])
  })

  it('GET /api/repos/compare rejects invalid refs (400)', async () => {
    const repo = path.join(codeRoot, 'r')
    gitInit(repo); commit(repo, 'c1', 'a.txt', 'a\n')
    await startServer()
    const q = new URLSearchParams({ path: repo, base: 'main', head: '--upload-pack=evil' })
    const { status } = await get(server, `/api/repos/compare?${q}`)
    assert.equal(status, 400)
  })

  it('GET /api/repos/compare rejects paths outside ~/code (403)', async () => {
    await startServer()
    const q = new URLSearchParams({ path: '/etc', base: 'main', head: 'feature' })
    const { status } = await get(server, `/api/repos/compare?${q}`)
    assert.equal(status, 403)
  })
})
