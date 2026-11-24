/**
 * Sessions browser plugin data source — MES-14031 (抄 codex resume/fork).
 *
 * Read-only discovery of past Codex + Claude Code sessions on this machine,
 * so nanocode can present a "session picker" and let the user fork/resume a
 * previous agent session into a new tab — porting Codex CLI's `codex resume`
 * (picker) and `codex fork` to the nanocode plugin surface.
 *
 * Two sources, same shape:
 *   - Codex sessions  : ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *                       line 1 = session_meta { id, timestamp, cwd, cli_version,
 *                       model_provider, originator, source, model }
 *   - Claude sessions : ~/.claude/projects/<slug>/<uuid>.jsonl
 *                       first `type:"user"` record carries message.content[].text
 *
 * listSessions() returns newest-first { sessions: [{ id, source, cwd, timestamp,
 *   cliVersion, model, firstMessage, lines }] }. firstMessage is the first
 * *real* user prompt (system/environment wrappers skipped, ≤200 chars).
 *
 * previewSession() returns a longer first-message + a tail excerpt of the last
 * few user/assistant text turns so the user can recognise the session before
 * forking. All read-only; never mutates session files. Never throws to the
 * caller — errors become { error }. All disk access is async and bounded (see
 * bounded-scan.js): a slow home mount must never stall the HTTP server.
 * Roots come from usage.js sessionSourceRoots (personal claude.autoDiscoverTeams).
 */

import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createScanCache, mapLimit, readHead, readTailLines, readdirSafe, DEFAULT_SCAN_CONCURRENCY } from './bounded-scan.js'
import { sessionSourceRoots } from './usage.js'
import { claudeProjectSlugToCwd, isSystemWrapper } from './session-naming.js'

const PREVIEW_MAXLEN = 200
const TAIL_TURNS = 6
const TAIL_TURN_MAXLEN = 300
const HEAD_BYTES = 65536        // read the first 64KB for listing (session_meta can be 15KB+ alone)
const PREVIEW_TAIL_BYTES = 1024 * 1024 // preview parses only the last 1 MB of a transcript
const CACHE_TTL_MS = 60_000     // per-root list cache; older results are served while refreshing
const LIST_DEADLINE_MS = 4_000  // a request waits at most this long, then gets partial results
const SCAN_TIMEOUT_MS = 120_000 // one root scan is abandoned (marked partial) after this

// One cache entry per session root ("pool"): key = `${kind}\0${dir}`.
const rootCache = createScanCache({
  ttlMs: CACHE_TTL_MS,
  scanTimeoutMs: SCAN_TIMEOUT_MS,
  scan: (key, progress) => {
    const [kind, dir] = key.split('\0')
    return kind === 'codex' ? scanCodexRoot(dir, progress) : scanClaudeRoot(dir, progress)
  },
})

async function rootKeys(home, source) {
  const { claudeProjectRoots, codexSessionsDir } = await sessionSourceRoots(home)
  const keys = []
  if (source !== 'claude' && codexSessionsDir) keys.push(`codex\0${codexSessionsDir}`)
  if (source !== 'codex') for (const dir of claudeProjectRoots) keys.push(`claude\0${dir}`)
  return keys
}

// ── Codex ────────────────────────────────────────────────────────────────────

async function scanCodexRoot(root, progress) {
  const files = []
  const subdirs = async (dir) => (await readdirSafe(dir, { withFileTypes: true })).filter((d) => d.isDirectory())
  for (const yd of await subdirs(root)) {
    for (const md of await subdirs(join(root, yd.name))) {
      for (const dd of await subdirs(join(root, yd.name, md.name))) {
        if (progress.stopped) return
        const ddir = join(root, yd.name, md.name, dd.name)
        for (const f of await readdirSafe(ddir)) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) files.push(join(ddir, f))
        }
      }
    }
  }
  await mapLimit(files, DEFAULT_SCAN_CONCURRENCY, async (file) => {
    const s = extractCodexSession(await readHead(file, HEAD_BYTES), file)
    if (s) progress.items.push(s)
  }, () => progress.stopped)
}

function extractCodexSession(raw, filePath) {
  const lines = raw.split('\n').filter(Boolean)
  if (!lines.length) return null
  let meta = null
  try { meta = JSON.parse(lines[0]) } catch { return null }
  const p = meta && meta.payload ? meta.payload : meta
  if (!p || !p.id) return null
  let firstMessage = ''
  let model = p.model || ''
  let turns = 0
  for (const line of lines.slice(0, 100)) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    const payload = d.payload || d
    if (d.type === 'response_item' && payload && payload.role === 'user') {
      const text = extractCodexUserText(payload)
      if (!text) continue
      if (isSystemWrapper(text)) continue
      if (!firstMessage) firstMessage = text.slice(0, PREVIEW_MAXLEN)
      turns++
      break
    }
    if (d.type === 'event_msg' && payload && payload.type === 'task_started') {
      if (payload.model && !model) model = payload.model
    }
  }
  return {
    id: p.id,
    source: 'codex',
    cwd: p.cwd || '',
    timestamp: p.timestamp || '',
    cliVersion: p.cli_version || '',
    model,
    firstMessage,
    turns,
    lines: lines.length,
    file: filePath,
  }
}

function extractCodexUserText(payload) {
  const content = payload && payload.content
  if (!Array.isArray(content)) return ''
  for (const c of content) {
    if (c && c.type === 'input_text' && typeof c.text === 'string') return c.text
  }
  return ''
}

// ── Claude ───────────────────────────────────────────────────────────────────

async function scanClaudeRoot(root, progress) {
  const projects = (await readdirSafe(root, { withFileTypes: true })).filter((d) => d.isDirectory())
  const files = []
  await mapLimit(projects, DEFAULT_SCAN_CONCURRENCY, async (pd) => {
    for (const f of await readdirSafe(join(root, pd.name))) {
      if (f.endsWith('.jsonl')) files.push({ file: join(root, pd.name, f), projectSlug: pd.name })
    }
  }, () => progress.stopped)
  await mapLimit(files, DEFAULT_SCAN_CONCURRENCY, async (entry) => {
    const s = extractClaudeSession(await readHead(entry.file, HEAD_BYTES), entry)
    if (s) progress.items.push(s)
  }, () => progress.stopped)
}

function extractClaudeSession(raw, { file, projectSlug }) {
  const lines = raw.split('\n').filter(Boolean)
  if (!lines.length) return null
  let sessionId = ''
  let firstMessage = ''
  let timestamp = ''
  let turns = 0
  for (const line of lines.slice(0, 100)) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (!timestamp && d.timestamp) timestamp = d.timestamp
    if (!sessionId && d.sessionId) sessionId = d.sessionId
    if (d.type === 'user' && d.message) {
      const text = extractClaudeUserText(d.message)
      if (!text) continue
      if (isSystemWrapper(text)) continue
      if (!firstMessage) firstMessage = text.slice(0, PREVIEW_MAXLEN)
      turns++
      break
    }
  }
  if (!sessionId) {
    const m = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
    if (m) sessionId = m[1]
  }
  return {
    id: sessionId,
    source: 'claude',
    cwd: claudeProjectSlugToCwd(projectSlug),
    timestamp,
    cliVersion: '',
    model: '',
    firstMessage,
    turns,
    lines: lines.length,
    file,
    projectSlug,
  }
}

function extractClaudeUserText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && c.type === 'text' && typeof c.text === 'string') return c.text
    }
  }
  return ''
}

// ── Public API ───────────────────────────────────────────────────────────────

export function resetSessionsCache() { rootCache.clear() }

/**
 * Newest-first session list across the configured session roots. Never blocks
 * the event loop: roots are scanned with fs/promises (bounded concurrency),
 * cached per root, and a request waits at most `deadlineMs`. Result:
 *   { sessions, total, partial, partialReason?, stale }
 * partial=true means some root was still scanning (or hit its scan timeout);
 * stale=true means a cached result older than the TTL was served while it
 * refreshes in the background.
 */
export async function listSessions({ source, limit, home = homedir(), deadlineMs = LIST_DEADLINE_MS } = {}) {
  const results = await Promise.all((await rootKeys(home, source)).map((k) => rootCache.get(k, { deadlineMs })))
  const all = results.flatMap((r) => r.items)
  all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
  const out = sliceSessions(all, source, limit)
  const reasons = [...new Set(results.filter((r) => r.partial).map((r) => r.partialReason))]
  out.partial = reasons.length > 0
  if (out.partial) out.partialReason = reasons.join('; ')
  out.stale = results.some((r) => r.stale)
  return out
}

function sliceSessions(all, source, limit) {
  const filtered = source ? all.filter((s) => s.source === source) : all
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)))
  return { sessions: filtered.slice(0, n), total: filtered.length }
}

function isUnder(file, dir) {
  const f = resolve(file)
  const d = resolve(dir)
  return f.startsWith(d.endsWith(sep) ? d : d + sep)
}

/**
 * Locate a session file: an explicit `file` must live under one of the
 * configured roots for that source (the route is reachable from the browser,
 * so it must not read arbitrary paths); otherwise `id` is looked up in the
 * (cached, deadline-bounded) listing.
 */
async function resolvePreviewFile(source, id, file, home, deadlineMs) {
  const { claudeProjectRoots, codexSessionsDir } = await sessionSourceRoots(home)
  const roots = source === 'codex' ? [codexSessionsDir].filter(Boolean) : claudeProjectRoots
  if (file) {
    if (!file.endsWith('.jsonl') || !roots.some((r) => isUnder(file, r))) {
      return { error: 'session file is outside the configured session roots' }
    }
    return { file }
  }
  if (!id) return { error: 'session file not found' }
  const list = await listSessions({ source, limit: 200, home, deadlineMs })
  const hit = (await Promise.all((await rootKeys(home, source)).map((k) => rootCache.get(k, { deadlineMs: 0 }))))
    .flatMap((r) => r.items).find((s) => s.id === id)
  if (hit) return { file: hit.file }
  return { error: list.partial ? `session file not found (listing partial: ${list.partialReason})` : 'session file not found' }
}

export async function previewSession({ source, id, file, home = homedir(), deadlineMs = LIST_DEADLINE_MS } = {}) {
  if (source !== 'codex' && source !== 'claude') return { error: 'unknown source' }
  const found = await resolvePreviewFile(source, id, file, home, deadlineMs)
  if (found.error) return { error: found.error }
  return source === 'codex' ? previewCodex(found.file, id) : previewClaude(found.file, id)
}

// Preview reads the head (codex meta) plus only the last PREVIEW_TAIL_BYTES —
// transcripts reach 40 MB+, and the excerpt shows just the last TAIL_TURNS.
// totalTurns is exact only when the whole file fit in the window; otherwise
// it is null and truncated=true.
async function previewCodex(filePath, id) {
  const head = await readHead(filePath, HEAD_BYTES)
  if (!head) return { error: 'cannot read session file' }
  let meta = null
  try { meta = JSON.parse(head.split('\n')[0]) } catch {}
  const p = meta && meta.payload ? meta.payload : meta
  const { lines, truncated } = await readTailLines(filePath, PREVIEW_TAIL_BYTES)
  const turns = []
  for (const line of lines) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    const payload = d.payload || d
    if (d.type === 'response_item' && payload) {
      if (payload.role === 'user') {
        const text = extractCodexUserText(payload)
        if (text && !isSystemWrapper(text)) turns.push({ role: 'user', text: text.slice(0, TAIL_TURN_MAXLEN) })
      } else if (payload.role === 'assistant') {
        const text = extractCodexAssistantText(payload)
        if (text) turns.push({ role: 'assistant', text: text.slice(0, TAIL_TURN_MAXLEN) })
      }
    }
  }
  return {
    id: p && p.id ? p.id : id,
    source: 'codex',
    cwd: p && p.cwd ? p.cwd : '',
    timestamp: p && p.timestamp ? p.timestamp : '',
    cliVersion: p && p.cli_version ? p.cli_version : '',
    model: p && p.model ? p.model : '',
    turns: turns.slice(-TAIL_TURNS),
    totalTurns: truncated ? null : turns.length,
    truncated,
  }
}

function extractCodexAssistantText(payload) {
  const content = payload && payload.content
  if (!Array.isArray(content)) return ''
  for (const c of content) {
    if (c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') return c.text
  }
  return ''
}

async function previewClaude(filePath, id) {
  const { lines, truncated, ok } = await readTailLines(filePath, PREVIEW_TAIL_BYTES)
  if (!ok) return { error: 'cannot read session file' }
  const turns = []
  for (const line of lines) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.type === 'user' && d.message) {
      const text = extractClaudeUserText(d.message)
      if (text && !isSystemWrapper(text)) turns.push({ role: 'user', text: text.slice(0, TAIL_TURN_MAXLEN) })
    } else if (d.type === 'assistant' && d.message) {
      const text = extractClaudeAssistantText(d.message)
      if (text) turns.push({ role: 'assistant', text: text.slice(0, TAIL_TURN_MAXLEN) })
    }
  }
  return {
    id,
    source: 'claude',
    turns: turns.slice(-TAIL_TURNS),
    totalTurns: truncated ? null : turns.length,
    truncated,
  }
}

function extractClaudeAssistantText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && c.type === 'text' && typeof c.text === 'string') return c.text
    }
  }
  return ''
}
