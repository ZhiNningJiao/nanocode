/**
 * Public-repo hygiene (owner 2026-11-22 point 11): patterns that must never
 * appear in a tracked file's content. Internal deployment addresses, personal
 * filesystem paths, and private comms identifiers belong in a *.local file or
 * ~/.config, never in the repo.
 *
 * Documentation-safe addresses are explicitly allowed:
 *   - loopback (127.0.0.1) and RFC 5737 TEST-NET ranges (192.0.2.0/24,
 *     198.51.100.0/24, 203.0.113.0/24) — used throughout *.example.json.
 *   - example.invalid / example.com / example.net / ntfy.example / akari.test
 *     style placeholder hosts.
 */

// Explicit known-real addresses (this project's own former defaults), not a
// blanket "every non-TEST-NET IP is bad" rule — test fixtures routinely use
// arbitrary made-up IPs (1.2.3.4, etc.) that are not sensitive and should not
// have to dodge a magic allowlist.
const REAL_INTERNAL_IP = /\b10\.18\.8\.55\b|\b172\.30\.20\.212\b/

// Narrow to the actual real username, not any path under a generic sandbox
// prefix — '/storage/home/<anything>' is a legitimate convention this repo
// itself uses in tests (e.g. an "other user" fixture for sandbox-rejection
// tests), so only the specific real owner account is a hygiene violation.
const PERSONAL_PATH = /\/(?:jfs|storage)\/home\/zhiningjiao\b|\/srv\/pc\d+|\bpc136\b/i

const REAL_EMAIL = /[A-Za-z0-9._%+-]+@(?:meshy\.ai|meshy\.team)\b/i

const COMMS_IDENTIFIER = /hooks\.feishu\.cn|open\.feishu\.cn|larksuite\.com\/open-apis|\bzhiningjiao\b|\bzhiningwork\b/i

export function scanTextForHygieneViolations(text) {
  const hits = []
  const ipM = text.match(REAL_INTERNAL_IP)
  if (ipM) hits.push(`real-internal-ip:${ipM[0]}`)
  const pathM = text.match(PERSONAL_PATH)
  if (pathM) hits.push(`personal-path:${pathM[0]}`)
  const emailM = text.match(REAL_EMAIL)
  if (emailM) hits.push(`real-email:${emailM[0]}`)
  const commsM = text.match(COMMS_IDENTIFIER)
  if (commsM) hits.push(`comms-identifier:${commsM[0]}`)
  return hits
}
