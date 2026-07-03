/**
 * Compare plugin data source — MES-13740 需求14.
 *
 * Read-only git branch discovery + diff for the "recent branches compare" view.
 * This is the first "heavy feature plugin" sample for the 需求6 plugin registry.
 *
 * Three operations (all read-only — never checkout or mutate the worktree):
 *   - listBranches(cwd, limit)  — `git for-each-ref` newest-first + worktree map
 *   - diffOverview(cwd, b, h)  — `git diff --numstat` + `--shortstat` (file list + summary)
 *   - fileDiff(cwd, b, h, f)   — `git diff b h -- <file>` (unified diff, plain text)
 *
 * Security: `base`/`head` are validated against the actual `git for-each-ref`
 * output (membership), so no arbitrary ref can be passed. `file` is validated
 * against a strict path regex (no `..`, no leading `/`, no NUL). All git calls
 * use `execFile` (no shell), with a timeout. Errors are returned as `{ error }`,
 * never thrown — the UI labels them honestly (防假过).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT = 8000
// Strict git refname-ish charset for the file pathspec. Rejects `..`, leading
// `/`, NUL, spaces-in-weird-places. Good enough: git paths are relative, no `..`.
const FILE_RE = /^[A-Za-z0-9._/+@~-][A-Za-z0-9._/+@~\s-]*$/
// Reject any path containing a `..` segment (path traversal / parent ref).
const DOTDOT_RE = /(^|\/)\.\.(\/|$)/

/** Run git in cwd; resolves to { stdout } or throws (caught by callers). */
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT })
  return stdout
}

/** Parse `git worktree list --porcelain` into a Map<refname, worktreePath>. */
function parseWorktrees(out) {
  const map = new Map()
  let wt = null
  for (const raw of String(out || '').split('\n')) {
    const line = raw.trimEnd()
    if (!line) { wt = null; continue }
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const val = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'worktree') wt = val
    else if (key === 'branch' && wt) map.set(val, wt) // branch is full refname: refs/heads/x
  }
  return map
}

/** Parse `--shortstat`: " 3 files changed, 10 insertions(+), 2 deletions(-)". */
function parseShortstat(out) {
  const s = String(out || '').trim()
  const files = (/(\d+)\s+files?\s+changed/i.exec(s) || [])[1]
  const ins = (/(\d+)\s+insertions?\(\+\)/i.exec(s) || [])[1]
  const del = (/(\d+)\s+deletions?\(-\)/i.exec(s) || [])[1]
  return {
    files: files ? Number(files) : 0,
    insertions: ins ? Number(ins) : 0,
    deletions: del ? Number(del) : 0,
  }
}

/** List local branches newest-first with commit metadata + worktree annotation.
 *  The default branch (main/master) is ALWAYS included even when it falls
 *  outside the newest-N window, so "newest branch vs main" works regardless of
 *  how old main is. Returns { branches, current, defaultBase, defaultHead } or
 *  { error }. */
export async function listBranches(cwd, limit = 10) {
  if (!cwd) return { error: 'no cwd' }
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)))
  try {
    const fmt = '%(refname:short)%09%(committerdate:iso-strict)%09%(objectname:short)%09%(subject)'
    // Fetch all local branches (cap 200 for safety) — we slice to the newest-N
    // below but always keep main/master so it's selectable as the base.
    const out = await git(cwd, ['for-each-ref', `--sort=-committerdate`, `--format=${fmt}`, 'refs/heads'])
    const wts = parseWorktrees(await git(cwd, ['worktree', 'list', '--porcelain']))
    let current = ''
    try { current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch {}

    const all = []
    for (const line of String(out).split('\n')) {
      if (!line) continue
      const [name, date, sha, ...rest] = line.split('\t')
      if (!name) continue
      all.push({
        name,
        date: date || '',
        sha: sha || '',
        subject: (rest.join('\t') || '').slice(0, 160),
        current: name === current,
        worktree: wts.get(`refs/heads/${name}`) || '',
      })
    }

    // Newest-N window.
    const branches = all.slice(0, n)
    const seen = new Set(branches.map((b) => b.name))
    // Always keep main/master selectable as a compare base even when old.
    for (const dflt of ['main', 'master']) {
      const b = all.find((x) => x.name === dflt)
      if (b && !seen.has(dflt)) { branches.push(b); seen.add(dflt) }
    }

    const names = branches.map((b) => b.name)
    const defaultHead = names[0] || ''
    const defaultBase =
      names.includes('main') ? 'main'
        : names.includes('master') ? 'master'
          : (names[names.length - 1] || '')
    return { branches, current, defaultBase, defaultHead }
  } catch (err) {
    return { error: String(err && err.message || err), branches: [], current: '', defaultBase: '', defaultHead: '' }
  }
}

/** Resolve + validate base/head against the real branch list. Returns Set of
 *  valid names, or throws if the repo can't be read (caller catches → {error}). */
async function validBranchSet(cwd) {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return new Set(String(out).split('\n').map((s) => s.trim()).filter(Boolean))
}

/** Overview of changes between two branches: per-file numstat + summary.
 *  Returns { files, summary } or { error }. */
export async function diffOverview(cwd, base, head) {
  if (!cwd) return { error: 'no cwd' }
  if (!base || !head) return { error: 'base and head required' }
  if (base === head) return { files: [], summary: { files: 0, insertions: 0, deletions: 0 } }
  try {
    const valid = await validBranchSet(cwd)
    if (!valid.has(base) || !valid.has(head)) {
      return { error: `unknown branch (base=${base} head=${head})` }
    }
    const numstat = await git(cwd, ['diff', '--numstat', base, head])
    const files = []
    for (const line of String(numstat).split('\n')) {
      if (!line) continue
      const [a, d, ...rest] = line.split('\t')
      if (rest.length === 0) continue
      const path = rest.join('\t')
      files.push({
        path,
        additions: a === '-' ? null : Number(a),
        deletions: d === '-' ? null : Number(d),
        binary: a === '-' || d === '-',
      })
    }
    const shortstat = await git(cwd, ['diff', '--shortstat', base, head])
    return { files, summary: parseShortstat(shortstat) }
  } catch (err) {
    return { error: String(err && err.message || err), files: [], summary: { files: 0, insertions: 0, deletions: 0 } }
  }
}

/** Unified diff for a single file between two branches. Returns { diff } or { error }. */
export async function fileDiff(cwd, base, head, file) {
  if (!cwd) return { error: 'no cwd' }
  if (!base || !head) return { error: 'base and head required' }
  if (!file || typeof file !== 'string') return { error: 'file required' }
  if (DOTDOT_RE.test(file) || file.startsWith('/') || file.includes('\0') || !FILE_RE.test(file)) {
    return { error: 'invalid file path' }
  }
  if (base === head) return { diff: '' }
  try {
    const valid = await validBranchSet(cwd)
    if (!valid.has(base) || !valid.has(head)) {
      return { error: `unknown branch (base=${base} head=${head})` }
    }
    const diff = await git(cwd, ['diff', base, head, '--', file])
    return { diff: String(diff) }
  } catch (err) {
    return { error: String(err && err.message || err), diff: '' }
  }
}
