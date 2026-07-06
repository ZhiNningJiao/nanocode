/**
 * Usage & provider data sources for the MES-13740 需求1 plugin.
 *
 * Three honest data sources:
 *   1. Claude JSONL token aggregation  — scan `$CLAUDE_CONFIG_DIR/projects/<encoded>/*.jsonl`
 *      and sum `message.usage` fields per assistant row. This is the same local-log
 *      approach CodexBar/ccusage use (see REPORT CodexBar research conclusion).
 *   2. AIGW model list                  — proxy `GET https://aigw.meshy.team/v1/models`
 *      with the user's meshy-aigw.key, filter to `litellm/*`.
 *   3. AIGW per-call cost probe         — nanocode does NOT proxy opencode's AIGW
 *      traffic (opencode talks to AIGW directly), so per-call `x-litellm-response-cost`
 *      headers are not captured for ongoing sessions. We expose a one-shot probe
 *      that makes a single AIGW chat request and reads the cost header, so the
 *      mechanism is demonstrated and the probed cost can be accumulated. The UI
 *      labels ongoing-session cost honestly as "该源无用量接口".
 *
 * Team discovery: `~/.claude` (team1 / default) and any `~/.claude-team*` dirs.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// node:sqlite is experimental (Node 22+). Guarded require so an unavailable /
// older runtime degrades to an honest "source unavailable" instead of crashing
// the server at boot. The opencode session-table usage reader (需求15 item6) is
// the only consumer; if it is null the route returns an honest error shape.
const _require = createRequire(import.meta.url)
let _DatabaseSync = null
try { ({ DatabaseSync: _DatabaseSync } = _require('node:sqlite')) } catch { /* node:sqlite unavailable */ }

const AIGW_BASE = process.env.MESHY_AIGW_BASE || 'https://aigw.meshy.team'
const AIGW_KEY_FILE = join(homedir(), '.config', 'meshy-aigw.key')

/** Read the AIGW key from the well-known file (chmod 600). Returns '' if absent. */
export function readAigwKey() {
  try {
    return readFileSync(AIGW_KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Resolve the effective Claude config dir from a store setting.
 * `claude_config_dir` is set by the Team switcher (需求1). Defaults to ~/.claude.
 */
export function effectiveClaudeConfigDir(store, home) {
  const configured = store?.getSetting?.('claude_config_dir')
  if (configured && typeof configured === 'string' && configured.trim()) {
    return configured.trim()
  }
  return join(home || homedir(), '.claude')
}

/**
 * Resolve the CLAUDE_CONFIG_DIR that a given claude TAB should use.
 *
 * 需求5 cross-team resume: a tab that resumes a session from another team
 * stores `claudeConfigDir` on the tab and must read its jsonl from that
 * team's dir — not the global store setting. Falls back to the global
 * Team-switch setting (需求1) and then ~/.claude.
 */
export function resolveClaudeConfigDirForTab(tab, store, home) {
  const dir = tab?.claudeConfigDir
  if (dir && typeof dir === 'string' && dir.trim()) return dir.trim()
  return effectiveClaudeConfigDir(store, home)
}

/**
 * Resolve the cwd a given claude TAB should spawn into.
 *
 * 需求5: a cross-cwd resume (e.g. resuming a home/secretary session from a
 * project tab) stores `claudeSessionCwd` so claude --resume finds the jsonl
 * in the matching project-slug dir and keeps the conversation's file context.
 * Falls back to the project's cwd.
 */
export function resolveClaudeCwdForTab(tab, project) {
  const c = tab?.claudeSessionCwd
  if (c && typeof c === 'string' && c.trim()) return c.trim()
  return project?.cwd
}

/**
 * Encode a cwd the way Claude does for its per-project jsonl directory:
 * every '/' becomes '-'. (`cwdToClaudeProjectDir` equivalent that takes an
 * explicit config dir instead of home, so Team switch (CLAUDE_CONFIG_DIR)
 * is honoured.)
 */
export function claudeProjectsDir(configDir, cwd) {
  const encoded = String(cwd).replace(/\//g, '-')
  return join(configDir, 'projects', encoded)
}

// ── Claude JSONL token aggregation ─────────────────────────────────────────

/**
 * Stream-scan a single jsonl file and accumulate `message.usage` numbers.
 * Reads at most `capBytes` (16 MB) per file so a pathological 70 MB+ session
 * does not block the usage panel; files over the cap are marked `truncated`.
 *
 * Returns { input, output, cacheCreation, cacheRead, rows, modelCounts, truncated }.
 * `rows` counts assistant rows that had a usage block (≈ API calls).
 */
const USAGE_CAP_BYTES = 16 * 1024 * 1024

export function aggregateJsonlUsage(jsonlPath, capBytes = USAGE_CAP_BYTES) {
  let size = 0
  try { size = statSync(jsonlPath).size } catch { return null }
  if (size === 0) return null

  const readCap = Math.min(size, capBytes)
  const chunkBuf = Buffer.allocUnsafe(128 * 1024)
  let fd
  try { fd = openSync(jsonlPath, 'r') } catch { return null }

  let pos = 0
  let tail = ''   // leftover partial line across chunks
  let truncated = size > readCap
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, rows: 0 }
  const modelCounts = new Map()  // model -> { input, output, cacheCreation, cacheRead, rows }

  // Quick reject: if the file has no usage markers at all, skip parsing entirely.
  // We still stream (don't read whole file) for large files.
  try {
    while (pos < readCap) {
      const n = readSync(fd, chunkBuf, 0, Math.min(chunkBuf.length, readCap - pos), pos)
      if (n <= 0) break
      tail += chunkBuf.subarray(0, n).toString('utf8')
      // Process complete lines; keep the last partial line in `tail`.
      const lastNl = tail.lastIndexOf('\n')
      let block
      if (lastNl >= 0) {
        block = tail.slice(0, lastNl + 1)
        tail = tail.slice(lastNl + 1)
      } else if (pos + n >= readCap) {
        // reached the cap end with no newline — process whatever we have
        block = tail
        tail = ''
      } else {
        // no newline yet in this chunk, keep buffering
        pos += n
        continue
      }
      pos += n

      const lines = block.split('\n')
      for (const line of lines) {
        if (!line || line.length < 8) continue
        // Fast path: only assistant rows carry usage, and only ones with a
        // "usage": field are interesting. This substring check avoids JSON.parse
        // for the vast majority of lines (user rows, queue-operation rows).
        if (line.indexOf('"usage"') === -1) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (row.type !== 'assistant') continue
        const u = row.message?.usage
        if (!u || typeof u !== 'object') continue
        const input = Number(u.input_tokens) || 0
        const output = Number(u.output_tokens) || 0
        const cacheCreation = Number(u.cache_creation_input_tokens) || 0
        const cacheRead = Number(u.cache_read_input_tokens) || 0
        totals.input += input
        totals.output += output
        totals.cacheCreation += cacheCreation
        totals.cacheRead += cacheRead
        totals.rows++
        const model = row.message?.model || '(unknown)'
        let m = modelCounts.get(model)
        if (!m) { m = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, rows: 0 }; modelCounts.set(model, m) }
        m.input += input; m.output += output; m.cacheCreation += cacheCreation; m.cacheRead += cacheRead; m.rows++
      }
    }
  } catch {
    // best-effort — return what we have
  } finally {
    try { closeSync(fd) } catch {}
  }

  return {
    input: totals.input,
    output: totals.output,
    cacheCreation: totals.cacheCreation,
    cacheRead: totals.cacheRead,
    rows: totals.rows,
    modelCounts: Object.fromEntries(modelCounts),
    truncated,
  }
}

/**
 * Scan every project dir under `$configDir/projects/` and aggregate usage
 * across all `*.jsonl` files. Returns:
 *   { totals, byModel, byDay, files, truncatedFiles, sampledBytes, configDir }
 *
 * `byDay` buckets by the jsonl row's `timestamp` (YYYY-MM-DD). To keep the
 * scan bounded, `maxFiles` caps how many jsonl files are scanned (default 200,
 * most-recent first by mtime) and each file is capped at USAGE_CAP_BYTES.
 */
export function scanClaudeUsage(configDir, { maxFiles = 200, days } = {}) {
  const projectsRoot = join(configDir, 'projects')
  if (!existsSync(projectsRoot)) {
    return { totals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, rows: 0 }, byModel: [], byDay: [], files: 0, truncatedFiles: 0, sampledBytes: 0, configDir }
  }

  // Collect all jsonl files across project dirs with mtime for ordering.
  const files = []
  let projectDirs = []
  try { projectDirs = readdirSync(projectsRoot, { withFileTypes: true }) } catch {}
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue
    const dirPath = join(projectsRoot, dirent.name)
    let names = []
    try { names = readdirSync(dirPath) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const fullPath = join(dirPath, name)
      try {
        const st = statSync(fullPath)
        if (st.size < 200) continue
        files.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size })
      } catch {}
    }
  }
  // Most-recent first so the cap keeps the freshest sessions.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const sinceMs = days ? Date.now() - days * 86400_000 : 0
  const scan = files.slice(0, maxFiles)

  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, rows: 0 }
  const modelMap = new Map()
  const dayMap = new Map()  // 'YYYY-MM-DD' -> { input, output, cacheCreation, cacheRead, rows }
  let truncatedFiles = 0
  let sampledBytes = 0
  let scanned = 0

  for (const f of scan) {
    if (sinceMs && f.mtimeMs < sinceMs) {
      // Even old-mtime files may contain recent rows, but as a cheap filter we
      // only skip entirely-old files when a days window is requested.
    }
    const agg = aggregateJsonlUsage(f.path)
    sampledBytes += Math.min(f.size, USAGE_CAP_BYTES)
    if (!agg) continue
    scanned++
    if (agg.truncated) truncatedFiles++
    totals.input += agg.input
    totals.output += agg.output
    totals.cacheCreation += agg.cacheCreation
    totals.cacheRead += agg.cacheRead
    totals.rows += agg.rows
    for (const [model, c] of Object.entries(agg.modelCounts)) {
      let m = modelMap.get(model)
      if (!m) { m = { model, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, rows: 0 }; modelMap.set(model, m) }
      m.input += c.input; m.output += c.output; m.cacheCreation += c.cacheCreation; m.cacheRead += c.cacheRead; m.rows += c.rows
    }
    // Per-day bucket from the file mtime (cheap; avoids re-parsing timestamps).
    const day = new Date(f.mtimeMs).toISOString().slice(0, 10)
    let d = dayMap.get(day)
    if (!d) { d = { day, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, rows: 0 }; dayMap.set(day, d) }
    d.input += agg.input; d.output += agg.output; d.cacheCreation += agg.cacheCreation; d.cacheRead += agg.cacheRead; d.rows += agg.rows
  }

  const byModel = [...modelMap.values()].sort((a, b) => (b.input + b.output + b.cacheCreation + b.cacheRead) - (a.input + a.output + a.cacheCreation + a.cacheRead))
  const byDay = [...dayMap.values()].sort((a, b) => a.day < b.day ? 1 : -1)

  return { totals, byModel, byDay, files: scanned, truncatedFiles, sampledBytes, configDir, totalJsonlFiles: files.length }
}

// ── Team discovery ──────────────────────────────────────────────────────────

/**
 * List available Claude "teams" — config dirs the user can switch between.
 * Always includes ~/.claude (team1 / default) plus any ~/.claude-team* dirs.
 * Returns [{ id, name, path, exists }].
 */
export function listTeams(home, store) {
  const homeDir = home || homedir()
  const teams = []
  const defaultDir = join(homeDir, '.claude')
  teams.push({ id: 'team1', name: 'Team 1', path: defaultDir, exists: existsSync(defaultDir) })
  // scan ~/.claude-team* (and ~/.claude_team* for robustness)
  let entries = []
  try { entries = readdirSync(homeDir, { withFileTypes: true }) } catch {}
  const seen = new Set([defaultDir])
  for (const d of entries) {
    if (!d.isDirectory()) continue
    if (!d.name.startsWith('.claude-team') && !d.name.startsWith('.claude_team')) continue
    const fullPath = join(homeDir, d.name)
    if (seen.has(fullPath)) continue
    seen.add(fullPath)
    // derive a friendly id from the dir name: .claude-team2 -> team2
    const m = d.name.match(/claude[-_](.+)$/)
    const id = m ? m[1] : d.name
    teams.push({ id, name: `Team ${id}`, path: fullPath, exists: true })
  }
  const active = effectiveClaudeConfigDir(store, homeDir)
  return { teams, activePath: active }
}

// ── AIGW model list + cost probe ─────────────────────────────────────────────

/**
 * Fetch the AIGW `/v1/models` list and filter to `litellm/*` (the gateway's
 * routed models). Returns { models: string[], raw: number, base, keyPresent }.
 * Never throws — returns { error } on failure so the route can 200 with a
 * clear reason (the UI labels the source honestly).
 */
export async function listAigwModels({ key } = {}) {
  const apiKey = (key ?? readAigwKey()).trim()
  if (!apiKey) return { models: [], raw: 0, base: AIGW_BASE, keyPresent: false, error: 'AIGW key not found (~/.config/meshy-aigw.key)' }
  const res = await fetch(`${AIGW_BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return { models: [], raw: 0, base: AIGW_BASE, keyPresent: true, error: `AIGW /v1/models HTTP ${res.status}` }
  const data = await res.json()
  const all = Array.isArray(data?.data) ? data.data : []
  const ids = all.map((m) => m.id).filter((id) => typeof id === 'string' && id.startsWith('litellm/'))
  ids.sort()
  return { models: ids, raw: all.length, base: AIGW_BASE, keyPresent: true }
}

/**
 * Make one AIGW chat-completions call and read the `x-litellm-response-cost`
 * response header (and friends). Demonstrates that the cost header is readable
 * when nanocode itself makes the call. Returns:
 *   { cost, model, promptTokens, completionTokens, headers, note }
 *
 * nanocode does NOT proxy opencode's AIGW traffic, so this is a one-shot probe,
 * not an ongoing per-session accumulator. The UI accumulates probed costs in a
 * setting and labels ongoing-session cost honestly.
 */
export async function probeAigwCost({ key, model = 'litellm/SGLang-GLM-latest', prompt = 'Reply with the single word: ok' } = {}) {
  const apiKey = (key ?? readAigwKey()).trim()
  if (!apiKey) return { error: 'AIGW key not found (~/.config/meshy-aigw.key)', keyPresent: false }
  const res = await fetch(`${AIGW_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(20000),
  })
  const costHeader = res.headers.get('x-litellm-response-cost')
  const responseCostMs = res.headers.get('x-litellm-response-cost-response-ms')
  const usageHeader = res.headers.get('x-litellm-usage')
  let body = null
  try { body = await res.json() } catch {}
  const usage = body?.usage || null
  if (!res.ok) {
    return { error: `AIGW HTTP ${res.status}`, status: res.status, keyPresent: true, model, base: AIGW_BASE }
  }
  return {
    cost: costHeader !== null ? Number(costHeader) : null,
    costHeader,
    responseCostMs,
    usageHeader,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    model,
    base: AIGW_BASE,
    keyPresent: true,
    note: 'nanocode made this call directly; opencode session calls are not proxied by nanocode so their per-call cost is not captured here.',
  }
}

// ── Claude memory viewer (MES-13740 需求7) ───────────────────────────────────
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
 * Decode a Claude project slug back to an approximate cwd. Claude encodes cwd
 * by replacing '/' with '-' (see claudeProjectsDir), which is lossy when a path
 * segment itself contains '-'. This is for DISPLAY ONLY — file operations use
 * the exact slug, never the decoded cwd, so the lossiness never affects safety.
 */
export function claudeProjectSlugToCwd(slug) {
  if (!slug) return ''
  return String(slug).replace(/-/g, '/')
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

/** List .md files in a team/project memory dir (name, size, mtime), newest-first. */
export function listMemoryFiles(configDir, projectSlug) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  const memDir = join(configDir, 'projects', projectSlug, 'memory')
  if (!existsSync(memDir)) return { files: [], path: memDir }
  let entries = []
  try { entries = readdirSync(memDir, { withFileTypes: true }) } catch { return { files: [], path: memDir } }
  const files = []
  for (const f of entries) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue
    try {
      const st = statSync(join(memDir, f.name))
      files.push({ name: f.name, size: st.size, mtime: st.mtimeMs })
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return { files, path: memDir }
}

/** Read a single memory md file. Returns { name, content, size, mtime, path }. */
export function readMemoryFile(configDir, projectSlug, fileName) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  if (!isValidMemFile(fileName)) return { error: 'invalid file name' }
  const filePath = join(configDir, 'projects', projectSlug, 'memory', fileName)
  if (!existsSync(filePath)) return { error: 'file not found' }
  try {
    const content = readFileSync(filePath, 'utf8')
    const st = statSync(filePath)
    return { name: fileName, content, size: st.size, mtime: st.mtimeMs, path: filePath }
  } catch (err) {
    return { error: err.message }
  }
}

/**
 * Search a keyword across .md files in a memory dir (case-insensitive).
 * Returns { query, matches: [{ file, line, snippet }] }, capped at 200 hits.
 */
export function searchMemory(configDir, projectSlug, query) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  const q = String(query || '').trim()
  if (!q) return { query: '', matches: [] }
  const memDir = join(configDir, 'projects', projectSlug, 'memory')
  if (!existsSync(memDir)) return { query: q, matches: [] }
  let entries = []
  try { entries = readdirSync(memDir, { withFileTypes: true }) } catch { return { query: q, matches: [] } }
  const lower = q.toLowerCase()
  const matches = []
  for (const f of entries) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue
    let content = ''
    try { content = readFileSync(join(memDir, f.name), 'utf8') } catch { continue }
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
export function saveMemoryFile(configDir, projectSlug, fileName, content) {
  if (!isValidSlug(projectSlug)) return { error: 'invalid project slug' }
  if (!isValidMemFile(fileName)) return { error: 'invalid file name' }
  const memDir = join(configDir, 'projects', projectSlug, 'memory')
  const filePath = join(memDir, fileName)
  if (!existsSync(memDir)) return { error: 'memory dir not found' }
  let backupPath = null
  if (existsSync(filePath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = join(memDir, `.${fileName}.bak.${ts}`)
    try { copyFileSync(filePath, backupPath) } catch { backupPath = null }
  }
  try {
    writeFileSync(filePath, String(content ?? ''), 'utf8')
    const st = statSync(filePath)
    return { name: fileName, size: st.size, mtime: st.mtimeMs, backupPath, path: filePath }
  } catch (err) {
    return { error: err.message }
  }
}

// ── opencode SQLite session usage (MES-13740 需求15 item6) ────────────────────
//
// opencode stores sessions in a SQLite DB (`$XDG_DATA_HOME/opencode/opencode.db`,
// default ~/.local/share/opencode/opencode.db). The `session` table has
// per-session token columns (tokens_input/output/reasoning/cache_read/cache_write)
// + a `cost` column + model/directory/time_created/time_updated. We read it
// read-only and aggregate — honest labelling: AIGW-routed sessions report cost=0
// (the provider does not report per-session cost to opencode); the token counts
// are real and authoritative. This mirrors the claude jsonl aggregation (需求1)
// for the Fable5/opencode side so the Ops usage pane shows both sources.

/** Empty opencode usage shape (kept consistent for the UI on every error path). */
export function opencodeUsageEmpty() {
  return {
    totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: [],
    byDay: [],
    byDirectory: [],
    sessionCount: 0,
    costTotal: 0,
  }
}

/**
 * opencode stores the `model` column as a JSON string like
 * {"id":"litellm/SGLang-GLM-latest","providerID":"kimi","variant":"default"}.
 * Parse it and return the clean model id; fall back to the raw string when it
 * is not JSON (some older/odd rows), and to '(unknown)' when empty.
 */
export function parseOpencodeModel(raw) {
  if (typeof raw !== 'string' || !raw) return '(unknown)'
  try {
    const o = JSON.parse(raw)
    if (o && typeof o.id === 'string' && o.id) return o.id
  } catch { /* not JSON — use raw */ }
  return raw
}

/**
 * Pure: aggregate an array of opencode `session` rows (as read from SQLite)
 * into a usage summary. Each row shape:
 *   { model, cost, tokens_input, tokens_output, tokens_reasoning,
 *     tokens_cache_read, tokens_cache_write, time_created, time_updated, directory }
 * Null / missing fields are treated as 0. `time_*` are epoch MILLISECONDS
 * (verified against a live DB: 1783133879857 -> 2026-07-04T02:57:59Z).
 *
 * Returns { totals, byModel, byDay, byDirectory, sessionCount, costTotal }.
 * `costTotal` is kept separate — opencode populates `cost` only when the
 * provider reports it; AIGW-routed sessions report 0 (the UI labels honestly).
 *
 * This is a PURE function (no SQLite / no subprocess) so it is unit-tested
 * without a DB — mirrors the aggregateJsonlUsage / normalizeOpencodeSessions
 * pattern.
 */
export function aggregateOpencodeSessions(rows) {
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let costTotal = 0
  let sessionCount = 0
  const modelMap = new Map()
  const dayMap = new Map()
  const dirMap = new Map()
  if (!Array.isArray(rows)) return { ...opencodeUsageEmpty() }
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const input = Number(r.tokens_input) || 0
    const output = Number(r.tokens_output) || 0
    const reasoning = Number(r.tokens_reasoning) || 0
    const cacheRead = Number(r.tokens_cache_read) || 0
    const cacheWrite = Number(r.tokens_cache_write) || 0
    const cost = Number(r.cost) || 0
    const model = parseOpencodeModel(r.model)
    const updated = Number(r.time_updated) || (Number(r.time_created) || 0)
    const dir = typeof r.directory === 'string' && r.directory ? r.directory : '(unknown)'
    totals.input += input
    totals.output += output
    totals.reasoning += reasoning
    totals.cacheRead += cacheRead
    totals.cacheWrite += cacheWrite
    costTotal += cost
    sessionCount++
    let m = modelMap.get(model)
    if (!m) { m = { model, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0 }; modelMap.set(model, m) }
    m.input += input; m.output += output; m.reasoning += reasoning; m.cacheRead += cacheRead; m.cacheWrite += cacheWrite; m.cost += cost; m.sessions++
    if (updated > 0) {
      const day = new Date(updated).toISOString().slice(0, 10)
      let d = dayMap.get(day)
      if (!d) { d = { day, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0 }; dayMap.set(day, d) }
      d.input += input; d.output += output; d.reasoning += reasoning; d.cacheRead += cacheRead; d.cacheWrite += cacheWrite; d.cost += cost; d.sessions++
    }
    let di = dirMap.get(dir)
    if (!di) { di = { directory: dir, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0 }; dirMap.set(dir, di) }
    di.input += input; di.output += output; di.reasoning += reasoning; di.cacheRead += cacheRead; di.cacheWrite += cacheWrite; di.cost += cost; di.sessions++
  }
  const byModel = [...modelMap.values()].sort((a, b) => (b.input + b.output + b.reasoning + b.cacheRead + b.cacheWrite) - (a.input + a.output + a.reasoning + a.cacheRead + a.cacheWrite))
  const byDay = [...dayMap.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
  const byDirectory = [...dirMap.values()].sort((a, b) => b.sessions - a.sessions)
  return { totals, byModel, byDay, byDirectory, sessionCount, costTotal }
}

/**
 * Resolve candidate opencode SQLite DB paths. opencode stores sessions under
 * `$XDG_DATA_HOME/opencode/opencode.db` (default ~/.local/share/opencode/).
 * The GLM worker may set GLM_XDG_DATA_HOME to a separate dir — include it as a
 * candidate too (honest: aggregate every DB that exists). An explicit
 * OPENCODE_DB_PATH env overrides everything (used by tests + power users).
 *
 * Returns string[] of EXISTING non-empty files (de-duplicated, order preserved).
 */
export function resolveOpencodeDbPaths(home) {
  const homeDir = home || homedir()
  const candidates = []
  if (process.env.OPENCODE_DB_PATH) candidates.push(process.env.OPENCODE_DB_PATH)
  const xdg = process.env.XDG_DATA_HOME || join(homeDir, '.local', 'share')
  candidates.push(join(xdg, 'opencode', 'opencode.db'))
  if (process.env.GLM_XDG_DATA_HOME) candidates.push(join(process.env.GLM_XDG_DATA_HOME, 'opencode', 'opencode.db'))
  const seen = new Set()
  const out = []
  for (const c of candidates) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    try { if (existsSync(c) && statSync(c).size > 0) out.push(c) } catch {}
  }
  return out
}

/**
 * Query raw session rows from ONE opencode SQLite DB (read-only). Returns
 * { rows, dbPath } on success or { error, dbPath, rows: [] } on failure — never
 * throws so the route can 200 with a clear reason.
 */
function queryOpencodeSessionRows(dbPath) {
  if (!_DatabaseSync) return { error: 'node:sqlite unavailable (Node 22+ required)', dbPath, rows: [] }
  if (!dbPath || !existsSync(dbPath)) return { error: 'opencode DB not found', dbPath, rows: [] }
  let db
  try {
    db = new _DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare(
      'SELECT model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, directory FROM session'
    ).all()
    return { rows, dbPath }
  } catch (err) {
    return { error: String(err.message || err), dbPath, rows: [] }
  } finally {
    try { db && db.close() } catch {}
  }
}

/**
 * Scan ONE opencode SQLite DB and aggregate its session rows. Returns the
 * aggregate shape plus `dbPath` and `source`; on failure returns the empty
 * shape plus `error` + `dbPath` (never throws).
 */
export function scanOpencodeUsage(dbPath) {
  const { rows, error } = queryOpencodeSessionRows(dbPath)
  if (error) return { ...opencodeUsageEmpty(), dbPath, error }
  return { ...aggregateOpencodeSessions(rows), dbPath, source: 'opencode SQLite session table' }
}

/**
 * Scan ALL discovered opencode DBs (standard XDG + GLM_XDG_DATA_HOME + explicit
 * override) and merge their session rows into one aggregate. This is the
 * entry point the route calls. Returns the aggregate plus `dbPaths` (every
 * candidate that existed) and `errors` (per-DB failures, if any). When every
 * DB is unreadable, returns the empty shape + the first error.
 */
export function scanAllOpencodeUsage(home) {
  const dbPaths = resolveOpencodeDbPaths(home)
  if (!dbPaths.length) return { ...opencodeUsageEmpty(), dbPaths: [], error: 'opencode DB not found (no $XDG_DATA_HOME/opencode/opencode.db)' }
  const perDb = dbPaths.map(queryOpencodeSessionRows)
  const errors = perDb.filter((r) => r.error).map((r) => ({ dbPath: r.dbPath, error: r.error }))
  const allRows = perDb.filter((r) => !r.error).flatMap((r) => r.rows)
  if (!allRows.length) return { ...opencodeUsageEmpty(), dbPaths, errors, error: errors[0]?.error || 'no readable opencode DB' }
  const agg = aggregateOpencodeSessions(allRows)
  return { ...agg, dbPaths, errors, source: 'opencode SQLite session table' }
}

// ── MES-13788: CodexBar-style usage windows + burn + projection ───────────────
//
// Algorithm ported from CodexBar (MIT license, https://github.com/steipete/CodexBar)
// — "Show usage stats for OpenAI Codex and Claude Code". CodexBar is a Swift/macOS
// menu bar app; the window/reset/burn logic is ported to JS here (not imported).
// See CodexBar docs/claude.md: Claude usage comes from the OAuth API
// (api.anthropic.com/api/oauth/usage) which returns five_hour (session) + seven_day
// (weekly) utilization% + reset time + extra_usage (monthly credits). The absolute
// token limit is NOT published by the API, so burn rate + hit projection are
// derived from the local jsonl token timeline and labelled `estimated`.
//
// Three sources, each honest (no fabricated numbers — a missing limit is null):
//   1. Claude Team1 (~/.claude)        — OAuth API (real % + reset) + jsonl burn
//   2. Claude Team2 (~/.claude-team2)  — same
//   3. AIGW (LiteLLM)                  — admin endpoints probed; a virtual
//      LLM-only key is 403-rejected (only llm_api_routes allowed), so the source
//      is labelled unavailable. If a real admin key is configured later, the
//      probe picks up spend/budget automatically.
//
// Unified per-window schema (the `entries[]` of /api/usage/summary):
//   { source, label, windowType, used, limit|null, remaining|null, utilization|null,
//     unit, resetAt|null, burnRatePerMin|null, projectedHitAt|null,
//     estimated:bool, severity|null, usedTokens|null, note|null }
//
// `estimated` reflects whether the core used/limit/remaining/reset come from a real
// API (false) or are inferred from the jsonl timeline (true). burnRatePerMin is
// always measured from the jsonl; projectedHitAt is always an estimate (the token
// limit is inferred from utilization%). `note` explains the provenance for the UI.

const CLAUDE_OAUTH_USAGE_URL = process.env.CLAUDE_OAUTH_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'
const WINDOW_5H_MS = 5 * 60 * 60 * 1000
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000
// LiteLLM admin/billing endpoints probed in order. A virtual LLM-only key can
// only call `llm_api_routes`, so all of these 403; we still try them so a real
// admin key works the moment it is configured. (CodexBar docs/litellm.md)
const AIGW_ADMIN_ENDPOINTS = ['/key/info', '/user/info', '/global/spend', '/spend/logs']

/**
 * Read Claude Code OAuth credentials from `<configDir>/.credentials.json`.
 * Returns { accessToken, expiresAt, subscriptionType, rateLimitTier, scopes }
 * or null if the file / key is absent. Never throws. The token is never logged.
 * CodexBar reads the same file (docs/claude.md "File fallback: ~/.claude/.credentials.json").
 */
export function readClaudeOAuthCredentials(configDir) {
  if (!configDir) return null
  const credPath = join(configDir, '.credentials.json')
  try {
    const raw = readFileSync(credPath, 'utf8')
    const obj = JSON.parse(raw)
    const o = obj?.claudeAiOauth
    if (!o || typeof o !== 'object') return null
    const token = typeof o.accessToken === 'string' ? o.accessToken.trim() : ''
    if (!token) return null
    return {
      accessToken: token,
      expiresAt: Number(o.expiresAt) || null,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
      rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : null,
      scopes: Array.isArray(o.scopes) ? o.scopes : [],
    }
  } catch {
    return null
  }
}

/**
 * Fetch the Claude Code OAuth usage API (`/api/oauth/usage`). Requires the
 * `user:profile` scope (CodexBar docs/claude.md). Returns the parsed API
 * response on 200, or { error, status } otherwise. Never throws — degrades to
 * { error } so the route can fall back to jsonl estimation.
 *
 * Live network is not unit-tested (needs a real token); the response→windows
 * mapping is exercised via the pure `mapClaudeOAuthToWindows` instead.
 */
export async function fetchClaudeOAuthUsage(configDir, { fetchImpl } = {}) {
  const cred = readClaudeOAuthCredentials(configDir)
  if (!cred) return { error: 'no Claude OAuth credentials at <configDir>/.credentials.json' }
  // If the token is past expiry, skip the network call and degrade directly
  // (we cannot refresh without the OAuth client secret). Still return a
  // structured error so the caller can fall back to jsonl.
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    return { error: 'Claude OAuth token expired (no client secret to refresh)', expired: true }
  }
  if (!cred.scopes.includes('user:profile')) {
    return { error: 'Claude OAuth token lacks user:profile scope (cannot read usage)' }
  }
  const f = fetchImpl || fetch
  try {
    const res = await f(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
      },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) {
      let body = null
      try { body = await res.json() } catch {}
      return { error: `Claude OAuth usage HTTP ${res.status}`, status: res.status, body }
    }
    const data = await res.json()
    return { data, subscriptionType: cred.subscriptionType, rateLimitTier: cred.rateLimitTier }
  } catch (err) {
    return { error: `Claude OAuth usage fetch failed: ${err?.message || err}` }
  }
}

// ── jsonl timeline (for burn rate + hit projection) ────────────────────────────

/**
 * Stream one jsonl file and collect assistant-row timeline entries since
 * `sinceMs`. Each entry: { ts, input, output, cacheCreation, cacheRead, tokens, model }.
 * `ts` is the row's `timestamp` (ISO) parsed to epoch ms. Rows without a
 * timestamp or before sinceMs are skipped. Mirrors aggregateJsonlUsage's
 * streaming + fast `"usage"` substring pre-check, but keeps per-row timestamps.
 */
export function streamJsonlTimeline(jsonlPath, sinceMs, capBytes = USAGE_CAP_BYTES) {
  let size = 0
  try { size = statSync(jsonlPath).size } catch { return [] }
  if (size === 0) return []
  const readCap = Math.min(size, capBytes)
  const chunkBuf = Buffer.allocUnsafe(128 * 1024)
  let fd
  try { fd = openSync(jsonlPath, 'r') } catch { return [] }
  const out = []
  let pos = 0
  let tail = ''
  try {
    while (pos < readCap) {
      const n = readSync(fd, chunkBuf, 0, Math.min(chunkBuf.length, readCap - pos), pos)
      if (n <= 0) break
      tail += chunkBuf.subarray(0, n).toString('utf8')
      const lastNl = tail.lastIndexOf('\n')
      let block
      if (lastNl >= 0) {
        block = tail.slice(0, lastNl + 1)
        tail = tail.slice(lastNl + 1)
      } else if (pos + n >= readCap) {
        block = tail; tail = ''
      } else {
        pos += n; continue
      }
      pos += n
      const lines = block.split('\n')
      for (const line of lines) {
        if (!line || line.length < 8) continue
        if (line.indexOf('"usage"') === -1) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (row.type !== 'assistant') continue
        const u = row.message?.usage
        if (!u || typeof u !== 'object') continue
        const tsStr = row.timestamp
        let ts = 0
        if (typeof tsStr === 'string' && tsStr) {
          const t = Date.parse(tsStr)
          if (Number.isFinite(t)) ts = t
        }
        if (!ts) continue
        if (sinceMs && ts < sinceMs) continue
        const input = Number(u.input_tokens) || 0
        const output = Number(u.output_tokens) || 0
        const cacheCreation = Number(u.cache_creation_input_tokens) || 0
        const cacheRead = Number(u.cache_read_input_tokens) || 0
        out.push({
          ts,
          input, output, cacheCreation, cacheRead,
          tokens: input + output + cacheCreation + cacheRead,
          model: row.message?.model || '(unknown)',
        })
      }
    }
  } catch {
    // best-effort
  } finally {
    try { closeSync(fd) } catch {}
  }
  return out
}

/**
 * Collect the per-row token timeline across a team's `$configDir/projects/`,
 * limited to rows since `sinceMs`. Files are scanned most-recent-first by mtime
 * (up to maxFiles); files whose mtime is older than sinceMs are skipped (cheap).
 * Returns entries sorted by ts ascending.
 */
export function collectClaudeTimeline(configDir, { sinceMs = 0, maxFiles = 200 } = {}) {
  const projectsRoot = join(configDir, 'projects')
  const out = []
  if (!existsSync(projectsRoot)) return out
  const files = []
  let projectDirs = []
  try { projectDirs = readdirSync(projectsRoot, { withFileTypes: true }) } catch { return out }
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue
    const dirPath = join(projectsRoot, dirent.name)
    let names = []
    try { names = readdirSync(dirPath) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const fullPath = join(dirPath, name)
      try {
        const st = statSync(fullPath)
        if (st.size < 200) continue
        files.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size })
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const f of files.slice(0, maxFiles)) {
    if (sinceMs && f.mtimeMs < sinceMs) continue
    const rows = streamJsonlTimeline(f.path, sinceMs)
    for (const r of rows) out.push(r)
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

/**
 * Pure: compute burn rate + window usage from a timeline for a given window.
 * `rows` are { ts, tokens } (any extra fields ignored). Returns:
 *   { usedTokens, burnRatePerMin, oldestTs, newestTs, activeMinutes }
 *
 * Burn rate (CodexBar style): tokens consumed divided by the elapsed minutes
 * between the oldest and newest row in the window, floored to 1 minute so a
 * single bursty row does not produce an infinite rate. When there are no rows,
 * burnRatePerMin is null and usedTokens is 0.
 */
export function computeBurnRate(rows, { now = Date.now() } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return { usedTokens: 0, burnRatePerMin: null, oldestTs: null, newestTs: null, activeMinutes: 0 }
  }
  let usedTokens = 0
  let oldestTs = Infinity
  let newestTs = -Infinity
  for (const r of rows) {
    const ts = Number(r?.ts) || 0
    const tok = Number(r?.tokens) || 0
    usedTokens += tok
    if (ts && ts < oldestTs) oldestTs = ts
    if (ts && ts > newestTs) newestTs = ts
  }
  if (!Number.isFinite(oldestTs)) oldestTs = null
  if (!Number.isFinite(newestTs)) newestTs = null
  // elapsed between oldest and newest row in the window; floor to 1 min
  const span = (oldestTs != null && newestTs != null) ? (newestTs - oldestTs) : 0
  const activeMinutes = Math.max(span / 60000, 1)
  const burnRatePerMin = usedTokens / activeMinutes
  return { usedTokens, burnRatePerMin, oldestTs, newestTs, activeMinutes }
}

/**
 * Pure: project when utilization will hit 100% given the current utilization%
 * and a token burn rate. The token limit is inferred as usedTokens / (util/100)
 * (because util% of the limit == usedTokens). Returns an ISO string or null
 * when the projection is not computable (no burn, already at/over 100%, or
 * missing inputs). Always an estimate — the inferred limit is the source of
 * uncertainty, so callers label projectedHitAt as estimated.
 */
export function projectHitAt({ utilization, burnRatePerMin, usedTokens, now = Date.now() }) {
  const util = Number(utilization)
  const burn = Number(burnRatePerMin)
  const used = Number(usedTokens)
  if (!Number.isFinite(util) || util <= 0 || util >= 100) return null
  if (!Number.isFinite(burn) || burn <= 0) return null
  if (!Number.isFinite(used) || used <= 0) return null
  // inferred token limit: usedTokens is util% of the limit
  const tokenLimit = used / (util / 100)
  const remaining = tokenLimit - used
  if (remaining <= 0) return null
  const minutesToHit = remaining / burn
  if (!Number.isFinite(minutesToHit) || minutesToHit < 0) return null
  return new Date(now + minutesToHit * 60000).toISOString()
}

/**
 * Pure: map a Claude OAuth `/api/oauth/usage` response to the unified window
 * entries. This is the testable core — the live fetch is in fetchClaudeOAuthUsage.
 *
 * Response shape (verified against a real 200 on 2026-07-06):
 *   { five_hour: { utilization, resets_at, limit_dollars, used_dollars, remaining_dollars },
 *     seven_day: { utilization, resets_at, ... },
 *     extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency, ... },
 *     limits: [{ kind, group, percent, severity, resets_at, scope, is_active }, ...] }
 *
 * Returns windows: [5h(session), weekly(seven_day), monthly(extra_usage)]. The 5h
 * and weekly `used`/`limit`/`remaining` are in PERCENT (the API's real metric);
 * the monthly is in CREDITS. burnRatePerMin / projectedHitAt / usedTokens are
 * attached later from the jsonl timeline (see attachBurnAndProjection).
 */
export function mapClaudeOAuthToWindows(apiResp, { source, label, now = Date.now() } = {}) {
  const windows = []
  const r = apiResp || {}
  const five = r.five_hour || null
  const seven = r.seven_day || null
  const extra = r.extra_usage || null
  // pick severity from the limits[] array when present (richest signal)
  const limits = Array.isArray(r.limits) ? r.limits : []
  const sevFor = (kind) => {
    const m = limits.find((l) => l && l.kind === kind)
    return m?.severity || null
  }
  if (five && typeof five.utilization === 'number') {
    windows.push({
      source, label,
      windowType: '5h',
      used: five.utilization, limit: 100, remaining: 100 - five.utilization,
      utilization: five.utilization, unit: 'percent',
      resetAt: typeof five.resets_at === 'string' ? five.resets_at : null,
      burnRatePerMin: null, projectedHitAt: null,
      estimated: false, severity: sevFor('session') || severityFor(five.utilization),
      usedTokens: null, note: 'Claude Code OAuth API: 5-hour session window utilization % + reset time (real).',
    })
  }
  if (seven && typeof seven.utilization === 'number') {
    windows.push({
      source, label,
      windowType: 'weekly',
      used: seven.utilization, limit: 100, remaining: 100 - seven.utilization,
      utilization: seven.utilization, unit: 'percent',
      resetAt: typeof seven.resets_at === 'string' ? seven.resets_at : null,
      burnRatePerMin: null, projectedHitAt: null,
      estimated: false, severity: sevFor('weekly_all') || severityFor(seven.utilization),
      usedTokens: null, note: 'Claude Code OAuth API: 7-day weekly window utilization % + reset time (real).',
    })
  }
  if (extra && extra.is_enabled && typeof extra.monthly_limit === 'number' && typeof extra.used_credits === 'number') {
    windows.push({
      source, label,
      windowType: 'monthly',
      used: extra.used_credits, limit: extra.monthly_limit,
      remaining: extra.monthly_limit - extra.used_credits,
      utilization: typeof extra.utilization === 'number' ? extra.utilization : null,
      unit: 'credits',
      resetAt: null, // monthly reset day is not returned by the API
      burnRatePerMin: null, projectedHitAt: null,
      estimated: false, severity: severityFor(extra.utilization),
      usedTokens: null,
      note: 'Claude Code OAuth API: extra_usage monthly credits (real used/limit). Reset day not provided by API.',
    })
  }
  return windows
}

function severityFor(util) {
  const u = Number(util)
  if (!Number.isFinite(u)) return null
  if (u >= 90) return 'critical'
  if (u >= 75) return 'warning'
  return 'normal'
}

/**
 * Attach jsonl-derived burn rate + hit projection to a 5h/weekly window that
 * came from the OAuth API. `timeline` is the full 7d timeline; we filter to
 * the window's span for the burn calc. usedTokens + burnRatePerMin come from
 * the timeline; projectedHitAt is inferred from (utilization, usedTokens,
 * burnRatePerMin). projectedHitAt and the inferred limit are estimates, so
 * the window keeps `estimated:false` (the used/limit/reset are real from the
 * API) but gains `projectedHitEstimated:true` + a note.
 */
export function attachBurnAndProjection(window, timeline, { now = Date.now() } = {}) {
  if (!window) return window
  if (window.windowType !== '5h' && window.windowType !== 'weekly') return window
  const spanMs = window.windowType === '5h' ? WINDOW_5H_MS : WINDOW_7D_MS
  const sinceMs = now - spanMs
  const rows = (timeline || []).filter((r) => Number(r?.ts) >= sinceMs)
  const { usedTokens, burnRatePerMin } = computeBurnRate(rows, { now })
  const projected = projectHitAt({
    utilization: window.utilization, burnRatePerMin, usedTokens, now,
  })
  return {
    ...window,
    usedTokens: usedTokens || null,
    burnRatePerMin: burnRatePerMin || null,
    projectedHitAt: projected,
    projectedHitEstimated: projected != null,
    note: (window.note || '') + (burnRatePerMin
      ? ` Burn rate ${Math.round(burnRatePerMin)} tokens/min from local jsonl (last ${window.windowType === '5h' ? '5h' : '7d'}); hit projection inferred from utilization% (estimated).`
      : ' No recent jsonl activity in this window for burn-rate projection.'),
  }
}

/**
 * Pure: estimate 5h + weekly windows purely from a jsonl timeline (the degraded
 * path when the OAuth API is unavailable). used = tokens in window, limit =
 * null (unknown), resetAt = oldest row ts + window span (when the oldest usage
 * ages out of the rolling window — a CodexBar-style rolling-window reset
 * estimate). Everything is `estimated:true`. No fabricated limits.
 */
export function estimateClaudeWindowsFromTimeline(timeline, { source, label, now = Date.now() } = {}) {
  const rows = Array.isArray(timeline) ? timeline : []
  const build = (windowType, spanMs) => {
    const sinceMs = now - spanMs
    const wRows = rows.filter((r) => Number(r?.ts) >= sinceMs)
    const { usedTokens, burnRatePerMin, oldestTs } = computeBurnRate(wRows, { now })
    const resetAt = (oldestTs != null && usedTokens > 0) ? new Date(oldestTs + spanMs).toISOString() : null
    return {
      source, label, windowType,
      used: usedTokens, limit: null, remaining: null,
      utilization: null, unit: 'tokens',
      resetAt,
      burnRatePerMin: burnRatePerMin || null,
      projectedHitAt: null, // no limit -> no projection
      estimated: true, severity: severityFor(null),
      usedTokens: usedTokens || null,
      note: `Estimated from local jsonl timeline (OAuth API unavailable). ${usedTokens > 0 ? `~${Math.round(usedTokens)} tokens in last ${windowType === '5h' ? '5h' : '7d'}; reset when oldest usage ages out.` : 'No usage in window.'}`,
    }
  }
  return [build('5h', WINDOW_5H_MS), build('weekly', WINDOW_7D_MS)]
}

/**
 * Build the full Claude source summary for one team config dir. Tries the
 * OAuth API first (real % + reset), attaches jsonl burn/projection; on any
 * OAuth failure, degrades to pure jsonl estimation. Never throws.
 */
export async function buildClaudeSourceSummary({ configDir, source, label, home, now = Date.now() }) {
  const dir = configDir || effectiveClaudeConfigDir(null, home)
  const base = { source, label, kind: 'claude-oauth', configDir: dir, available: true }
  const cred = readClaudeOAuthCredentials(dir)
  if (cred) {
    base.subscriptionType = cred.subscriptionType
    base.rateLimitTier = cred.rateLimitTier
  }
  // collect the 7d timeline once (used for both 5h and weekly burn)
  const timeline = collectClaudeTimeline(dir, { sinceMs: now - WINDOW_7D_MS })
  const oauth = await fetchClaudeOAuthUsage(dir)
  if (oauth.data) {
    let windows = mapClaudeOAuthToWindows(oauth.data, { source, label, now })
    windows = windows.map((w) => attachBurnAndProjection(w, timeline, { now }))
    return { ...base, available: true, oauthAvailable: true, windows }
  }
  // degrade to jsonl estimation
  const windows = estimateClaudeWindowsFromTimeline(timeline, { source, label, now })
  return {
    ...base, available: true, oauthAvailable: false,
    oauthError: oauth.error || 'OAuth API unavailable',
    windows,
  }
}

// ── AIGW (LiteLLM) spend probe ─────────────────────────────────────────────────

/**
 * Probe the AIGW (LiteLLM) admin/billing endpoints for real spend/budget. Tries
 * /key/info, /user/info, /global/spend, /spend/logs in order (CodexBar
 * docs/litellm.md). A virtual LLM-only key is 403-rejected ("only allowed to
 * call routes: ['llm_api_routes']") — verified live on 2026-07-06. Never throws;
 * returns { available, tried[], error?, spend? } so the UI labels honestly.
 *
 * When a real admin key is configured, /key/info returns { soft_budget,
 * spend, token, ... } and /global/spend returns total spend — we map the first
 * usable response into a monthly-budget window. No fabricated numbers.
 */
export async function probeAigwSpend({ key, fetchImpl } = {}) {
  const apiKey = (key ?? readAigwKey()).trim()
  if (!apiKey) {
    return { available: false, error: 'AIGW key not found (~/.config/meshy-aigw.key)', tried: [] }
  }
  const f = fetchImpl || fetch
  const tried = []
  for (const ep of AIGW_ADMIN_ENDPOINTS) {
    const url = `${AIGW_BASE}${ep}`
    try {
      const res = await f(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      })
      tried.push({ endpoint: ep, status: res.status })
      if (res.ok) {
        let body = null
        try { body = await res.json() } catch {}
        return mapAigwSpendResponse(ep, body, { tried })
      }
      // 403 with the "only allowed to call routes: ['llm_api_routes']" message
      // means this is a virtual LLM-only key — no admin endpoint will work, so
      // stop probing further and report unavailable honestly.
      if (res.status === 403) {
        let body = null
        try { body = await res.json() } catch {}
        const msg = body?.detail || body?.error || `HTTP ${res.status}`
        if (/llm_api_routes|not allowed/i.test(String(msg))) {
          return {
            available: false,
            error: `AIGW key is virtual LLM-only (403 on ${ep}: ${msg}). Admin/billing routes are not permitted; spend/budget unavailable.`,
            tried,
          }
        }
      }
    } catch (err) {
      tried.push({ endpoint: ep, error: String(err?.message || err) })
    }
  }
  return {
    available: false,
    error: 'All AIGW admin endpoints rejected or unreachable (no spend/budget data).',
    tried,
  }
}

/**
 * Pure: map a successful AIGW admin response into a monthly-budget window.
 * LiteLLM /key/info returns { soft_budget, spend, token, ... } (credits/usd);
 * /global/spend returns { total_spend }. We surface whatever the gateway gave
 * us, labelled with its unit, and never invent fields. Returns
 * { available:true, windows:[...], raw } or { available:false, error }.
 */
export function mapAigwSpendResponse(endpoint, body, { tried } = {}) {
  if (!body || typeof body !== 'object') {
    return { available: false, error: `${endpoint} returned no parseable body`, tried }
  }
  // /key/info shape: { soft_budget, spend, token, budget_duration, ... }
  if (endpoint === '/key/info') {
    const soft = Number(body.soft_budget)
    const spend = Number(body.spend)
    if (Number.isFinite(spend)) {
      const limit = Number.isFinite(soft) && soft > 0 ? soft : null
      return {
        available: true,
        tried,
        raw: { endpoint, soft_budget: body.soft_budget, spend: body.spend },
        windows: [{
          source: 'aigw-litellm', label: 'AIGW (LiteLLM)',
          windowType: 'monthly',
          used: spend, limit, remaining: limit != null ? limit - spend : null,
          utilization: limit != null ? (spend / limit) * 100 : null,
          unit: 'usd',
          resetAt: null, burnRatePerMin: null, projectedHitAt: null,
          estimated: false, severity: severityFor(limit != null ? (spend / limit) * 100 : null),
          usedTokens: null,
          note: `AIGW LiteLLM /key/info: spend $${spend.toFixed(4)}${limit != null ? ` of $${limit.toFixed(4)} soft budget` : ''} (real).`,
        }],
      }
    }
  }
  // /global/spend shape: { total_spend, ... } — spend only, no limit
  if (endpoint === '/global/spend') {
    const total = Number(body.total_spend ?? body.spend)
    if (Number.isFinite(total)) {
      return {
        available: true,
        tried,
        raw: { endpoint, total_spend: body.total_spend },
        windows: [{
          source: 'aigw-litellm', label: 'AIGW (LiteLLM)',
          windowType: 'monthly',
          used: total, limit: null, remaining: null,
          utilization: null, unit: 'usd',
          resetAt: null, burnRatePerMin: null, projectedHitAt: null,
          estimated: false, severity: null, usedTokens: null,
          note: `AIGW LiteLLM /global/spend: total spend $${total.toFixed(4)} (real, no budget limit exposed).`,
        }],
      }
    }
  }
  return { available: false, error: `${endpoint} response had no usable spend/budget fields`, tried, raw: body }
}

/**
 * Build the AIGW (LiteLLM) source summary. Probes admin endpoints; honestly
 * labels unavailable when the key is virtual LLM-only (403). No fabricated numbers.
 */
export async function buildAigwSourceSummary({ now = Date.now() } = {}) {
  const probe = await probeAigwSpend({})
  const base = {
    source: 'aigw-litellm', label: 'AIGW (LiteLLM)', kind: 'litellm',
    configDir: null, available: !!probe.available, tried: probe.tried || [],
  }
  if (probe.available) {
    return { ...base, windows: probe.windows, raw: probe.raw }
  }
  return {
    ...base,
    windows: [{
      source: 'aigw-litellm', label: 'AIGW (LiteLLM)',
      windowType: 'monthly',
      used: null, limit: null, remaining: null, utilization: null, unit: 'usd',
      resetAt: null, burnRatePerMin: null, projectedHitAt: null,
      estimated: false, severity: null, usedTokens: null,
      note: probe.error || 'AIGW spend/budget unavailable.',
    }],
    error: probe.error,
  }
}

// ── /api/usage/summary entry point ────────────────────────────────────────────

/**
 * Build the three-source usage summary returned by GET /api/usage/summary.
 * Iterates the discovered Claude teams (Team1 ~/.claude + ~/.claude-team*) and
 * adds the AIGW source. Returns:
 *   { generatedAt, schemaVersion, sources: [...], entries: [...] }
 * `entries` is a flat array of the unified per-window schema objects — the
 * AI-readable surface a secretary/agent fetches to read usage + limits and
 * decide degradation routing. Never throws; each source degrades independently.
 */
export async function buildUsageSummary({ home, store, now = Date.now() } = {}) {
  const homeDir = home || homedir()
  const { teams } = listTeams(homeDir, store)
  const sources = []
  // Claude teams: ~/.claude (team1) + ~/.claude-team* (CodexBar multi-account).
  for (const team of teams) {
    if (!team.exists) continue
    const src = await buildClaudeSourceSummary({
      configDir: team.path,
      source: `claude-${team.id}`,
      label: `${team.name} (Claude Code)`,
      home: homeDir, now,
    })
    sources.push(src)
  }
  // AIGW (LiteLLM)
  sources.push(await buildAigwSourceSummary({ now }))
  // flat entries for AI consumption
  const entries = []
  for (const s of sources) {
    for (const w of (s.windows || [])) entries.push({ ...w, source: s.source, label: s.label })
  }
  return {
    generatedAt: new Date(now).toISOString(),
    schemaVersion: 1,
    sources,
    entries,
  }
}
