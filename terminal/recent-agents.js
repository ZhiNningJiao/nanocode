import { closeSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createScanCache, mapLimit, readHead, readdirSafe, statSafe, DEFAULT_SCAN_CONCURRENCY } from './bounded-scan.js'
import { sessionSourceRoots } from './usage.js'

const RECENT_AGENTS_CACHE_MS = 10_000
const RECENT_AGENTS_DEADLINE_MS = 4_000
const RECENT_AGENTS_SCAN_TIMEOUT_MS = 120_000
const CWD_HEAD_BYTES = 8192
const SUMMARY_HEAD_BYTES = 16384
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

function readHeadSync(jsonlPath, maxBytes) {
  const fd = openSync(jsonlPath, 'r')
  const buf = Buffer.allocUnsafe(maxBytes)
  let bytesRead = 0
  try { bytesRead = readSync(fd, buf, 0, maxBytes, 0) } finally { closeSync(fd) }
  return buf.slice(0, bytesRead).toString('utf-8')
}

/** First `cwd` field among the complete lines of a jsonl head chunk. */
export function cwdFromHead(chunk) {
  const lines = chunk.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (typeof row.cwd === 'string' && row.cwd) return row.cwd
  }
  return null
}

export function cwdFromJsonl(jsonlPath) {
  try { return cwdFromHead(readHeadSync(jsonlPath, CWD_HEAD_BYTES)) } catch { return null }
}

export function cwdFromDirName(dirName) {
  return dirName.replace(/^-/, '/').replace(/-/g, '/')
}

/** First meaningful user prompt (≤80 chars) in a jsonl head chunk. */
export function summaryFromHead(chunk) {
  let fallback = null   // a bare warmup "OK" — used only if nothing better follows
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
  return fallback ? fallback.slice(0, 80) : null
}

export function extractSummary(jsonlPath) {
  try { return summaryFromHead(readHeadSync(jsonlPath, SUMMARY_HEAD_BYTES)) } catch { return null }
}

/**
 * Scan the configured Claude projects roots (usage.js sessionSourceRoots) for
 * the most recent conversations. Async + bounded concurrency: the roots may be
 * on a slow home mount and this runs on every history load (prime). Polls
 * `progress.stopped` so a scan timeout stops issuing new syscalls.
 */
export async function scanRecentAgents(home, now = Date.now(), progress = { stopped: false }) {
  const stop = () => progress.stopped
  const dirs = []
  for (const root of sessionSourceRoots(home).claudeProjectRoots) {
    for (const d of await readdirSafe(root, { withFileTypes: true })) {
      if (d.isDirectory()) dirs.push({ root, name: d.name })
    }
  }
  const files = []
  await mapLimit(dirs, DEFAULT_SCAN_CONCURRENCY, async (d) => {
    const projectDir = join(d.root, d.name)
    for (const f of await readdirSafe(projectDir)) {
      if (f.endsWith('.jsonl')) files.push({ dirName: d.name, fullPath: join(projectDir, f), sessionId: f.replace(/\.jsonl$/, '') })
    }
  }, stop)
  const allEntries = []
  await mapLimit(files, DEFAULT_SCAN_CONCURRENCY, async (f) => {
    const st = await statSafe(f.fullPath)
    if (st) allEntries.push({ ...f, mtimeMs: st.mtimeMs })
  }, stop)

  allEntries.sort((a, b) => b.mtimeMs - a.mtimeMs)

  let cutoff = allEntries.filter((e) => now - e.mtimeMs <= RECENT_WINDOW_MS)
  if (cutoff.length < 5) cutoff = allEntries.slice(0, 5)
  cutoff = cutoff.slice(0, 50)

  const heads = new Map()
  await mapLimit(cutoff, DEFAULT_SCAN_CONCURRENCY, async (e) => {
    heads.set(e.fullPath, await readHead(e.fullPath, SUMMARY_HEAD_BYTES))
  }, stop)
  const mapped = cutoff.map((e) => {
    const head = heads.get(e.fullPath) || ''
    const cwd = cwdFromHead(head.slice(0, CWD_HEAD_BYTES)) || cwdFromDirName(e.dirName)
    const cwdParts = cwd.split('/').filter(Boolean)
    const projectName = cwdParts[cwdParts.length - 1] || e.dirName
    return {
      projectDir: e.dirName,
      projectName,
      cwd,
      sessionId: e.sessionId,
      mtime: new Date(e.mtimeMs).toISOString(),
      relTime: relTimeFromMtime(e.mtimeMs, now),
      summary: summaryFromHead(head),
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
  // Stale-while-revalidate + single-flight (bounded-scan.js): concurrent history
  // loads share one scan, and no caller ever blocks on the disk walk.
  const cache = createScanCache({
    ttlMs: RECENT_AGENTS_CACHE_MS,
    scanTimeoutMs: RECENT_AGENTS_SCAN_TIMEOUT_MS,
    scan: async (_key, progress) => {
      const result = await scanRecentAgents(home, Date.now(), progress)
      if (progress.stopped) progress.partialReason = 'scan stopped'
      progress.items.push(...result)
    },
  })
  let lastComplete = null

  /**
   * Resolves to { entries, partial, partialReason } within `deadlineMs`.
   * While the first scan is still running, entries is the last complete
   * result (or []) and partial=true.
   */
  async function getRecentAgents({ deadlineMs = RECENT_AGENTS_DEADLINE_MS } = {}) {
    const r = await cache.get('recent', { deadlineMs })
    if (!r.partial) lastComplete = r.items
    const base = r.partial && lastComplete ? lastComplete : r.items
    const now = Date.now()
    return {
      entries: base.map((e) => ({
        ...e,
        relTime: relTimeFromMtime(e._mtimeMs, now),
        active: now - e._mtimeMs <= RECENT_WINDOW_MS,
      })),
      partial: !!r.partial,
      partialReason: r.partialReason || null,
    }
  }

  /** Fire-and-forget refresh (history loads call this). Never blocks. */
  function primeRecentAgentsCache() {
    getRecentAgents({ deadlineMs: 0 }).catch(() => {})
  }

  function getCachedEntries() {
    return lastComplete || []
  }

  return {
    getCachedEntries,
    getRecentAgents,
    primeRecentAgentsCache,
  }
}
