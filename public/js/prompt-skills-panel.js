/**
 * Prompt skills page render core (nanoskill_1730).
 *
 * The right-panel tab is only the list + entry point. Reading, editing,
 * history and diffs open in a full-window dialog — long prompts are never
 * edited inside the narrow column (owner: "我也好看好改").
 *
 * Data: /api/prompt-skills (server/prompt-skills-routes.js). The dispatcher
 * pulls the version marked 生效 (production); saving makes a new version,
 * rolling back moves the 生效 label to an older version. The diff is computed
 * server-side; this file only renders it.
 */

import { t } from './i18n.js'

const AUTHOR_KEY = 'nanocode.promptSkills.author'

let activePane = null
let skills = []
let listError = ''
let dialog = null // { root, body, name, skill, view, edit: { content, note, dirty }, diff: { from, to } }

export async function renderPromptSkillsPane(pane) {
  if (!pane) return
  activePane = pane
  await loadList()
}

export function resetPromptSkillsLoadState() {
  activePane = null
  skills = []
  listError = ''
  closeDialog(true)
}

// ── helpers ─────────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

function button(label, onClick, cls = 'rp-btn rp-btn-sm') {
  const b = el('button', cls, label)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

function fmtTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function savedAuthor() {
  try { return localStorage.getItem(AUTHOR_KEY) || 'owner' } catch { return 'owner' }
}

function rememberAuthor(name) {
  try { localStorage.setItem(AUTHOR_KEY, name) } catch {}
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

const SECONDARY = 'btn-secondary psk-btn'

const skillUrl = (name, rest = '') => `/api/prompt-skills/${encodeURIComponent(name)}${rest}`

// ── right-panel list ────────────────────────────────────────────────────────

async function loadList() {
  try {
    const data = await api('GET', '/api/prompt-skills')
    skills = Array.isArray(data.skills) ? data.skills : []
    listError = ''
  } catch (err) {
    listError = String(err.message || err)
  }
  renderList()
}

function renderList() {
  const pane = activePane
  if (!pane) return
  pane.innerHTML = ''
  const wrap = el('div', 'psk-list')

  const head = el('div', 'psk-list-head')
  head.appendChild(el('div', 'rp-section-title', t('pskills.title')))
  const actions = el('div', 'psk-list-actions')
  actions.appendChild(button(t('pskills.refresh'), () => loadList(), SECONDARY))
  actions.appendChild(button(t('pskills.new'), () => openNewDialog()))
  head.appendChild(actions)
  wrap.appendChild(head)
  wrap.appendChild(el('div', 'rp-hint', t('pskills.hint')))

  if (listError) wrap.appendChild(el('div', 'rp-hint rp-error', t('pskills.loadFailed', listError)))
  else if (!skills.length) wrap.appendChild(el('div', 'rp-empty', t('pskills.empty')))

  for (const s of skills) {
    const row = el('button', 'psk-row')
    row.type = 'button'
    row.dataset.skill = s.name
    if (s.error) {
      row.appendChild(el('div', 'psk-row-title', s.name))
      row.appendChild(el('div', 'psk-row-desc rp-error', s.error))
    } else {
      const top = el('div', 'psk-row-top')
      top.appendChild(el('span', 'psk-row-title', s.title))
      top.appendChild(el('span', 'psk-badge psk-badge-prod', t('pskills.prodBadge', s.production)))
      row.appendChild(top)
      row.appendChild(el('div', 'psk-row-name', s.name))
      if (s.description) row.appendChild(el('div', 'psk-row-desc', s.description))
      row.appendChild(el('div', 'psk-row-meta', t('pskills.rowMeta', s.versionCount, fmtTime(s.updatedAt), s.updatedBy)))
      row.addEventListener('click', () => openSkillDialog(s.name))
    }
    wrap.appendChild(row)
  }
  pane.appendChild(wrap)
}

// ── full-window dialog ──────────────────────────────────────────────────────

function closeDialog(force = false) {
  if (!dialog) return
  if (!force && dialog.edit?.dirty && !window.confirm(t('pskills.discardConfirm'))) return
  document.removeEventListener('keydown', onDialogKey)
  dialog.root.remove()
  dialog = null
}

function onDialogKey(e) {
  if (e.key === 'Escape') closeDialog()
}

function mountDialog(titleText, subText) {
  closeDialog(true)
  const root = el('div', 'psk-overlay')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  const card = el('div', 'psk-card')
  const head = el('div', 'psk-head')
  head.appendChild(el('div', 'psk-head-title', titleText))
  head.appendChild(el('div', 'psk-head-sub', subText || ''))
  head.appendChild(button('✕', () => closeDialog(), 'btn-icon psk-close'))
  card.appendChild(head)
  const tabs = el('div', 'psk-tabs')
  card.appendChild(tabs)
  const body = el('div', 'psk-body')
  card.appendChild(body)
  root.appendChild(card)
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeDialog() })
  document.body.appendChild(root)
  document.addEventListener('keydown', onDialogKey)
  dialog = { root, head, tabs, body }
  return dialog
}

async function openSkillDialog(name, view = 'content') {
  mountDialog(name, '')
  dialog.name = name
  dialog.view = view
  dialog.selVersion = null
  dialog.diff = null
  await reloadSkill()
}

async function reloadSkill() {
  const d = dialog
  if (!d) return
  try {
    d.skill = await api('GET', skillUrl(d.name))
  } catch (err) {
    d.body.innerHTML = ''
    d.body.appendChild(el('div', 'rp-hint rp-error', t('pskills.loadFailed', err.message)))
    return
  }
  d.head.querySelector('.psk-head-title').textContent = d.skill.title
  d.head.querySelector('.psk-head-sub').textContent =
    `${d.skill.name} · ${t('pskills.prodBadge', d.skill.production)} · ${t('pskills.rowMeta', d.skill.versionCount, fmtTime(d.skill.updatedAt), d.skill.updatedBy)}`
  renderDialog()
}

function setView(view) {
  if (dialog.view === 'edit' && view !== 'edit' && dialog.edit?.dirty && !window.confirm(t('pskills.discardConfirm'))) return
  if (view !== 'edit') dialog.edit = null
  dialog.view = view
  renderDialog()
}

function renderDialog() {
  const d = dialog
  d.tabs.innerHTML = ''
  for (const [id, key] of [['content', 'pskills.tabContent'], ['edit', 'pskills.tabEdit'], ['history', 'pskills.tabHistory'], ['diff', 'pskills.tabDiff']]) {
    const b = button(t(key), () => setView(id), `psk-tab${d.view === id ? ' active' : ''}`)
    b.dataset.view = id
    d.tabs.appendChild(b)
  }
  d.body.innerHTML = ''
  if (d.view === 'edit') renderEdit()
  else if (d.view === 'history') renderHistory()
  else if (d.view === 'diff') renderDiff()
  else renderContentView()
}

function versionOf(n) {
  return dialog.skill.versions.find((v) => v.version === n)
}

function renderContentView() {
  const d = dialog
  const shown = versionOf(d.selVersion ?? d.skill.production) || versionOf(d.skill.production)
  const bar = el('div', 'psk-bar')
  const sel = el('select', 'rp-input psk-select')
  for (const v of [...d.skill.versions].reverse()) {
    const o = el('option', '', `v${v.version}${v.isProduction ? ` · ${t('pskills.prodWord')}` : ''} · ${fmtTime(v.createdAt)} · ${v.author}`)
    o.value = String(v.version)
    if (v.version === shown.version) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', () => { d.selVersion = Number(sel.value); renderDialog() })
  bar.appendChild(sel)
  if (!shown.isProduction) {
    bar.appendChild(el('span', 'psk-badge psk-badge-old', t('pskills.notProd')))
    bar.appendChild(button(t('pskills.makeProd'), () => promote(shown.version)))
  }
  if (shown.note) bar.appendChild(el('span', 'psk-note', shown.note))
  d.body.appendChild(bar)
  d.body.appendChild(el('pre', 'psk-pre', shown.content))
}

function renderEdit() {
  const d = dialog
  const latest = d.skill.versions[d.skill.versions.length - 1]
  if (!d.edit) {
    d.edit = { base: latest.version, content: latest.content, note: '', title: d.skill.title, description: d.skill.description, dirty: false }
  }
  const e = d.edit

  const meta = el('div', 'psk-edit-meta')
  const field = (label, value, onInput, cls = '') => {
    const wrap = el('label', `psk-field ${cls}`)
    wrap.appendChild(el('span', 'psk-field-label', label))
    const input = el('input', 'rp-input')
    input.value = value
    input.addEventListener('input', () => onInput(input.value))
    wrap.appendChild(input)
    return wrap
  }
  meta.appendChild(field(t('pskills.fieldTitle'), e.title, (v) => { e.title = v; e.dirty = true }))
  meta.appendChild(field(t('pskills.fieldDesc'), e.description, (v) => { e.description = v; e.dirty = true }, 'psk-field-wide'))
  d.body.appendChild(meta)

  d.body.appendChild(el('div', 'rp-hint', t('pskills.editBase', e.base, d.skill.production)))
  const ta = el('textarea', 'psk-editor')
  ta.value = e.content
  ta.spellcheck = false
  ta.addEventListener('input', () => { e.content = ta.value; e.dirty = true })
  d.body.appendChild(ta)

  const foot = el('div', 'psk-edit-foot')
  const note = field(t('pskills.fieldNote'), e.note, (v) => { e.note = v }, 'psk-field-wide')
  note.querySelector('input').placeholder = t('pskills.notePlaceholder')
  foot.appendChild(note)
  const authorField = field(t('pskills.fieldAuthor'), savedAuthor(), (v) => rememberAuthor(v.trim()))
  foot.appendChild(authorField)
  const prodLabel = el('label', 'psk-check')
  const prodBox = el('input')
  prodBox.type = 'checkbox'
  prodBox.checked = true
  prodLabel.appendChild(prodBox)
  prodLabel.appendChild(document.createTextNode(t('pskills.saveAsProd')))
  foot.appendChild(prodLabel)
  const status = el('span', 'rp-hint psk-status')
  const saveBtn = button(t('pskills.save'), async () => {
    saveBtn.disabled = true
    status.textContent = t('pskills.saving')
    status.classList.remove('rp-error')
    try {
      const author = authorField.querySelector('input').value.trim()
      if (e.title !== d.skill.title || e.description !== d.skill.description) {
        await api('PUT', skillUrl(d.name, '/meta'), { title: e.title, description: e.description })
      }
      if (e.content !== latest.content) {
        await api('POST', skillUrl(d.name, '/versions'), {
          content: e.content, note: e.note, author, baseVersion: e.base, makeProduction: prodBox.checked,
        })
      }
      d.edit = null
      d.view = 'history'
      await reloadSkill()
      loadList()
    } catch (err) {
      status.textContent = t('pskills.saveFailed', err.message)
      status.classList.add('rp-error')
      saveBtn.disabled = false
    }
  })
  foot.appendChild(saveBtn)
  foot.appendChild(status)
  d.body.appendChild(foot)
  ta.focus()
}

function renderHistory() {
  const d = dialog
  const table = el('div', 'psk-history')
  for (const v of [...d.skill.versions].reverse()) {
    const row = el('div', `psk-hrow${v.isProduction ? ' prod' : ''}`)
    row.dataset.version = String(v.version)
    const left = el('div', 'psk-hrow-main')
    const top = el('div', 'psk-hrow-top')
    top.appendChild(el('span', 'psk-hver', `v${v.version}`))
    if (v.isProduction) top.appendChild(el('span', 'psk-badge psk-badge-prod', t('pskills.prodWord')))
    top.appendChild(el('span', 'psk-row-meta', `${fmtTime(v.createdAt)} · ${v.author}`))
    left.appendChild(top)
    if (v.note) left.appendChild(el('div', 'psk-note', v.note))
    row.appendChild(left)
    const acts = el('div', 'psk-hrow-acts')
    acts.appendChild(button(t('pskills.view'), () => { d.selVersion = v.version; setView('content') }, SECONDARY))
    if (v.version > 1) acts.appendChild(button(t('pskills.diffPrev'), () => openDiff(v.version - 1, v.version), SECONDARY))
    if (!v.isProduction) {
      acts.appendChild(button(t('pskills.diffProd'), () => openDiff(d.skill.production, v.version), SECONDARY))
      acts.appendChild(button(v.version < d.skill.production ? t('pskills.rollback') : t('pskills.makeProd'), () => promote(v.version), 'rp-btn rp-btn-sm psk-btn-warn'))
    }
    row.appendChild(acts)
    table.appendChild(row)
  }
  d.body.appendChild(el('div', 'rp-hint', t('pskills.historyHint')))
  d.body.appendChild(table)
}

async function promote(version) {
  const d = dialog
  if (!window.confirm(t('pskills.promoteConfirm', d.skill.title, d.skill.production, version))) return
  try {
    await api('POST', skillUrl(d.name, '/production'), { version, author: savedAuthor() })
    await reloadSkill()
    loadList()
  } catch (err) {
    window.alert(t('pskills.saveFailed', err.message))
  }
}

function openDiff(from, to) {
  dialog.diff = { from, to }
  setView('diff')
}

async function renderDiff() {
  const d = dialog
  const versions = d.skill.versions.map((v) => v.version)
  if (!d.diff) {
    const prod = d.skill.production
    const latest = versions[versions.length - 1]
    d.diff = latest !== prod ? { from: prod, to: latest } : { from: Math.max(1, prod - 1), to: prod }
  }
  const bar = el('div', 'psk-bar')
  const pick = (value, onChange) => {
    const sel = el('select', 'rp-input psk-select')
    for (const n of [...versions].reverse()) {
      const o = el('option', '', `v${n}${n === d.skill.production ? ` · ${t('pskills.prodWord')}` : ''}`)
      o.value = String(n)
      if (n === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(Number(sel.value)))
    return sel
  }
  bar.appendChild(el('span', 'psk-field-label', t('pskills.diffFrom')))
  bar.appendChild(pick(d.diff.from, (n) => { d.diff.from = n; renderDialog() }))
  bar.appendChild(el('span', 'psk-field-label', t('pskills.diffTo')))
  bar.appendChild(pick(d.diff.to, (n) => { d.diff.to = n; renderDialog() }))
  const stats = el('span', 'psk-note')
  bar.appendChild(stats)
  d.body.appendChild(bar)
  const out = el('div', 'psk-diff')
  d.body.appendChild(out)
  try {
    const data = await api('GET', skillUrl(d.name, `/diff?from=${d.diff.from}&to=${d.diff.to}`))
    stats.textContent = t('pskills.diffStats', data.stats.added, data.stats.deleted)
    if (!data.stats.added && !data.stats.deleted) out.appendChild(el('div', 'rp-empty', t('pskills.diffSame')))
    for (const op of data.ops) {
      const sign = op.op === 'add' ? '+' : op.op === 'del' ? '-' : ' '
      out.appendChild(el('div', `psk-dline psk-d-${op.op}`, `${sign} ${op.text}`))
    }
  } catch (err) {
    out.appendChild(el('div', 'rp-hint rp-error', t('pskills.loadFailed', err.message)))
  }
}

// ── new skill ───────────────────────────────────────────────────────────────

function openNewDialog() {
  const d = mountDialog(t('pskills.newTitle'), t('pskills.newSub'))
  d.tabs.remove()
  d.edit = { dirty: false }
  const form = el('div', 'psk-edit-meta')
  const inputs = {}
  for (const [key, label, cls] of [['name', 'pskills.fieldName', ''], ['title', 'pskills.fieldTitle', ''], ['description', 'pskills.fieldDesc', 'psk-field-wide']]) {
    const wrap = el('label', `psk-field ${cls}`)
    wrap.appendChild(el('span', 'psk-field-label', t(label)))
    const input = el('input', 'rp-input')
    input.addEventListener('input', () => { d.edit.dirty = true })
    inputs[key] = input
    wrap.appendChild(input)
    form.appendChild(wrap)
  }
  inputs.name.placeholder = 'cred-push'
  d.body.appendChild(form)
  const ta = el('textarea', 'psk-editor')
  ta.addEventListener('input', () => { d.edit.dirty = true })
  d.body.appendChild(ta)
  const foot = el('div', 'psk-edit-foot')
  const status = el('span', 'rp-hint psk-status')
  foot.appendChild(button(t('pskills.create'), async () => {
    try {
      const name = inputs.name.value.trim()
      await api('POST', '/api/prompt-skills', {
        name, title: inputs.title.value, description: inputs.description.value,
        content: ta.value, author: savedAuthor(), note: t('pskills.createdNote'),
      })
      await loadList()
      openSkillDialog(name)
    } catch (err) {
      status.textContent = t('pskills.saveFailed', err.message)
      status.classList.add('rp-error')
    }
  }))
  foot.appendChild(status)
  d.body.appendChild(foot)
}
