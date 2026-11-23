/**
 * Issue lineage (父链) — the one place that asks the tracker (Linear,
 * READ-ONLY) "what are this issue's parents, all the way up?".
 *
 * Consumers:
 *   - command-center.js: files every car under the root's direct child its
 *     issue descends from (the category), and labels a sub-row with the
 *     nearest 【named】 issue on the way (e.g. 「重定向质量 › IK」), however
 *     deep the car's issue hangs. Nothing about the tree is hard-coded: the
 *     owner re-parents issues in Linear and the board follows within the
 *     cache window.
 *   - tools/dispatch: checks at dispatch time that the line's parent issue
 *     and the car's issue really sit under the root.
 *
 * mapLineageResponse / classifyLineage are pure (groupLabel lives in
 * public/js/issue-group-label.js, shared with the browser); the source does
 * the IO with a per-issue cache (default 10 min, errors 60 s) and a
 * single-flight per key, so a dashboard polling every few seconds never
 * re-asks Linear.
 */

import { resolveLinearApiKey } from './linear-key.js'
import { groupLabel } from '../public/js/issue-group-label.js'

export { groupLabel }

export const LINEAGE_MAX_DEPTH = 8
export const DEFAULT_LINEAGE_CACHE_SEC = 600
const LINEAGE_ERROR_CACHE_SEC = 60
const LINEAGE_TIMEOUT_MS = 15_000
const LINEAGE_CONCURRENCY = 4

/** Tracker issue keys look like ABC-123; anything else (none:<why>, free text) is never looked up. */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/

function parentSelection(depth) {
  if (depth === 0) return ''
  return ` parent { identifier title ${parentSelection(depth - 1)} }`
}

export const LINEAGE_QUERY = `
  query ($id: String!) {
    issue(id: $id) {
      identifier title url updatedAt
      team { key }
      state { type }
     ${parentSelection(LINEAGE_MAX_DEPTH)}
    }
  }
`

const NOT_FOUND_RX = /not found|could not find|does not exist/i
const CLOSED_TYPES = new Set(['completed', 'canceled'])

/**
 * GraphQL response → { found: false } | { found: true, key, title, team,
 * closed, chain: [{ key, title }, ...] } where chain[0] is the issue itself
 * and the last element is the topmost parent seen. `truncated` = the chain
 * hit LINEAGE_MAX_DEPTH and may continue above. Throws on transport-level
 * GraphQL errors (the caller reports "unknown", never "not under root").
 */
export function mapLineageResponse(json) {
  const issue = json?.data?.issue
  if (!issue) {
    const msg = json?.errors?.[0]?.message || ''
    if (!json?.errors?.length || NOT_FOUND_RX.test(msg)) return { found: false }
    throw new Error(`Linear GraphQL error: ${msg || 'unknown'}`)
  }
  const chain = []
  let node = issue
  let depth = 0
  while (node && typeof node.identifier === 'string') {
    chain.push({ key: node.identifier, title: typeof node.title === 'string' ? node.title : '' })
    node = node.parent
    depth++
  }
  return {
    found: true,
    key: issue.identifier,
    title: typeof issue.title === 'string' ? issue.title : '',
    team: typeof issue.team?.key === 'string' ? issue.team.key : null,
    closed: CLOSED_TYPES.has(issue.state?.type),
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
    chain,
    truncated: depth > LINEAGE_MAX_DEPTH && !!node,
  }
}

/**
 * Where does an issue sit relative to the root's direct children?
 *   lineage    = mapLineageResponse() result for the car's issue
 *   eventKeys  = Set of the root's direct children (the categories)
 *   rootKey    = the root issue key
 * → { eventKey, via, sub: { key, label } | null, path: [keys from issue up to the event] }
 *   or { eventKey: null, reason: 'not_found' | 'not_under_root' | 'root_itself' }.
 * `sub` = the nearest 【named】 issue strictly below the category on the
 * issue's own chain (the issue itself included), so 「ALGO-31 → ALGO-45 →
 * TEAM-113【IK】 → TEAM-109【重定向质量】」 yields sub = TEAM-113 「IK」.
 */
export function classifyLineage(lineage, eventKeys, rootKey) {
  if (!lineage || !lineage.found) return { eventKey: null, reason: 'not_found' }
  const chain = lineage.chain || []
  if (chain[0]?.key === rootKey) return { eventKey: null, reason: 'root_itself' }
  const idx = chain.findIndex((n) => eventKeys.has(n.key))
  if (idx < 0) return { eventKey: null, reason: 'not_under_root' }
  let sub = null
  for (let i = 0; i < idx; i++) {
    const label = groupLabel(chain[i].title)
    if (label) { sub = { key: chain[i].key, label }; break }
  }
  return { eventKey: chain[idx].key, via: idx > 0 ? chain[idx - 1].key : null, sub, path: chain.slice(0, idx + 1).map((n) => n.key) }
}

/** Is `ancestorKey` the issue itself or one of its parents? (dispatch-time line check) */
export function lineageIncludes(lineage, ancestorKey) {
  return !!lineage?.found && lineage.chain.some((n) => n.key === ancestorKey)
}

async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Cached lineage reader. get(graphqlUrl, keys) → Map key → entry, where
 * entry = { ok: true, data: mapLineageResponse(...) } | { ok: false, error }.
 * Keys that don't look like issue keys are skipped (absent from the map).
 * A good answer is kept cacheSec (default 10 min — the owner re-parenting
 * issues shows up within that); a failed lookup only 60 s.
 */
export function createLineageSource({
  fetchImpl = fetch,
  getApiKey = resolveLinearApiKey,
  now = () => Date.now(),
  cacheSec = DEFAULT_LINEAGE_CACHE_SEC,
} = {}) {
  const cache = new Map() // `${url} ${key}` -> { at, ttlMs, entry }
  const inflight = new Map()
  let fetches = 0

  async function fetchOne(graphqlUrl, key) {
    fetches++
    try {
      const apiKey = getApiKey()
      if (!apiKey) throw new Error('Linear API key not configured')
      const res = await fetchImpl(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query: LINEAGE_QUERY, variables: { id: key } }),
        signal: AbortSignal.timeout(LINEAGE_TIMEOUT_MS),
      })
      // Linear answers an unknown identifier with a GraphQL error body (HTTP 200 or 400)
      const body = await res.json().catch(() => null)
      if (!res.ok && !body?.errors) throw new Error(`Linear HTTP ${res.status}`)
      return { ok: true, data: mapLineageResponse(body) }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  function lookup(graphqlUrl, key) {
    const ck = `${graphqlUrl} ${key}`
    const hit = cache.get(ck)
    if (hit && now() - hit.at < hit.ttlMs) return Promise.resolve(hit.entry)
    if (inflight.has(ck)) return inflight.get(ck)
    const p = fetchOne(graphqlUrl, key).then((entry) => {
      cache.set(ck, { at: now(), ttlMs: (entry.ok ? cacheSec : LINEAGE_ERROR_CACHE_SEC) * 1000, entry })
      return entry
    }).finally(() => inflight.delete(ck))
    inflight.set(ck, p)
    return p
  }

  return {
    async get(graphqlUrl, keys) {
      const uniq = [...new Set(keys)].filter((k) => typeof k === 'string' && ISSUE_KEY_RE.test(k))
      const out = new Map()
      await mapLimit(uniq, LINEAGE_CONCURRENCY, async (k) => { out.set(k, await lookup(graphqlUrl, k)) })
      return out
    },
    /** number of real tracker requests made so far (tests / diagnostics) */
    get fetchCount() { return fetches },
  }
}
