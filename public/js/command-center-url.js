/**
 * Link-safety filter for the Command Center — the ONE copy, used by the
 * server mappers (server/command-center*.js) and the browser panels alike.
 *
 * Links shown in the panels (PR / board / tracker / owner-pending) come from
 * free text other programs wrote (car reports, trace metadata, a hand-kept
 * JSON file). HTML-escaping alone does not stop `javascript:` / `data:` URLs
 * from running when clicked, so only absolute http(s) URLs become links;
 * anything else is dropped (server) or shown as plain text (browser).
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** → normalized absolute http(s) URL string, or null. */
export function safeHttpUrl(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  let u
  try { u = new URL(s) } catch { return null } // relative / garbage
  return ALLOWED_PROTOCOLS.has(u.protocol) ? u.href : null
}
