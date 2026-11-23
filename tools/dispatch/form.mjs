/**
 * The dispatch form (派车表) — one JSON file per car. Pure: shape checks and
 * defaults only; checks that need the disk / tracker / quota are in plan.mjs.
 *
 * Fields (see config/dispatch-form.example.json for a filled one):
 *   tag            optional; default `<topic>_<HHMM>` (Beijing time, now)
 *   topic          required when tag is absent ([a-z][a-z0-9]*)
 *   line           required; an alias from the local config's `lines` table
 *   issue          existing tracker key (ABC-123) — or —
 *   newIssue       { title } : create a child issue under the line's parent
 *   model          opus | sonnet | haiku | glm  (fable only with ownerFableOk)
 *   effort         low | medium | high | xhigh | max
 *   hardCapHours   > 0
 *   pool           optional; default = picked by pool-pick.mjs rules
 *   heavy          optional; default true for effort xhigh / max
 *   title          one sentence (the task book's heading)
 *   why            owner's words (string or array of lines)
 *   readFirst      [ "/abs/path" | { path, note } ]  — every path absolute and present
 *   todo           [ step, ... ]
 *   deliverExtra, redlinesExtra, titleNotes  optional string arrays
 *   deadlineNote   optional ("最好 16:30 前交")
 *   siblings       optional extra sibling tags (cars on the same line are added automatically)
 *   boardDir       optional board directory name (under the configured board root)
 *   heavyUnits     optional, default 1 (max concurrent heavy units)
 *   plainLines     optional, default 6 (report opens with ≤ N plain lines); plainAudience optional ("给 owner 的")
 *   keyUse         optional: the one way this car may use a key (else "no keys")
 *   ownerFableOk   owner's authorisation message id — required for fable
 *   allowSecretaryPool  optional, lets an explicit `pool` name a secretary pool
 */

export const MODELS = Object.freeze({
  opus: { arg: 'opus', label: 'Opus', claude: true },
  sonnet: { arg: 'sonnet', label: 'Sonnet', claude: true },
  haiku: { arg: 'haiku', label: 'Haiku', claude: true },
  glm: { arg: '', label: 'GLM', claude: false },
  fable: { arg: 'fable', label: 'Fable', claude: true, ownerOnly: true },
})
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const HEAVY_EFFORTS = new Set(['xhigh', 'max'])
export const TAG_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const TOPIC_RE = /^[a-z][a-z0-9]*$/
const ISSUE_RE = /^[A-Z][A-Z0-9]*-\d+$/
const TAG_MAX = 40

/** "HHMM" in Beijing time. */
export function bjtHHMM(nowMs) {
  const d = new Date(nowMs + 8 * 3600 * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function err(code, msg) { return { code, msg } }

function strList(v) {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x.trim())
}

/**
 * raw form + { nowMs, lines (config alias table) } → { form, errors }.
 * Every problem is reported (not just the first) with a stable code.
 */
export function normalizeForm(raw, { nowMs, lines = {} }) {
  const errors = []
  const f = raw && typeof raw === 'object' ? raw : {}
  const form = {}

  if (f.tag != null) {
    if (typeof f.tag !== 'string' || !TAG_RE.test(f.tag) || f.tag.length > TAG_MAX) errors.push(err('bad_tag', `tag "${f.tag}" 不合法：只许小写字母数字和下划线、字母开头、≤${TAG_MAX} 字符`))
    form.tag = f.tag
  } else if (typeof f.topic === 'string' && TOPIC_RE.test(f.topic)) {
    form.tag = `${f.topic}_${bjtHHMM(nowMs)}`
  } else {
    errors.push(err('missing_field', '没填 tag 时必须填 topic（小写字母数字，字母开头），tag 按「topic_HHMM」生成'))
  }

  if (typeof f.line !== 'string' || !f.line) errors.push(err('missing_field', '缺 line（本地配置 lines 表里的别名）'))
  else if (!Object.prototype.hasOwnProperty.call(lines, f.line)) errors.push(err('unknown_line', `line "${f.line}" 不在本地配置的 lines 表里（有：${Object.keys(lines).join(' / ') || '空'}）`))
  form.line = f.line

  const hasIssue = f.issue != null
  const hasNew = f.newIssue != null
  if (hasIssue === hasNew) errors.push(err('missing_field', 'issue（已有单号）和 newIssue（{ title }，在线下建子单）必须二选一'))
  if (hasIssue && (typeof f.issue !== 'string' || !ISSUE_RE.test(f.issue))) errors.push(err('bad_issue', `issue "${f.issue}" 不是单号形状（如 ALGO-31）`))
  if (hasNew && !(typeof f.newIssue?.title === 'string' && f.newIssue.title.trim())) errors.push(err('bad_issue', 'newIssue 要有 title'))
  form.issue = hasIssue ? f.issue : null
  form.newIssue = hasNew ? { title: String(f.newIssue?.title || '').trim(), description: typeof f.newIssue?.description === 'string' ? f.newIssue.description : '' } : null

  const model = MODELS[f.model]
  if (!model) errors.push(err('bad_model', `model "${f.model}" 不合法：只许短名 ${Object.keys(MODELS).filter((m) => !MODELS[m].ownerOnly).join(' / ')}（写全名会被派车脚本悄悄退回 GLM）`))
  else if (model.ownerOnly && !(typeof f.ownerFableOk === 'string' && f.ownerFableOk.trim())) errors.push(err('fable_needs_owner', 'fable 只在 owner 亲口授权时派：表里要带 ownerFableOk（授权消息 id）'))
  form.model = f.model
  form.ownerFableOk = typeof f.ownerFableOk === 'string' ? f.ownerFableOk.trim() : null

  if (!EFFORTS.includes(f.effort)) errors.push(err('bad_effort', `effort "${f.effort}" 不合法：${EFFORTS.join(' / ')}`))
  form.effort = f.effort

  const h = Number(f.hardCapHours)
  if (!(Number.isFinite(h) && h > 0 && h <= 24)) errors.push(err('bad_hardcap', `hardCapHours "${f.hardCapHours}" 要是 0–24 之间的正数`))
  form.hardCapHours = h

  form.pool = typeof f.pool === 'string' && f.pool ? f.pool : null
  form.allowSecretaryPool = f.allowSecretaryPool === true
  form.heavy = typeof f.heavy === 'boolean' ? f.heavy : HEAVY_EFFORTS.has(f.effort)

  if (!(typeof f.title === 'string' && f.title.trim())) errors.push(err('missing_field', '缺 title（任务书标题一句话）'))
  form.title = typeof f.title === 'string' ? f.title.trim() : ''
  form.why = strList(f.why)
  if (!form.why.length) errors.push(err('missing_field', '缺 why（owner 原话）'))
  form.todo = strList(f.todo)
  if (!form.todo.length) errors.push(err('missing_field', '缺 todo（要做）'))

  form.readFirst = []
  for (const r of Array.isArray(f.readFirst) ? f.readFirst : []) {
    const item = typeof r === 'string' ? { path: r } : { path: r?.path, note: typeof r?.note === 'string' ? r.note : null }
    if (typeof item.path !== 'string' || !item.path) { errors.push(err('bad_read_first', `readFirst 里有一项没有 path：${JSON.stringify(r)}`)); continue }
    form.readFirst.push(item)
  }
  if (!form.readFirst.length) errors.push(err('missing_field', '缺 readFirst（先读的文件，绝对路径）'))

  form.deliverExtra = strList(f.deliverExtra)
  form.redlinesExtra = strList(f.redlinesExtra)
  form.titleNotes = strList(f.titleNotes)
  form.deadlineNote = typeof f.deadlineNote === 'string' && f.deadlineNote.trim() ? f.deadlineNote.trim() : null
  form.siblings = strList(f.siblings).filter((s) => TAG_RE.test(s))
  form.boardDir = null
  if (f.boardDir != null) {
    if (typeof f.boardDir === 'string' && /^[A-Za-z0-9._-]+$/.test(f.boardDir) && !f.boardDir.startsWith('.')) form.boardDir = f.boardDir
    else errors.push(err('bad_board_dir', `boardDir "${f.boardDir}" 只许一个目录名（字母数字 . _ -）`))
  }
  const hu = f.heavyUnits == null ? 1 : Number(f.heavyUnits)
  if (!(Number.isInteger(hu) && hu >= 1 && hu <= 4)) errors.push(err('bad_heavy_units', `heavyUnits "${f.heavyUnits}" 要是 1–4 的整数`))
  form.heavyUnits = hu
  const pl = f.plainLines == null ? 6 : Number(f.plainLines)
  if (!(Number.isInteger(pl) && pl >= 1 && pl <= 20)) errors.push(err('bad_plain_lines', `plainLines "${f.plainLines}" 要是 1–20 的整数`))
  form.plainLines = pl
  form.plainAudience = typeof f.plainAudience === 'string' && f.plainAudience.trim() ? f.plainAudience.trim() : null
  form.keyUse = typeof f.keyUse === 'string' && f.keyUse.trim() ? f.keyUse.trim() : null

  return { form, errors }
}
