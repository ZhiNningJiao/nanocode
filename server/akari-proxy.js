/**
 * akari dispatch-server proxy (MES-14049).
 *
 * The akari server (axum) at http://10.18.8.55:9481 exposes its control surface
 * over HTTP but sets NO CORS headers, so a browser on the nanocode port cannot
 * reach it directly. This module proxies the four read-only observability
 * endpoints through the nanocode server (same-origin), keeps the server URL
 * server-side configurable (see personal-config.js `akari.serverUrl`), and
 * degrades gracefully — an unreachable akari returns a structured `reachable:
 * false` bundle, never a thrown error, so the panel can render a calm "down"
 * state without console spam.
 *
 * Endpoint field shapes are aligned to the akari-server source (NOT guessed):
 *   - GET /api/health     — crates/akari-server/src/small_handlers.rs::health
 *     { ok, version, build_commit, dispatch_caps{lane_cap, max_concurrent_workers,
 *       max_vision_workers, default_worker_model}, provider_fallback_enabled,
 *       instance_tokens_in, instance_tokens_out,
 *       agent_concurrency{in_flight, permits_available} }
 *   - GET /api/concurrency — small_handlers.rs::concurrency
 *     { running, peak, open_lanes }
 *   - GET /api/workers    — small_handlers.rs::workers
 *     { workers:[{worker_id,label,lane_id?,model_id,state,turn,tool_calls,
 *       elapsed_secs,tokens_in,tokens_out,kind?,stage?,needs_attention?,...}],
 *       instance_tokens_in, instance_tokens_out }
 *   - GET /api/lanes      — lib.rs::lanes_pool / lane_pool_entry_json
 *     { lanes:[{id,state,is_special,marker,head_short?,at_main,occupant?,
 *       reserved}] }
 *
 * `fetchAkariState` fans out to all four in parallel (Promise.all) with a short
 * per-request timeout; the bundle is always 200 with per-section reachability,
 * so one slow/dead endpoint never hides the others (mirrors the usage.js
 * independent-source philosophy).
 */

import {
  DEFAULT_AKARI_SERVER_URL,
  DEFAULT_AKARI_LENS_URL,
} from '../terminal/personal-config.js'

export const AKARI_PROXY_TIMEOUT_MS = 4000

/**
 * Resolve the akari server + lens URLs from a loaded personal config. The
 * server URL is stripped of a trailing slash so endpoint concatenation is
 * safe. Falls back to the documented internal defaults when the config omits
 * them (the loader itself already applies env + default fallbacks, so this is
 * belt-and-braces for a config object that bypassed the loader, e.g. tests).
 */
export function getAkariUrls(config) {
  const serverUrl = String(config?.akari?.serverUrl || DEFAULT_AKARI_SERVER_URL).trim().replace(/\/+$/, '')
  const lensUrl = String(config?.akari?.lensUrl || DEFAULT_AKARI_LENS_URL).trim()
  return { serverUrl, lensUrl }
}

/**
 * Fetch one URL and parse JSON, with an AbortController timeout. Never throws:
 * returns { ok:false, error } on network failure, timeout, or non-2xx. The
 * `fetchFn` option lets tests inject a fake fetch (hermetic — no real network).
 */
export async function fetchJson(url, { fetchFn = fetch, timeoutMs = AKARI_PROXY_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status }
    const json = await res.json()
    return { ok: true, json }
  } catch (e) {
    const name = e?.name || ''
    const msg = e?.message || String(e)
    return { ok: false, error: name === 'AbortError' ? 'timeout' : msg }
  } finally {
    clearTimeout(timer)
  }
}

async function _section(base, path, opts) {
  const r = await fetchJson(`${base}${path}`, opts)
  return r.ok ? { ok: true, data: r.json } : { ok: false, error: r.error }
}

/**
 * Bundle the four akari observability endpoints into one response. Always
 * resolves (never rejects) so the Express handler can return 200 with a
 * `reachable` flag — the panel renders a calm degraded state when akari is down
 * rather than a red error banner that spams on every poll.
 *
 * `reachable` is derived from /api/health (the task contract: up/down 用
 * /api/health): true only when health responded 2xx AND json.ok === true.
 */
export async function fetchAkariState(serverUrl, opts = {}) {
  const base = String(serverUrl).trim().replace(/\/+$/, '')
  const [health, concurrency, workers, lanes] = await Promise.all([
    _section(base, '/api/health', opts),
    _section(base, '/api/concurrency', opts),
    _section(base, '/api/workers', opts),
    _section(base, '/api/lanes', opts),
  ])
  const reachable = !!(health.ok && health.data && health.data.ok === true)
  return {
    reachable,
    fetchedAt: new Date().toISOString(),
    serverUrl: base,
    health: health.ok ? health.data : null,
    concurrency: concurrency.ok ? concurrency.data : null,
    workers: workers.ok ? workers.data : null,
    lanes: lanes.ok ? lanes.data : null,
    errors: {
      health: health.ok ? null : health.error,
      concurrency: concurrency.ok ? null : concurrency.error,
      workers: workers.ok ? null : workers.error,
      lanes: lanes.ok ? null : lanes.error,
    },
  }
}

/**
 * Single health probe for the services panel (up/down 用 /api/health). Returns
 * true only when /api/health responds 2xx with ok===true. Used by
 * runServiceChecks so the Port Health grid shows an `akari` row whose dot is
 * driven by the real HTTP health endpoint, not a bare TCP connect.
 */
export async function checkAkariReachable(serverUrl, opts = {}) {
  const base = String(serverUrl).trim().replace(/\/+$/, '')
  const r = await fetchJson(`${base}/api/health`, opts)
  return !!(r.ok && r.json && r.json.ok === true)
}

/**
 * Build the managed (read-only) akari service entry for the Port Health grid,
 * parsed from the server URL so the row shows a real host:port. `managed:true`
 * tells services-panel.js to render it without edit/delete controls, and the
 * PUT /api/services-config handler to never persist it (it is injected fresh on
 * every read from the live akari config, so an operator URL change propagates
 * without a stale services-config.json entry).
 */
export function getAkariServiceEntry(serverUrl) {
  const base = String(serverUrl).trim().replace(/\/+$/, '')
  let host = ''
  let port = ''
  try {
    const u = new URL(base)
    host = u.hostname
    port = u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    host = base
  }
  return { name: 'akari', host, port, managed: true, kind: 'http' }
}
