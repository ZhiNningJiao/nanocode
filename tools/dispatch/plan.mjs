/**
 * Dispatch planning: form + local config + live readings → either a list of
 * refusals (each with a stable code and a plain sentence) or a complete plan
 * (task book text, the exact dispatch command, pool reason). No side
 * effects; every IO goes through `deps`, so each refusal is unit-testable.
 *
 * deps = {
 *   nowMs,
 *   exists(path) → Promise<bool>,
 *   listWorkRoot() → Promise<string[]>        names directly under workRoot
 *   issueMapTags() → Promise<Set<string>>     tags already registered to an issue
 *   lineage(keys) → Promise<Map>              server/linear-lineage.js source .get
 *   quotaRows() → Promise<rows>               server/command-center-quota.js rows
 *   cars() → Promise<cars>                    mapped cars export (command-center mapBar shape)
 *   template?                                 task book template text (tests)
 * }
 */

import { isAbsolute } from 'node:path'
import { normalizeForm, MODELS, CATEGORY_LINES } from './form.mjs'
import { pickPool, bjtStamp } from './pool-pick.mjs'

export { bjtStamp }
import { renderTaskbook, findKeyShapes, loadTemplate } from './taskbook.mjs'
import { lineageIncludes } from '../../server/linear-lineage.js'

function err(code, msg) { return { code, msg } }

const ALIVE_STATES = new Set(['queued', 'running', 'waiting_human', 'blocked'])

/** Cars still running per pool name ("T3" → 2). */
export function runningByPool(cars) {
  const out = {}
  for (const c of cars || []) if (c.endOpen && ALIVE_STATES.has(c.state) && c.pool) out[c.pool] = (out[c.pool] || 0) + 1
  return out
}

/** Display-only shell rendering of an env + argv (single-quoted); never executed. */
export function shellQuote(s) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`
}

export async function planDispatch(rawForm, cfg, deps) {
  const { form, errors } = normalizeForm(rawForm, { nowMs: deps.nowMs, lines: cfg.lines })
  if (errors.some((e) => ['missing_field', 'bad_tag', 'unknown_line', 'bad_model', 'bad_issue'].includes(e.code))) {
    return { ok: false, errors, form }
  }
  const W = cfg.paths.workRoot
  const tag = form.tag
  const isCategory = CATEGORY_LINES.includes(form.line)
  const line = isCategory ? null : cfg.lines[form.line]
  const model = MODELS[form.model]

  // ── paths the car will read ──
  for (const r of form.readFirst) {
    if (!isAbsolute(r.path)) errors.push(err('read_first_not_absolute', `先读路径不是绝对路径：${r.path}`))
    else if (!(await deps.exists(r.path))) errors.push(err('read_first_missing', `先读路径不存在：${r.path}`))
  }

  // ── tag not used before ──
  const names = await deps.listWorkRoot()
  const flagHits = names.filter((n) => n === `FLAG_${tag}` || n.startsWith(`FLAG_${tag}.`) || n.startsWith(`FLAG_${tag}_`))
  if (flagHits.length) errors.push(err('tag_taken', `tag ${tag} 已用过：${flagHits.slice(0, 3).join(', ')}`))
  if (names.includes(`TASK_${tag}.md`)) errors.push(err('tag_taken', `tag ${tag} 已有任务书 TASK_${tag}.md`))
  if (names.includes(tag)) errors.push(err('tag_taken', `tag ${tag} 已有工区目录`))
  if ((await deps.issueMapTags()).has(tag)) errors.push(err('tag_taken', `tag ${tag} 已在派车登记表里挂过单`))

  // ── tracker: the line's parent must still sit under the root; the issue must sit under the line ──
  // daily/misc (dailycat_0955): no tracker issue exists at all, so none of this applies —
  // the whole point is these cars don't need Linear to be reachable to dispatch.
  const cars = await deps.cars()
  const openCars = (cars || []).filter((c) => c.endOpen && ALIVE_STATES.has(c.state) && c.car !== tag)
  let lin = new Map()
  if (!isCategory) {
    const keys = [line.parent, ...(form.issue ? [form.issue] : []), ...openCars.map((c) => c.issue).filter(Boolean)]
    lin = await deps.lineage(keys)
    const lp = lin.get(line.parent)
    if (!lp?.ok) errors.push(err('linear_unreachable', `Linear 查不通，没法确认线 ${form.line} 的父单 ${line.parent}：${lp?.error || '无结果'}`))
    else if (!lp.data.found) errors.push(err('line_parent_missing', `线 ${form.line} 的父单 ${line.parent} 在 Linear 里查不到（本地配置该更新了）`))
    else if (line.parent === cfg.rootIssue || !lineageIncludes(lp.data, cfg.rootIssue)) {
      errors.push(err('line_not_under_root', `线 ${form.line} 的父单 ${line.parent} 现在不在根 ${cfg.rootIssue} 下面（父链：${lp.data.chain.map((n) => n.key).join(' → ')}）；owner 可能改过结构，先改本地配置的线表`))
    }
    if (form.issue) {
      const li = lin.get(form.issue)
      if (!li?.ok) errors.push(err('linear_unreachable', `Linear 查不通，没法确认单 ${form.issue}：${li?.error || '无结果'}`))
      else if (!li.data.found) errors.push(err('issue_not_found', `单 ${form.issue} 在 Linear 里查不到`))
      else {
        if (li.data.closed) errors.push(err('issue_closed', `单 ${form.issue} 已关`))
        if (!lineageIncludes(li.data, line.parent)) errors.push(err('issue_not_in_line', `单 ${form.issue} 不在线 ${form.line}（${line.parent}）下面（父链：${li.data.chain.map((n) => n.key).join(' → ')}）`))
      }
    }
  }

  // ── pool ──
  let pool = null
  let poolWhy = 'GLM 走自建网关，不占 Claude 池'
  let considered = []
  if (model?.claude) {
    const picked = pickPool({
      pools: cfg.pools,
      quotaRows: await deps.quotaRows(),
      runningByPool: runningByPool(cars),
      heavy: form.heavy,
      nowMs: deps.nowMs,
      rules: cfg.poolRules,
      requested: form.pool,
      allowSecretaryPool: form.allowSecretaryPool,
    })
    considered = picked.considered
    if (!picked.pool) errors.push(err(form.pool ? 'pool_capped' : 'no_pool', picked.error))
    else { pool = picked.pool; poolWhy = picked.why }
  } else if (form.pool) {
    errors.push(err('pool_not_applicable', `model ${form.model} 不用 Claude 池，别填 pool`))
  }

  // ── siblings: cars still running on the same line (by real parent chain) + the form's own ──
  // daily/misc cars have no parent chain to match against — siblings are whatever the form names.
  const siblings = new Set(form.siblings)
  if (!isCategory) {
    for (const c of openCars) {
      const e = c.issue ? lin.get(c.issue) : null
      if (e?.ok && lineageIncludes(e.data, line.parent)) siblings.add(c.car)
    }
  }
  siblings.delete(tag)

  // ── task book ──
  const issueText = form.issue || `（新建：${line.parent} 下的子单「${form.newIssue?.title || ''}」）`
  let taskbook = ''
  try {
    taskbook = renderTaskbook(form, {
      modelLabel: model?.label || form.model,
      hostLabel: cfg.hostLabel,
      paths: cfg.paths,
      issue: form.issue || '<新建子单>',
      siblings: [...siblings].sort(),
    }, deps.template ?? loadTemplate())
  } catch (e) {
    errors.push(err('template_error', String(e.message || e)))
  }
  for (const h of findKeyShapes(taskbook)) errors.push(err('key_in_taskbook', `任务书里有 key 形状的字符串（${h.kind}：${h.sample}），拒派`))

  // ── the dispatch command (same shape as the hand-typed one it replaces) ──
  const paths = {
    workdir: `${W}/${tag}`,
    tmp: `${W}/${tag}/tmp`,
    task: `${W}/TASK_${tag}.md`,
    flag: `${W}/FLAG_${tag}`,
    log: `${W}/loop_${tag}.log`,
    step: `${W}/STEP_${tag}.md`,
    report: `${W}/REPORT_${tag}.md`,
  }
  const seconds = Math.round(form.hardCapHours * 3600)
  const poolCfg = pool ? cfg.pools[pool] : null
  const env = {
    LINEAR_ISSUE: form.issue || '<新建子单>',
    WORKER_CLAUDE_EFFORT: form.effort,
    ...(poolCfg ? { WORKER_CLAUDE_CONFIG_DIR: poolCfg.configDir, ...(poolCfg.env || {}) } : {}),
    ...(form.ownerFableOk ? { OWNER_FABLE_OK: form.ownerFableOk } : {}),
  }
  const argv = ['bash', cfg.paths.dispatchScript, tag, paths.workdir, paths.flag, paths.task, paths.log, model?.arg ?? '', String(seconds)]
  const etaMs = deps.nowMs + seconds * 1000
  const plan = {
    tag,
    line: form.line,
    lineParent: line?.parent || null,
    team: line?.team || null,
    issue: form.issue,
    newIssue: form.newIssue,
    issueText,
    model: form.model,
    effort: form.effort,
    hardCapHours: form.hardCapHours,
    seconds,
    pool,
    poolWhy,
    considered,
    guardTagsFile: poolCfg?.guardTagsFile || null,
    siblings: [...siblings].sort(),
    paths,
    env,
    argv,
    cwd: W,
    timeoutSec: cfg.dispatchTimeoutSec,
    taskbook,
    eta: bjtStamp(etaMs),
    command: `mkdir -p ${shellQuote(paths.tmp)} && cd ${shellQuote(W)} && ${Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')} timeout ${cfg.dispatchTimeoutSec} ${argv.map(shellQuote).join(' ')}`,
  }
  const lineDesc = line ? `${form.line}（${line.parent}）` : `${form.line}（${form.line === 'daily' ? '每日' : '杂项'}，无 Linear 单）`
  plan.summary = `派车 ${tag} | 线 ${lineDesc}| 单 ${form.issue || `新建「${form.newIssue?.title}」`} | 池 ${pool || '—（GLM）'} | ${model?.label || form.model} ${form.effort} | 硬顶 ${form.hardCapHours} 小时 | 预计交付 ${plan.eta}`
  return { ok: errors.length === 0, errors, form, plan }
}
