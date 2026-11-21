/**
 * Command Center (指挥舱) phase 1 — big events from the task tracker, cars
 * folded under them, one gantt bar per car trace.
 *
 * Two independent data sources (PRD P0-8: each degrades on its own):
 *   1. Big events = task-tracker issues (Linear, READ-ONLY): the configured
 *      root issue's direct children are the events; grandchildren only count
 *      toward progress. Cached >= 60s. The API key comes from the existing
 *      personal-config permission gate (never from this module's config,
 *      never sent to the browser).
 *   2. Cars = ONE exported JSON file (tools/command-center/export-cars.mjs
 *      writes it every minute on the host that owns the car trace store). We
 *      never scan the per-car status files from here: on the deployment host
 *      the shared disk is a network mount where hundreds of small reads are
 *      slow and sqlite is unsafe.
 *
 * Layering: the mapXxx / buildXxx functions are pure (unit-tested without HTTP or
 * network); the source objects do the IO; the router only parses, calls and
 * responds.
 *
 * Phase 2 adds two more blocks on the same router, each its own module and
 * its own source: the "waiting on you" queue (command-center-waiting.js) and
 * per-pool quota (command-center-quota.js).
 *
 * Config: config/command-center.local.json (gitignored — real issue keys and
 * paths never committed); config/command-center.example.json is the shape.
 */

import express from 'express'
import { readFileSync } from 'node:fs'
import { readFile, stat, open } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPersonalConfig, resolvePluginSecrets } from '../terminal/personal-config.js'
import { builtinPlugin } from '../public/js/plugins-registry.js'
import { CARS_EXPORT_SCHEMA, GANTT_SCHEMA } from '../tools/command-center/export-cars.mjs'
import { safeHttpUrl } from '../public/js/command-center-url.js'
import { str, arr, validIso } from './command-center-fields.js'
import { mapExportWaiting, buildWaitingView, createOwnerPendingSource } from './command-center-waiting.js'
import { DEFAULT_QUOTA_STALE_SEC, createQuotaSource } from './command-center-quota.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

export const CC_CONFIG_PATH = join(REPO_ROOT, 'config', 'command-center.local.json')

const LINEAR_MIN_CACHE_SEC = 60
const LINEAR_TIMEOUT_MS = 15_000
const DEFAULT_CARS_STALE_SEC = 300
const DOCUMENT_MAX_BYTES = 512 * 1024
const EVENT_MILESTONES_MAX = 20

// ─── Unified car state vocabulary (PRD §6.3) — the only copy ────────────────
// The trace store's `status` (car-trace-gantt/v1) is mapped here once
// (REUSE §8.3); list, gantt, "waiting on you" and the group rollup all read
// `state`, never the raw trace status.
export const CAR_STATES = ['queued', 'running', 'waiting_human', 'blocked', 'delivered', 'done', 'failed', 'timeout', 'unknown']

// Group state = the worst child (idea from uptime-kuma group monitor, not
// copied). Higher = worse.
export const STATE_SEVERITY = {
  done: 0, delivered: 1, queued: 2, running: 3, unknown: 4,
  waiting_human: 5, blocked: 5, timeout: 6, failed: 6,
}
export const WAITING_STATES = new Set(['waiting_human', 'blocked'])

const TRACE_STATUS_MAP = {
  running: { state: 'running', reason: null },
  stale: { state: 'unknown', reason: 'stale' }, // no writes for hours, no end marker
  blocked: { state: 'waiting_human', reason: null }, // car asked for info / permission
  delivered: { state: 'delivered', reason: null },
  accepted: { state: 'done', reason: null },
  failed: { state: 'failed', reason: null },
  ended_noflag: { state: 'unknown', reason: 'ended_noflag' }, // report but no completion flag
  superseded: { state: 'unknown', reason: 'superseded' }, // replaced by a re-dispatch
}

export function mapTraceStatus(status) {
  const hit = TRACE_STATUS_MAP[status]
  if (hit) return { ...hit }
  return { state: 'unknown', reason: 'unrecognized' }
}

// Superseded segments have a successor trace in the same data; counting them
// would let an old, replaced attempt colour the whole event.
function countsTowardGroup(car) {
  return car.reason !== 'superseded'
}

export function groupWorst(cars) {
  const live = cars.filter(countsTowardGroup)
  if (live.length === 0) return null
  let worst = live[0].state
  for (const c of live) {
    if ((STATE_SEVERITY[c.state] ?? STATE_SEVERITY.unknown) > (STATE_SEVERITY[worst] ?? STATE_SEVERITY.unknown)) worst = c.state
  }
  return worst
}

// ─── Linear mapping (pure) ──────────────────────────────────────────────────

const LINEAR_TREE_QUERY = `
  query ($id: String!) {
    issue(id: $id) {
      identifier title url updatedAt
      state { name type }
      children(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          identifier title url updatedAt
          state { name type }
          children(first: 100) {
            pageInfo { hasNextPage }
            nodes { identifier updatedAt state { type } }
          }
        }
      }
    }
  }
`

const LINEAR_DONE_TYPES = new Set(['completed', 'canceled'])

function mapLinearState(s) {
  if (!s || typeof s !== 'object') return null
  return { name: typeof s.name === 'string' ? s.name : null, type: typeof s.type === 'string' ? s.type : null }
}

function maxIso(a, b) {
  if (!a) return b || null
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

/**
 * Linear GraphQL response → { root, events[], truncated }. Throws on GraphQL
 * errors or a missing root issue (the caller turns that into an
 * "unreachable" source state — never an empty list posing as "no events").
 */
export function mapLinearResponse(json) {
  if (json?.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0]?.message || 'unknown'}`)
  }
  const root = json?.data?.issue
  if (!root) throw new Error('Linear root issue not found')
  const childConn = root.children || {}
  let truncated = !!childConn.pageInfo?.hasNextPage
  const events = (Array.isArray(childConn.nodes) ? childConn.nodes : [])
    .filter((n) => n && typeof n.identifier === 'string')
    .map((n) => {
      const sub = Array.isArray(n.children?.nodes) ? n.children.nodes : []
      if (n.children?.pageInfo?.hasNextPage) truncated = true
      let updatedAt = n.updatedAt || null
      for (const s of sub) updatedAt = maxIso(updatedAt, s?.updatedAt || null)
      return {
        key: n.identifier,
        title: typeof n.title === 'string' ? n.title : n.identifier,
        url: safeHttpUrl(n.url),
        trackerState: mapLinearState(n.state),
        updatedAt,
        subIssues: {
          keys: sub.filter((s) => typeof s?.identifier === 'string').map((s) => s.identifier),
          total: sub.length,
          done: sub.filter((s) => LINEAR_DONE_TYPES.has(s?.state?.type)).length,
        },
      }
    })
  return {
    root: {
      key: root.identifier,
      title: root.title || root.identifier,
      url: safeHttpUrl(root.url),
      trackerState: mapLinearState(root.state),
    },
    events,
    truncated,
  }
}

// ─── Cars export mapping (pure) ─────────────────────────────────────────────

function mapPoint(p) {
  if (!p || typeof p !== 'object') return null
  const t = validIso(p.t)
  if (!t) return null
  return { t, kind: str(p.kind) || 'other', label: typeof p.label === 'string' ? p.label : '', source: str(p.source) }
}

/**
 * One gantt bar → one car. Missing fields degrade to null / [] (and an
 * unparseable start makes the car list-only, not drawn); paths stay
 * server-side — the browser only learns *which* documents exist. PR / board
 * links come from free text: only absolute http(s) URLs survive.
 */
export function mapBar(b) {
  const { state, reason } = mapTraceStatus(b?.status)
  const links = b?.links && typeof b.links === 'object' ? b.links : {}
  const points = arr(b?.points).map(mapPoint).filter(Boolean).sort((x, y) => Date.parse(x.t) - Date.parse(y.t))
  const last = b?.last_event && typeof b.last_event === 'object' ? mapPoint(b.last_event) : null
  const issueSource = str(b?.issue_source)
  return {
    traceId: str(b?.trace_id) || '?',
    car: str(b?.car) || str(b?.trace_id) || '?',
    parent: str(b?.parent),
    parentInferred: b?.parent_source === 'inferred',
    issue: str(b?.issue),
    // task_title = recognised from free text after the fact, not registered
    // at dispatch time: shown as "inferred" (PRD P2-4: guesses never pose as fact).
    issueInferred: issueSource === 'task_title',
    title: typeof b?.title === 'string' ? b.title : '',
    start: validIso(b?.start),
    end: validIso(b?.end),
    endOpen: b?.end_open === true || (b?.end == null && validIso(b?.start) != null),
    traceStatus: str(b?.status),
    state,
    reason,
    verdict: str(b?.verdict),
    plain: str(b?.plain),
    model: str(b?.model),
    pool: str(b?.pool),
    effort: str(b?.effort),
    points,
    lastEvent: last,
    traceCmd: str(b?.think?.cmd),
    sessions: arr(b?.think?.sessions).map((s) => ({
      iter: Number.isFinite(s?.iter) ? s.iter : null,
      sessionId: str(s?.session_id),
      start: validIso(s?.start_t),
      end: validIso(s?.end_t),
    })),
    docs: { task: !!str(links.task), step: !!str(links.step), report: !!str(links.report) },
    prs: arr(links.prs).map(safeHttpUrl).filter(Boolean),
    branches: arr(links.branches).filter((u) => typeof u === 'string'),
    boards: arr(links.boards).map(safeHttpUrl).filter(Boolean),
  }
}

/** trace_id → { task, step, report } local paths (server-side only). */
export function docPathsByTrace(gantt) {
  const out = new Map()
  for (const b of arr(gantt?.bars)) {
    const id = str(b?.trace_id)
    if (!id || !b.links) continue
    out.set(id, { task: str(b.links.task), step: str(b.links.step), report: str(b.links.report) })
  }
  return out
}

/**
 * Export envelope → { ok, exportedAt, lastOkAt, error, window, cars }.
 * Throws on a schema it doesn't understand (wrong file / incompatible version).
 */
export function mapCarsExport(env) {
  if (!env || env.schema !== CARS_EXPORT_SCHEMA) {
    throw new Error(`cars export: unexpected schema ${JSON.stringify(env?.schema)} (want ${CARS_EXPORT_SCHEMA})`)
  }
  const exportedAt = validIso(env.exported_at)
  if (!env.ok) {
    return { ok: false, exportedAt, lastOkAt: validIso(env.last_ok_at), error: str(env.error) || 'export failed', window: null, cars: [] }
  }
  const g = env.gantt
  if (!g || g.schema !== GANTT_SCHEMA) {
    throw new Error(`cars export: unexpected gantt schema ${JSON.stringify(g?.schema)} (want ${GANTT_SCHEMA})`)
  }
  return {
    ok: true,
    exportedAt,
    lastOkAt: exportedAt,
    error: null,
    window: { from: validIso(g.from), to: validIso(g.to) },
    cars: arr(g.bars).map(mapBar),
  }
}

// ─── View assembly (pure) ───────────────────────────────────────────────────

const EVENT_MILESTONE_KINDS = new Set(['milestone', 'delivered', 'accepted', 'failed', 'blocked', 'steered'])

function latestEvent(cars) {
  let best = null
  for (const c of cars) {
    const e = c.lastEvent
    if (e && (!best || Date.parse(e.t) > Date.parse(best.t))) best = { ...e, car: c.car }
  }
  return best
}

function summarizeEvent(base, cars, carsOk) {
  const sorted = [...cars].sort((a, b) => (Date.parse(a.start || 0) || 0) - (Date.parse(b.start || 0) || 0))
  const live = sorted.filter(countsTowardGroup)
  let progress = null
  if (base.subIssues && base.subIssues.total > 0) {
    progress = { basis: 'subissues', done: base.subIssues.done, total: base.subIssues.total }
  } else if (carsOk && live.length > 0) {
    progress = { basis: 'cars', done: live.filter((c) => c.state === 'done').length, total: live.length }
  }
  const milestones = []
  for (const c of sorted) {
    for (const p of c.points) {
      if (EVENT_MILESTONE_KINDS.has(p.kind)) milestones.push({ t: p.t, kind: p.kind, label: p.label, car: c.car })
    }
  }
  milestones.sort((a, b) => Date.parse(b.t) - Date.parse(a.t))
  const starts = sorted.map((c) => c.start).filter(Boolean)
  return {
    ...base,
    carsAvailable: carsOk,
    carCount: carsOk ? live.length : null,
    waitingCount: carsOk ? live.filter((c) => WAITING_STATES.has(c.state)).length : null,
    state: carsOk ? groupWorst(sorted) : null,
    progress,
    startedAt: starts.length ? starts.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null,
    lastProgress: carsOk ? latestEvent(sorted) : null,
    milestones: milestones.slice(0, EVENT_MILESTONES_MAX),
    cars: sorted,
  }
}

function eventActivity(e) {
  return Math.max(Date.parse(e.lastProgress?.t || 0) || 0, Date.parse(e.updatedAt || 0) || 0)
}

/**
 * Join the two sources. When Linear is down the events fall back to the
 * issue keys the cars carry (title/state unknown, said so in the UI); when
 * the car export is down every event says "car data unreachable" instead of
 * claiming zero cars.
 */
export function buildCommandCenterView({ linear, cars }) {
  const carsOk = !!cars?.ok
  const carList = carsOk ? cars.data.cars : []
  const linearOk = !!linear?.ok

  let bases
  const issueToEvent = new Map()
  if (linearOk) {
    bases = linear.data.events.map((e) => ({ ...e, fromTracker: true }))
    for (const e of bases) {
      issueToEvent.set(e.key, e.key)
      for (const k of e.subIssues.keys) issueToEvent.set(k, e.key)
    }
  } else {
    const keys = [...new Set(carList.map((c) => c.issue).filter(Boolean))]
    bases = keys.map((k) => ({ key: k, title: null, url: null, trackerState: null, updatedAt: null, subIssues: null, fromTracker: false }))
    for (const k of keys) issueToEvent.set(k, k)
  }

  const byEvent = new Map(bases.map((e) => [e.key, []]))
  const unassigned = []
  for (const c of carList) {
    const ek = c.issue ? issueToEvent.get(c.issue) : null
    if (ek) byEvent.get(ek).push(c)
    else unassigned.push({ ...c, unassignedReason: c.issue ? 'not_under_root' : 'no_issue' })
  }

  const events = bases.map((b) => summarizeEvent(b, byEvent.get(b.key), carsOk))
  events.sort((a, b) => {
    const w = (b.waitingCount || 0) - (a.waitingCount || 0)
    if (w) return w
    const c = (b.carCount ? 1 : 0) - (a.carCount ? 1 : 0)
    if (c) return c
    return eventActivity(b) - eventActivity(a)
  })

  const unassignedGroup = summarizeEvent({ key: '_none', title: null, url: null, trackerState: null, updatedAt: null, subIssues: null, fromTracker: false }, unassigned, carsOk)
  return {
    root: linearOk ? linear.data.root : null,
    events,
    unassigned: unassignedGroup,
    summary: {
      events: events.length,
      cars: carsOk ? carList.filter(countsTowardGroup).length : null,
      waiting: carsOk ? carList.filter((c) => countsTowardGroup(c) && WAITING_STATES.has(c.state)).length : null,
    },
    window: carsOk ? cars.data.window : null,
    sources: {
      linear: { ok: linearOk, checkedAt: linear?.checkedAt || null, lastOkAt: linear?.lastOkAt || null, error: linear?.error || null, truncated: linearOk ? !!linear.data.truncated : false },
      cars: { ok: carsOk, checkedAt: cars?.checkedAt || null, lastOkAt: cars?.lastOkAt || null, error: cars?.error || null },
    },
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** { config } or { error } — a missing config is reported, never guessed. */
export function loadCommandCenterConfig(path = CC_CONFIG_PATH) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { error: `config ${basename(path)} unreadable: ${err.code || err.message}` }
  }
  const rootIssue = str(parsed?.linear?.rootIssue)
  const graphqlUrl = str(parsed?.linear?.graphqlUrl)
  const carsPath = str(parsed?.carsExport?.path)
  const missing = [!rootIssue && 'linear.rootIssue', !graphqlUrl && 'linear.graphqlUrl', !carsPath && 'carsExport.path'].filter(Boolean)
  if (missing.length) return { error: `config ${basename(path)} missing ${missing.join(', ')}` }
  const cacheSec = Number(parsed.linear.cacheSeconds)
  const staleSec = Number(parsed.carsExport.staleSeconds)
  const quotaStaleSec = Number(parsed.quota?.staleSeconds)
  return {
    config: {
      rootIssue,
      graphqlUrl,
      linearCacheSec: Math.max(LINEAR_MIN_CACHE_SEC, Number.isFinite(cacheSec) ? cacheSec : LINEAR_MIN_CACHE_SEC),
      carsPath,
      carsStaleSec: Number.isFinite(staleSec) && staleSec > 0 ? staleSec : DEFAULT_CARS_STALE_SEC,
      // phase 2 — optional: absent = that block shows "not connected"
      ownerPendingPath: str(parsed.ownerPending?.path),
      waitingIgnoreTagPrefixes: arr(parsed.waiting?.ignoreTagPrefixes).filter((x) => typeof x === 'string' && x),
      quotaDir: str(parsed.quota?.dir),
      quotaStaleSec: Number.isFinite(quotaStaleSec) && quotaStaleSec > 0 ? quotaStaleSec : DEFAULT_QUOTA_STALE_SEC,
    },
  }
}

// ─── Sources (IO) ───────────────────────────────────────────────────────────

// The key goes through the plugin permission gate (manifest declares
// personal.linear) — server-side only, never serialized to the browser.
function defaultLinearApiKey() {
  return resolvePluginSecrets(loadPersonalConfig(), builtinPlugin('command-center')).linear?.apiKey || null
}

/**
 * Cached Linear reader. A failure keeps lastOkAt for the "last success" label
 * but drops the data (no silently stale numbers — PRD P0-8).
 */
export function createLinearSource({ fetchImpl = fetch, getApiKey = defaultLinearApiKey, now = () => Date.now() } = {}) {
  let snap = null
  let snapKey = null
  let lastOkAt = null
  let inflight = null

  async function refresh(graphqlUrl, rootIssue) {
    const checkedAt = new Date(now()).toISOString()
    try {
      const key = getApiKey()
      if (!key) throw new Error('Linear API key not configured')
      const res = await fetchImpl(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: key },
        body: JSON.stringify({ query: LINEAR_TREE_QUERY, variables: { id: rootIssue } }),
        signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`Linear HTTP ${res.status}`)
      const data = mapLinearResponse(await res.json())
      lastOkAt = checkedAt
      snap = { ok: true, checkedAt, lastOkAt, error: null, data }
    } catch (err) {
      snap = { ok: false, checkedAt, lastOkAt, error: String(err?.message || err), data: null }
    }
    snapKey = `${graphqlUrl} ${rootIssue}`
    return snap
  }

  return {
    async get(graphqlUrl, rootIssue, cacheSec) {
      const fresh = snap && snapKey === `${graphqlUrl} ${rootIssue}` && now() - Date.parse(snap.checkedAt) < cacheSec * 1000
      if (fresh) return snap
      if (!inflight) inflight = refresh(graphqlUrl, rootIssue).finally(() => { inflight = null })
      return inflight
    },
  }
}

/**
 * Cars export reader: one file, re-parsed only when its mtime changes. An
 * export older than staleSec counts as unreachable ("the exporter stopped"),
 * with the export time as last success. The same file carries the
 * "waiting on you" signals (`waiting`): returned alongside, available even
 * when the trace part failed, gone when the whole file is stale/unreadable.
 */
export function createCarsSource({ now = () => Date.now() } = {}) {
  let cache = null // { path, mtimeMs, mapped, docPaths, waiting }
  let lastOkAt = null

  return {
    async get(path, staleSec) {
      const checkedAt = new Date(now()).toISOString()
      try {
        const st = await stat(path)
        if (!cache || cache.path !== path || cache.mtimeMs !== st.mtimeMs) {
          const env = JSON.parse(await readFile(path, 'utf8'))
          cache = { path, mtimeMs: st.mtimeMs, mapped: mapCarsExport(env), docPaths: docPathsByTrace(env.gantt), waiting: mapExportWaiting(env.waiting) }
        }
      } catch (err) {
        cache = null
        return { ok: false, checkedAt, lastOkAt, error: `cars export unreadable: ${err.code || err.message}`, data: null, waiting: null }
      }
      const m = cache.mapped
      if (m.lastOkAt && (!lastOkAt || Date.parse(m.lastOkAt) > Date.parse(lastOkAt))) lastOkAt = m.lastOkAt
      const ageSec = (now() - Date.parse(m.exportedAt || 0)) / 1000
      if (!(ageSec <= staleSec)) {
        const error = `cars export stale (${Math.round(ageSec)}s old, limit ${staleSec}s)`
        return { ok: false, checkedAt, lastOkAt, error, data: null, waiting: { ok: false, error, signals: [] } }
      }
      if (!m.ok) return { ok: false, checkedAt, lastOkAt, error: m.error, data: null, waiting: cache.waiting }
      return { ok: true, checkedAt, lastOkAt, error: null, data: m, waiting: cache.waiting }
    },
    docPath(traceId, kind) {
      return cache?.docPaths.get(traceId)?.[kind] || null
    },
  }
}

// ─── Routes (parse → call → respond) ────────────────────────────────────────

const DOCUMENT_KINDS = new Set(['task', 'step', 'report'])

/**
 * Read at most maxBytes of a regular file in one bounded read — the size is
 * decided by what was read, not by an earlier stat (a file growing between
 * stat and read can't push more than maxBytes into memory).
 */
export async function readTextCapped(p, maxBytes) {
  const fh = await open(p, 'r')
  try {
    if (!(await fh.stat()).isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' })
    const buf = Buffer.alloc(maxBytes + 1)
    let n = 0
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
      if (!bytesRead) break
      n += bytesRead
    }
    return { text: buf.subarray(0, Math.min(n, maxBytes)).toString('utf8'), truncated: n > maxBytes }
  } finally {
    await fh.close()
  }
}

export function createCommandCenterRoutes({
  configPath = CC_CONFIG_PATH,
  linearSource = createLinearSource(),
  carsSource = createCarsSource(),
  ownerSource = createOwnerPendingSource(),
  quotaSource = createQuotaSource(),
} = {}) {
  const router = express.Router()

  router.get('/api/command-center', async (_req, res, next) => {
    try {
      const { config, error } = loadCommandCenterConfig(configPath)
      if (error) return res.json({ configured: false, error })
      const [linear, cars] = await Promise.all([
        linearSource.get(config.graphqlUrl, config.rootIssue, config.linearCacheSec),
        carsSource.get(config.carsPath, config.carsStaleSec),
      ])
      res.json({ configured: true, ...buildCommandCenterView({ linear, cars }) })
    } catch (err) { next(err) }
  })

  // A car's task / progress / report document, as plain text. Only the exact
  // path the export lists for that trace is readable — never a caller path.
  router.get('/api/command-center/doc', async (req, res, next) => {
    try {
      const traceId = String(req.query.trace || '')
      const kind = String(req.query.kind || '')
      if (!DOCUMENT_KINDS.has(kind)) return res.status(400).json({ error: 'bad kind' })
      const p = carsSource.docPath(traceId, kind)
      if (!p) return res.status(404).json({ error: 'no such document for this trace' })
      let doc
      try { doc = await readTextCapped(p, DOCUMENT_MAX_BYTES) } catch (err) { return res.status(404).json({ error: `document unreadable: ${err.code || err.message}` }) }
      if (doc.truncated) res.set('X-Truncated', String(DOCUMENT_MAX_BYTES))
      res.type('text/plain; charset=utf-8').send(doc.truncated ? `${doc.text}\n\n[… truncated at ${DOCUMENT_MAX_BYTES} bytes]` : doc.text)
    } catch (err) { next(err) }
  })

  // P0-4 "waiting on you": car signals (from the cars export) + owner decisions.
  router.get('/api/command-center/waiting', async (_req, res, next) => {
    try {
      const { config, error } = loadCommandCenterConfig(configPath)
      if (error) return res.json({ configured: false, error })
      const [carsSnap, owner] = await Promise.all([
        carsSource.get(config.carsPath, config.carsStaleSec),
        ownerSource.get(config.ownerPendingPath),
      ])
      res.json({ configured: true, ...buildWaitingView({ carsSnap, owner, ignoreTagPrefixes: config.waitingIgnoreTagPrefixes }) })
    } catch (err) { next(err) }
  })

  // P0-5 quota per pool, from the on-disk header-reading cache (no model API calls).
  router.get('/api/command-center/quota', async (_req, res, next) => {
    try {
      const { config, error } = loadCommandCenterConfig(configPath)
      if (error) return res.json({ configured: false, error })
      const q = await quotaSource.get(config.quotaDir, config.quotaStaleSec)
      const { data, ...source } = q
      res.json({ configured: true, staleSec: config.quotaStaleSec, ...(data || { pools: [], tightest: [] }), source })
    } catch (err) { next(err) }
  })

  return router
}
