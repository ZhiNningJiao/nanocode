/**
 * Tiny field coercers shared by the Command Center mappers
 * (command-center.js, command-center-waiting.js, command-center-quota.js).
 * Untrusted JSON in, typed value or null out — never a guess.
 */

export function str(v) { return typeof v === 'string' && v ? v : null }
export function arr(v) { return Array.isArray(v) ? v : [] }
export function validIso(v) { return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null }

/** Trimmed string capped at `max` chars (with an ellipsis), or null. */
export function clip(v, max) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max)}…` : s
}
