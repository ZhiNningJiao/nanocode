/**
 * Task book (任务书) rendering — pure. The fixed sections (deliver lines,
 * NEEDSIG, sibling re-check, red lines) live in taskbook.template.md next to
 * this file; the form only supplies the car's own sections.
 *
 * Substitution is ONE pass of `{{name}}` → string through a replacer
 * function: values are inserted literally (no `$&` patterns, no second
 * expansion of a `{{…}}` that a value happens to contain) and nothing ever
 * goes through a shell, so backticks / `$(…)` in a task book stay text.
 * An unknown placeholder throws (a template typo is a bug, not a blank).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_PATH = join(HERE, 'taskbook.template.md')

export function loadTemplate(path = TEMPLATE_PATH) {
  return readFileSync(path, 'utf8')
}

export function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) throw new Error(`taskbook template: no value for {{${k}}}`)
    return String(vars[k])
  })
}

function lines(v) {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x.trim())
}

/** Numbered list; continuation lines of an item are indented under it. */
function numbered(items) {
  return lines(items).map((it, i) => `${i + 1}. ${it.replace(/\n/g, '\n   ')}`).join('\n')
}

function bullets(items) {
  return lines(items).map((it) => (it.startsWith('- ') ? it : `- ${it}`).replace(/\n/g, '\n  ')).join('\n')
}

function hoursText(h) {
  return `${Number.isInteger(h) ? h : Number(h.toFixed(2))} 小时`
}

/**
 * form = normalized form (form.mjs); ctx = { modelLabel, hostLabel, paths:
 * { workRoot, sharedCheckouts, boardRoot? }, issue, siblings: [tags] }.
 * → task book text.
 */
export function renderTaskbook(form, ctx, tpl = loadTemplate()) {
  const W = ctx.paths.workRoot
  const tag = form.tag
  const meta = [
    `${ctx.modelLabel} ${form.effort}`,
    ctx.hostLabel,
    `硬顶 ${hoursText(form.hardCapHours)}${form.deadlineNote ? `，${form.deadlineNote}` : ''}`,
    ...lines(form.titleNotes),
    `Linear ${ctx.issue}`,
  ]
  const board = form.boardDir && ctx.paths.boardRoot ? `${ctx.paths.boardRoot}/${form.boardDir}/` : null
  const siblings = ctx.siblings?.length
    ? `- 姊妹车 ${ctx.siblings.map((s) => `\`${s}\``).join('、')} 同时在跑：每次大跑之前、写报告之前，重新看它们的 STEP / REPORT。`
    : '- 同线没有别的车在跑；若中途有新车加入（看板同一行），每次大跑之前、写报告之前，重新看它们的 STEP / REPORT。'
  const extraDeliver = lines(form.deliverExtra)
  return fillTemplate(tpl, {
    tag,
    title: form.title,
    titleMeta: meta.join('；'),
    why: lines(form.why).join('\n'),
    readFirst: numbered(form.readFirst.map((r) => (r.note ? `\`${r.path}\` — ${r.note}` : `\`${r.path}\``))),
    todo: numbered(form.todo),
    report: `${W}/REPORT_${tag}.md`,
    plainAudience: form.plainAudience || '',
    plainLines: form.plainLines,
    deliverExtra: extraDeliver.length ? `；${extraDeliver.join('；')}` : '',
    flag: `${W}/FLAG_${tag}`,
    step: `${W}/STEP_${tag}.md`,
    needsig: `${W}/NEEDSIG_${tag}.md`,
    boardLine: board ? `板放 \`${board}\`（只新建这一个目录，不跑 git），报告里给完整链接。` : '',
    siblings,
    redlinesExtra: lines(form.redlinesExtra).length ? `${bullets(form.redlinesExtra)}\n` : '',
    sharedCheckouts: ctx.paths.sharedCheckouts,
    boardException: board ? `（板目录 \`${board}\` 除外）` : '',
    hostLabel: ctx.hostLabel,
    keyRule: form.keyUse ? `key 只许这样用：${form.keyUse}；不打印、不进命令行参数、不进日志。` : '不用任何 key。',
    workdir: `${W}/${tag}`,
    unitPrefix: tag.replace(/_/g, '-'),
    heavyUnits: form.heavyUnits,
    workRoot: W,
  })
}

// ─── key-shaped strings (refuse to dispatch a task book that carries one) ───

const KEY_SHAPES = [
  ['linear-key', /\blin_api_[A-Za-z0-9]{20,}/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{24,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

/** → [{ kind, sample }] — sample is masked, the key itself is never echoed. */
export function findKeyShapes(text) {
  const hits = []
  for (const [kind, re] of KEY_SHAPES) {
    const m = re.exec(String(text))
    if (m) hits.push({ kind, sample: `${m[0].slice(0, 6)}…(${m[0].length} chars)` })
  }
  return hits
}
