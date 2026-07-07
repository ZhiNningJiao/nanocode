/**
 * Repo-scoped git compare API — works from a top-level (~zhining) launch.
 *
 * Unlike the project-scoped routes in git-compare.js (which require the
 * project's cwd to be a git repo), these routes are driven by an explicit
 * repo path selected from a dropdown. The server scans ~/code for git
 * repos/worktrees, lists branches (fetching first), and diffs two refs.
 *
 *   GET /api/repos                          → { repos: [{ name, path, branch, isWorktree }] }
 *   GET /api/repos/branches?path=<abs>      → { current, defaultBranch, branches[] }
 *   GET /api/repos/compare?path=<abs>&base=&head=
 *       → { base, head, ahead, behind, files[] }
 *
 * Security / red lines:
 *   - repo path MUST resolve under ~/code (sandbox). Anything else → 403.
 *   - server is read-only to every repo EXCEPT `git fetch --all --prune`
 *     (updates remote-tracking refs only; never checks out / pulls / touches
 *     the working tree or local branches).
 *   - refs are validated by isValidRef (no option-injection); passed to git
 *     as separate argv (no shell).
 */

import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'util'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, relative, sep, join } from 'node:path'
import { homedir } from 'node:os'
import { computeDiff, isValidRef } from './git-compare.js'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 20_000
const FETCH_TIMEOUT_MS = 25_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024

/**
 * Resolve and sandbox a repo path under ~/code. Returns the absolute
 * path if it is inside ~/code, otherwise throws a 403 error.
 *
 * Exported for unit testing.
 */
export function resolveRepoPath(rawPath, { codeRoot } = {}) {
  const root = codeRoot || join(homedir(), 'code')
  if (!rawPath || typeof rawPath !== 'string') {
    const e = new Error('path required'); e.status = 400; throw e
  }
  const resolved = resolve(rawPath)
  const rel = relative(root, resolved)
  // relative() returns '' when resolved === root, and a path starting with
  // '..' when resolved is outside root. Both must be rejected.
  if (rel === '' || rel.startsWith('..')) {
    const e = new Error('repo path must be under ~/code'); e.status = 403; throw e
  }
  return resolved
}

// Re-export for tests / consumers
export { isValidRef }

/**
 * Scan a directory for git repos and linked worktrees. Returns a list of
 * { name, path, branch, isWorktree } sorted by name. Shallow scan of the
 * direct children of `codeRoot` — covers regular repos and wt-* worktrees
 * which live as direct children of ~/code.
 *
 * Exported for unit testing (no HTTP needed).
 */
export async function scanRepos(codeRoot, { exec = execFileAsync } = {}) {
  const out = []
  let entries = []
  try { entries = readdirSync(codeRoot) } catch { return out }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const dir = join(codeRoot, name)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    // Quick fs check: .git must exist (file for worktrees, dir for repos).
    if (!existsSync(join(dir, '.git'))) continue
    try {
      const branchOut = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeout: GIT_TIMEOUT_MS,
      })
      const toplevelOut = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
        timeout: GIT_TIMEOUT_MS,
      })
      const branch = branchOut.stdout.trim() || '(detached)'
      const toplevel = toplevelOut.stdout.trim()
      // isWorktree: the worktree's toplevel differs from the common .git dir,
      // i.e. toplevel is not where the main repo lives. A reliable signal:
      // .git is a file (not a dir). We approximate via toplevel !== dir for
      // bare-checkout edge cases; for the common case (wt-* under ~/code)
      // toplevel === dir so use the .git-file signal.
      const isWorktree = existsSync(join(dir, '.git')) && !statSync(join(dir, '.git')).isDirectory()
      out.push({ name, path: dir, branch, isWorktree, toplevel })
    } catch {
      // not a usable git repo (e.g. .git is a broken pointer) → skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * Parse `git for-each-ref` output (tab-separated fields) into a branch list.
 * Fields: refname:short \t committerdate:unix \t committerdate:iso \t authorname \t subject
 *
 * Remote symbolic refs (refs/remotes/<remote>/HEAD) are skipped. The branch
 * `name` for remote refs is `<remote>/<branch>` (e.g. `origin/main`).
 *
 * Exported for unit testing.
 */
export function parseBranchList(forEachRefOut, headOut) {
  const current = (headOut || '').trim() || null
  const branches = []
  for (const line of (forEachRefOut || '').split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [name, tsStr, iso, author, subject] = parts
    if (!name) continue
    // skip remote symbolic HEAD pointers: short name ends with '/HEAD'
    if (/\/HEAD$/.test(name)) continue
    const isRemote = name.includes('/') && /^(origin|upstream|github|gitlab)\//.test(name)
    branches.push({
      name,
      isCurrent: name === current,
      isRemote: !!isRemote,
      lastCommitTs: Number.isFinite(parseInt(tsStr, 10)) ? parseInt(tsStr, 10) : null,
      lastCommitIso: iso || null,
      author: author || '',
      subject: subject || '',
    })
  }
  return { current, branches }
}

export function createReposRoutes({ home, codeRoot } = {}) {
  const router = Router()
  const root = codeRoot || join(home || homedir(), 'code')

  async function git(args, cwd, timeout = GIT_TIMEOUT_MS) {
    return execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, timeout })
  }

  // GET /api/repos — list git repos/worktrees under ~/code
  router.get('/api/repos', async (_req, res) => {
    try {
      const repos = await scanRepos(root)
      res.json({ repos })
    } catch (e) {
      res.status(500).json({ error: 'repo scan failed', detail: e.message })
    }
  })

  // GET /api/repos/branches?path=<abs> — fetch + list branches by recent commit
  router.get('/api/repos/branches', async (req, res) => {
    let cwd
    try { cwd = resolveRepoPath(req.query.path, { codeRoot: root }) }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }) }

    try {
      await git(['rev-parse', '--is-inside-work-tree'], cwd)
    } catch {
      return res.status(400).json({ error: 'not a git repository' })
    }

    // Fetch remote refs — read-only to the working tree. Best-effort:
    // failures (offline, no remotes) are swallowed so local branches still
    // list. Timeout via git's own --timeout-ish mechanism (we pass timeout).
    try {
      await git(['fetch', '--all', '--prune'], cwd, FETCH_TIMEOUT_MS)
    } catch {
      // ignore — offline / no remotes; continue with local refs
    }

    try {
      const fmt = '%(refname:short)\t%(committerdate:unix)\t%(committerdate:iso)\t%(authorname)\t%(subject)'
      const [branchOut, headOut, defaultOut] = await Promise.all([
        git(['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'], cwd),
        git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
        git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).catch(() => ({ stdout: '' })),
      ])
      const { current, branches } = parseBranchList(branchOut.stdout, headOut.stdout)
      let defaultBranch = null
      for (const cand of ['main', 'master']) {
        if (branches.some((b) => b.name === cand)) { defaultBranch = cand; break }
      }
      // Prefer the upstream's declared default (origin/HEAD → strip prefix).
      if (!defaultBranch) {
        const up = (defaultOut.stdout || '').trim()
        if (up && branches.some((b) => b.name === up)) defaultBranch = up
      }
      if (!defaultBranch && branches.length) defaultBranch = branches[0].name
      res.json({ current, defaultBranch, branches })
    } catch (e) {
      res.status(500).json({ error: 'git branch failed', detail: e.message })
    }
  })

  // GET /api/repos/compare?path=<abs>&base=&head= — diff two refs in the repo
  router.get('/api/repos/compare', async (req, res) => {
    let cwd
    try { cwd = resolveRepoPath(req.query.path, { codeRoot: root }) }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }) }
    const base = typeof req.query.base === 'string' ? req.query.base.trim() : ''
    const head = typeof req.query.head === 'string' ? req.query.head.trim() : ''
    try {
      const result = await computeDiff((args) => git(args, cwd), base, head)
      res.json(result)
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, detail: e.detail })
    }
  })

  return router
}
