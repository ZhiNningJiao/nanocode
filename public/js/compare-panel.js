/**
 * Compare plugin render core — MES-13740 需求14.
 *
 * "Recent branches compare": discover the newest N local branches of the
 * current project's git repo, diff any two branches, and view per-file unified
 * diffs. This is the first "heavy feature plugin" for the 需求6 registry — it
 * replaces the 需求6 built-in Compare placeholder with a dynamically mounted
 * Artifacts tab.
 *
 * All git operations are read-only (no checkout); the backend (terminal/compare.js)
 * validates branch names against the real branch list and file paths against a
 * strict regex. The panel is mobile-readable (≤480px): branch selects are ≥44px
 * touch targets and the unified diff scrolls horizontally.
 *
 * This is a render core ("芯"); right-panel.js mounts/unmounts it via the
 * registry. The manifest is passed as the 2nd arg so the default branch limit
 * can be read from `plugin.settings.defaultBranches`.
 */

import { t } from './i18n.js'

const LIMIT_KEY = 'compare:branchLimit'

let activePane = null
let loaded = false
let branches = []
let current = ''
let base = ''
let head = ''
let limit = 10
let overview = null       // { files, summary } | { error }
let selectedFile = ''
let fileDiff = null       // { diff } | { error }
let loadingBranches = false
let loadingDiff = false
let loadingFile = false

export async function renderComparePane(pane, plugin) {
  if (!pane) return
  activePane = pane
  // Seed the default limit from the manifest's settings, then let the user
  // override via localStorage. (REPORT gap: settings aren't yet surfaced by a
  // per-plugin settings panel — 需求13 — so the panel reads the manifest directly.)
  const def = plugin && plugin.settings && Number(plugin.settings.defaultBranches)
  if (Number.isFinite(def) && def > 0) limit = Math.min(50, Math.max(1, Math.floor(def)))
  try {
    const saved = Number(localStorage.getItem(LIMIT_KEY))
    if (Number.isFinite(saved) && saved > 0) limit = Math.min(50, Math.max(1, Math.floor(saved)))
  } catch {}
  renderShell(pane)
  await loadBranches()
}

export function resetCompareLoadState() {
  activePane = null
  loaded = false
  branches = []
  current = ''
  base = ''
  head = ''
  overview = null
  selectedFile = ''
  fileDiff = null
  loadingBranches = false
  loadingDiff = false
  loadingFile = false
}

// ── data loading ────────────────────────────────────────────────────────────

async function loadBranches() {
  loadingBranches = true
  renderStatus(t('compare.loading'))
  const pid = projectId()
  try {
    const data = await fetch(`/api/compare/branches?projectId=${encodeURIComponent(pid)}&limit=${limit}`).then((r) => r.json())
    loadingBranches = false
    if (data.error) {
      branches = []
      renderStatus(`${t('compare.error')}: ${data.error}`, true)
      renderControls()
      return
    }
    branches = Array.isArray(data.branches) ? data.branches : []
    current = data.current || ''
    // Initialise base/head from defaults (main/master vs newest), keeping any
    // prior selection if it still exists in the new list.
    const names = branches.map((b) => b.name)
    if (!base || !names.includes(base)) base = data.defaultBase || ''
    if (!head || !names.includes(head)) head = data.defaultHead || ''
    renderControls()
    await loadDiff()
  } catch (err) {
    loadingBranches = false
    renderStatus(String(err.message || err), true)
    renderControls()
  }
}

async function loadDiff() {
  if (!base || !head) {
    overview = null
    renderOverview()
    return
  }
  loadingDiff = true
  selectedFile = ''
  fileDiff = null
  renderOverview({ loading: true })
  const pid = projectId()
  try {
    const data = await fetch(
      `/api/compare/diff?projectId=${encodeURIComponent(pid)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
    ).then((r) => r.json())
    loadingDiff = false
    overview = data
    renderOverview()
  } catch (err) {
    loadingDiff = false
    overview = { error: String(err.message || err) }
    renderOverview()
  }
}

async function loadFileDiff(file) {
  if (!file) return
  selectedFile = file
  fileDiff = null
  loadingFile = true
  renderFileView({ loading: true })
  const pid = projectId()
  try {
    const data = await fetch(
      `/api/compare/file-diff?projectId=${encodeURIComponent(pid)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}&file=${encodeURIComponent(file)}`,
    ).then((r) => r.json())
    loadingFile = false
    fileDiff = data
    renderFileView()
  } catch (err) {
    loadingFile = false
    fileDiff = { error: String(err.message || err) }
    renderFileView()
  }
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderShell(pane) {
  pane.innerHTML = ''
  const controls = document.createElement('div')
  controls.className = 'cmp-controls'
  controls.id = 'cmp-controls'
  pane.appendChild(controls)
  const body = document.createElement('div')
  body.className = 'cmp-body'
  body.id = 'cmp-body'
  pane.appendChild(body)
}

function renderStatus(msg, isError = false) {
  const body = document.getElementById('cmp-body')
  if (!body) return
  body.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'cmp-hint' + (isError ? ' cmp-error' : '')
  el.textContent = msg
  body.appendChild(el)
}

function renderControls() {
  const el = document.getElementById('cmp-controls')
  if (!el) return
  el.innerHTML = ''

  const row = document.createElement('div')
  row.className = 'cmp-row'
  row.appendChild(renderBranchSelect('base', base))
  row.appendChild(renderSwapBtn())
  row.appendChild(renderBranchSelect('head', head))
  el.appendChild(row)

  const row2 = document.createElement('div')
  row2.className = 'cmp-row cmp-row-2'
  row2.appendChild(renderLimitControl())
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'rp-btn rp-btn-sm'
  refresh.textContent = t('compare.refresh')
  refresh.addEventListener('click', () => { base = ''; head = ''; loadBranches() })
  row2.appendChild(refresh)
  el.appendChild(row2)
}

function renderBranchSelect(which, val) {
  const group = document.createElement('label')
  group.className = 'cmp-field'
  const lab = document.createElement('span')
  lab.className = 'cmp-field-label'
  lab.textContent = t(which === 'base' ? 'compare.base' : 'compare.head')
  const sel = document.createElement('select')
  sel.className = 'rp-select'
  sel.id = `cmp-${which}-select`
  if (!branches.length) {
    const opt = document.createElement('option')
    opt.textContent = t('compare.noBranches')
    sel.appendChild(opt)
    sel.disabled = true
  } else {
    for (const b of branches) {
      const opt = document.createElement('option')
      opt.value = b.name
      const tags = []
      if (b.current) tags.push(t('compare.current'))
      if (b.worktree) tags.push(t('compare.worktree'))
      opt.textContent = tags.length ? `${b.name}  (${tags.join(' · ')})` : b.name
      if (b.name === val) opt.selected = true
      opt.title = `${b.subject || ''}${b.date ? '  ·  ' + b.date : ''}`
      sel.appendChild(opt)
    }
  }
  sel.addEventListener('change', async () => {
    if (which === 'base') base = sel.value
    else head = sel.value
    await loadDiff()
  })
  group.appendChild(lab)
  group.appendChild(sel)
  return group
}

function renderSwapBtn() {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'rp-btn rp-btn-sm cmp-swap'
  btn.textContent = '⇄'
  btn.title = t('compare.swap')
  btn.addEventListener('click', () => {
    const tmp = base
    base = head
    head = tmp
    renderControls()
    loadDiff()
  })
  return btn
}

function renderLimitControl() {
  const group = document.createElement('label')
  group.className = 'cmp-field cmp-limit'
  const lab = document.createElement('span')
  lab.className = 'cmp-field-label'
  lab.textContent = t('compare.branchLimit')
  const sel = document.createElement('select')
  sel.className = 'rp-select'
  for (const n of [5, 10, 20, 30, 50]) {
    const opt = document.createElement('option')
    opt.value = n
    opt.textContent = String(n)
    if (n === limit) opt.selected = true
    sel.appendChild(opt)
  }
  sel.addEventListener('change', async () => {
    limit = Number(sel.value) || 10
    try { localStorage.setItem(LIMIT_KEY, String(limit)) } catch {}
    base = ''
    head = ''
    await loadBranches()
  })
  group.appendChild(lab)
  group.appendChild(sel)
  return group
}

function renderOverview(state = {}) {
  const body = document.getElementById('cmp-body')
  if (!body) return
  body.innerHTML = ''

  if (loadingBranches || state.loading) {
    body.appendChild(cmpHint(t('compare.loading')))
    return
  }
  if (!overview) {
    body.appendChild(cmpHint(t('compare.pickFile')))
    return
  }
  if (overview.error) {
    const e = document.createElement('div')
    e.className = 'cmp-hint cmp-error'
    e.textContent = `${t('compare.error')}: ${overview.error}`
    body.appendChild(e)
    return
  }
  const files = Array.isArray(overview.files) ? overview.files : []
  const sm = overview.summary || { files: 0, insertions: 0, deletions: 0 }

  const summary = document.createElement('div')
  summary.className = 'cmp-summary'
  summary.textContent = fmtSummary(sm)
  body.appendChild(summary)

  if (!files.length) {
    body.appendChild(cmpHint(t('compare.noChanges')))
    return
  }

  const head2 = document.createElement('div')
  head2.className = 'cmp-list-head'
  head2.textContent = `${t('compare.fileList')} (${files.length})`
  body.appendChild(head2)

  const list = document.createElement('div')
  list.className = 'cmp-filelist'
  for (const f of files) {
    list.appendChild(renderFileRow(f))
  }
  body.appendChild(list)
}

function renderFileRow(f) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'cmp-file-row'
  row.dataset.file = f.path
  const name = document.createElement('span')
  name.className = 'cmp-file-name'
  name.textContent = f.path
  const meta = document.createElement('span')
  meta.className = 'cmp-file-meta'
  meta.textContent = f.binary ? 'binary' : `+${f.additions || 0} / -${f.deletions || 0}`
  row.appendChild(name)
  row.appendChild(meta)
  row.addEventListener('click', () => {
    loadFileDiff(f.path)
    const list = document.querySelector('#cmp-body .cmp-filelist')
    if (list) list.querySelectorAll('.cmp-file-row').forEach((r) => r.classList.toggle('active', r.dataset.file === f.path))
  })
  return row
}

function renderFileView(state = {}) {
  const body = document.getElementById('cmp-body')
  if (!body) return
  body.innerHTML = ''

  const bar = document.createElement('div')
  bar.className = 'cmp-diff-bar'
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'rp-btn rp-btn-sm'
  back.textContent = '← ' + t('compare.back')
  back.addEventListener('click', () => {
    selectedFile = ''
    fileDiff = null
    renderOverview()
  })
  bar.appendChild(back)
  const crumb = document.createElement('div')
  crumb.className = 'cmp-diff-crumb'
  crumb.textContent = fmtKey('compare.diffFor', { file: selectedFile })
  bar.appendChild(crumb)
  body.appendChild(bar)

  if (loadingFile || state.loading) {
    body.appendChild(cmpHint(t('compare.loading')))
    return
  }
  if (!fileDiff) {
    body.appendChild(cmpHint(t('compare.pickFile')))
    return
  }
  if (fileDiff.error) {
    const e = document.createElement('div')
    e.className = 'cmp-hint cmp-error'
    e.textContent = `${t('compare.error')}: ${fileDiff.error}`
    body.appendChild(e)
    return
  }

  const wrap = document.createElement('div')
  wrap.className = 'cmp-diff-wrap'
  const pre = document.createElement('pre')
  pre.className = 'cmp-diff preview-code'
  pre.textContent = fileDiff.diff || ''
  wrap.appendChild(pre)
  body.appendChild(wrap)
}

// ── helpers ─────────────────────────────────────────────────────────────────

function projectId() {
  try { return localStorage.getItem('activeProjectId') || '' } catch { return '' }
}

function fmtKey(key, vars) {
  let s = t(key)
  if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]))
  return s
}

function fmtSummary(sm) {
  return fmtKey('compare.summary', {
    files: sm.files || 0,
    ins: sm.insertions || 0,
    del: sm.deletions || 0,
  })
}

function cmpHint(text) {
  const d = document.createElement('div')
  d.className = 'cmp-hint'
  d.textContent = text
  return d
}
