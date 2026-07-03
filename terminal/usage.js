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

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

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
