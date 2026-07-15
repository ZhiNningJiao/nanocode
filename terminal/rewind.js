/**
 * Rewind plugin data source — MES-14031 S2 (抄 Claude Code checkpointing/rewind).
 *
 * Ports Claude Code desktop's signature safety-net feature to nanocode: every
 * user prompt is a "checkpoint"; the user can rewind the conversation to a
 * prior turn, discarding everything after it — the recovery path when an agent
 * goes down a wrong direction (vs `/clear` which loses all context).
 *
 * This module is PURE (no Express, no DOM): the route handler in routes.js
 * calls it. It never throws to the caller — every failure becomes { error }.
 *
 * Two operations:
 *   buildCheckpoints(jsonlPath)
 *     -> { checkpoints: [{ index, lineStart, lineEnd, timestamp, preview }],
 *          totalLines, totalTurns, sessionId, error? }
 *       A "checkpoint" = one user turn = a real user-prompt row + all following
 *       assistant / tool_result rows up to (but not including) the next real
 *       user-prompt row. `lineStart`/`lineEnd` are 0-based file line indices
 *       (inclusive) so the route can truncate the file at a turn boundary.
 *
 *   rewindConversation({ jsonlPath, toIndex, dryRun })
 *     -> { ok, backupPath, keptLines, droppedLines, toIndex, error? }
 *       Keeps file lines [0 .. checkpoints[toIndex].lineEnd] (turns 0..toIndex
 *       inclusive), drops the rest. BACKS UP the original to
 *       `<jsonl>.rewind-bak.<ts>` before any write (never destroys data). The
 *       write is atomic (tmp + rename) so a crash mid-write cannot truncate the
 *       live transcript. dryRun=true returns the plan without writing.
 *
 * Design notes (防假过 / honesty):
 *   - Read-only listing (buildCheckpoints) never mutates the session file.
 *   - "Restore code" (Claude Code's file-snapshot rewind) is NOT faked here: it
 *     needs per-turn working-tree snapshots (git stash create). That is the
 *     documented next step (REPORT §6). This prototype delivers the
 *     conversation-rewind half — real, safe, and verified — and explicitly does
 *     NOT pretend to restore files.
 *   - The module is agnostic to claude vs codex jsonl shape: it keys off
 *     `type === 'user'` rows with non-empty extracted text (real prompts),
 *     reusing claude-history.js's extractReplayUserText so tool_result user
 *     rows do not create false turn boundaries.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { extractReplayUserText } from './claude-history.js'

const PREVIEW_MAXLEN = 120

/**
 * Extract a single-line preview (<= PREVIEW_MAXLEN chars) from a user row's
 * message. Returns '' for tool_result-only user rows (no real prompt text).
 */
function userPreview(row) {
  const text = extractReplayUserText(row?.message)
  if (!text) return ''
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= PREVIEW_MAXLEN) return flat
  return flat.slice(0, PREVIEW_MAXLEN - 1) + '…'
}

/**
 * Read + parse every non-empty line of a jsonl file into an array of
 * { row, line } where `line` is the 0-based file line index. Unparseable lines
 * are kept as { row: null, line } so line indices stay aligned with the file
 * (truncation must cut at the exact file line, not at the parsed-row index).
 * Returns null when the file is absent / unreadable (never throws).
 */
function readRows(jsonlPath) {
  let content
  try {
    content = readFileSync(jsonlPath, 'utf-8')
  } catch {
    return null
  }
  const lines = content.split('\n')
  // A trailing '\n' produces a final empty element; drop one trailing empty
  // element so line indices match real rows, but remember the file ended with
  // a newline so we can reproduce that on write.
  const hadTrailingNewline = content.endsWith('\n')
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop()
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || !raw.trim()) {
      rows.push({ row: null, line: i, raw: '' })
      continue
    }
    let row = null
    try { row = JSON.parse(raw) } catch { row = null }
    rows.push({ row, line: i, raw })
  }
  return { rows, hadTrailingNewline }
}

/**
 * Group parsed rows into turns. A turn starts at a `type:'user'` row whose
 * extracted prompt text is non-empty (a real user prompt — NOT a tool_result
 * user row). The turn includes that user row + every subsequent row (assistant
 * deltas, tool_use, tool_result user rows) until the next real user-prompt row.
 *
 * Returns an array of { index, lineStart, lineEnd, timestamp, preview } where
 * lineStart/lineEnd are 0-based file line indices (inclusive).
 */
function groupTurns(rows) {
  const turns = []
  let cur = null
  for (const { row, line } of rows) {
    if (!row) {
      // Blank/unparseable line: belongs to the current turn if any (extends
      // lineEnd), otherwise ignored (a leading blank line before turn 0).
      if (cur) cur.lineEnd = line
      continue
    }
    const isUserPrompt = row.type === 'user' && userPreview(row) !== ''
    if (isUserPrompt) {
      // Start a new turn.
      if (cur) turns.push(cur)
      cur = {
        index: turns.length,
        lineStart: line,
        lineEnd: line,
        timestamp: typeof row.timestamp === 'string' ? row.timestamp : '',
        preview: userPreview(row),
      }
    } else if (cur) {
      // Belongs to the current turn (assistant / tool_result / summary row).
      cur.lineEnd = line
    }
    // Rows before the first real user prompt (rare: a leading assistant row)
    // are not part of any turn and are dropped on rewind — same as Claude Code,
    // which keys checkpoints to user prompts.
  }
  if (cur) turns.push(cur)
  return turns
}

/**
 * Build the checkpoint (turn) list for a session jsonl file. Read-only.
 * Returns { checkpoints, totalLines, totalTurns, sessionId, error? }.
 * Never throws.
 */
export function buildCheckpoints(jsonlPath) {
  if (!jsonlPath || !existsSync(jsonlPath)) {
    return { checkpoints: [], totalLines: 0, totalTurns: 0, sessionId: '', error: 'session file not found' }
  }
  const read = readRows(jsonlPath)
  if (!read) return { checkpoints: [], totalLines: 0, totalTurns: 0, sessionId: '', error: 'session file unreadable' }
  const turns = groupTurns(read.rows)
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, '')
  return {
    checkpoints: turns.map((t) => ({
      index: t.index,
      lineStart: t.lineStart,
      lineEnd: t.lineEnd,
      timestamp: t.timestamp,
      preview: t.preview,
    })),
    totalLines: read.rows.length,
    totalTurns: turns.length,
    sessionId,
  }
}

/**
 * Rewind a conversation jsonl to keep turns 0..toIndex (inclusive), dropping
 * everything after. BACKS UP the original file first. Atomic write.
 *
 * Options:
 *   dryRun : if true, return the plan { backupPath, keptLines, droppedLines,
 *            toIndex } WITHOUT writing — used by the route's safe smoke-test
 *            path and by tests.
 *
 * Returns { ok, backupPath, keptLines, droppedLines, toIndex, error? }.
 * Never throws.
 */
export function rewindConversation({ jsonlPath, toIndex, dryRun = false }) {
  if (!jsonlPath || !existsSync(jsonlPath)) {
    return { ok: false, error: 'session file not found' }
  }
  const cp = buildCheckpoints(jsonlPath)
  if (cp.error) return { ok: false, error: cp.error }
  if (!cp.totalTurns) return { ok: false, error: 'no user turns in this session' }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= cp.totalTurns) {
    return { ok: false, error: `toIndex out of range (0..${cp.totalTurns - 1})` }
  }
  const last = cp.checkpoints[cp.totalTurns - 1]
  if (toIndex === cp.totalTurns - 1) {
    return { ok: false, error: 'already at the last turn — nothing to rewind' }
  }
  const keep = cp.checkpoints[toIndex]
  // Keep file lines [0 .. keep.lineEnd] inclusive => keep (lineEnd + 1) lines.
  const keptLines = keep.lineEnd + 1
  const droppedLines = cp.totalLines - keptLines

  const backupPath = `${jsonlPath}.rewind-bak.${Date.now()}`
  if (dryRun) {
    return { ok: true, dryRun: true, backupPath, keptLines, droppedLines, toIndex }
  }

  // Read the exact lines to keep (preserve raw bytes — do not re-serialize, so
  // untouched rows stay byte-identical: no risk of altering history above the
  // cut, and a no-op rewind of the kept prefix is byte-identical to original).
  let content
  try {
    content = readFileSync(jsonlPath, 'utf-8')
  } catch (e) {
    return { ok: false, error: `read failed: ${e?.message || e}` }
  }
  const lines = content.split('\n')
  const hadTrailingNewline = content.endsWith('\n')
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop()
  const keepSlice = lines.slice(0, keptLines)
  const newContent = keepSlice.join('\n') + '\n'

  // Backup the ORIGINAL (before any write) — never destroy data.
  try {
    copyFileSync(jsonlPath, backupPath)
  } catch (e) {
    return { ok: false, error: `backup failed: ${e?.message || e}` }
  }
  // Atomic write: tmp + rename (a crash leaves the original intact).
  const tmp = `${jsonlPath}.rewind-tmp.${Date.now()}`
  try {
    writeFileSync(tmp, newContent)
    renameSync(tmp, jsonlPath)
  } catch (e) {
    // Best-effort cleanup of the tmp file on failure; the backup + original
    // are still intact (rename had not completed).
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
    return { ok: false, error: `write failed: ${e?.message || e}` }
  }
  return { ok: true, backupPath, keptLines, droppedLines, toIndex }
}

/** Stat helper for the route: mtime ms of a jsonl, or null. */
export function jsonlMtimeMs(jsonlPath) {
  try { return statSync(jsonlPath).mtimeMs } catch { return null }
}
