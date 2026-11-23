#!/usr/bin/env node
/**
 * Command Center cars exporter — runs on the host that owns the car trace
 * store (the trace CLI's sqlite must be read locally, never over a network
 * mount) and writes ONE JSON file the nanocode server reads.
 *
 *   node tools/command-center/export-cars.mjs --trace-cmd <path/to/trace> \
 *        --out <path/to/cars.json> [--from -3d] [--signals-dir <dir>]
 *
 * It runs `<trace-cmd> gantt --from=<from> --to now` (car-trace-gantt/v1),
 * drops the per-session transcript paths (the dashboard never needs them),
 * wraps the result in a small envelope and writes it atomically (temp file in
 * the same directory + rename), so a reader never sees half a file.
 *
 * With --signals-dir it also lists the cars waiting on a human (the
 * "waiting on you" queue, section `waiting`, schema nanocc-waiting-signals/v1):
 *   - NEEDSIG_<tag>*  in that directory = the car is stuck and asked for
 *     something (info / permission / an asset); the file text says what.
 *   - FLAG_<tag>      (exact name, not yet renamed to FLAG_<tag>.accepted-*)
 *     = the car delivered and waits to be accepted. Only tags that are cars in
 *     the gantt window count — other un-accepted flags (scheduled jobs) are
 *     only counted (`skipped_flags`), never shown as cars.
 * One readdir of the directory per run; only the matching files are stat'ed.
 *
 * Failure is written too (ok:false + error + the previous last_ok_at) and the
 * process exits non-zero, so the dashboard shows "source unreachable + last
 * success" instead of an empty chart, and the timer unit shows the failure.
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile, rename, mkdir, readdir, stat, open } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CARS_EXPORT_SCHEMA = 'nanocc-cars-export/v1'
export const GANTT_SCHEMA = 'car-trace-gantt/v1'
export const WAITING_SCHEMA = 'nanocc-waiting-signals/v1'

const NEEDSIG_TEXT_MAX_BYTES = 2048
const NEEDSIG_TEXT_MAX_CHARS = 600
const TASK_TITLE_MAX_BYTES = 4096

const TRACE_TIMEOUT_MS = 120_000
const TRACE_MAX_BUFFER = 64 * 1024 * 1024

/** Remove fields the dashboard must not see (local transcript paths). */
export function stripGantt(gantt) {
  const bars = Array.isArray(gantt?.bars) ? gantt.bars : []
  return {
    ...gantt,
    bars: bars.map((b) => {
      if (!b?.think || !Array.isArray(b.think.sessions)) return b
      return {
        ...b,
        think: {
          ...b.think,
          sessions: b.think.sessions.map(({ jsonl_path: _j, md_path: _m, ...rest }) => rest),
        },
      }
    }),
  }
}

// ─── ETA estimation (pure) ──────────────────────────────────────────────────
// MES-18517 (大事记甘特): a still-running car's `eta` ("expected finish", read
// as-is by command-center.js mapBar — see its comment "never guessed here")
// has to come from somewhere; this is that somewhere. One priority order,
// defined once:
//   1. the dispatch task doc's own "最好 HH:MM 前交/前出" (an explicit clock
//      time the dispatcher already wrote down — same Shanghai calendar day
//      as the car's own start, the only day a same-day task doc means);
//   2. the task doc's "硬顶 N 小时/分钟" + the car's own start (dispatch time);
//   3. the median close time of other cars in the same task family (this
//      export's own window — no second data source);
// No signal at any step → no `eta` (same as before this feature existed;
// never a number invented past this point — DCC 荣耻篇 七·二).
// A trace CLI that one day learns to supply `b.eta` itself is authoritative:
// addEstimatedEtas() only fills a bar that does not already carry one.

const DEADLINE_HARDCAP_RE = /硬顶\s*([\d.]+)\s*(小时|分钟)/
const DEADLINE_PREFER_RE = /最好\s*(\d{1,2}):(\d{2})\s*前/

/**
 * The task doc's first line (its `# TASK ... (...)` title) → the deadline
 * hint(s) it carries, or null when it carries neither. Both may be present
 * ("硬顶 1.5 小时，最好 14:15 前交"); the caller tries `preferHH`/`preferMM`
 * before `hardcapMin` (an explicit clock time beats a relative budget).
 */
export function parseTaskDeadline(titleLine) {
  if (typeof titleLine !== 'string') return null
  const out = {}
  const prefer = titleLine.match(DEADLINE_PREFER_RE)
  if (prefer) { out.preferHH = Number(prefer[1]); out.preferMM = Number(prefer[2]) }
  const hardcap = titleLine.match(DEADLINE_HARDCAP_RE)
  if (hardcap) {
    const v = Number(hardcap[1])
    if (Number.isFinite(v)) out.hardcapMin = hardcap[2] === '小时' ? v * 60 : v
  }
  return (out.preferHH != null || out.hardcapMin != null) ? out : null
}

/**
 * Shanghai wall-clock `hh:mm`, same calendar day as `startIso` (UTC+8 fixed —
 * never the host's own TZ, so this is the same instant no matter which host
 * runs the exporter) → the ISO instant. Rolled to the next day when that
 * instant would land before the car even started (the task doc's "HH:MM" is
 * always later today, never a time already past at dispatch).
 */
export function shanghaiDeadlineIso(startIso, hh, mm) {
  const startMs = Date.parse(startIso)
  if (!Number.isFinite(startMs)) return null
  const sh = new Date(startMs + 8 * 3600_000)
  let ms = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate(), hh, mm, 0) - 8 * 3600_000
  if (ms < startMs) ms += 24 * 3600_000
  return new Date(ms).toISOString()
}

/** Dispatch tag → task family: drop a trailing run-timestamp/date so repeat dispatches of the same task share one family (distinct sibling tasks, e.g. "..._G1" vs "..._G4", stay distinct). */
export function taskFamily(tag) {
  const s = String(tag || '')
  return s.replace(/_\d{4}-\d{2}-\d{2}$/, '').replace(/_\d{3,4}$/, '') || s
}

function isOpenBar(b) {
  return b?.end_open === true || (b?.end_open !== false && b?.end == null && Number.isFinite(Date.parse(b?.start)))
}

/** Median minutes-to-close of this export's other *closed* bars in `family` (null with zero samples — a median of nothing is not a median). */
export function familyP50Minutes(bars, family, excludeTraceId) {
  const mins = []
  for (const b of (Array.isArray(bars) ? bars : [])) {
    if (b?.trace_id === excludeTraceId) continue
    if (taskFamily(b?.car || b?.trace_id) !== family) continue
    if (isOpenBar(b)) continue
    const s = Date.parse(b?.start)
    const e = Date.parse(b?.end)
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) mins.push((e - s) / 60_000)
  }
  if (!mins.length) return null
  mins.sort((a, b) => a - b)
  const mid = Math.floor(mins.length / 2)
  return mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2
}

/** One bar's eta (ISO) by the priority order above, or null — never a guess with zero signal. */
export function estimateEta(bar, { taskTitle = null, bars = [] } = {}) {
  const startMs = Date.parse(bar?.start)
  if (!Number.isFinite(startMs)) return null
  const deadline = parseTaskDeadline(taskTitle)
  if (deadline?.preferHH != null) return shanghaiDeadlineIso(bar.start, deadline.preferHH, deadline.preferMM)
  if (deadline?.hardcapMin != null) return new Date(startMs + deadline.hardcapMin * 60_000).toISOString()
  const p50 = familyP50Minutes(bars, taskFamily(bar?.car || bar?.trace_id), bar?.trace_id)
  if (p50 != null) return new Date(startMs + p50 * 60_000).toISOString()
  return null
}

/**
 * IO: fills `bar.eta` on every still-open bar that doesn't already have one
 * (a trace CLI that learns to supply its own wins — this never overwrites
 * it); a closed bar never gets one (PRD: 已落 FLAG 的车不显示 ETA). One bar's
 * doc read failing (missing file, unreadable) degrades that bar to the P50
 * step, never aborts the export.
 */
export async function addEstimatedEtas(gantt, { readTaskTitle } = {}) {
  const bars = Array.isArray(gantt?.bars) ? gantt.bars : []
  for (const b of bars) {
    if (!b || b.eta || !isOpenBar(b)) continue
    let taskTitle = null
    const taskPath = b?.links?.task
    if (taskPath && readTaskTitle) {
      try { taskTitle = await readTaskTitle(taskPath) } catch { taskTitle = null }
    }
    const eta = estimateEta(b, { taskTitle, bars })
    if (eta) b.eta = eta
  }
  return gantt
}

// ─── "waiting on you" signals (pure) ────────────────────────────────────────

/** A directory entry name → { kind, tag } for a waiting signal, or null. */
export function classifySignalName(name) {
  if (typeof name !== 'string') return null
  if (name.startsWith('NEEDSIG_')) {
    const tag = name.slice('NEEDSIG_'.length)
    return tag ? { kind: 'needsig', tag } : null
  }
  if (name.startsWith('FLAG_')) {
    const tag = name.slice('FLAG_'.length)
    // FLAG_<tag>.accepted-HHMM (any suffix after a dot) = already accepted
    return tag && !tag.includes('.') ? { kind: 'flag', tag } : null
  }
  return null
}

/**
 * NEEDSIG_<tag>* may carry a suffix (NEEDSIG_<tag>_login, NEEDSIG_<tag>.txt):
 * the car is the longest known trace id the tag starts with, followed by the
 * end or a non-alphanumeric char. No match → null (shown by its tag, never
 * attached to a guessed car).
 */
export function matchTraceId(tag, traceIds) {
  if (traceIds.has(tag)) return tag
  let best = null
  for (const id of traceIds) {
    if (tag.length > id.length && tag.startsWith(id) && !/[A-Za-z0-9]/.test(tag[id.length]) && (!best || id.length > best.length)) best = id
  }
  return best
}

/**
 * Directory names → the signal files worth stat'ing. `traceIds` is null when
 * the car list is unavailable: then delivered flags can't be told apart from
 * scheduled-job flags, so none are picked (flags_checked:false says so).
 */
export function pickSignals(names, traceIds) {
  const picks = []
  let skippedFlags = 0
  for (const name of names) {
    const c = classifySignalName(name)
    if (!c) continue
    if (c.kind === 'needsig') {
      picks.push({ name, kind: c.kind, tag: c.tag, traceId: traceIds ? matchTraceId(c.tag, traceIds) : null })
    } else if (traceIds && traceIds.has(c.tag)) {
      picks.push({ name, kind: c.kind, tag: c.tag, traceId: c.tag })
    } else if (traceIds) {
      skippedFlags++
    }
  }
  return { picks, skippedFlags, flagsChecked: !!traceIds }
}

/** Picks + their mtime / text → the `waiting` envelope section. */
export function buildWaitingSection({ picked, files, now = new Date(), error = null }) {
  if (error) {
    return { schema: WAITING_SCHEMA, scanned_at: now.toISOString(), ok: false, error: String(error), flags_checked: false, skipped_flags: 0, items: [] }
  }
  const items = []
  for (const p of picked.picks) {
    const f = files.get(p.name)
    if (!f) continue // vanished between readdir and stat (accepted / resolved meanwhile)
    items.push({
      kind: p.kind,
      tag: p.tag,
      file: p.name,
      trace_id: p.traceId,
      since: new Date(f.mtimeMs).toISOString(),
      text: p.kind === 'needsig' ? (f.text || '').trim().slice(0, NEEDSIG_TEXT_MAX_CHARS) : null,
    })
  }
  items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
  return {
    schema: WAITING_SCHEMA,
    scanned_at: now.toISOString(),
    ok: true,
    error: null,
    flags_checked: picked.flagsChecked,
    skipped_flags: picked.skippedFlags,
    items,
  }
}

/**
 * Pure: build the envelope from either a parsed gantt (success) or an error.
 * `prev` is the previous envelope (or null) — only its last_ok_at is carried.
 * `waiting` (the signals section, or null when not scanned) rides along either
 * way: the signal scan does not depend on the trace store.
 */
export function buildEnvelope({ gantt = null, error = null, prev = null, now = new Date(), from, waiting = null }) {
  const exportedAt = now.toISOString()
  if (error) {
    return {
      schema: CARS_EXPORT_SCHEMA,
      exported_at: exportedAt,
      ok: false,
      error: String(error),
      last_ok_at: prev?.schema === CARS_EXPORT_SCHEMA ? prev.last_ok_at || null : null,
      window_from: from,
      gantt: null,
      waiting,
    }
  }
  if (gantt?.schema !== GANTT_SCHEMA) {
    return buildEnvelope({ error: `trace gantt returned schema ${JSON.stringify(gantt?.schema)}, want ${GANTT_SCHEMA}`, prev, now, from, waiting })
  }
  return {
    schema: CARS_EXPORT_SCHEMA,
    exported_at: exportedAt,
    ok: true,
    error: null,
    last_ok_at: exportedAt,
    window_from: from,
    gantt: stripGantt(gantt),
    waiting,
  }
}

export async function writeAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(obj))
  await rename(tmp, path)
}

async function readHead(path, maxBytes) {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally { await fh.close() }
}

/** IO: one readdir, then stat (+ read NEEDSIG text) only for the picks. */
export async function scanWaiting(dir, gantt, now = () => new Date()) {
  try {
    const bars = gantt?.schema === GANTT_SCHEMA && Array.isArray(gantt.bars) ? gantt.bars : null
    const traceIds = bars ? new Set(bars.map((b) => b?.trace_id).filter((id) => typeof id === 'string' && id)) : null
    const picked = pickSignals(await readdir(dir), traceIds)
    const files = new Map()
    await Promise.all(picked.picks.map(async (p) => {
      const full = join(dir, p.name)
      try {
        const st = await stat(full)
        if (!st.isFile()) return
        files.set(p.name, { mtimeMs: st.mtimeMs, text: p.kind === 'needsig' ? await readHead(full, NEEDSIG_TEXT_MAX_BYTES) : null })
      } catch { /* gone since readdir: skip */ }
    }))
    return buildWaitingSection({ picked, files, now: now() })
  } catch (err) {
    return buildWaitingSection({ error: `signals dir unreadable: ${err.code || err.message}`, now: now() })
  }
}

function runTraceGantt(traceCmd, from) {
  return new Promise((resolve, reject) => {
    execFile(traceCmd, ['gantt', `--from=${from}`, '--to', 'now'], { timeout: TRACE_TIMEOUT_MS, maxBuffer: TRACE_MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').trim().split('\n').slice(-2).join(' | ')
        return reject(new Error(`trace gantt failed (${err.code ?? err.signal ?? err.message})${tail ? `: ${tail}` : ''}`))
      }
      try { resolve(JSON.parse(stdout)) } catch (e) { reject(new Error(`trace gantt output is not JSON: ${e.message}`)) }
    })
  })
}

function parseArgs(argv) {
  const out = { from: '-3d' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--trace-cmd') out.traceCmd = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--from') out.from = argv[++i]
    else if (a === '--signals-dir') out.signalsDir = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.traceCmd || !out.out) throw new Error('usage: export-cars.mjs --trace-cmd <trace> --out <cars.json> [--from -3d] [--signals-dir <dir>]')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let prev = null
  try { prev = JSON.parse(await readFile(args.out, 'utf8')) } catch { /* first run or unreadable: no last_ok_at to carry */ }
  let gantt = null
  let ganttError = null
  try { gantt = await runTraceGantt(args.traceCmd, args.from) } catch (err) { ganttError = err.message }
  if (gantt?.schema === GANTT_SCHEMA) {
    try {
      await addEstimatedEtas(gantt, { readTaskTitle: async (p) => (await readHead(p, TASK_TITLE_MAX_BYTES)).split('\n', 1)[0] })
    } catch (err) {
      // ETA is a nice-to-have on top of the real gantt data: a bug here degrades
      // to "no eta this run", never fails the whole export (fail-loud stays on
      // the trace gantt itself, above).
      console.error(`[export-cars] eta estimation skipped: ${err.message}`)
    }
  }
  const waiting = args.signalsDir ? await scanWaiting(args.signalsDir, gantt) : null
  const env = ganttError
    ? buildEnvelope({ error: ganttError, prev, from: args.from, waiting })
    : buildEnvelope({ gantt, prev, from: args.from, waiting })
  await writeAtomic(args.out, env)
  const w = waiting ? (waiting.ok ? `, waiting ${waiting.items.length} (skipped flags ${waiting.skipped_flags})` : `, waiting FAILED: ${waiting.error}`) : ''
  if (!env.ok) {
    console.error(`[export-cars] FAILED: ${env.error}${w}`)
    process.exit(1)
  }
  console.log(`[export-cars] ok: ${env.gantt.n_bars ?? env.gantt.bars.length} bars${w} → ${args.out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => { console.error(`[export-cars] ${err.message}`); process.exit(2) })
}
