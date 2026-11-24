/**
 * Claude memory viewer backend (the memory plugin). Lived inside usage.js
 * until slim/core — usage was the wrong address for it (荣耻篇 一、内聚).
 */
// Sync fs: only listMemoryProjects/listMemoryTree (no production caller since
// nanolock_0730 — the route uses the *Async twins; kept for the parity tests).
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mapLimit, readdirSafe, statSafe, pathExists, readTextSafe, timedFs, DEFAULT_SCAN_CONCURRENCY } from './bounded-scan.js'
import { claudeProjectSlugToCwd } from './session-naming.js'
import { listTeams, listTeamsAsync } from './usage.js'

// ── Claude memory viewer ──────────────────────────────────────────────────────
//
// Memory data source: each team config dir's `projects/<slug>/memory/*.md`
// (MEMORY.md + fragment md files). The plugin lets the user browse by
// team × project, render md (read-only first), search keywords, and — as a
// dangerous, opt-in op — edit a file with a timestamped backup of the original.
//
// Path-traversal guards: `team` must be a known config dir (validated by the
// route against listTeams); `projectSlug` and `fileName` are validated by
// strict character classes so no `..` / `/` can escape the memory dir.

const SLUG_RE = /^[A-Za-z0-9._-]+$/
const MEM_FILE_RE = /^[A-Za-z0-9._-]+\.md$/i

function isValidSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 && SLUG_RE.test(slug) && !slug.includes('..')
}
function isValidMemFile(name) {
  return typeof name === 'string' && name.length > 0 && MEM_FILE_RE.test(name) && !name.includes('..')
}

/**
 * List projects (slugs) under a team config dir that have a `memory/` subdir,
 * with file count + most-recent mtime. Sorted newest-first.
 */
export function listMemoryProjects(configDir) {
  const projectsRoot = join(configDir, 'projects')
  let entries = []
  try { entries = readdirSync(projectsRoot, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of entries) {
    if (!d.isDirectory()) continue
    const memDir = join(projectsRoot, d.name, 'memory')
    if (!existsSync(memDir)) continue
    let fileCount = 0
    let lastMtime = 0
    try {
      const files = readdirSync(memDir, { withFileTypes: true })
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.md')) continue
        fileCount++
        try { const st = statSync(join(memDir, f.name)); if (st.mtimeMs > lastMtime) lastMtime = st.mtimeMs } catch {}
      }
    } catch {}
    out.push({ slug: d.name, cwd: claudeProjectSlugToCwd(d.name), fileCount, lastMtime })
  }
  out.sort((a, b) => b.lastMtime - a.lastMtime)
  return out
}

/**
 * Build the full browse tree: every known team → its projects that have memory.
 * Teams come from listTeams (~/.claude + ~/.claude-team*). Non-existent team
 * dirs are skipped.
 */
export function listMemoryTree(home, store) {
  const { teams } = listTeams(home, store)
  const out = []
  for (const team of teams) {
    if (!team.exists) continue
    out.push({
      id: team.id,
      name: team.name,
      path: team.path,
      projects: listMemoryProjects(team.path),
    })
  }
  return out
}

/** Async twin of listMemoryProjects — bounded-scan readdir/stat, one team's projects root. */
async function listMemoryProjectsAsync(configDir) {
  const projectsRoot = join(configDir, 'projects')
  const entries = await readdirSafe(projectsRoot, { withFileTypes: true })
  const dirs = entries.filter((d) => d.isDirectory())
  const out = []
  await mapLimit(dirs, DEFAULT_SCAN_CONCURRENCY, async (d) => {
    const memDir = join(projectsRoot, d.name, 'memory')
    if (!(await statSafe(memDir))) return
    const files = await readdirSafe(memDir, { withFileTypes: true })
    let fileCount = 0
    let lastMtime = 0
    await mapLimit(files, DEFAULT_SCAN_CONCURRENCY, async (f) => {
      if (!f.isFile() || !f.name.endsWith('.md')) return
      fileCount++
      const st = await statSafe(join(memDir, f.name))
      if (st && st.mtimeMs > lastMtime) lastMtime = st.mtimeMs
    })
    out.push({ slug: d.name, cwd: claudeProjectSlugToCwd(d.name), fileCount, lastMtime })
  })
  out.sort((a, b) => b.lastMtime - a.lastMtime)
  return out
}

/** Async twin of listMemoryTree for the `/api/memory/tree` route (request-time, slow-mount safe). */
export async function listMemoryTreeAsync(home, store) {
  const { teams } = await listTeamsAsync(home, store)
  const existing = teams.filter((t) => t.exists)
  return Promise.all(existing.map(async (team) => ({
    id: team.id,
    name: team.name,
    path: team.path,
    projects: await listMemoryProjectsAsync(team.path),
  })))
}

/** List .md files in a team/project memory dir (name, size, mtime), newest-first. */
export async function listMemoryFiles(configDir, projectSlug) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  const memDir = join(configDir, 'projects', projectSlug, 'memory')
  const entries = await readdirSafe(memDir, { withFileTypes: true })
  const files = []
  await mapLimit(entries, DEFAULT_SCAN_CONCURRENCY, async (f) => {
    if (!f.isFile() || !f.name.endsWith('.md')) return
    const st = await statSafe(join(memDir, f.name))
    if (st) files.push({ name: f.name, size: st.size, mtime: st.mtimeMs })
  })
  files.sort((a, b) => b.mtime - a.mtime)
  return { files, path: memDir }
}

/** Read a single memory md file. Returns { name, content, size, mtime, path }. */
export async function readMemoryFile(configDir, projectSlug, fileName) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  if (!isValidMemFile(fileName)) return { error: 'invalid file name' }
  const filePath = join(configDir, 'projects', projectSlug, 'memory', fileName)
  if (!(await pathExists(filePath))) return { error: 'file not found' }
  try {
    const content = await timedFs.readFile(filePath, 'utf8')
    const st = await timedFs.stat(filePath)
    return { name: fileName, content, size: st.size, mtime: st.mtimeMs, path: filePath }
  } catch (err) {
    return { error: err.message }
  }
}

/**
 * Search a keyword across .md files in a memory dir (case-insensitive).
 * Returns { query, matches: [{ file, line, snippet }] }, capped at 200 hits.
 */
export async function searchMemory(configDir, projectSlug, query) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  const q = String(query || '').trim()
  if (!q) return { query: '', matches: [] }
  const memDir = join(configDir, 'projects', projectSlug, 'memory')
  const entries = await readdirSafe(memDir, { withFileTypes: true })
  const lower = q.toLowerCase()
  const matches = []
  for (const f of entries) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue
    const content = await readTextSafe(join(memDir, f.name))
    if (content === null) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toLowerCase().indexOf(lower)
      if (idx >= 0) {
        const start = Math.max(0, idx - 30)
        const end = Math.min(lines[i].length, idx + q.length + 30)
        matches.push({ file: f.name, line: i + 1, snippet: lines[i].slice(start, end) })
        if (matches.length >= 200) return { query: q, matches }
      }
    }
  }
  return { query: q, matches }
}

/**
 * Save (edit) a memory md file. DANGEROUS — the route only calls this after
 * the UI has confirmed. The original file is copied to a timestamped `.<name>.bak.<ts>`
 * backup in the same memory dir before writing. If the file is new (not present),
 * no backup is made. Returns { name, size, mtime, backupPath, path } or { error }.
 */
export async function saveMemoryFile(configDir, projectSlug, fileName, content) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  if (!isValidMemFile(fileName)) return { error: 'invalid file name' }
  const memDir = join(configDir, 'projects', projectSlug, 'memory')
  const filePath = join(memDir, fileName)
  if (!(await pathExists(memDir))) return { error: 'memory dir not found' }
  let backupPath = null
  if (await pathExists(filePath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = join(memDir, `.${fileName}.bak.${ts}`)
    try { await timedFs.copyFile(filePath, backupPath) } catch { backupPath = null }
  }
  try {
    await timedFs.writeFile(filePath, String(content ?? ''), 'utf8')
    const st = await timedFs.stat(filePath)
    return { name: fileName, size: st.size, mtime: st.mtimeMs, backupPath, path: filePath }
  } catch (err) {
    return { error: err.message }
  }
}
