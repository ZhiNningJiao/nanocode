/**
 * The small naming rules every session listing shares — one copy each.
 *
 * Before: the cwd-from-slug rule lived in three files (sessions-browser,
 * recent-agents, usage), the relative-time label in two (recent-agents,
 * opencode-sessions), and the "is this a system wrapper, not the human
 * prompt" check in two that had already drifted apart (3 prefixes / no trim in
 * sessions-browser vs 6 prefixes / trimStart in codex-history) — so the same
 * session got different titles in different lists.
 */

/**
 * Claude Code project dir slug → cwd: every '/' (incl. the leading one) became
 * '-'. Lossy when a path segment contains '-' — DISPLAY ONLY; file operations
 * use the exact slug, never the decoded cwd.
 */
export function claudeProjectSlugToCwd(slug) {
  if (!slug) return ''
  return String(slug).replace(/-/g, '/')
}

/** mtime → "just now" / "5m ago" / "3h ago" / "2d ago" ('' when not a time). */
export function relTimeFromMtime(mtimeMs, nowMs) {
  const diff = nowMs - mtimeMs
  if (!Number.isFinite(diff)) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const WRAPPER_PREFIXES = [
  '<environment_context>', '<permissions', '<system_',
  '<recommended_plugins>', '<INSTRUCTIONS', '<user_instructions',
]

/** A CLI-injected wrapper message (context / permissions / instructions), not the human prompt. */
export function isSystemWrapper(text) {
  if (typeof text !== 'string') return true
  const t = text.trimStart()
  return WRAPPER_PREFIXES.some((p) => t.startsWith(p))
}
