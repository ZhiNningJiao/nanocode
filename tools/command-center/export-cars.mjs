#!/usr/bin/env node
/**
 * Command Center cars exporter — runs on the host that owns the car trace
 * store (the trace CLI's sqlite must be read locally, never over a network
 * mount) and writes ONE JSON file the nanocode server reads.
 *
 *   node tools/command-center/export-cars.mjs --trace-cmd <path/to/trace> \
 *        --out <path/to/cars.json> [--from -3d]
 *
 * It runs `<trace-cmd> gantt --from=<from> --to now` (car-trace-gantt/v1),
 * drops the per-session transcript paths (the dashboard never needs them),
 * wraps the result in a small envelope and writes it atomically (temp file in
 * the same directory + rename), so a reader never sees half a file.
 *
 * Failure is written too (ok:false + error + the previous last_ok_at) and the
 * process exits non-zero, so the dashboard shows "source unreachable + last
 * success" instead of an empty chart, and the timer unit shows the failure.
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CARS_EXPORT_SCHEMA = 'nanocc-cars-export/v1'
export const GANTT_SCHEMA = 'car-trace-gantt/v1'

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

/**
 * Pure: build the envelope from either a parsed gantt (success) or an error.
 * `prev` is the previous envelope (or null) — only its last_ok_at is carried.
 */
export function buildEnvelope({ gantt = null, error = null, prev = null, now = new Date(), from }) {
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
    }
  }
  if (gantt?.schema !== GANTT_SCHEMA) {
    return buildEnvelope({ error: `trace gantt returned schema ${JSON.stringify(gantt?.schema)}, want ${GANTT_SCHEMA}`, prev, now, from })
  }
  return {
    schema: CARS_EXPORT_SCHEMA,
    exported_at: exportedAt,
    ok: true,
    error: null,
    last_ok_at: exportedAt,
    window_from: from,
    gantt: stripGantt(gantt),
  }
}

export async function writeAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(obj))
  await rename(tmp, path)
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
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.traceCmd || !out.out) throw new Error('usage: export-cars.mjs --trace-cmd <trace> --out <cars.json> [--from -3d]')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let prev = null
  try { prev = JSON.parse(await readFile(args.out, 'utf8')) } catch { /* first run or unreadable: no last_ok_at to carry */ }
  let env
  try {
    env = buildEnvelope({ gantt: await runTraceGantt(args.traceCmd, args.from), prev, from: args.from })
  } catch (err) {
    env = buildEnvelope({ error: err.message, prev, from: args.from })
  }
  await writeAtomic(args.out, env)
  if (!env.ok) {
    console.error(`[export-cars] FAILED: ${env.error}`)
    process.exit(1)
  }
  console.log(`[export-cars] ok: ${env.gantt.n_bars ?? env.gantt.bars.length} bars → ${args.out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => { console.error(`[export-cars] ${err.message}`); process.exit(2) })
}
