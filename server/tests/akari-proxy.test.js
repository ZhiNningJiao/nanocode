/**
 * Tests for the akari dispatch-server proxy (server/akari-proxy.js — MES-14049).
 *
 * Hermetic: every test injects a fake `fetchFn` so no real network call is made.
 * Covers:
 *   - getAkariUrls: default fallback, trailing-slash strip, personal-config shape
 *   - fetchJson: ok 2xx, non-2xx, network error, abort/timeout — never throws
 *   - fetchAkariState: bundles all four endpoints; reachable derived from
 *     /api/health ok===true; per-section reachability when one endpoint dies;
 *     full unreachable (down server) returns reachable:false with errors (the
 *     calm degradation contract — never rejects)
 *   - checkAkariReachable: true only on 2xx + ok===true (the services panel
 *     up/down contract)
 *   - getAkariServiceEntry: parses host:port from the URL; managed + http kind
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getAkariUrls,
  fetchJson,
  fetchAkariState,
  checkAkariReachable,
  getAkariServiceEntry,
} from '../../server/akari-proxy.js'

// ── fake fetch helpers ──────────────────────────────────────────────────────

function okJson(json) {
  return async () => ({ ok: true, status: 200, json: async () => json })
}
function errStatus(status) {
  return async () => ({ ok: false, status })
}
function netErr(msg) {
  return async () => { const e = new Error(msg); throw e }
}

// A fetchFn that routes by URL suffix to different responses.
function router(map, fallback = netErr('no route')) {
  return async (url) => {
    for (const [suffix, handler] of map) {
      if (String(url).endsWith(suffix)) return handler()
    }
    return fallback()
  }
}

// ── getAkariUrls ────────────────────────────────────────────────────────────

describe('akari-proxy: getAkariUrls', () => {
  it('defaults to the internal akari server + lens URLs', () => {
    const u = getAkariUrls(undefined)
    assert.equal(u.serverUrl, 'http://10.18.8.55:9481')
    assert.equal(u.lensUrl, 'http://10.18.8.55:9482')
  })

  it('reads serverUrl + lensUrl from a loaded personal config', () => {
    const u = getAkariUrls({ akari: { serverUrl: 'http://host:1234/', lensUrl: 'http://host:5678' } })
    assert.equal(u.serverUrl, 'http://host:1234') // trailing slash stripped
    assert.equal(u.lensUrl, 'http://host:5678')
  })

  it('strips multiple trailing slashes', () => {
    const u = getAkariUrls({ akari: { serverUrl: 'http://h//', lensUrl: 'http://l' } })
    assert.equal(u.serverUrl, 'http://h')
  })
})

// ── fetchJson ───────────────────────────────────────────────────────────────

describe('akari-proxy: fetchJson', () => {
  it('returns { ok, json } on a 2xx response', async () => {
    const r = await fetchJson('http://x/api/health', { fetchFn: okJson({ ok: true, version: '0.4.0' }) })
    assert.equal(r.ok, true)
    assert.equal(r.json.version, '0.4.0')
  })

  it('returns { ok:false, error, status } on a non-2xx', async () => {
    const r = await fetchJson('http://x/api/health', { fetchFn: errStatus(503) })
    assert.equal(r.ok, false)
    assert.equal(r.status, 503)
    assert.equal(r.error, 'HTTP 503')
  })

  it('returns { ok:false, error } on a network error (never throws)', async () => {
    const r = await fetchJson('http://x/api/health', { fetchFn: netErr('ECONNREFUSED') })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'ECONNREFUSED')
  })

  it('returns error:"timeout" on an AbortError (timeout)', async () => {
    const fetchFn = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    const r = await fetchJson('http://x/api/health', { fetchFn })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'timeout')
  })
})

// ── fetchAkariState ─────────────────────────────────────────────────────────

const HEALTH = {
  ok: true, version: '0.4.0', build_commit: '92410bc8-dirty',
  dispatch_caps: { lane_cap: 4, max_concurrent_workers: 8, max_vision_workers: 6, default_worker_model: 'litellm/SGLang-GLM-5.2' },
  provider_fallback_enabled: true, instance_tokens_in: 0, instance_tokens_out: 0,
  agent_concurrency: { in_flight: 0, permits_available: 8 },
}
const CONCURRENCY = { running: 0, peak: 0, open_lanes: 0 }
const WORKERS = { workers: [], instance_tokens_in: 0, instance_tokens_out: 0 }
const LANES = { lanes: [] }

describe('akari-proxy: fetchAkariState', () => {
  it('bundles all four endpoints and is reachable when health.ok===true', async () => {
    const fetchFn = router([
      ['/api/health', okJson(HEALTH)],
      ['/api/concurrency', okJson(CONCURRENCY)],
      ['/api/workers', okJson(WORKERS)],
      ['/api/lanes', okJson(LANES)],
    ])
    const s = await fetchAkariState('http://10.18.8.55:9481', { fetchFn })
    assert.equal(s.reachable, true)
    assert.equal(s.health.version, '0.4.0')
    assert.equal(s.health.build_commit, '92410bc8-dirty')
    assert.equal(s.health.dispatch_caps.max_concurrent_workers, 8)
    assert.equal(s.health.agent_concurrency.permits_available, 8)
    assert.equal(s.concurrency.open_lanes, 0)
    assert.equal(s.workers.instance_tokens_in, 0)
    assert.equal(s.lanes.lanes.length, 0)
    assert.equal(s.serverUrl, 'http://10.18.8.55:9481')
    assert.ok(s.fetchedAt, 'fetchedAt timestamp present')
    assert.equal(s.errors.health, null)
  })

  it('renders real workers + lanes fields aligned to the akari contract', async () => {
    const fetchFn = router([
      ['/api/health', okJson(HEALTH)],
      ['/api/concurrency', okJson({ running: 2, peak: 5, open_lanes: 3 })],
      ['/api/workers', okJson({
        workers: [{
          worker_id: 'w-1', label: 'fix-bug', lane_id: 'lane-3', model_id: 'glm-5.2',
          state: 'running', turn: 5, tool_calls: 12, elapsed_secs: 34.5,
          tokens_in: 5000, tokens_out: 1200, current_activity: 'thinking',
          stage: 'gate', needs_attention: null,
        }],
        instance_tokens_in: 5000, instance_tokens_out: 1200,
      })],
      ['/api/lanes', okJson({
        lanes: [{ id: 'lane-3', state: 'Busy', is_special: false, marker: 'xmod', head_short: 'abc1234', at_main: false, occupant: 'xmod', reserved: false }],
      })],
    ])
    const s = await fetchAkariState('http://x', { fetchFn })
    assert.equal(s.workers.workers[0].worker_id, 'w-1')
    assert.equal(s.workers.workers[0].stage, 'gate')
    assert.equal(s.lanes.lanes[0].state, 'Busy')
    assert.equal(s.lanes.lanes[0].occupant, 'xmod')
  })

  it('is NOT reachable when health responds 2xx but ok===false', async () => {
    const fetchFn = router([
      ['/api/health', okJson({ ok: false, version: '0.4.0' })],
      ['/api/concurrency', okJson(CONCURRENCY)],
      ['/api/workers', okJson(WORKERS)],
      ['/api/lanes', okJson(LANES)],
    ])
    const s = await fetchAkariState('http://x', { fetchFn })
    assert.equal(s.reachable, false)
    assert.equal(s.health.ok, false)
  })

  it('keeps the other sections when one endpoint fails (per-section reachability)', async () => {
    const fetchFn = router([
      ['/api/health', okJson(HEALTH)],
      ['/api/concurrency', netErr('ECONNRESET')],
      ['/api/workers', errStatus(500)],
      ['/api/lanes', okJson(LANES)],
    ])
    const s = await fetchAkariState('http://x', { fetchFn })
    assert.equal(s.reachable, true) // health still ok
    assert.equal(s.concurrency, null)
    assert.equal(s.workers, null)
    assert.equal(s.errors.concurrency, 'ECONNRESET')
    assert.equal(s.errors.workers, 'HTTP 500')
    assert.equal(s.errors.health, null)
  })

  it('returns reachable:false (never rejects) when the whole server is down', async () => {
    const s = await fetchAkariState('http://x', { fetchFn: netErr('ECONNREFUSED') })
    assert.equal(s.reachable, false)
    assert.equal(s.health, null)
    assert.equal(s.concurrency, null)
    assert.equal(s.workers, null)
    assert.equal(s.lanes, null)
    assert.equal(s.errors.health, 'ECONNREFUSED')
    assert.equal(s.errors.concurrency, 'ECONNREFUSED')
    assert.ok(s.fetchedAt, 'still emits a fetchedAt for the panel timestamp')
  })

  it('strips a trailing slash from the server URL before concatenating', async () => {
    const seen = []
    const fetchFn = async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => HEALTH } }
    await fetchAkariState('http://x:9481///', { fetchFn })
    assert.ok(seen.every((u) => !u.includes('9481//')), 'no double slash in any URL')
    assert.ok(seen.includes('http://x:9481/api/health'))
  })
})

// ── checkAkariReachable ─────────────────────────────────────────────────────

describe('akari-proxy: checkAkariReachable (services panel up/down contract)', () => {
  it('returns true on 2xx + ok===true', async () => {
    const up = await checkAkariReachable('http://x', { fetchFn: okJson(HEALTH) })
    assert.equal(up, true)
  })

  it('returns false when ok===false', async () => {
    const up = await checkAkariReachable('http://x', { fetchFn: okJson({ ok: false }) })
    assert.equal(up, false)
  })

  it('returns false on a network error (never throws)', async () => {
    const up = await checkAkariReachable('http://x', { fetchFn: netErr('ECONNREFUSED') })
    assert.equal(up, false)
  })

  it('returns false on a non-2xx', async () => {
    const up = await checkAkariReachable('http://x', { fetchFn: errStatus(503) })
    assert.equal(up, false)
  })
})

// ── getAkariServiceEntry ────────────────────────────────────────────────────

describe('akari-proxy: getAkariServiceEntry (managed services-config injection)', () => {
  it('parses host + port from the server URL and marks managed + http', () => {
    const e = getAkariServiceEntry('http://10.18.8.55:9481')
    assert.equal(e.name, 'akari')
    assert.equal(e.host, '10.18.8.55')
    assert.equal(e.port, '9481')
    assert.equal(e.managed, true)
    assert.equal(e.kind, 'http')
  })

  it('defaults the port for https', () => {
    const e = getAkariServiceEntry('https://akari.test')
    assert.equal(e.host, 'akari.test')
    assert.equal(e.port, '443')
  })

  it('falls back gracefully on an unparseable URL', () => {
    const e = getAkariServiceEntry('not-a-url')
    assert.equal(e.name, 'akari')
    assert.equal(e.managed, true)
    assert.ok(e.host, 'host is non-empty even on parse failure')
  })
})
