import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extractSummary, relTimeFromMtime, cwdFromJsonl } from './recent-agents.js'
import { effectiveClaudeConfigDir, claudeProjectsDir, resolveClaudeConfigDirForTab, resolveClaudeCwdForTab, listTeams } from './usage.js'

export function cwdToClaudeProjectDir(home, cwd) {
  // Backward-compatible: defaults to ~/.claude. Kept for existing tests/callers
  // that don't know about the Team switch (CLAUDE_CONFIG_DIR) setting.
  return claudeProjectsDir(join(home, '.claude'), cwd)
}

function hashReplayText(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

export function extractReplayUserText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

export function buildUserReplayId(text, userTextCounts) {
  if (!text) return null
  const next = (userTextCounts.get(text) ?? 0) + 1
  userTextCounts.set(text, next)
  return `user:${hashReplayText(text)}:${next}`
}

function buildAssistantReplayId(row) {
  if (row.uuid) return row.uuid
  if (!row.requestId) return null
  const firstType = row.message?.content?.[0]?.type || 'unknown'
  return `assistant:${row.requestId}:${firstType}`
}

export function buildReplaySeed(events) {
  const userTextCounts = new Map()
  for (const event of events) {
    if (event.type !== 'user') continue
    const text = extractReplayUserText(event.message)
    if (!text) continue
    userTextCounts.set(text, (userTextCounts.get(text) ?? 0) + 1)
  }
  // hasHistory=true signals to attachClaudeSession that this tab is restoring
  // an existing conversation — the first user turn should use --resume (not --session-id).
  const hasHistory = events.length > 0
  return { userTextCounts, hasHistory }
}

/**
 * Parse a jsonl session file into renderer-compatible events.
 * Returns an array of {type, message, uuid, parent_tool_use_id} objects.
 *
 * Strategy for multiple assistant rows per turn:
 * Claude CLI streams assistant messages incrementally and writes each delta
 * as a new jsonl row. The final row for a given requestId has the complete
 * content. We collect all assistant rows, then for each requestId keep only
 * the last (most complete) one. This avoids rendering duplicate/partial text.
 */
export function parseJsonlHistory(jsonlPath) {
  let content
  try {
    content = readFileSync(jsonlPath, 'utf-8')
  } catch {
    return []
  }

  const lines = content.split('\n').filter((l) => l.trim())
  const events = []
  const replayState = { userTextCounts: new Map() }

  const rawRows = []
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    rawRows.push(row)
  }

  // N52 fix: de-duplicate assistant rows correctly for Claude CLI stream-json format.
  //
  // BACKGROUND: Claude CLI emits MULTIPLE separate assistant rows per turn (one per
  // content block: thinking -> text -> tool_use -> text). All rows within the same turn
  // share the SAME requestId. The old logic kept only the LAST row per requestId
  // (treating it like a progressive streaming case where later rows supersede earlier
  // ones). But in practice, each row carries a DISTINCT content block type - keeping
  // only the last drops intermediate content (e.g. the leading "Hello!" text block
  // before a tool_use, causing N52: text1 visible during live streaming but missing
  // on history replay).
  //
  // NEW STRATEGY: for rows with the same requestId, group them and deduplicate WITHIN
  // each content-type. If two rows share both requestId AND content block type, keep
  // only the last (that is the true progressive-streaming case - partial -> complete
  // for the same block). If they have different content types, keep both in order.
  //
  // Dedup key: requestId + first-content-block-type (e.g. 'req_xxx:text', 'req_xxx:tool_use').
  // Rows without requestId are never deduplicated (kept as-is).
  //
  // Example for a turn with requestId='req_abc':
  //   row1: {requestId:'req_abc', content:[{type:'thinking'}]}  -> key 'req_abc:thinking'
  //   row2: {requestId:'req_abc', content:[{type:'text', text:'Hi!'}]}  -> key 'req_abc:text'
  //   row3: {requestId:'req_abc', content:[{type:'tool_use'}]}  -> key 'req_abc:tool_use'
  //   -> all THREE are kept (different content types)
  //
  // Example for progressive streaming (partial -> complete same block):
  //   row1: {requestId:'req_abc', content:[{type:'text', text:'Hi'}]}  -> key 'req_abc:text'
  //   row2: {requestId:'req_abc', content:[{type:'text', text:'Hi!'}]}  -> key 'req_abc:text'
  //   -> only row2 kept (same key, later row wins)
  const assistantByKey = new Map()
  for (const row of rawRows) {
    if (row.type !== 'assistant') continue
    const rid = row.requestId
    if (!rid) continue
    const msg = row.message
    if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) continue
    const firstType = msg.content[0]?.type || 'unknown'
    const key = `${rid}:${firstType}`
    assistantByKey.set(key, row)
  }

  const emittedKeys = new Set()
  for (const row of rawRows) {
    if (row.type === 'user') {
      const msg = row.message
      if (!msg || !msg.content) continue
      events.push({
        type: 'user',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildUserReplayId(extractReplayUserText(msg), replayState.userTextCounts),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    } else if (row.type === 'assistant') {
      const msg = row.message
      if (!msg || !Array.isArray(msg.content)) continue
      const rid = row.requestId
      if (rid) {
        const firstType = msg.content[0]?.type || 'unknown'
        const key = `${rid}:${firstType}`
        if (assistantByKey.get(key) !== row) continue
        if (emittedKeys.has(key)) continue
        emittedKeys.add(key)
      }
      events.push({
        type: 'assistant',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildAssistantReplayId(row),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    }
  }

  return events
}

/**
 * Parse the TAIL of a large jsonl file — reads only the last TAIL_BYTES bytes
 * so we don't load the entire file into memory for sessions with 10K+ events.
 * We still need to decode enough events for INITIAL_HISTORY_BLOCKS (200) in
 * the front-end plus some margin for dedup.  With typical event sizes of a
 * few KB each, 4 MB of tail covers 500–2000 events — enough for any scroll depth.
 *
 * Returns the same format as parseJsonlHistory but only includes events from the
 * tail window.  For files smaller than TAIL_BYTES it falls back to the full read.
 */
const TAIL_BYTES = 4 * 1024 * 1024  // 4 MB

/**
 * Internal helper: read TAIL_BYTES ending at `endOffset` (exclusive) from a file.
 * Returns parsed raw rows array, or null on error.
 * `endOffset` defaults to file end if not provided.
 */
function _readChunkBefore(jsonlPath, endOffset) {
  let fileSize = 0
  try { fileSize = statSync(jsonlPath).size } catch { return null }

  const safeEnd = Math.min(endOffset ?? fileSize, fileSize)
  if (safeEnd <= 0) return []

  const readStart = Math.max(0, safeEnd - TAIL_BYTES)
  const readLen = safeEnd - readStart

  let chunk
  try {
    const fd = openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(readLen)
    let bytesRead = 0
    try {
      bytesRead = readSync(fd, buf, 0, readLen, readStart)
    } finally {
      closeSync(fd)
    }
    chunk = buf.slice(0, bytesRead).toString('utf-8')
  } catch {
    return null
  }

  // First line may be partial if we jumped mid-line; drop it.
  if (readStart > 0) {
    const firstNewline = chunk.indexOf('\n')
    chunk = firstNewline >= 0 ? chunk.slice(firstNewline + 1) : ''
  }

  const rawRows = []
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    rawRows.push(row)
  }
  return rawRows
}

/**
 * Convert raw rows to events using the same dedup logic as parseJsonlHistory.
 */
function _rawRowsToEvents(rawRows) {
  const replayState = { userTextCounts: new Map() }
  const events = []

  const assistantByKey = new Map()
  for (const row of rawRows) {
    if (row.type !== 'assistant') continue
    const rid = row.requestId
    if (!rid) continue
    const msg = row.message
    if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) continue
    const firstType = msg.content[0]?.type || 'unknown'
    const key = `${rid}:${firstType}`
    assistantByKey.set(key, row)
  }

  const emittedKeys = new Set()
  for (const row of rawRows) {
    if (row.type === 'user') {
      const msg = row.message
      if (!msg || !msg.content) continue
      events.push({
        type: 'user',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildUserReplayId(extractReplayUserText(msg), replayState.userTextCounts),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    } else if (row.type === 'assistant') {
      const msg = row.message
      if (!msg || !Array.isArray(msg.content)) continue
      const rid = row.requestId
      if (rid) {
        const firstType = msg.content[0]?.type || 'unknown'
        const key = `${rid}:${firstType}`
        if (assistantByKey.get(key) !== row) continue
        if (emittedKeys.has(key)) continue
        emittedKeys.add(key)
      }
      events.push({
        type: 'assistant',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildAssistantReplayId(row),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    }
  }
  return events
}

export function parseJsonlHistoryTail(jsonlPath) {
  let fileSize = 0
  try { fileSize = statSync(jsonlPath).size } catch { return [] }

  // Small file: use the full parser (no point seeking)
  if (fileSize <= TAIL_BYTES) return parseJsonlHistory(jsonlPath)

  const rawRows = _readChunkBefore(jsonlPath, fileSize)
  if (!rawRows) return []
  return _rawRowsToEvents(rawRows)
}

/**
 * Parse events BEFORE a given event UUID in a large jsonl.
 * Strategy:
 *   1. Scan the full file to find the byte offset of the line containing `beforeUuid`.
 *   2. Read TAIL_BYTES ending at that offset.
 *   3. Parse and return events; include hasMore=true if there are bytes before the window.
 *
 * Returns { events, hasMore, firstUuid } where firstUuid is the uuid of the oldest
 * returned event (for the next pagination request).
 */
export function parseJsonlHistoryBefore(jsonlPath, beforeUuid) {
  let fileSize = 0
  try { fileSize = statSync(jsonlPath).size } catch { return { events: [], hasMore: false } }

  // We need to find the byte offset of the line with beforeUuid.
  // For a 73MB file, scanning line by line with node's fs is too slow.
  // Strategy: read in TAIL_BYTES chunks from the end until we find it,
  // or fall back to a full scan if the uuid is very old.
  // We track the byte offset by scanning the file in reverse chunks.

  let targetEndOffset = null  // byte offset just before the line containing beforeUuid

  // Walk the file in TAIL_BYTES chunks from the end
  let scanEnd = fileSize
  let found = false
  const MAX_SCAN_CHUNKS = 20  // scan at most 80 MB backward — enough for any session
  for (let attempt = 0; attempt < MAX_SCAN_CHUNKS && !found; attempt++) {
    const scanStart = Math.max(0, scanEnd - TAIL_BYTES)
    let chunkBuf
    try {
      const fd = openSync(jsonlPath, 'r')
      const buf = Buffer.allocUnsafe(scanEnd - scanStart)
      let br = 0
      try { br = readSync(fd, buf, 0, buf.length, scanStart) } finally { closeSync(fd) }
      chunkBuf = buf.slice(0, br).toString('utf-8')
    } catch { break }

    // Drop partial first line if we didn't start at position 0
    let chunkLines
    let lineStartOffset = scanStart  // byte offset of chunk start
    if (scanStart > 0) {
      const fi = chunkBuf.indexOf('\n')
      if (fi >= 0) {
        lineStartOffset = scanStart + fi + 1
        chunkBuf = chunkBuf.slice(fi + 1)
      }
    }

    // Split into lines and track byte offsets
    // (approximate: assume utf-8 byte length equals char count for ASCII lines)
    const rawLines = chunkBuf.split('\n')
    let bytePos = lineStartOffset
    const lineInfos = []
    for (const rawLine of rawLines) {
      const lineByteLen = Buffer.byteLength(rawLine, 'utf-8') + 1  // +1 for \n
      if (rawLine.trim()) {
        lineInfos.push({ line: rawLine, startOffset: bytePos })
      }
      bytePos += lineByteLen
    }

    // Search for beforeUuid (iterate backwards within chunk to find the line)
    for (let li = lineInfos.length - 1; li >= 0; li--) {
      const { line, startOffset } = lineInfos[li]
      if (!line.includes(beforeUuid)) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.uuid === beforeUuid) {
        targetEndOffset = startOffset  // read events ending just before this line
        found = true
        break
      }
    }

    if (scanStart === 0) break  // scanned entire file
    scanEnd = scanStart + 1  // overlap by 1 byte to avoid missing lines at chunk boundary
  }

  if (!found || targetEndOffset === null) {
    // UUID not found — return empty; front-end will hide the button
    return { events: [], hasMore: false }
  }

  if (targetEndOffset === 0) {
    // The found event is the very first line — nothing before it
    return { events: [], hasMore: false }
  }

  const hasMore = targetEndOffset > TAIL_BYTES
  const rawRows = _readChunkBefore(jsonlPath, targetEndOffset)
  if (!rawRows) return { events: [], hasMore: false }

  const events = _rawRowsToEvents(rawRows)
  const firstUuid = events.length > 0 ? (events[0].uuid || null) : null

  return { events, hasMore, firstUuid }
}

/**
 * Find the most-recently-modified .jsonl in a project directory.
 * Returns { path, sessionId } or null.
 */
export function findNewestJsonl(projectDir) {
  if (!existsSync(projectDir)) return null
  let best = null
  let bestMtime = 0
  try {
    const entries = readdirSync(projectDir)
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const fullPath = join(projectDir, entry)
      try {
        const st = statSync(fullPath)
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs
          best = { path: fullPath, sessionId: entry.replace(/\.jsonl$/, '') }
        }
      } catch {}
    }
  } catch {}
  return best
}

/**
 * Count user-message rows in a jsonl by scanning for the `"type":"user"` marker.
 * Uses a buffered byte scan with a small overlap tail so a marker straddling a
 * chunk boundary is not missed. Reads at most `capBytes` (default 16 MB) so a
 * pathological 70 MB+ file does not block the picker; for files larger than the
 * cap the count is approximate (labelled so by the caller via byteSize).
 */
const USER_MSG_NEEDLE = Buffer.from('"type":"user"')
const COUNT_CAP_BYTES = 16 * 1024 * 1024

export function countUserMessages(jsonlPath, capBytes = COUNT_CAP_BYTES) {
  let fd
  try {
    fd = openSync(jsonlPath, 'r')
  } catch {
    return 0
  }
  let size = 0
  try { size = statSync(jsonlPath).size } catch {}
  const readCap = Math.min(size, capBytes)
  const chunkBuf = Buffer.allocUnsafe(64 * 1024)
  let pos = 0
  let count = 0
  // Tail keeps needle.length-1 bytes so a marker straddling a chunk boundary is
  // still found, but a marker can never live entirely in the tail (which would
  // cause a double count on the next iteration).
  let tail = Buffer.alloc(0)
  try {
    while (pos < readCap) {
      const n = readSync(fd, chunkBuf, 0, Math.min(chunkBuf.length, readCap - pos), pos)
      if (n <= 0) break
      const chunk = chunkBuf.subarray(0, n)
      const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk
      let idx = combined.indexOf(USER_MSG_NEEDLE)
      while (idx !== -1) {
        count++
        idx = combined.indexOf(USER_MSG_NEEDLE, idx + USER_MSG_NEEDLE.length)
      }
      const keep = USER_MSG_NEEDLE.length - 1
      tail = combined.length > keep ? combined.subarray(combined.length - keep) : combined
      pos += n
    }
  } catch {} finally {
    try { closeSync(fd) } catch {}
  }
  return count
}

/**
 * List the most recent "longer" conversations for a project's cwd.
 *
 * Used by the Claude Code tab picker (需求3 Auto Resume): when the user opens a
 * new Claude Code tab we show up to `limit` recent conversations sorted by length
 * (byte size = 字节数, an explicit sort criterion in the requirement) so they can
 * pick one to 继续 (resume) or start a 开启新对话 (fresh). Each entry carries a
 * summary (first user message), an approximate user-message count, byte size,
 * mtime and a relative time string — everything the picker needs without a second
 * round-trip.
 *
 * Returns an array of { sessionId, summary, messageCount, byteSize, mtime, relTime }.
 */
export function scanRecentConversations(home, cwd, limit = 5, now = Date.now(), configDir = null) {
  const projectDir = claudeProjectsDir(configDir || join(home, '.claude'), cwd)
  if (!existsSync(projectDir)) return []
  let files
  try { files = readdirSync(projectDir) } catch { return [] }
  const entries = []
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    const fullPath = join(projectDir, f)
    try {
      const st = statSync(fullPath)
      // Skip empty/trivial files (a brand-new session with no turns yet).
      if (st.size < 200) continue
      entries.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        fullPath,
        mtimeMs: st.mtimeMs,
        byteSize: st.size,
      })
    } catch {}
  }
  // 需求3 紧急修正: "最近的 5 条较长对话" — sort by most-recent activity (mtime)
  // desc as the PRIMARY key, with byte size desc as a secondary tiebreaker (the
  // "较长" criterion among equally-recent files). The old byte-size-desc-first
  // sort let big OLD sessions permanently suppress recent small ones (master saw
  // only stale conversations on 9475). The < 200-byte skip above already drops
  // fragmentary 1-message sessions, so "较长" survives as the secondary key.
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.byteSize - a.byteSize)
  const top = entries.slice(0, limit)
  return top.map((e) => ({
    sessionId: e.sessionId,
    summary: extractSummary(e.fullPath),
    messageCount: countUserMessages(e.fullPath),
    byteSize: e.byteSize,
    mtime: new Date(e.mtimeMs).toISOString(),
    relTime: relTimeFromMtime(e.mtimeMs, now),
  }))
}

/**
 * Scan a single (configDir, cwd) project-slug dir for jsonl conversations.
 * Internal helper used by scanRecentConversationsMulti so each (team, cwd)
 * pair is scanned exactly once with the same byte-size sort criteria.
 *
 * Returns an array of raw entries (with fullPath/mtimeMs/byteSize/sessionId)
 * enriched with the team + source-cwd metadata the multi-team aggregator
 * needs. Files < 200 bytes (brand-new sessions) are skipped.
 */
function _scanProjectDirEntries(projectDir, teamMeta, sourceCwd, activeConfigDir) {
  if (!existsSync(projectDir)) return []
  let files
  try { files = readdirSync(projectDir) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    const fullPath = join(projectDir, f)
    try {
      const st = statSync(fullPath)
      if (st.size < 200) continue
      out.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        fullPath,
        mtimeMs: st.mtimeMs,
        byteSize: st.size,
        teamId: teamMeta.id,
        teamName: teamMeta.name,
        configDir: teamMeta.path,
        sourceCwd,
        isCrossTeam: teamMeta.path !== activeConfigDir,
      })
    } catch {}
  }
  return out
}

/**
 * List the most recent "longer" conversations for the Claude Code tab picker,
 * aggregated across ALL known teams (需求5 跨 team 会话延续).
 *
 * Aggregation dimensions:
 *   1. Team  — every known CLAUDE_CONFIG_DIR (~/.claude plus ~/.claude-team*)
 *              is scanned, so a session from team2 is visible while the active
 *              team is team1. Each entry is labelled with its source team.
 *   2. cwd   — both the current project's cwd AND the home dir (cwd=~) are
 *              scanned, so home/secretary sessions are listable from any
 *              project tab (主人常在 home 跑秘书会话). Home entries are
 *              flagged `isHome=true`.
 *
 * Each entry carries the fields scanRecentConversations returns plus:
 *   teamId, teamName, configDir, cwd (the session's real cwd from the jsonl),
 *   isCrossTeam, isHome — everything the picker needs to resume the session
 *   with the owning team's CLAUDE_CONFIG_DIR and the session's original cwd.
 *
 * Returns an array sorted by most-recent mtime desc (the "最近的" criterion,
 * 需求3 紧急修正 — recent sessions always surface above big old ones), with
 * byte size desc as a secondary tiebreaker ("较长"), capped at `limit`.
 */
export function scanRecentConversationsMulti(home, cwd, store, limit = 5, now = Date.now(), source = 'all') {
  const { teams } = listTeams(home, store)
  const activeConfigDir = effectiveClaudeConfigDir(store, home)
  // 需求5.3: allow switching the project-directory source ("允许切换项目目录来源")
  // so cross-team PROJECT sessions can surface without being drowned by the
  // (often huge) home/secretary sessions. 'project' = current project slug only
  // (all teams); 'home' = home slug only (all teams); 'all' = both (default —
  // home stays listable from any project tab, the 需求5.3 "至少" minimum).
  let cwdSources
  if (source === 'project') cwdSources = [cwd]
  else if (source === 'home') cwdSources = [home]
  else cwdSources = cwd === home ? [cwd] : [cwd, home]
  const seen = new Set()
  const entries = []
  for (const team of teams) {
    if (!team.exists) continue
    const teamMeta = { id: team.id, name: team.name, path: team.path }
    for (const sourceCwd of cwdSources) {
      const projectDir = claudeProjectsDir(team.path, sourceCwd)
      const found = _scanProjectDirEntries(projectDir, teamMeta, sourceCwd, activeConfigDir)
      for (const e of found) {
        if (seen.has(e.fullPath)) continue
        seen.add(e.fullPath)
        entries.push(e)
      }
    }
  }
  // 需求3 紧急修正: mtime desc PRIMARY (最近的对话优先), byte size desc as a
  // secondary tiebreaker (较长). The old byte-size-desc-first sort let big old
  // sessions permanently suppress recent small ones — master saw only stale
  // conversations on 9475.
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.byteSize - a.byteSize)
  const top = entries.slice(0, limit)
  return top.map((e) => ({
    sessionId: e.sessionId,
    summary: extractSummary(e.fullPath),
    messageCount: countUserMessages(e.fullPath),
    byteSize: e.byteSize,
    mtime: new Date(e.mtimeMs).toISOString(),
    relTime: relTimeFromMtime(e.mtimeMs, now),
    teamId: e.teamId,
    teamName: e.teamName,
    configDir: e.configDir,
    // The session's real cwd (read from the jsonl) — used as the spawn cwd on
    // resume so claude --resume finds the jsonl in the matching project slug.
    cwd: cwdFromJsonl(e.fullPath) || e.sourceCwd,
    isCrossTeam: e.isCrossTeam,
    isHome: e.sourceCwd === home && e.sourceCwd !== cwd,
  }))
}

/**
 * Resolve the jsonl file and sessionId for a claude tab by directory.
 *
 * Reads from the same source as block-mode history replay
 * (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`). When the tab has
 * no explicit sessionId or its jsonl is missing, it falls back to the most
 * recently modified jsonl in the project directory. The active-session
 * guard (main session / recent write / held file) prevents resuming a
 * session that is currently active in another Claude process.
 *
 * Returns:
 *   resolvedPath      - absolute path to the jsonl file, or null if none found
 *   resolvedSessionId - the sessionId to use for this tab
 *   fallback          - true if we fell back to a newer jsonl than tab metadata
 *   skipped           - true if active-session guard forced a fresh UUID
 *   freshSessionId    - the fresh UUID assigned when skipped, otherwise null
 */
export function resolveSessionJsonl({ store, home, project, tab }) {
  // 需求5: a cross-team/cross-cwd tab stores its own configDir + session cwd so
  // the jsonl is located in the session's owning team + original project slug,
  // not the global Team setting / the current project cwd. Falls back to the
  // global setting (需求1) and project.cwd for normal tabs.
  const configDir = resolveClaudeConfigDirForTab(tab, store, home)
  const sessionCwd = resolveClaudeCwdForTab(tab, project)
  const projectDir = claudeProjectsDir(configDir, sessionCwd)
  const sessionId = tab?.claudeSessionId || null
  const jsonlPath = sessionId ? join(projectDir, `${sessionId}.jsonl`) : null

  let resolvedPath = null
  let resolvedSessionId = sessionId
  let fallback = false
  let skipped = false
  let freshSessionId = null

  if (jsonlPath && existsSync(jsonlPath)) {
    resolvedPath = jsonlPath
  } else {
    // CASE B: No explicit sessionId or jsonl file missing — fall back to
    // newest jsonl in the project dir (auto-resume behaviour).
    // The active-session guard applies HERE to the fallback path only, because
    // this path would otherwise silently --resume the main session on the first
    // user turn, causing a lock conflict.
    // EXCEPTION: tab.skipAutoResume is set when the user explicitly chose
    // "开启新对话" (start a fresh conversation) from the Claude Code tab picker.
    // In that case we must NOT fall back to the newest jsonl — start fresh.
    const autoResumeSetting = store.getSetting('claude_autoresume')
    const autoResumeEnabled = autoResumeSetting !== '0'
    if (autoResumeEnabled && !tab?.skipAutoResume) {
      const newest = findNewestJsonl(projectDir)
      if (newest) {
        const mainSessionId = process.env.CLAUDE_CODE_SESSION_ID
        const isMainSession = mainSessionId && newest.sessionId === mainSessionId
        const ACTIVE_THRESHOLD_MS = 30_000
        let isRecentlyWritten = false
        try {
          const st = statSync(newest.path)
          isRecentlyWritten = (Date.now() - st.mtimeMs) < ACTIVE_THRESHOLD_MS
        } catch {}
        let isFileHeld = false
        if (!isMainSession && !isRecentlyWritten) {
          try {
            const r = spawnSync('lsof', ['-t', newest.path], { encoding: 'utf8', timeout: 1000 })
            isFileHeld = r.status === 0 && r.stdout.trim().length > 0
          } catch {}
        }
        if (isMainSession || isRecentlyWritten || isFileHeld) {
          skipped = true
          freshSessionId = randomUUID()
          resolvedSessionId = freshSessionId
        } else {
          resolvedPath = newest.path
          resolvedSessionId = newest.sessionId
          fallback = true
        }
      }
    }
  }

  return { resolvedPath, resolvedSessionId, fallback, skipped, freshSessionId }
}

export function createClaudeHistoryService({ store, home, recentAgents, sessionController }) {
  function syncResolvedSession(projectId, tabId, sessionId) {
    if (store.updateTabMetadata) {
      store.updateTabMetadata(projectId, tabId, { claudeSessionId: sessionId })
    }
    sessionController.setClaudeSessionId(projectId, tabId, sessionId, { resetTurnCount: true })
  }

  function findMostRecentClaudeTab(project) {
    const tabs = store.listTabs(project.id).filter((t) => t.type === 'claude')
    if (!tabs.length) return null

    let bestTabId = null
    let bestMtime = 0

    for (const tab of tabs) {
      if (!tab.claudeSessionId) continue
      // 需求5: each claude tab may carry its own configDir + session cwd
      // (cross-team / cross-cwd resume). Look up the jsonl in the tab's own
      // team/project-slug dir rather than a single global config dir.
      const configDir = resolveClaudeConfigDirForTab(tab, store, home)
      const sessionCwd = resolveClaudeCwdForTab(tab, project)
      const projectDir = claudeProjectsDir(configDir, sessionCwd)
      const jsonlPath = join(projectDir, `${tab.claudeSessionId}.jsonl`)
      try {
        if (existsSync(jsonlPath)) {
          const st = statSync(jsonlPath)
          if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs
            bestTabId = tab.id
          }
        }
      } catch {}
    }

    if (!bestTabId && tabs.length > 0) bestTabId = tabs[0].id
    return bestTabId
  }

  function handleHistory(req, res) {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab || tab.type !== 'claude') {
      return res.status(404).json({ error: 'claude tab not found' })
    }

    // CASE A: Tab has an explicit claudeSessionId and the jsonl file exists.
    // Always read it for display — reading a file never causes lock conflicts.
    // The guard preventing --resume on the active session lives in attachClaudeSession
    // (claude-session-controller.js), not here.
    //
    // Historical note: commit 989f0ba added an active-session-guard here that
    // blocked reading when sessionId === CLAUDE_CODE_SESSION_ID.  This was too
    // aggressive: users clicking "Recent Agents" to view their active session
    // saw "[Restored 1 event(s)]" instead of the full history because the guard
    // fired and the fallback assigned a fresh UUID instead of reading the jsonl.
    const resolution = resolveSessionJsonl({ store, home, project, tab })
    let { resolvedPath, resolvedSessionId, fallback } = resolution

    if (resolution.skipped) {
      console.log(
        `[history:fallback-skipped] tab=${req.params.tabId} newest jsonl is active - starting fresh`
      )
      if (store.updateTabMetadata) {
        store.updateTabMetadata(req.params.id, req.params.tabId, { claudeSessionId: resolution.freshSessionId })
      }
      sessionController.setClaudeSessionId(req.params.id, req.params.tabId, resolution.freshSessionId, { resetTurnCount: true })
      console.log(
        `[history:fallback-skipped] tab=${req.params.tabId} assigned fresh sessionId=${resolution.freshSessionId}`
      )
    } else if (resolvedPath && resolvedSessionId !== tab.claudeSessionId) {
      syncResolvedSession(req.params.id, req.params.tabId, resolvedSessionId)
      console.log(`[history:fallback] tab=${req.params.tabId} using newest jsonl: ${resolvedSessionId}`)
    } else if (!resolvedPath) {
      console.log(`[history:fallback-skipped] tab=${req.params.tabId} auto-resume disabled or no jsonl, returning empty history`)
    }

    if (!resolvedPath) {
      sessionController.primeReplayHistory(req.params.id, req.params.tabId, [])
      recentAgents.primeRecentAgentsCache()
      return res.json({ events: [], sessionId: resolvedSessionId, fallback })
    }

    // ── Pagination: ?before=<uuid> fetches events older than the given uuid ──
    const beforeUuid = typeof req.query.before === 'string' ? req.query.before.trim() : null
    if (beforeUuid) {
      // Load earlier page — do NOT update primeReplayHistory (that's for initial load only)
      const { events, hasMore, firstUuid } = parseJsonlHistoryBefore(resolvedPath, beforeUuid)
      console.log(`[history:before] tab=${req.params.tabId} before=${beforeUuid} events=${events.length} hasMore=${hasMore}`)
      return res.json({ events, hasMore, firstUuid, sessionId: resolvedSessionId })
    }

    // Use tail-reader for large files to avoid loading the entire jsonl into memory.
    // parseJsonlHistoryTail reads only the last 4 MB (≈500-2000 events) which is
    // more than enough for the front-end's INITIAL_HISTORY_BLOCKS (200) + lazy pages.
    const events = parseJsonlHistoryTail(resolvedPath)
    // Determine if there's more history before the tail window
    let fileSize = 0
    try { fileSize = statSync(resolvedPath).size } catch {}
    const hasMore = fileSize > TAIL_BYTES
    const firstUuid = events.length > 0 ? (events[0].uuid || null) : null

    sessionController.primeReplayHistory(req.params.id, req.params.tabId, events)
    recentAgents.primeRecentAgentsCache()
    console.log(`[history] tab=${req.params.tabId} sessionId=${resolvedSessionId} events=${events.length} hasMore=${hasMore} fallback=${fallback}`)
    res.json({ events, hasMore, firstUuid, sessionId: resolvedSessionId, fallback })
  }

  return {
    cwdToClaudeProjectDir: (cwd) => claudeProjectsDir(effectiveClaudeConfigDir(store, home), cwd),
    findMostRecentClaudeTab,
    handleHistory,
    // 需求5: aggregate across all known teams + the home cwd so the picker can
    // list & resume cross-team / cross-cwd (home) conversations. 需求5.3: `source`
    // switches the project-directory source (project/home/all).
    recentConversations: (cwd, limit, source) => scanRecentConversationsMulti(home, cwd, store, limit, Date.now(), source),
  }
}
