#!/usr/bin/env node
/**
 * 派车 — one form (JSON) in, one car out.
 *
 *   node tools/dispatch/dispatch.mjs <form.json> --dry-run [--preview-dir <dir>]
 *   node tools/dispatch/dispatch.mjs <form.json>                 (really dispatch)
 *   node tools/dispatch/dispatch.mjs steer <tag> <message-file> [--dry-run]
 *   [--config <path>]   default config/dispatch.local.json (gitignored)
 *
 * What it replaces: the hand-typed `LINEAR_ISSUE=… WORKER_CLAUDE_…=… timeout …
 * bash <dispatch script> …` line and the hand-copied red-line section. The
 * existing dispatch script stays the one place that launches cars; this
 * tool only fills its arguments from a checked form.
 *
 * --dry-run: prints the task book path (and writes the generated book to
 * --preview-dir if given), the exact dispatch command, the pool choice with
 * every pool's reason, and the ledger summary line. Nothing is created,
 * written or launched. A real dispatch only runs on a configured host
 * (`hostNames`).
 *
 * Exit codes: 0 ok · 2 usage/config · 4 refused (reasons printed) · 5 dispatch failed.
 */

import { readFile, readdir, stat, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planDispatch } from './plan.mjs'
import { executeDispatch } from './execute.mjs'
import { createChildIssue } from './linear-create.mjs'
import { TAG_RE } from './form.mjs'
import { createLineageSource } from '../../server/linear-lineage.js'
import { loadCommandCenterConfig, mapCarsExport } from '../../server/command-center.js'
import { createQuotaSource } from '../../server/command-center-quota.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DISPATCH_CONFIG_PATH = join(REPO, 'config', 'dispatch.local.json')

/** Local config → { config } | { error }. Tracker root / quota / cars come from the command-center config (one source). */
export function loadDispatchConfig(path = DISPATCH_CONFIG_PATH) {
  let c
  try { c = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { return { error: `dispatch config ${path} unreadable: ${e.code || e.message}` } }
  const p = c.paths || {}
  const missing = ['workRoot', 'dispatchScript', 'steerScript', 'sharedCheckouts', 'issueMap'].filter((k) => typeof p[k] !== 'string' || !p[k]).map((k) => `paths.${k}`)
  if (!c.lines || typeof c.lines !== 'object' || !Object.keys(c.lines).length) missing.push('lines')
  if (!c.pools || typeof c.pools !== 'object' || !Object.keys(c.pools).length) missing.push('pools')
  if (!Array.isArray(c.hostNames) || !c.hostNames.length) missing.push('hostNames')
  if (missing.length) return { error: `dispatch config missing ${missing.join(', ')}` }
  for (const [alias, l] of Object.entries(c.lines)) if (typeof l?.parent !== 'string') return { error: `dispatch config lines.${alias}.parent missing` }
  for (const [name, pl] of Object.entries(c.pools)) if (typeof pl?.configDir !== 'string') return { error: `dispatch config pools.${name}.configDir missing` }
  const ccPath = c.commandCenterConfig ? (isAbsolute(c.commandCenterConfig) ? c.commandCenterConfig : join(REPO, c.commandCenterConfig)) : undefined
  const cc = loadCommandCenterConfig(ccPath)
  if (cc.error) return { error: `dispatch needs the command-center config (tracker root, quota, cars): ${cc.error}` }
  return {
    config: {
      hostNames: c.hostNames,
      hostLabel: typeof c.hostLabel === 'string' && c.hostLabel ? c.hostLabel : c.hostNames[0],
      steerSsh: typeof c.steerSsh === 'string' && c.steerSsh ? c.steerSsh : null,
      paths: { ...p, boardRoot: typeof p.boardRoot === 'string' ? p.boardRoot : null },
      lines: c.lines,
      pools: c.pools,
      poolRules: c.poolRules || {},
      dispatchTimeoutSec: Number.isFinite(c.dispatchTimeoutSec) ? c.dispatchTimeoutSec : 280,
      backfill: c.backfill || {},
      rootIssue: cc.config.rootIssue,
      graphqlUrl: cc.config.graphqlUrl,
      cc: cc.config,
    },
  }
}

/** Tags registered in the tag↔issue map (bad lines skipped, same as its other reader). */
export async function readIssueMap(path) {
  let text = ''
  try { text = await readFile(path, 'utf8') } catch (e) { if (e.code === 'ENOENT') return new Map(); throw e }
  const out = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (typeof r.tag === 'string' && typeof r.issue === 'string') out.set(r.tag, r.issue)
    } catch { /* bad line: skipped */ }
  }
  return out
}

export function realDeps(cfg, { nowMs = Date.now() } = {}) {
  const lineageSource = createLineageSource()
  return {
    nowMs,
    exists: async (p) => { try { await stat(p); return true } catch { return false } },
    listWorkRoot: () => readdir(cfg.paths.workRoot),
    issueMapTags: async () => new Set((await readIssueMap(cfg.paths.issueMap)).keys()),
    lineage: (keys) => lineageSource.get(cfg.graphqlUrl, keys),
    quotaRows: async () => {
      const q = await createQuotaSource().get(cfg.cc.quotaDir, cfg.cc.quotaStaleSec, {
        usageSnapLogPath: cfg.cc.quotaUsageSnapLogPath,
        dispatchLogDirs: cfg.cc.quotaDispatchLogDirs,
      })
      return q.ok ? q.data.pools : []
    },
    cars: async () => mapCarsExport(JSON.parse(await readFile(cfg.cc.carsPath, 'utf8'))).cars,
  }
}

function runArgv(argv, { env, cwd, timeoutSec, stdinText = null }) {
  return new Promise((res) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutSec * 1000)
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d) })
    child.on('close', (code) => { clearTimeout(timer); res({ code: code ?? 1, stdout, stderr }) })
    child.on('error', (e) => { clearTimeout(timer); res({ code: 127, stdout, stderr: String(e) }) })
    if (stdinText != null) child.stdin.end(stdinText)
    else child.stdin.end()
  })
}

function printPlan(plan, previewPath) {
  console.log(`任务书: ${plan.paths.task}${previewPath ? `（预览已写到 ${previewPath}）` : ''}`)
  console.log(`选池: ${plan.poolWhy}`)
  for (const j of plan.considered) console.log(`  ${j.ok ? '✓' : '✗'} ${j.why}`)
  if (plan.siblings.length) console.log(`姊妹车（同线在跑）: ${plan.siblings.join(', ')}`)
  if (plan.guardTagsFile) console.log(`超额守卫登记: 追加 ${plan.tag} 到 ${plan.guardTagsFile}`)
  console.log(`派车命令: ${plan.command}`)
  console.log(`摘要: ${plan.summary}`)
}

async function cmdSteer(cfg, args, dryRun) {
  const [tag, msgFile] = args
  if (!tag || !TAG_RE.test(tag) || !msgFile || !isAbsolute(msgFile)) {
    console.error('usage: dispatch.mjs steer <tag> <message-file 绝对路径> [--dry-run]')
    return 2
  }
  let msg
  try { msg = await readFile(msgFile, 'utf8') } catch (e) { console.error(`REFUSED: 消息文件读不了：${e.code || e.message}`); return 4 }
  if (!msg.trim()) { console.error('REFUSED: 消息文件是空的'); return 4 }
  const local = cfg.hostNames.includes(hostname())
  if (!local && !cfg.steerSsh) { console.error(`REFUSED: 转向要在车所在的机器上跑（${cfg.hostNames.join(', ')}），本机 ${hostname()}，又没配 steerSsh`); return 4 }
  // the remote shell sees only fixed words + a validated tag; the message goes over stdin
  const argv = local ? ['bash', cfg.paths.steerScript, tag, '-'] : ['ssh', cfg.steerSsh, `timeout 60 bash ${cfg.paths.steerScript} ${tag} -`]
  console.log(`转向命令: ${argv.join(' ')} < ${msgFile}`)
  if (dryRun) return 0
  const r = await runArgv(argv, { env: {}, cwd: cfg.paths.workRoot, timeoutSec: 90, stdinText: msg })
  return r.code === 0 ? 0 : 5
}

async function main(argv) {
  const args = argv.slice(2)
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v }
  const dryRun = args.includes('--dry-run')
  if (dryRun) args.splice(args.indexOf('--dry-run'), 1)
  const configPath = flag('--config') || DISPATCH_CONFIG_PATH
  const previewDir = flag('--preview-dir')
  const { config: cfg, error } = loadDispatchConfig(configPath)
  if (error) { console.error(error); return 2 }

  if (args[0] === 'steer') return cmdSteer(cfg, args.slice(1), dryRun)
  if (args.length !== 1) { console.error('usage: dispatch.mjs <form.json> [--dry-run] [--preview-dir <dir>] [--config <path>] | steer <tag> <msgfile> [--dry-run]'); return 2 }

  let form
  try { form = JSON.parse(await readFile(args[0], 'utf8')) } catch (e) { console.error(`form ${args[0]} unreadable: ${e.code || e.message}`); return 2 }
  const res = await planDispatch(form, cfg, realDeps(cfg))
  if (!res.ok) {
    console.error(`REFUSED: 拒派 ${res.form?.tag || ''}，${res.errors.length} 条：`)
    for (const e of res.errors) console.error(`  [${e.code}] ${e.msg}`)
    for (const j of res.plan?.considered || []) console.error(`    ${j.ok ? '✓' : '✗'} ${j.why}`)
    return 4
  }
  const plan = res.plan
  let previewPath = null
  if (dryRun && previewDir) {
    await mkdir(previewDir, { recursive: true })
    previewPath = join(previewDir, `TASK_${plan.tag}.md`)
    await writeFile(previewPath, plan.taskbook)
  }
  printPlan(plan, previewPath)
  if (dryRun) { console.log('DRY-RUN：没建单、没写文件（预览除外）、没派车。'); return 0 }

  if (!cfg.hostNames.includes(hostname())) { console.error(`REFUSED: 真派只在 ${cfg.hostNames.join(', ')} 上跑，本机 ${hostname()}`); return 4 }
  const out = await executeDispatch(plan, {
    createIssue: (spec) => createChildIssue({ graphqlUrl: cfg.graphqlUrl }, spec),
    mkdir: (p) => mkdir(p, { recursive: true }),
    writeNew: (p, text) => writeFile(p, text, { flag: 'wx' }),
    appendLine: (p, line) => appendFile(p, `${line}\n`),
    run: (av, o) => runArgv(av, o),
  })
  for (const s of out.steps) console.log(`· ${s}`)
  console.log(out.ok ? out.summary : `派车脚本失败（退出码 ${out.run.code}），见上面输出`)
  return out.ok ? 0 : 5
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then((code) => process.exit(code), (e) => { console.error(e?.stack || e); process.exit(1) })
}
