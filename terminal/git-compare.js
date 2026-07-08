/**
 * Branch-compare (git diff) API — project-scoped, runs git in the project cwd.
 *
 *   GET /api/projects/:id/git/branches  → { current, defaultBranch, branches[] }
 *   GET /api/projects/:id/git/compare?base=&head=
 *       → { base, head, ahead, behind, files: [{ path, status, additions, deletions, patch }] }
 *
 * Security: refs are passed to git as separate argv (no shell), and validated
 * against a strict allow-list regex so option-injection (e.g. "--upload-pack")
 * is impossible. Remote-SSH projects are rejected (no local repo to diff).
 */

import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'util'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

// Refs: allow letters, digits, . _ / - ~ (covers branch names, tags, short SHAs).
// Reject anything that could be mistaken for a git option (leading '-') or
// contain shell meta — though execFile never spawns a shell, this is defense
// in depth against `--upload-pack`-style argument injection.
const REF_RE = /^[A-Za-z0-9._/~-]+$/
const MAX_REF_LEN = 200
const MAX_PATCH_BYTES = 200 * 1024 // 200 KB per-file patch cap
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024 // 32 MB (large diffs)

export function isValidRef(ref) {
  if (!ref || typeof ref !== 'string') return false
  if (ref.length > MAX_REF_LEN) return false
  if (ref.startsWith('-')) return false
  return REF_RE.test(ref)
}

/** git quotes paths containing special chars with C-escapes; strip them. */
export function unquotePath(p) {
  if (!p) return p
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    let inner = p.slice(1, -1)
    inner = inner.replace(/\\([0-7]{3}|.)/g, (m, g) => {
      if (/^[0-7]{3}$/.test(g)) {
        return String.fromCharCode(parseInt(g, 8) & 0xff)
      }
      switch (g) {
        case 'n': return '\n'
        case 't': return '\t'
        case 'r': return '\r'
        case '\\': return '\\'
        case '"': return '"'
        default: return g
      }
    })
    return inner
  }
  return p
}

/**
 * Split a full `git diff` output into per-file patch chunks keyed by path.
 * Returns Map<path, patchString>.
 */
export function splitDiffByFile(diff) {
  const map = new Map()
  if (!diff) return map
  const lines = diff.split('\n')
  const chunks = []
  let cur = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (cur) chunks.push(cur)
      cur = [line]
    } else if (cur) {
      cur.push(line)
    }
  }
  if (cur) chunks.push(cur)

  for (const chunkLines of chunks) {
    let path = null
    // Prefer +++ b/<path> (destination); fall back to --- a/<path> (deletions).
    for (const l of chunkLines) {
      if (l.startsWith('+++ ')) {
        const rest = l.slice(4)
        if (rest === '/dev/null') continue
        path = unquotePath(rest.startsWith('b/') ? rest.slice(2) : rest)
        break
      }
    }
    if (!path) {
      for (const l of chunkLines) {
        if (l.startsWith('--- ')) {
          const rest = l.slice(4)
          if (rest === '/dev/null') continue
          path = unquotePath(rest.startsWith('a/') ? rest.slice(2) : rest)
          break
        }
      }
    }
    if (!path) {
      // Last resort: parse "diff --git a/<old> b/<new>".
      const hdr = chunkLines[0] || ''
      const m = hdr.match(/^diff --git a\/(.*) b\/(.*)$/)
      if (m) path = unquotePath(m[2])
    }
    if (path) map.set(path, chunkLines.join('\n'))
  }
  return map
}

export function createGitCompareRoutes(store) {
  const router = Router()

  function resolveCwd(req) {
    const project = store.getProject(req.params.id)
    if (!project) return { error: { status: 404, message: 'project not found' } }
    if (project.ssh_host) return { error: { status: 400, message: 'remote projects unsupported' } }
    if (!project.cwd || !existsSync(project.cwd)) {
      return { error: { status: 404, message: 'project cwd not found' } }
    }
    return { cwd: project.cwd }
  }

  async function git(args, cwd) {
    return execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS })
  }

  // GET /api/projects/:id/git/branches
  router.get('/api/projects/:id/git/branches', async (req, res) => {
    const r = resolveCwd(req)
    if (r.error) return res.status(r.error.status).json({ error: r.error.message })
    const cwd = r.cwd
    try {
      await git(['rev-parse', '--is-inside-work-tree'], cwd)
    } catch {
      return res.status(400).json({ error: 'not a git repository' })
    }
    try {
      const [branchOut, headOut] = await Promise.all([
        git(['branch', '--format=%(refname:short)'], cwd),
        git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      ])
      const current = headOut.stdout.trim() || null
      const branches = branchOut.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name, isCurrent: name === current }))
      let defaultBranch = null
      for (const cand of ['main', 'master']) {
        if (branches.some((b) => b.name === cand)) { defaultBranch = cand; break }
      }
      if (!defaultBranch && branches.length) defaultBranch = branches[0].name
      res.json({ current, defaultBranch, branches })
    } catch (e) {
      res.status(500).json({ error: 'git branch failed', detail: e.message })
    }
  })

  // GET /api/projects/:id/git/compare?base=&head=
  router.get('/api/projects/:id/git/compare', async (req, res) => {
    const r = resolveCwd(req)
    if (r.error) return res.status(r.error.status).json({ error: r.error.message })
    const base = typeof req.query.base === 'string' ? req.query.base.trim() : ''
    const head = typeof req.query.head === 'string' ? req.query.head.trim() : ''
    try {
      const result = await computeDiff((args) => git(args, r.cwd), base, head)
      res.json(result)
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, detail: e.detail })
    }
  })

  return router
}

/**
 * Compute a branch diff (file list + per-file patches + ahead/behind).
 *
 * @param {function(string[]): Promise<{stdout:string,stderr:string}>} gitRun
 *        git runner bound to the target repo cwd (takes argv only).
 * @param {string} base
 * @param {string} head
 * @returns {Promise<{base,head,ahead,behind,files}>}
 * @throws {Error} with `.status=400` for invalid/unverifiable refs, `.status=500` for git failures.
 */
export async function computeDiff(gitRun, base, head) {
  if (!isValidRef(base) || !isValidRef(head)) {
    const e = new Error('invalid base/head ref'); e.status = 400; throw e
  }
  if (base === head) return { base, head, ahead: 0, behind: 0, files: [] }
  try {
    await gitRun(['rev-parse', '--verify', `${base}^{commit}`])
    await gitRun(['rev-parse', '--verify', `${head}^{commit}`])
  } catch {
    const e = new Error('invalid ref (not found in repo)'); e.status = 400; throw e
  }
  try {
    const [nameStatusOut, numstatOut, diffOut, aheadOut, behindOut] = await Promise.all([
      gitRun(['diff', '--name-status', base, head]),
      gitRun(['diff', '--numstat', base, head]),
      gitRun(['diff', base, head]),
      gitRun(['rev-list', '--count', `${base}..${head}`]),
      gitRun(['rev-list', '--count', `${head}..${base}`]),
    ])

    // status per (final) path
    const statusByPath = new Map()
    for (const line of nameStatusOut.stdout.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const code = parts[0] || ''
      const path = parts[parts.length - 1] // R/C: [old, new] → new
      statusByPath.set(path, code[0]) // M/A/D/R/C/T/U
    }

    // additions/deletions per path
    const statByPath = new Map()
    for (const line of numstatOut.stdout.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const adds = parts[0] === '-' ? null : parseInt(parts[0], 10)
      const dels = parts[1] === '-' ? null : parseInt(parts[1], 10)
      const p = parts.length >= 3 ? parts[parts.length - 1] : ''
      statByPath.set(p, { additions: Number.isFinite(adds) ? adds : null, deletions: Number.isFinite(dels) ? dels : null })
    }

    const patches = splitDiffByFile(diffOut.stdout)

    const files = []
    for (const [path, status] of statusByPath) {
      const stat = statByPath.get(path) || { additions: null, deletions: null }
      let patch = patches.get(path) || ''
      let truncated = false
      if (patch.length > MAX_PATCH_BYTES) {
        patch = patch.slice(0, MAX_PATCH_BYTES) + '\n…[truncated]'
        truncated = true
      }
      files.push({
        path,
        status: status || 'M',
        additions: stat.additions,
        deletions: stat.deletions,
        binary: stat.additions === null && stat.deletions === null,
        truncated,
        patch,
      })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))

    const ahead = parseInt(aheadOut.stdout.trim(), 10) || 0
    const behind = parseInt(behindOut.stdout.trim(), 10) || 0
    return { base, head, ahead, behind, files }
  } catch (e) {
    if (e.status) throw e
    const err = new Error('git diff failed'); err.status = 500; err.detail = e.message; throw err
  }
}
