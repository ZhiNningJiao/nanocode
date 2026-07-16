import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const RECENT_AGENTS_CACHE_MS = 10_000
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Relative time string from mtime ms and a reference 'now'. */
export function relTimeFromMtime(mtimeMs, nowMs) {
  const diff = nowMs - mtimeMs
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function cwdFromJsonl(jsonlPath) {
  try {
    const MAX_BYTES = 8192
    const fd = openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    let bytesRead = 0
    try { bytesRead = readSync(fd, buf, 0, MAX_BYTES, 0) } finally { closeSync(fd) }
    const chunk = buf.slice(0, bytesRead).toString('utf-8')
    const lines = chunk.split('\n')
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim()
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (typeof row.cwd === 'string' && row.cwd) return row.cwd
    }
  } catch {}
  return null
}

export function cwdFromDirName(dirName) {
  return dirName.replace(/^-/, '/').replace(/-/g, '/')
}

export function extractSummary(jsonlPath) {
  let fallback = null   // a bare warmup "OK" — used only if nothing better follows
  try {
    const MAX_BYTES = 16384
    const fd = openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    let bytesRead = 0
    try { bytesRead = readSync(fd, buf, 0, MAX_BYTES, 0) } finally { closeSync(fd) }
    const chunk = buf.slice(0, bytesRead).toString('utf-8')
    const lines = chunk.split('\n')
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim()
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.type === 'user' && row.message?.content) {
        const parts = row.message.content
        let text = null
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) { text = p.text.trim(); break }
          }
        } else if (typeof parts === 'string' && parts.trim()) {
          text = parts.trim()
        }
        if (text) {
          // Skip a bare warmup/probe "OK" so the picker title shows the first
          // MEANINGFUL user prompt. Fall back to "OK" only if that's all there is.
          if (/^ok$/i.test(text)) { if (fallback === null) fallback = text; continue }
          return text.slice(0, 80)
        }
      }
    }
  } catch {}
  return fallback ? fallback.slice(0, 80) : null
}

export function scanRecentAgents(home, now = Date.now()) {
  const claudeProjectsRoot = join(home, '.claude', 'projects')
  if (!existsSync(claudeProjectsRoot)) return []

  const allEntries = []
  let dirs
  try { dirs = readdirSync(claudeProjectsRoot, { withFileTypes: true }) } catch { return [] }

  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const projectDir = join(claudeProjectsRoot, d.name)
    let files
    try { files = readdirSync(projectDir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const fullPath = join(projectDir, f)
      try {
        const st = statSync(fullPath)
        allEntries.push({
          dirName: d.name,
          fullPath,
          sessionId: f.replace(/\.jsonl$/, ''),
          mtimeMs: st.mtimeMs,
        })
      } catch {}
    }
  }

  allEntries.sort((a, b) => b.mtimeMs - a.mtimeMs)

  let cutoff = allEntries.filter((e) => now - e.mtimeMs <= RECENT_WINDOW_MS)
  if (cutoff.length < 5) cutoff = allEntries.slice(0, 5)
  cutoff = cutoff.slice(0, 50)

  const mapped = cutoff.map((e) => {
    const cwd = cwdFromJsonl(e.fullPath) || cwdFromDirName(e.dirName)
    const cwdParts = cwd.split('/').filter(Boolean)
    const projectName = cwdParts[cwdParts.length - 1] || e.dirName
    return {
      projectDir: e.dirName,
      projectName,
      cwd,
      sessionId: e.sessionId,
      mtime: new Date(e.mtimeMs).toISOString(),
      relTime: relTimeFromMtime(e.mtimeMs, now),
      summary: extractSummary(e.fullPath),
      active: now - e.mtimeMs <= RECENT_WINDOW_MS,
      _mtimeMs: e.mtimeMs,
    }
  })

  // Deduplicate: keep only the most recent entry per (projectName + summary-prefix) combo.
  // This prevents the list from being flooded with many identical "work" sessions.
  const seen = new Set()
  const deduped = []
  for (const entry of mapped) {
    const key = entry.projectName + '::' + (entry.summary || '').slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry)
  }

  return deduped.slice(0, 20)
}

export function createRecentAgentsService({ home = homedir() } = {}) {
  let recentAgentsCache = null
  let recentAgentsCacheAt = 0

  function getRecentAgentsCached({ forceRefresh = false } = {}) {
    const now = Date.now()
    if (!forceRefresh && recentAgentsCache && now - recentAgentsCacheAt < RECENT_AGENTS_CACHE_MS) {
      return recentAgentsCache.map((e) => ({
        ...e,
        relTime: relTimeFromMtime(e._mtimeMs, now),
        active: now - e._mtimeMs <= RECENT_WINDOW_MS,
      }))
    }

    const result = scanRecentAgents(home, now)
    recentAgentsCache = result
    recentAgentsCacheAt = now
    return result
  }

  function primeRecentAgentsCache() {
    try { getRecentAgentsCached() } catch {}
  }

  function getCachedEntries() {
    return recentAgentsCache || []
  }

  return {
    getCachedEntries,
    getRecentAgentsCached,
    primeRecentAgentsCache,
  }
}
