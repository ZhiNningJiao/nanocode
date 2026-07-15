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
 * caller — errors become { error }.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openSync, readSync, closeSync } from 'node:fs'

const HOME = homedir()
const CODEX_SESSIONS_DIR = join(HOME, '.codex', 'sessions')
const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects')

const PREVIEW_MAXLEN = 200
const TAIL_TURNS = 6
const TAIL_TURN_MAXLEN = 300
const MAX_SCAN_LINES = 4000
const HEAD_BYTES = 65536        // read the first 64KB for listing (session_meta can be 15KB+ alone)
const CACHE_TTL_MS = 30_000     // list cache: 30s — sessions rarely change mid-session

let _listCache = null           // { ts, data }

function readHead(filePath, maxBytes = HEAD_BYTES) {
  let fd
  try { fd = openSync(filePath, 'r') } catch { return '' }
  try {
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch { return '' }
  finally { try { closeSync(fd) } catch {} }
}

// ── Codex ────────────────────────────────────────────────────────────────────

function listCodexFiles() {
  const out = []
  let years = []
  try { years = readdirSync(CODEX_SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return out }
  for (const yd of years) {
    const ydir = join(CODEX_SESSIONS_DIR, yd.name)
    let months = []
    try { months = readdirSync(ydir, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const md of months) {
      const mdir = join(ydir, md.name)
      let days = []
      try { days = readdirSync(mdir, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
      for (const dd of days) {
        const ddir = join(mdir, dd.name)
        let files = []
        try { files = readdirSync(ddir) } catch { continue }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue
          out.push(join(ddir, f))
        }
      }
    }
  }
  return out
}

function extractCodexSession(filePath) {
  const raw = readHead(filePath)
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

function isSystemWrapper(text) {
  return text.startsWith('<environment_context>') ||
    text.startsWith('<permissions') ||
    text.startsWith('<system_')
}

// ── Claude ───────────────────────────────────────────────────────────────────

function listClaudeFiles() {
  const out = []
  let projects = []
  try { projects = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return out }
  for (const pd of projects) {
    const pdir = join(CLAUDE_PROJECTS_DIR, pd.name)
    let files = []
    try { files = readdirSync(pdir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      out.push({ file: join(pdir, f), projectSlug: pd.name })
    }
  }
  return out
}

function extractClaudeSession({ file, projectSlug }) {
  const raw = readHead(file)
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
    cwd: claudeSlugToCwd(projectSlug),
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

function claudeSlugToCwd(slug) {
  if (!slug) return ''
  return slug.replace(/^-/, '').replace(/-/g, '/')
}

// ── Public API ───────────────────────────────────────────────────────────────

export function resetSessionsCache() { _listCache = null }

export function listSessions({ source, limit } = {}) {
  if (_listCache && Date.now() - _listCache.ts < CACHE_TTL_MS) {
    return sliceSessions(_listCache.data, source, limit)
  }
  const all = []
  for (const f of listCodexFiles()) {
    const s = extractCodexSession(f)
    if (s) all.push(s)
  }
  for (const entry of listClaudeFiles()) {
    const s = extractClaudeSession(entry)
    if (s) all.push(s)
  }
  all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
  _listCache = { ts: Date.now(), data: all }
  return sliceSessions(all, source, limit)
}

function sliceSessions(all, source, limit) {
  const filtered = source ? all.filter((s) => s.source === source) : all
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)))
  return { sessions: filtered.slice(0, n), total: filtered.length }
}

export function previewSession({ source, id, file } = {}) {
  if (source === 'codex') return previewCodex(file, id)
  if (source === 'claude') return previewClaude(file, id)
  return { error: 'unknown source' }
}

function previewCodex(file, id) {
  const filePath = file || findCodexFile(id)
  if (!filePath) return { error: 'session file not found' }
  let raw
  try { raw = readFileSync(filePath, 'utf8') } catch { return { error: 'cannot read session file' } }
  const lines = raw.split('\n').filter(Boolean)
  let meta = null
  try { meta = JSON.parse(lines[0]) } catch {}
  const p = meta && meta.payload ? meta.payload : meta
  const turns = []
  for (const line of lines.slice(0, MAX_SCAN_LINES)) {
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
    totalTurns: turns.length,
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

function findCodexFile(id) {
  if (!id) return null
  for (const f of listCodexFiles()) {
    if (f.includes(id)) return f
  }
  return null
}

function previewClaude(file, id) {
  let filePath = file
  if (!filePath && id) {
    let projects = []
    try { projects = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch {}
    for (const pd of projects) {
      const candidate = join(CLAUDE_PROJECTS_DIR, pd.name, `${id}.jsonl`)
      try { statSync(candidate); filePath = candidate; break } catch {}
    }
  }
  if (!filePath) return { error: 'session file not found' }
  let raw
  try { raw = readFileSync(filePath, 'utf8') } catch { return { error: 'cannot read session file' } }
  const lines = raw.split('\n').filter(Boolean)
  const turns = []
  for (const line of lines.slice(0, MAX_SCAN_LINES)) {
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
    totalTurns: turns.length,
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
