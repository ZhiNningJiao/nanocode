#!/usr/bin/env node
/**
 * One-off: attach an issue to old cars that were dispatched before the
 * dispatch gate required one, so the board can file them.
 *
 *   node tools/dispatch/backfill-issue-map.mjs [--config <dispatch config>]            (list only — the default)
 *   node tools/dispatch/backfill-issue-map.mjs --write [--include-inferred]            (append to the tag↔issue map)
 *
 * Candidates = cars in the cars export with no issue and no line in the map.
 * Evidence, strongest first (each record says which one it used):
 *   task_title   the car's task book heading names one tracker key ("Linear TEAM-113")
 *   trace_parent the car is a re-dispatch of a car that has an issue
 *   maintenance  tag starts with a configured scheduled-job prefix → `none:<reason>`
 *   tag_prefix   tag starts with a prefix the secretary mapped to a line in the
 *                local config (backfill.tagPrefixLines) → that line's parent.
 *                This one is a human-given mapping, not a fact read off the car,
 *                so it is listed separately and written only with --include-inferred.
 * Every key that would be written is checked against the tracker (read-only):
 * it must exist and sit under the root. Everything left over is listed with why.
 */

import { readFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDispatchConfig, readIssueMap, DISPATCH_CONFIG_PATH } from './dispatch.mjs'
import { mapCarsExport } from '../../server/command-center.js'
import { createLineageSource, lineageIncludes, ISSUE_KEY_RE } from '../../server/linear-lineage.js'

const TITLE_KEY_RE = /Linear\s+([A-Z][A-Z0-9]*-\d+)/g
const HEADING_MAX_BYTES = 4096

/** Tracker keys named as "Linear KEY" in a task book heading (first line). */
export function titleKeys(heading) {
  return [...new Set([...String(heading || '').matchAll(TITLE_KEY_RE)].map((m) => m[1]))]
}

function longestPrefix(tag, table) {
  let best = null
  for (const p of Object.keys(table || {})) if (tag.startsWith(p) && (!best || p.length > best.length)) best = p
  return best
}

/**
 * Pure: decide per car. cars = mapped cars; issueMap = Map tag→issue;
 * headings = Map tag→first line of its task book (or undefined);
 * cfg.backfill = { maintenancePrefixes, tagPrefixLines }; cfg.lines.
 * → { proposals: [{ tag, issue, source, note, start }], left: [{ tag, why }] }
 */
export function proposeBackfill({ cars, issueMap, headings, cfg }) {
  const known = new Map(issueMap)
  const todo = cars.filter((c) => !c.issue && !known.has(c.car))
  const proposals = []
  const left = []
  const byTag = new Map(todo.map((c) => [c.car, c]))
  const decided = new Map()
  const decide = (c) => {
    if (decided.has(c.car)) return decided.get(c.car)
    decided.set(c.car, null) // cycle guard
    let out = null
    const keys = titleKeys(headings.get(c.car))
    if (keys.length === 1) out = { issue: keys[0], source: 'task_title', note: `任务书标题写着 Linear ${keys[0]}` }
    else if (keys.length > 1) out = { issue: null, why: `任务书标题里有 ${keys.length} 个单号（${keys.join(', ')}），不替你挑` }
    if (!out && c.parent) {
      // a re-dispatch inherits its parent's issue — and its parent's certainty:
      // a parent whose issue was only inferred from a tag prefix stays inferred
      const pd = known.has(c.parent) ? { issue: known.get(c.parent), source: 'map' } : (byTag.has(c.parent) ? decide(byTag.get(c.parent)) : null)
      if (pd?.issue) {
        out = pd.source === 'tag_prefix'
          ? { issue: pd.issue, source: 'tag_prefix', note: `续跑自 ${c.parent}，它的单 ${pd.issue} 是前缀推断的` }
          : { issue: pd.issue, source: 'trace_parent', note: `续跑自 ${c.parent}（${pd.issue}）` }
      }
    }
    const mp = longestPrefix(c.car, cfg.backfill?.maintenancePrefixes)
    if (!out && mp) out = { issue: `none:${cfg.backfill.maintenancePrefixes[mp]}`, source: 'maintenance', note: `定时作业前缀 ${mp}` }
    const lp = longestPrefix(c.car, cfg.backfill?.tagPrefixLines)
    if (!out && lp) {
      const alias = cfg.backfill.tagPrefixLines[lp]
      const line = cfg.lines[alias]
      out = line ? { issue: line.parent, source: 'tag_prefix', note: `tag 前缀 ${lp} → 线 ${alias}（秘书在本地配置里给的对应）` } : { issue: null, why: `tag 前缀 ${lp} 指向的线 ${alias} 不在线表里` }
    }
    if (!out) out = { issue: null, why: headings.has(c.car) ? '任务书标题没写 Linear 单号，没有续跑来源，也没配前缀' : '找不到任务书，没有续跑来源，也没配前缀' }
    decided.set(c.car, out)
    return out
  }
  for (const c of todo) {
    const d = decide(c)
    if (d.issue) proposals.push({ tag: c.car, issue: d.issue, source: d.source, note: d.note, start: c.start })
    else left.push({ tag: c.car, why: d.why })
  }
  return { proposals, left }
}

/** The map's other reader parses dispatched_at with Python's fromisoformat: no trailing Z. */
export function isoNoZ(s) {
  return String(s).replace(/\.\d+Z$/, '+00:00').replace(/Z$/, '+00:00')
}

async function heading(path) {
  try {
    const buf = await readFile(path)
    return buf.subarray(0, HEADING_MAX_BYTES).toString('utf8').split('\n')[0]
  } catch { return undefined }
}

async function main(argv) {
  const args = argv.slice(2)
  const write = args.includes('--write')
  const includeInferred = args.includes('--include-inferred')
  const ci = args.indexOf('--config')
  const { config: cfg, error } = loadDispatchConfig(ci >= 0 ? args[ci + 1] : DISPATCH_CONFIG_PATH)
  if (error) { console.error(error); return 2 }

  const cars = mapCarsExport(JSON.parse(await readFile(cfg.cc.carsPath, 'utf8'))).cars
  const issueMap = await readIssueMap(cfg.paths.issueMap)
  const headings = new Map()
  for (const c of cars) if (!c.issue) { const h = await heading(join(cfg.paths.workRoot, `TASK_${c.car}.md`)); if (h !== undefined) headings.set(c.car, h) }
  const { proposals, left } = proposeBackfill({ cars, issueMap, headings, cfg })
  const total = proposals.length + left.length

  // every real key must exist and sit under the root (read-only lookups)
  const lin = await createLineageSource().get(cfg.graphqlUrl, proposals.map((p) => p.issue).filter((k) => ISSUE_KEY_RE.test(k)))
  const good = []
  for (const p of proposals) {
    if (!ISSUE_KEY_RE.test(p.issue)) { good.push(p); continue }
    const e = lin.get(p.issue)
    if (!e?.ok) left.push({ tag: p.tag, why: `${p.issue} 查不了 Linear：${e?.error || '无结果'}` })
    else if (!e.data.found) left.push({ tag: p.tag, why: `${p.issue} 在 Linear 里查不到` })
    else if (!lineageIncludes(e.data, cfg.rootIssue) || p.issue === cfg.rootIssue) left.push({ tag: p.tag, why: `${p.issue} 不在根 ${cfg.rootIssue} 下面` })
    else good.push(p)
  }
  const facts = good.filter((p) => p.source !== 'tag_prefix')
  const inferred = good.filter((p) => p.source === 'tag_prefix')
  const show = (title, list) => { console.log(`\n## ${title}：${list.length}`); for (const p of list) console.log(`  ${p.tag}  →  ${p.issue}   [${p.source}] ${p.note}`) }
  console.log(`没挂单的车 ${total} 辆（cars export 里 issue 为空、登记表里也没有）`)
  show('有凭据可补', facts)
  show('按本地配置前缀推断（要 --include-inferred 才写）', inferred)
  console.log(`\n## 补不了：${left.length}`)
  for (const l of left) console.log(`  ${l.tag}  —  ${l.why}`)

  const toWrite = includeInferred ? [...facts, ...inferred] : facts
  if (!write) { console.log(`\nDRY-RUN：会写 ${toWrite.length} 行到 ${cfg.paths.issueMap}（加 --write 才真写）`); return 0 }
  const lines = toWrite.map((p) => JSON.stringify({ tag: p.tag, issue: p.issue, dispatched_at: isoNoZ(p.start || new Date().toISOString()), source: `backfill_${p.source}`, note: p.note }))
  if (lines.length) await appendFile(cfg.paths.issueMap, `${lines.join('\n')}\n`)
  console.log(`\n已追加 ${lines.length} 行到 ${cfg.paths.issueMap}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => process.exit(code), (e) => { console.error(e?.stack || e); process.exit(1) })
}
