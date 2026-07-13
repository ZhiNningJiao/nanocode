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
import { loadPersonalConfig, DEFAULT_AIGW_BASE, DEFAULT_AIGW_BUDGET_USD } from './personal-config.js'

// node:sqlite is experimental (Node 22+). Guarded require so an unavailable /
// older runtime degrades to an honest "source unavailable" instead of crashing
// the server at boot. The opencode session-table usage reader (需求15 item6) is
// the only consumer; if it is null the route returns an honest error shape.
const _require = createRequire(import.meta.url)
let _DatabaseSync = null
try { ({ DatabaseSync: _DatabaseSync } = _require('node:sqlite')) } catch { /* node:sqlite unavailable */ }

// AIGW base + key come from the unified personal config (personal-config.js),
// which reads ~/.config/nanocode/personal.json first then falls back to the
// scattered ~/.config/meshy-aigw.key + $MESHY_AIGW_BASE + the default base.
// `getAigwBase()` / `readAigwKey()` are kept as the single read points so every
// call picks up the personal config (and tests can pass a fake `home`).
function getAigwBase({ home } = {}) {
  return loadPersonalConfig({ home }).aigw.base
}
function getAigwBudgetUsd({ home } = {}) {
  return loadPersonalConfig({ home }).aigw.budgetUsd
}

/** Read the AIGW key (personal config -> ~/.config/meshy-aigw.key). Returns '' if absent. */
export function readAigwKey({ home } = {}) {
  return loadPersonalConfig({ home }).aigw.key
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
 * every '/' and '.' becomes '-'. The '.' replacement matters for paths with
 * dotfiles / dot-segments (e.g. "/.../nanocode/.interrupt-probe" encodes to
 * "...-nanocode--interrupt-probe"); without it such cwds failed to resolve
 * their jsonl dir → empty/wrong session replay. (`cwdToClaudeProjectDir`
 * equivalent that takes an explicit config dir instead of home, so Team
 * switch (CLAUDE_CONFIG_DIR) is honoured.)
 */
export function claudeProjectsDir(configDir, cwd) {
  const encoded = String(cwd).replace(/[/.]/g, '-')
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
 * Auto-discovers ~/.claude (team1 / default) plus any ~/.claude-team* dirs,
 * then MERGES any teams declared in the personal config (personal-config.js
 * claude.teams[], loaded from ~/.config/nanocode/personal.json). Declared
 * teams are unioned by resolved path so the existing Team1/Team2 discovery
 * never regresses; the personal file only lets the user ADD/label extra teams
 * (e.g. a team3 at a custom path). When the personal file is absent or has no
 * claude.teams, behaviour is identical to before. Returns { teams, activePath }.
 */
export function listTeams(home, store) {
  const homeDir = home || homedir()
  const teams = []
  const seen = new Set()
  // Friendly-name overrides from personal config, keyed by configDir. Lets the
  // auto-discovered ~/.claude / ~/.claude-team* show real org names (e.g.
  // "Meshy-Algorithm") instead of the generic "Team 1 / Team 2".
  const personal = loadPersonalConfig({ home: homeDir })
  const personalTeams = Array.isArray(personal?.claude?.teams) ? personal.claude.teams : []
  const nameByPath = {}
  for (const t of personalTeams) {
    const dir = t?.configDir || t?.path
    if (dir && t?.name) nameByPath[dir] = t.name
  }
  const pushTeam = (id, name, path) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    teams.push({ id, name: nameByPath[path] || name, path, exists: existsSync(path) })
  }
  // 1. auto-discover ~/.claude (team1) + ~/.claude-team*
  const defaultDir = join(homeDir, '.claude')
  pushTeam('team1', 'Team 1', defaultDir)
  let entries = []
  try { entries = readdirSync(homeDir, { withFileTypes: true }) } catch {}
  for (const d of entries) {
    if (!d.isDirectory()) continue
    if (!d.name.startsWith('.claude-team') && !d.name.startsWith('.claude_team')) continue
    const fullPath = join(homeDir, d.name)
    const m = d.name.match(/claude[-_](.+)$/)
    const id = m ? m[1] : d.name
    pushTeam(id, `Team ${id}`, fullPath)
  }
  // 2. merge extra teams declared only in the personal config
  for (const t of personalTeams) {
    const dir = t?.configDir || t?.path
    if (!dir) continue
    const base = String(dir).split('/').filter(Boolean).pop() || dir
    const m = String(base).match(/claude[-_](.+)$/)
    const id = m ? m[1] : base
    pushTeam(id, t.name || `Team ${id}`, dir)
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
export async function listAigwModels({ key, home } = {}) {
  const base = getAigwBase({ home })
  const apiKey = (key ?? readAigwKey({ home })).trim()
  if (!apiKey) return { models: [], raw: 0, base, keyPresent: false, error: 'AIGW key not found (personal.json aigw.key or ~/.config/meshy-aigw.key)' }
  const res = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return { models: [], raw: 0, base, keyPresent: true, error: `AIGW /v1/models HTTP ${res.status}` }
  const data = await res.json()
  const all = Array.isArray(data?.data) ? data.data : []
  const ids = all.map((m) => m.id).filter((id) => typeof id === 'string' && id.startsWith('litellm/'))
  ids.sort()
  return { models: ids, raw: all.length, base, keyPresent: true }
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
export async function probeAigwCost({ key, model = 'litellm/SGLang-GLM-latest', prompt = 'Reply with the single word: ok', home } = {}) {
  const base = getAigwBase({ home })
  const apiKey = (key ?? readAigwKey({ home })).trim()
  if (!apiKey) return { error: 'AIGW key not found (personal.json aigw.key or ~/.config/meshy-aigw.key)', keyPresent: false }
  const res = await fetch(`${base}/v1/chat/completions`, {
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
    return { error: `AIGW HTTP ${res.status}`, status: res.status, keyPresent: true, model, base }
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
    base,
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
//   3. AIGW (LiteLLM)                  — /key/info?key=KEY (real spend) +
//      /spend/logs/v2 (window token burn). remaining = budgetUsd - spend,
//      where budgetUsd comes from the personal config (default 1000); the
//      key-side max_budget is null for a virtual LLM-only key, so the budget
//      is local and the window is labelled `estimated:true`. Verified live
//      2026-07-07: spend≈$426.35, alias zhiningjiao@meshy.ai.
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
// Public PKCE client (no secret) — the Claude Code CLI's own OAuth client. Lets
// the usage monitor refresh an expired access token via the stored refresh token
// so it keeps showing real OAuth windows instead of degrading to jsonl estimate.
const CLAUDE_OAUTH_TOKEN_URL = process.env.CLAUDE_OAUTH_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_OAUTH_CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const WINDOW_5H_MS = 5 * 60 * 60 * 1000
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000
// LiteLLM admin/billing endpoints probed in order by the legacy probeAigwSpend
// fallback (CodexBar docs/litellm.md). The primary AIGW source now uses the
// verified-live /key/info?key=KEY + /spend/logs/v2 flow (fetchAigwKeyInfo /
// fetchAigwSpendLogs below); this list is kept for the legacy fallback.
const AIGW_ADMIN_ENDPOINTS = ['/key/info', '/user/info', '/global/spend', '/spend/logs']
// /spend/logs/v2 window sample size. The full history can be 20k+ rows; we
// fetch the most-recent bounded page and compute burn from its active span
// (labelled estimated/sampled in the window note).
const AIGW_SPEND_LOGS_PAGE_SIZE = 100
const AIGW_SPEND_LOGS_WINDOW_DAYS = 7

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
/**
 * Refresh an expired Claude OAuth access token using the stored refresh token
 * (public PKCE client — no secret needed). On success, persists the rotated
 * tokens back to <configDir>/.credentials.json (backup first) and returns the
 * fresh cred; on ANY failure returns null so the caller degrades to jsonl
 * estimation. Never throws. A dead/rotated refresh token (invalid_grant) → null
 * → user must re-login that team (`CLAUDE_CONFIG_DIR=<dir> claude` then /login).
 */
export async function refreshClaudeOAuthToken(configDir, { fetchImpl } = {}) {
  try {
    const credPath = join(configDir, '.credentials.json')
    if (!existsSync(credPath)) return null
    const raw = JSON.parse(readFileSync(credPath, 'utf8'))
    const o = raw?.claudeAiOauth
    if (!o?.refreshToken) return null
    const f = fetchImpl || fetch
    const res = await f(CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    if (!body?.access_token) return null
    o.accessToken = body.access_token
    if (body.refresh_token) o.refreshToken = body.refresh_token
    if (typeof body.expires_in === 'number') o.expiresAt = Date.now() + body.expires_in * 1000
    try { copyFileSync(credPath, credPath + '.bak-refresh') } catch {}
    writeFileSync(credPath, JSON.stringify(raw))
    return {
      accessToken: o.accessToken,
      expiresAt: Number(o.expiresAt) || null,
      subscriptionType: o.subscriptionType || null,
      rateLimitTier: o.rateLimitTier || null,
      scopes: Array.isArray(o.scopes) ? o.scopes : [],
    }
  } catch { return null }
}

export async function fetchClaudeOAuthUsage(configDir, { fetchImpl } = {}) {
  let cred = readClaudeOAuthCredentials(configDir)
  if (!cred) return { error: 'no Claude OAuth credentials at <configDir>/.credentials.json' }
  // Token past expiry: refresh it (public PKCE client) rather than giving up.
  // Only if refresh fails (dead refresh token) do we degrade to jsonl estimation.
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    const refreshed = await refreshClaudeOAuthToken(configDir, { fetchImpl })
    if (!refreshed) return { error: 'Claude OAuth token expired and refresh failed (re-login needed)', expired: true }
    cred = refreshed
  }
  if (!cred.scopes.includes('user:profile')) {
    return { error: 'Claude OAuth token lacks user:profile scope (cannot read usage)' }
  }
  const f = fetchImpl || fetch
  const call = (token) => f(CLAUDE_OAUTH_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': CLAUDE_OAUTH_BETA },
    signal: AbortSignal.timeout(12000),
  })
  try {
    let res = await call(cred.accessToken)
    // 401 despite a non-expired timestamp → token revoked/rotated on the server.
    // Try one refresh + retry before degrading.
    if (res.status === 401) {
      const refreshed = await refreshClaudeOAuthToken(configDir, { fetchImpl })
      if (refreshed) { cred = refreshed; res = await call(cred.accessToken) }
    }
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
  // Per-model token breakdown for THIS team (Fable / Opus / Sonnet / Haiku …),
  // from the team's own jsonl. OAuth gives no per-model limit, so this is token
  // counts + message rows — surfaced under each team card in the UI.
  try {
    const scan = scanClaudeUsage(dir, {})
    base.byModel = (scan.byModel || [])
      .filter((m) => m.model && m.model !== '<synthetic>')
      .map((m) => ({
        model: m.model,
        tokens: (m.input || 0) + (m.output || 0) + (m.cacheCreation || 0) + (m.cacheRead || 0),
        input: m.input || 0,
        output: m.output || 0,
        cacheRead: m.cacheRead || 0,
        rows: m.rows || 0,
      }))
      .slice(0, 8)
    base.rows = scan.totals?.rows || 0
    base.filesScanned = scan.files || 0
  } catch { base.byModel = [] }
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

// ── AIGW (LiteLLM) spend source ─────────────────────────────────────────────────

/**
 * Fetch AIGW `GET /key/info?key=KEY` (Authorization: Bearer KEY) and return the
 * real spend + alias + the key-side max_budget. Verified live 2026-07-07: 200
 * with `{ info: { spend, max_budget, key_alias, budget_duration, budget_reset_at, ... } }`
 * (max_budget is null for a virtual LLM-only key, so remaining is computed
 * locally from the personal-config budgetUsd — see buildAigwSourceSummary).
 * Never throws; returns { error } so the source degrades honestly.
 */
export async function fetchAigwKeyInfo({ key, base, fetchImpl } = {}) {
  const apiKey = String(key ?? '').trim()
  const b = base || getAigwBase()
  if (!apiKey) return { error: 'AIGW key not found (personal.json aigw.key or ~/.config/meshy-aigw.key)' }
  const f = fetchImpl || fetch
  try {
    const res = await f(`${b}/key/info?key=${encodeURIComponent(apiKey)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      let body = null
      try { body = await res.json() } catch {}
      const msg = body?.detail || body?.error || `HTTP ${res.status}`
      return { error: `AIGW /key/info HTTP ${res.status}: ${msg}`, status: res.status }
    }
    const body = await res.json()
    const info = body?.info || body  // real API nests under info; flat fallback
    const spend = Number(info?.spend)
    if (!Number.isFinite(spend)) return { error: 'AIGW /key/info returned no usable spend field' }
    return {
      spend,
      alias: typeof info?.key_alias === 'string' ? info.key_alias : null,
      maxBudget: (info?.max_budget == null) ? null : (Number.isFinite(Number(info.max_budget)) ? Number(info.max_budget) : null),
      budgetDuration: typeof info?.budget_duration === 'string' ? info.budget_duration : null,
      budgetResetAt: typeof info?.budget_reset_at === 'string' ? info.budget_reset_at : null,
      raw: { spend: info?.spend, max_budget: info?.max_budget, key_alias: info?.key_alias },
    }
  } catch (err) {
    return { error: `AIGW /key/info fetch failed: ${err?.message || err}` }
  }
}

/**
 * Fetch AIGW `GET /spend/logs/v2?key=KEY&page=1&page_size=N&start_date=...&end_date=...`
 * (Authorization: Bearer KEY) and aggregate the window's token detail into a
 * burn rate. The page is bounded (AIGW_SPEND_LOGS_PAGE_SIZE) so a 20k+-entry
 * history does not stall the endpoint; burn is computed from the sampled rows'
 * active span (CodexBar-style, same computeBurnRate used for the jsonl
 * timeline). Each row carries total_tokens/prompt/completion/model/model_group/
 * startTime/endTime. Returns { tokensWindow, burnPerMin, rows, oldestTs,
 * newestTs, sampled, totalEntries } or { error }. Never throws.
 */
export async function fetchAigwSpendLogs({ key, base, fetchImpl, days = AIGW_SPEND_LOGS_WINDOW_DAYS, now = Date.now() } = {}) {
  const apiKey = String(key ?? '').trim()
  const b = base || getAigwBase()
  if (!apiKey) return { error: 'AIGW key not found' }
  const f = fetchImpl || fetch
  const fmt = (d) => new Date(d).toISOString().slice(0, 10)
  const url = `${b}/spend/logs/v2?key=${encodeURIComponent(apiKey)}&page=1&page_size=${AIGW_SPEND_LOGS_PAGE_SIZE}&start_date=${fmt(now - days * 86400_000)}&end_date=${fmt(now)}`
  try {
    const res = await f(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return { error: `AIGW /spend/logs/v2 HTTP ${res.status}` }
    const body = await res.json()
    const data = Array.isArray(body?.data) ? body.data : []
    const rows = []
    let tokensWindow = 0
    for (const e of data) {
      const tsStr = e?.startTime || e?.endTime
      const ts = tsStr ? Date.parse(tsStr) : 0
      const tok = Number(e?.total_tokens) || 0
      if (!ts || !tok) continue
      rows.push({ ts, tokens: tok, model: e?.model_group || e?.model || '(unknown)' })
      tokensWindow += tok
    }
    rows.sort((a, b) => a.ts - b.ts)
    const { burnRatePerMin, oldestTs, newestTs } = computeBurnRate(rows, { now })
    return {
      tokensWindow,
      burnPerMin: burnRatePerMin,
      rows: rows.length,
      oldestTs, newestTs,
      sampled: rows.length,
      totalEntries: typeof body?.total === 'number' ? body.total : null,
    }
  } catch (err) {
    return { error: `AIGW /spend/logs/v2 fetch failed: ${err?.message || err}` }
  }
}

/**
 * Legacy probe of LiteLLM admin/billing endpoints (kept as a fallback; the
 * primary AIGW source uses fetchAigwKeyInfo + fetchAigwSpendLogs). Tries
 * /key/info, /user/info, /global/spend, /spend/logs in order. Never throws;
 * returns { available, tried[], error?, spend? } so a caller can label honestly.
 */
export async function probeAigwSpend({ key, base, fetchImpl, home } = {}) {
  const apiKey = String(key ?? readAigwKey({ home })).trim()
  const b = base || getAigwBase({ home })
  if (!apiKey) {
    return { available: false, error: 'AIGW key not found (personal.json aigw.key or ~/.config/meshy-aigw.key)', tried: [] }
  }
  const f = fetchImpl || fetch
  const tried = []
  for (const ep of AIGW_ADMIN_ENDPOINTS) {
    const url = `${b}${ep}`
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
 * LiteLLM /key/info returns `{ info: { spend, max_budget, key_alias, ... } }`
 * (verified live; max_budget is null for a virtual LLM-only key) — we accept
 * both the nested `info.*` shape and the flat `{ soft_budget, spend }` shape
 * (the latter is the legacy/CodexBar-documented shape). /global/spend returns
 * `{ total_spend }`. We surface whatever the gateway gave us, labelled with its
 * unit, and never invent fields. Returns { available:true, windows, raw } or
 * { available:false, error }.
 */
export function mapAigwSpendResponse(endpoint, body, { tried } = {}) {
  if (!body || typeof body !== 'object') {
    return { available: false, error: `${endpoint} returned no parseable body`, tried }
  }
  if (endpoint === '/key/info') {
    const info = body.info || body
    const soft = Number(info?.soft_budget ?? body.soft_budget)
    const spend = Number(info?.spend ?? body.spend)
    if (Number.isFinite(spend)) {
      const limit = Number.isFinite(soft) && soft > 0 ? soft : null
      return {
        available: true,
        tried,
        raw: { endpoint, soft_budget: info?.soft_budget ?? body.soft_budget, spend: info?.spend ?? body.spend },
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

function aigwUnavailableWindow(note) {
  return {
    source: 'aigw-litellm', label: 'AIGW (LiteLLM)',
    windowType: 'monthly',
    used: null, limit: null, remaining: null, utilization: null, unit: 'usd',
    resetAt: null, burnRatePerMin: null, projectedHitAt: null,
    estimated: false, severity: null, usedTokens: null,
    note,
  }
}

/**
 * Build the AIGW (LiteLLM) source summary. Calls /key/info?key=KEY for the real
 * spend and /spend/logs/v2 for the window token burn. remaining = budgetUsd -
 * spend (budgetUsd from the personal config, default 1000; the key-side
 * max_budget is null for a virtual LLM-only key, so the budget is local and the
 * window is labelled `estimated:true`). `home` / `fetchImpl` are threaded
 * through so tests run hermetically against a fake home + mocked fetch. Never
 * throws; degrades to an honest unavailable window when the key / endpoints fail.
 */
export async function buildAigwSourceSummary({ now = Date.now(), home, fetchImpl } = {}) {
  const personal = loadPersonalConfig({ home })
  const { base, key, budgetUsd } = personal.aigw
  const baseFields = {
    source: 'aigw-litellm', label: 'AIGW (LiteLLM)', kind: 'litellm',
    configDir: null, base, alias: null, available: false, tried: [],
  }
  if (!key) {
    return {
      ...baseFields,
      windows: [aigwUnavailableWindow('AIGW key not found (personal.json aigw.key or ~/.config/meshy-aigw.key).')],
      error: 'AIGW key not found (personal.json aigw.key or ~/.config/meshy-aigw.key)',
    }
  }
  const info = await fetchAigwKeyInfo({ key, base, fetchImpl })
  if (info.error) {
    return {
      ...baseFields, available: false,
      tried: [{ endpoint: '/key/info', error: info.error }],
      windows: [aigwUnavailableWindow(info.error)],
      error: info.error,
    }
  }
  // spend is real from the API; budget is local (key max_budget is null) → estimated.
  const spend = info.spend
  const limit = (info.maxBudget != null && info.maxBudget > 0) ? info.maxBudget : budgetUsd
  const remaining = limit - spend
  const utilization = limit > 0 ? (spend / limit) * 100 : null
  // burn from the spend/logs/v2 window (best-effort; does not gate availability)
  const logs = await fetchAigwSpendLogs({ key, base, fetchImpl, now })
  const burnPerMin = logs && !logs.error ? (logs.burnPerMin || null) : null
  const tokensWindow = logs && !logs.error ? (logs.tokensWindow || 0) : null
  const logsNote = logs?.error
    ? ` (spend/logs/v2 unavailable: ${logs.error})`
    : (tokensWindow != null
      ? ` Window burn from /spend/logs/v2 (last ${AIGW_SPEND_LOGS_WINDOW_DAYS}d, ${logs.sampled} sampled rows${logs.totalEntries != null ? ` of ${logs.totalEntries}` : ''}).`
      : '')
  const tried = [{ endpoint: '/key/info', status: 200 }]
  if (logs?.error) tried.push({ endpoint: '/spend/logs/v2', error: logs.error })
  else tried.push({ endpoint: '/spend/logs/v2', status: 200, sampled: logs?.sampled ?? null })
  return {
    ...baseFields,
    available: true,
    alias: info.alias,
    tried,
    raw: info.raw,
    windows: [{
      source: 'aigw-litellm', label: 'AIGW (LiteLLM)',
      windowType: 'monthly',
      used: spend, limit, remaining, utilization, unit: 'usd',
      resetAt: info.budgetResetAt || null,
      burnRatePerMin: burnPerMin, projectedHitAt: null,
      estimated: true,   // budget is local (key max_budget is null); remaining computed locally
      severity: severityFor(utilization),
      usedTokens: tokensWindow,
      // AI-readable AIGW-specific fields (task unified schema):
      used_usd: spend, budget_usd: limit, remaining_usd: remaining,
      tokens_window: tokensWindow, burn_per_min: burnPerMin,
      note: `AIGW LiteLLM /key/info: spend $${spend.toFixed(2)}${info.alias ? ` (alias ${info.alias})` : ''} of $${limit.toFixed(2)} budget (spend real from API, budget local from personal config → estimated). Remaining $${remaining.toFixed(2)}.${logsNote}`,
    }],
  }
}

// ── AIGW monthly budget (MES-13788 延续: /user/info 剩余额度 + 自适配档) ────────
//
// The 4th honest source: GET https://aigw.meshy.team/user/info → user_info.
//   { max_budget, spend, budget_reset_at, budget_duration, user_email }
// `remaining = max_budget - spend`, `pct_remaining = remaining / max_budget * 100`,
// `days_left` = whole days from now to budget_reset_at (floor 0). The
// self-adapting strategy tier is ported verbatim from ~/code/aigw_budget.sh:
//   FREE_ONLY  : 剩<10%           → 只免费 GLM/Kimi
//   BURN       : reset≤4天 且 剩>25% → 用不完就清零, 猛往付费堆
//   SPEND_PAID : >40% 且 reset 还远 → 硬活放开上付费 gpt-5.5/opus
//   BALANCED   : 10-40%           → 免费铺量, 付费只给硬骨头
// No fabricated numbers — every field comes from the gateway response.

/** Tier advice strings (mirror aigw_budget.sh, zh source of truth). */
export const AIGW_BUDGET_ADVICE = {
  FREE_ONLY: '剩<10%: 只蹬免费 GLM/Kimi; 付费仅留给主人点名的紧急活。',
  BALANCED: '10-40%: 免费铺量; 付费(gpt-5.5/opus)只给高优先级硬骨头。',
  SPEND_PAID: '>40% 且离重置远: 硬活/交叉审放开上付费 gpt-5.5/claude-opus, 不心疼。',
  BURN: '临近月末且剩余多: use-it-or-lose-it! 硬活猛往付费堆, 别让额度清零白瞎。',
}

/**
 * Pure: compute the self-adapting strategy tier from remaining% + days to
 * reset. Ported verbatim from aigw_budget.sh (the order matters: BURN is
 * checked before SPEND_PAID so a near-reset surplus is not mislabelled).
 * `pctRemaining` is remaining / max_budget * 100; `daysLeft` may be null when
 * the reset time is unknown (then BURN is unreachable — honest).
 */
export function computeAigwBudgetTier({ pctRemaining, daysLeft }) {
  const pct = Number(pctRemaining)
  if (!Number.isFinite(pct)) return 'BALANCED'
  if (pct < 10) return 'FREE_ONLY'
  // daysLeft null/undefined = reset unknown -> BURN unreachable (honest: don't
  // cry "use-it-or-lose-it" when we don't actually know when reset happens).
  // Number(null)===0 would otherwise slip through the finite guard below.
  if (daysLeft == null) return pct > 40 ? 'SPEND_PAID' : 'BALANCED'
  const dl = Number(daysLeft)
  if (Number.isFinite(dl) && dl <= 4 && pct > 25) return 'BURN'
  if (pct > 40) return 'SPEND_PAID'
  return 'BALANCED'
}

/**
 * Pure: parse a budget_reset_at ISO string into whole days from `now` to reset,
 * floored to 0. Returns null when the string is missing/unparseable. Mirrors
 * aigw_budget.sh (UTC day diff). Never throws.
 */
export function computeBudgetDaysLeft(resetAt, now = Date.now()) {
  if (typeof resetAt !== 'string' || !resetAt) return null
  const rt = Date.parse(resetAt)
  if (!Number.isFinite(rt)) return null
  const diff = rt - now
  if (diff <= 0) return 0
  return Math.floor(diff / 86400_000)
}

/**
 * Pure: map a successful AIGW /user/info response body into the budget object.
 * The body's `user_info` carries max_budget / spend / budget_reset_at. Returns
 * { available:true, ...budget } or { available:false, error } — no fabrication.
 * This is the testable core; the live fetch is in fetchAigwBudget.
 */
export function mapAigwBudgetResponse(body, { now = Date.now() } = {}) {
  const ui = body && typeof body === 'object' ? body.user_info : null
  if (!ui || typeof ui !== 'object') {
    return { available: false, error: '/user/info returned no user_info body' }
  }
  const maxb = Number(ui.max_budget)
  const spend = Number(ui.spend)
  if (!Number.isFinite(spend)) {
    return { available: false, error: '/user/info user_info.spend is not a number' }
  }
  const maxBudget = Number.isFinite(maxb) && maxb > 0 ? maxb : null
  const remaining = maxBudget != null ? Math.round((maxBudget - spend) * 100) / 100 : null
  const pctRemaining = maxBudget != null ? Math.round((remaining / maxBudget) * 1000) / 10 : null
  const pctUsed = maxBudget != null ? Math.round((spend / maxBudget) * 1000) / 10 : null
  const resetAt = typeof ui.budget_reset_at === 'string' && ui.budget_reset_at ? ui.budget_reset_at : null
  const daysLeft = computeBudgetDaysLeft(resetAt, now)
  const tier = computeAigwBudgetTier({ pctRemaining: pctRemaining ?? -1, daysLeft })
  return {
    available: true,
    user_email: typeof ui.user_email === 'string' && ui.user_email ? ui.user_email : null,
    max_budget: maxBudget,
    spend: Math.round(spend * 100000) / 100000,
    remaining,
    pct_remaining: pctRemaining,
    pct_used: pctUsed,
    reset_at: resetAt,
    days_left: daysLeft,
    budget_duration: typeof ui.budget_duration === 'string' && ui.budget_duration ? ui.budget_duration : null,
    tier,
    advice: AIGW_BUDGET_ADVICE[tier] || null,
  }
}

/**
 * Fetch the AIGW /user/info budget endpoint. Uses the well-known meshy-aigw.key
 * (readAigwKey). Never throws — returns { available:false, error, keyPresent }
 * on any failure so the route can 200 with a clear reason. Accepts a fetchImpl
 * injection so unit tests can stub the network without a real gateway.
 */
export async function fetchAigwBudget({ key, home, fetchImpl, now = Date.now() } = {}) {
  const base = getAigwBase({ home })
  const apiKey = (key ?? readAigwKey({ home })).trim()
  if (!apiKey) {
    return { available: false, keyPresent: false, base, error: 'AIGW key not found (~/.config/meshy-aigw.key)' }
  }
  const f = fetchImpl || fetch
  try {
    const res = await f(`${base}/user/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      let body = null
      try { body = await res.json() } catch {}
      const msg = body?.detail || body?.error || `HTTP ${res.status}`
      return { available: false, keyPresent: true, base, error: `AIGW /user/info ${msg}` }
    }
    const data = await res.json()
    return { ...mapAigwBudgetResponse(data, { now }), keyPresent: true, base }
  } catch (err) {
    return { available: false, keyPresent: true, base, error: `AIGW /user/info fetch failed: ${err?.message || err}` }
  }
}

/**
 * Build the AIGW monthly-budget source summary for /api/usage/summary. Probes
 * /user/info and surfaces a monthly window carrying the tier + advice + reset
 * for the AI-readable surface. No fabricated numbers — unavailable is honest.
 */
export async function buildAigwBudgetSourceSummary({ now = Date.now(), fetchImpl } = {}) {
  const budget = await fetchAigwBudget({ fetchImpl, now })
  const base = {
    source: 'aigw-budget', label: 'AIGW 月度额度', kind: 'litellm-budget',
    configDir: null, available: !!budget.available, base: budget.base,
    keyPresent: !!budget.keyPresent,
  }
  if (budget.available) {
    const pctUsed = budget.pct_used
    const sev = pctUsed == null ? null : (pctUsed >= 90 ? 'critical' : pctUsed >= 75 ? 'warning' : 'normal')
    return {
      ...base,
      user_email: budget.user_email,
      max_budget: budget.max_budget,
      spend: budget.spend,
      remaining: budget.remaining,
      pct_remaining: budget.pct_remaining,
      days_left: budget.days_left,
      reset_at: budget.reset_at,
      tier: budget.tier,
      advice: budget.advice,
      windows: [{
        source: 'aigw-budget', label: 'AIGW 月度额度',
        windowType: 'monthly',
        used: budget.spend, limit: budget.max_budget, remaining: budget.remaining,
        utilization: pctUsed, unit: 'usd',
        resetAt: budget.reset_at,
        burnRatePerMin: null, projectedHitAt: null,
        estimated: false, severity: sev, usedTokens: null,
        pctRemaining: budget.pct_remaining, daysLeft: budget.days_left,
        tier: budget.tier, advice: budget.advice,
        note: `AIGW /user/info: 预算 $${budget.max_budget} / 已花 $${budget.spend} / 剩余 $${budget.remaining} (${budget.pct_remaining}%). 重置 ${budget.reset_at || '?'}${budget.days_left != null ? ` (还剩 ~${budget.days_left} 天)` : ''}. 策略档=${budget.tier}`,
      }],
    }
  }
  return {
    ...base,
    windows: [{
      source: 'aigw-budget', label: 'AIGW 月度额度',
      windowType: 'monthly',
      used: null, limit: null, remaining: null, utilization: null, unit: 'usd',
      resetAt: null, burnRatePerMin: null, projectedHitAt: null,
      estimated: false, severity: null, usedTokens: null,
      note: budget.error || 'AIGW /user/info budget unavailable.',
    }],
    error: budget.error,
  }
}

// ── /api/usage/summary entry point ────────────────────────────────────────────

/**
 * Build the three-source usage summary returned by GET /api/usage/summary.
 * Iterates the discovered Claude teams (personal config + ~/.claude + ~/.claude-team*)
 * and adds the AIGW source. Returns:
 *   { generatedAt, schemaVersion, sources: [...], entries: [...] }
 * `entries` is a flat array of the unified per-window schema objects — the
 * AI-readable surface a secretary/agent fetches to read usage + limits and
 * decide degradation routing. `home` is threaded to the AIGW source so it reads
 * the personal config under that home (tests use a fake home); `fetchImpl`
 * lets tests mock the AIGW endpoints hermetically. Never throws; each source
 * degrades independently.
 */
export async function buildUsageSummary({ home, store, now = Date.now(), fetchImpl } = {}) {
  const homeDir = home || homedir()
  const { teams } = listTeams(homeDir, store)
  const sources = []
  // Claude teams: ~/.claude (team1) + ~/.claude-team* + personal.claude.teams.
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
  // AIGW (LiteLLM) — /key/info real spend + /spend/logs/v2 burn + local budgetUsd.
  sources.push(await buildAigwSourceSummary({ now, home: homeDir, fetchImpl }))
  // AIGW monthly budget — /user/info max_budget + spend + reset + tier (MES-13788 延续)
  sources.push(await buildAigwBudgetSourceSummary({ now, fetchImpl }))
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
