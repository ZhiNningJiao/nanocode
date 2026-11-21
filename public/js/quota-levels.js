/**
 * The one yellow / red line for every quota number in Nanocode — the cockpit
 * quota block + header chip, the usage panel, the AIGW monthly card and the
 * AI-readable /api/usage/summary `severity` all use these. (Before: the
 * cockpit said 80 / 95, the usage panel 75 / 90 — the same 78% was yellow in
 * one place and plain in the other.) Shared by server (terminal/usage.js) and
 * browser.
 */
export const QUOTA_WARN_PCT = 75
export const QUOTA_CRIT_PCT = 90

/** % used → 'critical' | 'warning' | 'normal' (null when not a number). */
export function quotaSeverity(pct) {
  const u = Number(pct)
  if (pct == null || !Number.isFinite(u)) return null
  if (u >= QUOTA_CRIT_PCT) return 'critical'
  if (u >= QUOTA_WARN_PCT) return 'warning'
  return 'normal'
}
