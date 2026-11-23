/**
 * Command Center P0-4 — the "waiting on you" (等你) queue.
 *
 * Two independent sources (PRD P0-8: each degrades on its own):
 *   1. Cars — the `waiting` section of the cars export
 *      (tools/command-center/export-cars.mjs, schema nanocc-waiting-signals/v1):
 *      NEEDSIG files (car stuck, asked for something) and un-accepted FLAG
 *      files (car delivered, waits to be accepted). Cars whose trace status is
 *      "blocked" without a NEEDSIG file are added too, so this queue and the
 *      phase-1 "waiting" counts never disagree.
 *   2. Owner decisions — a small JSON file the secretary maintains
 *      (schema nanocc-owner-pending/v1, see docs/product/COMMAND_CENTER_CONTRACTS.md).
 *      A missing file means "not connected", never "nothing pending".
 *
 * Item shape follows vibe-kanban's ApprovalInfo idea (what is waiting, on
 * what, since when, optional deadline — crates/services/src/services/approvals.rs,
 * Apache-2.0; shape only, no code copied). agent-deck's status debounce is not
 * needed here: every signal is a file written once by its owner, not a sampled
 * terminal state that can flicker.
 *
 * mapXxx / buildWaitingView are pure; createOwnerPendingSource does the IO.
 */

import { timedFs } from '../terminal/bounded-scan.js'
const { readFile, stat } = timedFs // home fs: slot budget + slow-call log
import { str, arr, validIso, clip } from './command-center-fields.js'
import { safeHttpUrl } from '../public/js/command-center-url.js'
import { WAITING_SCHEMA } from '../tools/command-center/export-cars.mjs'

export const OWNER_PENDING_SCHEMA = 'nanocc-owner-pending/v1'

const TITLE_MAX = 200
const DETAIL_MAX = 600
const OPTION_MAX = 80
const OPTIONS_MAX = 6

function sinceMs(item) {
  const ms = Date.parse(item.since || '')
  return Number.isFinite(ms) ? ms : Infinity // unknown start sorts last
}

// ─── cars (pure) ────────────────────────────────────────────────────────────

/**
 * Export `waiting` section → { ok, error, scannedAt, flagsChecked,
 * skippedFlags, signals[] }. A missing section = the exporter was not run with
 * --signals-dir (reported as such, never as an empty queue).
 */
export function mapExportWaiting(section) {
  if (section == null) return { ok: false, error: 'cars export has no waiting section (exporter runs without --signals-dir)', signals: [] }
  if (section.schema !== WAITING_SCHEMA) {
    return { ok: false, error: `waiting section: unexpected schema ${JSON.stringify(section.schema)} (want ${WAITING_SCHEMA})`, signals: [] }
  }
  if (!section.ok) return { ok: false, error: str(section.error) || 'signal scan failed', scannedAt: validIso(section.scanned_at), signals: [] }
  const signals = arr(section.items)
    .filter((i) => (i?.kind === 'needsig' || i?.kind === 'flag') && str(i.tag) && validIso(i.since))
    .map((i) => ({ kind: i.kind, tag: i.tag, file: str(i.file), traceId: str(i.trace_id), since: i.since, text: clip(i.text, DETAIL_MAX) }))
  return {
    ok: true,
    error: null,
    scannedAt: validIso(section.scanned_at),
    flagsChecked: section.flags_checked === true,
    skippedFlags: Number.isFinite(section.skipped_flags) ? section.skipped_flags : 0,
    signals,
  }
}

function lastBlockedPoint(car) {
  for (let i = car.points.length - 1; i >= 0; i--) if (car.points[i].kind === 'blocked') return car.points[i]
  return null
}

/**
 * Signals + mapped cars (command-center.js mapBar output) → queue items.
 * `ignoreTagPrefixes` (local config) hides scheduled jobs whose flags are never
 * accepted; hidden items are counted, not silently dropped.
 */
export function mapCarWaitingItems(waiting, cars, ignoreTagPrefixes = []) {
  const byTrace = new Map(cars.map((c) => [c.traceId, c]))
  const ignored = (tag) => ignoreTagPrefixes.some((p) => tag.startsWith(p))
  const items = []
  let hidden = 0
  const covered = new Set()
  for (const s of waiting.signals) {
    if (ignored(s.tag)) { hidden++; continue }
    const car = s.traceId ? byTrace.get(s.traceId) : null
    if (s.traceId) covered.add(`${s.kind}:${s.traceId}`)
    items.push({
      id: `${s.kind}:${s.file || s.tag}`,
      source: 'car',
      kind: s.kind === 'needsig' ? 'blocked' : 'delivered',
      waitingOn: 'secretary',
      waiter: s.traceId || s.tag,
      traceId: s.traceId,
      title: clip(car?.title, TITLE_MAX) || s.tag,
      detail: s.kind === 'needsig' ? s.text : clip(car?.plain, DETAIL_MAX),
      since: s.since,
      url: null,
      recommendation: null,
      options: [],
    })
  }
  for (const c of cars) {
    if (c.state !== 'waiting_human' || covered.has(`needsig:${c.traceId}`) || ignored(c.traceId)) continue
    const p = lastBlockedPoint(c) || c.lastEvent
    items.push({
      id: `trace:${c.traceId}`,
      source: 'car',
      kind: 'blocked',
      waitingOn: 'secretary',
      waiter: c.traceId,
      traceId: c.traceId,
      title: clip(c.title, TITLE_MAX) || c.traceId,
      detail: clip(p?.label, DETAIL_MAX),
      since: p?.t || c.start,
      url: null,
      recommendation: null,
      options: [],
    })
  }
  return { items, hidden }
}

// ─── owner decisions (pure) ─────────────────────────────────────────────────

/**
 * owner_pending.json → { items[], invalid, updatedAt }. Throws on a wrong
 * schema (wrong file / incompatible writer). Items missing id / title / a
 * valid `since` are counted as invalid and skipped (said so in the UI).
 */
export function mapOwnerPending(doc) {
  if (!doc || doc.schema !== OWNER_PENDING_SCHEMA) {
    throw new Error(`owner pending: unexpected schema ${JSON.stringify(doc?.schema)} (want ${OWNER_PENDING_SCHEMA})`)
  }
  let invalid = 0
  const items = []
  for (const raw of arr(doc.items)) {
    const id = str(raw?.id)
    const title = clip(raw?.title, TITLE_MAX)
    const since = validIso(raw?.since)
    if (!id || !title || !since) { invalid++; continue }
    items.push({
      id: `owner:${id}`,
      source: 'owner',
      kind: 'decision',
      waitingOn: 'owner',
      waiter: clip(raw.waiter, 60),
      traceId: str(raw.trace_id),
      title,
      detail: clip(raw.summary, DETAIL_MAX),
      since,
      deadline: validIso(raw.deadline),
      url: safeHttpUrl(raw.url),
      recommendation: clip(raw.recommendation, DETAIL_MAX),
      options: arr(raw.options).map((o) => clip(o, OPTION_MAX)).filter(Boolean).slice(0, OPTIONS_MAX),
    })
  }
  return { items, invalid, updatedAt: validIso(doc.updated_at) }
}

// ─── view (pure) ────────────────────────────────────────────────────────────

/**
 * carsSnap = carsSource.get() result (command-center.js); owner =
 * ownerSource.get() result. → { items (longest wait first), counts, sources }.
 */
export function buildWaitingView({ carsSnap, owner, ignoreTagPrefixes = [] }) {
  const w = carsSnap?.waiting
  const carsSegOk = !!w?.ok
  const cars = carsSnap?.ok ? carsSnap.data.cars : []
  const carPart = carsSegOk ? mapCarWaitingItems(w, cars, ignoreTagPrefixes) : { items: [], hidden: 0 }
  const ownerOk = !!owner?.ok
  const ownerItems = ownerOk ? owner.data.items : []
  const items = [...ownerItems, ...carPart.items].sort((a, b) => sinceMs(a) - sinceMs(b))
  return {
    items,
    counts: {
      total: carsSegOk || ownerOk ? items.length : null,
      owner: ownerOk ? ownerItems.length : null,
      cars: carsSegOk ? carPart.items.length : null,
    },
    sources: {
      cars: {
        ok: carsSegOk,
        checkedAt: carsSnap?.checkedAt || null,
        lastOkAt: carsSnap?.lastOkAt || null,
        scannedAt: w?.scannedAt || null,
        // cars file fine but its waiting section missing/failed → that error
        error: carsSegOk ? null : (w?.error || carsSnap?.error || 'cars export unavailable'),
        flagsChecked: carsSegOk ? w.flagsChecked : false,
        skippedFlags: carsSegOk ? w.skippedFlags : 0,
        hidden: carPart.hidden,
        carsKnown: !!carsSnap?.ok, // false → titles fall back to tags
      },
      owner: {
        ok: ownerOk,
        notConnected: !!owner?.notConnected,
        checkedAt: owner?.checkedAt || null,
        lastOkAt: owner?.lastOkAt || null,
        updatedAt: ownerOk ? owner.data.updatedAt : null,
        invalid: ownerOk ? owner.data.invalid : 0,
        error: owner?.error || null,
      },
    },
  }
}

// ─── source (IO) ────────────────────────────────────────────────────────────

/**
 * Reads owner_pending.json, re-parsed only when its mtime changes. No path
 * configured or no file = { notConnected: true } ("未接入"), a broken file =
 * unreachable with the last success time.
 */
export function createOwnerPendingSource({ now = () => Date.now() } = {}) {
  let cache = null // { path, mtimeMs, data }
  let lastOkAt = null
  return {
    async get(path) {
      const checkedAt = new Date(now()).toISOString()
      if (!path) return { ok: false, notConnected: true, checkedAt, lastOkAt, error: 'ownerPending.path not configured', data: null }
      try {
        const st = await stat(path)
        if (!cache || cache.path !== path || cache.mtimeMs !== st.mtimeMs) {
          cache = { path, mtimeMs: st.mtimeMs, data: mapOwnerPending(JSON.parse(await readFile(path, 'utf8'))) }
        }
      } catch (err) {
        cache = null
        if (err.code === 'ENOENT') return { ok: false, notConnected: true, checkedAt, lastOkAt, error: 'owner pending file does not exist', data: null }
        return { ok: false, notConnected: false, checkedAt, lastOkAt, error: `owner pending unreadable: ${err.code || err.message}`, data: null }
      }
      lastOkAt = checkedAt
      return { ok: true, notConnected: false, checkedAt, lastOkAt, error: null, data: cache.data }
    },
  }
}
