/**
 * Memory viewer plugin render core — MES-13740 需求7.
 *
 * Browses Claude memory (MEMORY.md + fragment md files) across teams × projects.
 * Data source: each team config dir's `projects/<slug>/memory/*.md`.
 *
 * Features:
 *   - Team × project selectors (browse any team's any project memory)
 *   - File list (md files, newest-first)
 *   - Rendered markdown (links clickable: external → new tab, .md → open in list)
 *   - Keyword search across the project's memory files
 *   - Edit (dangerous, opt-in): double-confirm + timestamped backup of original
 *
 * Read-only is the primary mode; editing is guarded. Mobile-readable (≤480px):
 * the two-pane body stacks vertically with ≥44px touch targets.
 *
 * This is a render core ("芯"); the 需求6 right-panel.js registry mounts/unmounts it.
 * Markdown rendering reuses the global `window.marked` + `window.DOMPurify` that
 * explorer.js also relies on (loaded as UMD in index.html).
 */

import { t } from './i18n.js'

let memLoaded = false
let activePane = null
let tree = []
let activePath = ''
let currentSlug = ''
let selTeam = ''
let selProject = ''
let selFile = ''
let fileContent = null
let fileMeta = null
let searchQuery = ''
let searchResults = null
let searching = false
let editing = false
let editContent = ''
let saving = false

export async function renderMemoryPane(pane) {
  if (!pane) return
  activePane = pane
  if (!memLoaded) {
    pane.innerHTML = ''
    pane.appendChild(buildSkeleton())
    memLoaded = true
  }
  try {
    await loadTree()
    renderShell(pane)
    await loadFileList()
  } catch (err) {
    renderError(pane, err)
  }
}

export function resetMemoryLoadState() {
  memLoaded = false
  activePane = null
  tree = []
  activePath = ''
  currentSlug = ''
  selTeam = ''
  selProject = ''
  selFile = ''
  fileContent = null
  fileMeta = null
  searchQuery = ''
  searchResults = null
  searching = false
  editing = false
  editContent = ''
  saving = false
}

// ── data loading ────────────────────────────────────────────────────────────

async function loadTree() {
  let projectId = ''
  try { projectId = localStorage.getItem('activeProjectId') || '' } catch {}
  const url = `/api/memory/tree${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`
  const data = await fetch(url).then((r) => r.json())
  if (data.error) throw new Error(data.error)
  tree = Array.isArray(data.teams) ? data.teams : []
  activePath = data.activePath || ''
  currentSlug = data.currentSlug || ''
  if (!selTeam || !teamKnown(selTeam)) {
    selTeam = activePath || (tree[0] && tree[0].path) || ''
  }
  if (!selProject || !projectKnown(selTeam, selProject)) {
    selProject = pickDefaultProject(selTeam)
  }
}

async function loadFileList() {
  if (!selTeam || !selProject) {
    renderFileList()
    renderContent()
    return
  }
  renderFileList({ loading: true })
  try {
    const data = await fetch(
      `/api/memory/files?team=${encodeURIComponent(selTeam)}&project=${encodeURIComponent(selProject)}`,
    ).then((r) => r.json())
    if (data.error) {
      renderFileList({ error: data.error })
      renderContent()
      return
    }
    const files = Array.isArray(data.files) ? data.files : []
    // Keep selFile if it still exists, else pick the first (MEMORY.md preferred).
    if (selFile && !files.some((f) => f.name === selFile)) selFile = ''
    if (!selFile && files.length) {
      const mem = files.find((f) => f.name === 'MEMORY.md')
      selFile = mem ? mem.name : files[0].name
    }
    renderFileList({ files })
    if (selFile) await loadFile(selFile)
    else renderContent()
  } catch (err) {
    renderFileList({ error: String(err.message || err) })
    renderContent()
  }
}

async function loadFile(name) {
  selFile = name
  editing = false
  editContent = ''
  renderContent({ loading: true })
  try {
    const data = await fetch(
      `/api/memory/read?team=${encodeURIComponent(selTeam)}&project=${encodeURIComponent(selProject)}&file=${encodeURIComponent(name)}`,
    ).then((r) => r.json())
    if (data.error) {
      fileContent = null
      fileMeta = null
      renderContent({ error: data.error })
      return
    }
    fileContent = data.content
    fileMeta = { size: data.size, mtime: data.mtime, path: data.path }
    renderContent()
  } catch (err) {
    fileContent = null
    fileMeta = null
    renderContent({ error: String(err.message || err) })
  }
}

async function runSearch(q) {
  searchQuery = String(q || '').trim()
  if (!searchQuery) {
    searchResults = null
    searching = false
    renderFileList()
    return
  }
  searching = true
  renderFileList({ searching: true })
  try {
    const data = await fetch(
      `/api/memory/search?team=${encodeURIComponent(selTeam)}&project=${encodeURIComponent(selProject)}&q=${encodeURIComponent(searchQuery)}`,
    ).then((r) => r.json())
    if (data.error) {
      searchResults = null
      renderFileList({ error: data.error })
    } else {
      searchResults = Array.isArray(data.matches) ? data.matches : []
      renderFileList({ searchResults: true })
    }
  } catch (err) {
    renderFileList({ error: String(err.message || err) })
  } finally {
    searching = false
  }
}

async function saveEdit() {
  if (!selFile) return
  saving = true
  renderContent({ saving: true })
  try {
    const res = await fetch('/api/memory/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team: selTeam,
        project: selProject,
        file: selFile,
        content: editContent,
      }),
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    fileContent = editContent
    fileMeta = { size: data.size, mtime: data.mtime, path: data.path }
    editing = false
    editContent = ''
    const msg = data.backupPath
      ? `${t('memory.saved')} (${t('memory.backup')}: ${data.backupPath.split('/').pop()})`
      : t('memory.saved')
    flashStatus(activePane, msg)
    renderContent()
    // Refresh file list (mtime/size changed) without losing selection.
    loadFileList()
  } catch (err) {
    flashStatus(activePane, String(err.message || err), true)
  } finally {
    saving = false
  }
}

// ── rendering ──────────────────────────────────────────────────────────────

function buildSkeleton() {
  const div = document.createElement('div')
  div.className = 'rp-loading'
  div.textContent = '...'
  return div
}

function renderError(pane, err) {
  pane.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'rp-section rp-error'
  div.textContent = String(err.message || err)
  pane.appendChild(div)
}

/** Build the static shell (controls + two-pane body). Called once per mount. */
function renderShell(pane) {
  pane.innerHTML = ''
  pane.appendChild(renderControls())
  const body = document.createElement('div')
  body.className = 'mem-body'
  const list = document.createElement('div')
  list.className = 'mem-filelist'
  list.id = 'mem-filelist'
  const content = document.createElement('div')
  content.className = 'mem-content'
  content.id = 'mem-content'
  body.appendChild(list)
  body.appendChild(content)
  pane.appendChild(body)
}

function renderControls() {
  const wrap = document.createElement('div')
  wrap.className = 'mem-controls'

  const row = document.createElement('div')
  row.className = 'mem-row'
  row.appendChild(renderTeamSelect())
  row.appendChild(renderProjectSelect())
  wrap.appendChild(row)

  const search = document.createElement('div')
  search.className = 'mem-search'
  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'rp-input mem-search-input'
  input.id = 'mem-search-input'
  input.value = searchQuery
  input.setAttribute('data-i18n-placeholder', 'memory.searchPlaceholder')
  input.placeholder = t('memory.searchPlaceholder')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      runSearch(input.value)
    } else if (e.key === 'Escape') {
      input.value = ''
      runSearch('')
    }
  })
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'rp-btn rp-btn-sm'
  btn.textContent = t('memory.search')
  btn.addEventListener('click', () => runSearch(input.value))
  const clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.className = 'rp-btn rp-btn-sm mem-clear-btn'
  clearBtn.textContent = t('memory.clear')
  clearBtn.title = t('memory.clear')
  clearBtn.addEventListener('click', () => { input.value = ''; runSearch('') })
  search.appendChild(input)
  search.appendChild(btn)
  if (searchQuery) search.appendChild(clearBtn)
  wrap.appendChild(search)

  return wrap
}

function renderTeamSelect() {
  const group = document.createElement('label')
  group.className = 'mem-field'
  const lab = document.createElement('span')
  lab.className = 'mem-field-label'
  lab.textContent = t('memory.team')
  const sel = document.createElement('select')
  sel.className = 'rp-select'
  sel.id = 'mem-team-select'
  for (const team of tree) {
    const opt = document.createElement('option')
    opt.value = team.path
    const count = team.projects.reduce((a, p) => a + (p.fileCount || 0), 0)
    opt.textContent = `${team.name || team.id} (${count})`
    if (team.path === selTeam) opt.selected = true
    sel.appendChild(opt)
  }
  if (!tree.length) {
    const opt = document.createElement('option')
    opt.textContent = t('memory.noTeams')
    sel.appendChild(opt)
    sel.disabled = true
  }
  sel.addEventListener('change', async () => {
    selTeam = sel.value
    selProject = pickDefaultProject(selTeam)
    selFile = ''
    searchQuery = ''
    searchResults = null
    renderShell(activePane)
    await loadFileList()
  })
  group.appendChild(lab)
  group.appendChild(sel)
  return group
}

function renderProjectSelect() {
  const group = document.createElement('label')
  group.className = 'mem-field'
  const lab = document.createElement('span')
  lab.className = 'mem-field-label'
  lab.textContent = t('memory.project')
  const sel = document.createElement('select')
  sel.className = 'rp-select'
  sel.id = 'mem-project-select'
  const team = teamById(selTeam)
  const projects = team ? team.projects : []
  for (const p of projects) {
    const opt = document.createElement('option')
    opt.value = p.slug
    const cwd = p.cwd || p.slug
    const home = homedirish(cwd)
    opt.textContent = home ? `~ (${p.fileCount})` : `${shortPath(cwd)} (${p.fileCount})`
    if (p.current) opt.title = t('memory.currentProject')
    if (p.slug === selProject) opt.selected = true
    sel.appendChild(opt)
  }
  if (!projects.length) {
    const opt = document.createElement('option')
    opt.textContent = t('memory.noProjects')
    sel.appendChild(opt)
    sel.disabled = true
  }
  sel.addEventListener('change', async () => {
    selProject = sel.value
    selFile = ''
    searchQuery = ''
    searchResults = null
    renderShell(activePane)
    await loadFileList()
  })
  group.appendChild(lab)
  group.appendChild(sel)
  return group
}

function renderFileList(state = {}) {
  const el = document.getElementById('mem-filelist')
  if (!el) return
  el.innerHTML = ''

  if (state.loading || state.searching) {
    el.appendChild(memHint(t('memory.loading')))
    return
  }
  if (state.error) {
    el.appendChild(memError(state.error))
    return
  }

  // Search results replace the file list when a query is active.
  if (searchQuery && state.searchResults) {
    const head = document.createElement('div')
    head.className = 'mem-list-head'
    head.textContent = `${t('memory.searchResults')} (${searchResults.length})`
    el.appendChild(head)
    if (!searchResults.length) {
      el.appendChild(memHint(t('memory.noResults')))
      return
    }
    for (const m of searchResults) {
      el.appendChild(renderSearchMatch(m))
    }
    return
  }

  const head = document.createElement('div')
  head.className = 'mem-list-head'
  head.textContent = `${t('memory.files')} (${state.files ? state.files.length : 0})`
  el.appendChild(head)

  if (!state.files || !state.files.length) {
    el.appendChild(memHint(t('memory.noFiles')))
    return
  }
  for (const f of state.files) {
    el.appendChild(renderFileRow(f))
  }
}

function renderFileRow(f) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'mem-file-row' + (f.name === selFile ? ' active' : '')
  row.dataset.file = f.name
  const name = document.createElement('span')
  name.className = 'mem-file-name'
  name.textContent = f.name
  const meta = document.createElement('span')
  meta.className = 'mem-file-meta'
  meta.textContent = `${formatSize(f.size)} · ${relTime(f.mtime)}`
  row.appendChild(name)
  row.appendChild(meta)
  row.addEventListener('click', () => {
    if (searchQuery) { inputClear(); }
    loadFile(f.name)
    // highlight
    const list = document.getElementById('mem-filelist')
    if (list) list.querySelectorAll('.mem-file-row').forEach((r) => r.classList.toggle('active', r.dataset.file === f.name))
  })
  return row
}

function renderSearchMatch(m) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'mem-search-match'
  const file = document.createElement('span')
  file.className = 'mem-match-file'
  file.textContent = `${m.file}:${m.line}`
  const snip = document.createElement('span')
  snip.className = 'mem-match-snippet'
  snip.textContent = m.snippet
  row.appendChild(file)
  row.appendChild(snip)
  row.addEventListener('click', () => {
    inputClear()
    loadFile(m.file)
  })
  return row
}

function inputClear() {
  searchQuery = ''
  searchResults = null
  const inp = document.getElementById('mem-search-input')
  if (inp) inp.value = ''
}

function renderContent(state = {}) {
  const el = document.getElementById('mem-content')
  if (!el) return
  el.innerHTML = ''

  if (!selFile) {
    el.appendChild(memHint(t('memory.selectFile')))
    return
  }
  if (state.loading) {
    el.appendChild(memHint(t('memory.loading')))
    return
  }
  if (state.error) {
    el.appendChild(memError(state.error))
    return
  }

  // Toolbar: file name + meta + actions
  const bar = document.createElement('div')
  bar.className = 'mem-content-bar'
  const crumb = document.createElement('div')
  crumb.className = 'mem-content-crumb'
  crumb.textContent = selFile
  bar.appendChild(crumb)
  if (fileMeta) {
    const meta = document.createElement('span')
    meta.className = 'mem-content-meta'
    meta.textContent = `${formatSize(fileMeta.size)} · ${relTime(fileMeta.mtime)}`
    bar.appendChild(meta)
  }
  const actions = document.createElement('div')
  actions.className = 'mem-content-actions'
  if (editing) {
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'rp-btn rp-btn-sm'
    saveBtn.textContent = saving ? t('memory.saving') : t('memory.save')
    saveBtn.disabled = saving || state.saving
    saveBtn.addEventListener('click', () => {
      if (window.confirm(t('memory.confirmEdit'))) saveEdit()
    })
    actions.appendChild(saveBtn)
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'rp-btn rp-btn-sm'
    cancelBtn.textContent = t('memory.cancel')
    cancelBtn.disabled = saving
    cancelBtn.addEventListener('click', () => {
      editing = false
      editContent = ''
      renderContent()
    })
    actions.appendChild(cancelBtn)
  } else {
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'rp-btn rp-btn-sm'
    editBtn.textContent = t('memory.edit')
    editBtn.title = t('memory.editHint')
    editBtn.addEventListener('click', () => {
      editing = true
      editContent = fileContent || ''
      renderContent()
    })
    actions.appendChild(editBtn)
  }
  bar.appendChild(actions)
  el.appendChild(bar)

  // Body: editor textarea or rendered markdown
  if (editing) {
    const ta = document.createElement('textarea')
    ta.className = 'mem-editor'
    ta.value = editContent
    ta.spellcheck = false
    ta.addEventListener('input', () => { editContent = ta.value })
    el.appendChild(ta)
    const warn = document.createElement('div')
    warn.className = 'rp-hint mem-edit-warn'
    warn.textContent = t('memory.editWarn')
    el.appendChild(warn)
    return
  }

  if (fileContent == null) {
    el.appendChild(memHint(t('memory.selectFile')))
    return
  }

  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(fileContent)
    const safe = window.DOMPurify.sanitize(html)
    const md = document.createElement('div')
    md.className = 'mem-md chat-prose'
    md.innerHTML = safe
    if (window.hljs) {
      md.querySelectorAll('pre code').forEach((codeEl) => {
        try { window.hljs.highlightElement(codeEl) } catch {}
      })
    }
    // External links open in a new tab; relative .md links open in the list.
    md.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || ''
      if (/^https?:\/\//i.test(href)) {
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
      } else if (/^[a-z0-9._-]+\.md$/i.test(href)) {
        a.title = t('memory.openInList')
        a.addEventListener('click', (ev) => {
          ev.preventDefault()
          inputClear()
          loadFile(href)
        })
      }
    })
    el.appendChild(md)
  } else {
    const pre = document.createElement('pre')
    pre.className = 'preview-code'
    pre.textContent = fileContent
    el.appendChild(pre)
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function teamById(path) { return tree.find((t) => t.path === path) || null }
function teamKnown(path) { return !!teamById(path) }
function projectKnown(path, slug) {
  const t = teamById(path)
  return !!(t && t.projects.some((p) => p.slug === slug))
}

/** Default project for a team: the current project if it has memory here,
 *  else the first project (already sorted newest-first by the backend). */
function pickDefaultProject(path) {
  const t = teamById(path)
  if (!t) return ''
  const cur = t.projects.find((p) => p.current)
  if (cur) return cur.slug
  return t.projects[0] ? t.projects[0].slug : ''
}

function homedirish(cwd) {
  try {
    const h = (typeof window !== 'undefined' && window.__HOME__) || ''
    if (h && cwd === h) return true
  } catch {}
  // Heuristic: a decoded home slug ends with the home dir's last segment and
  // has no deeper path — good enough for the ~ label.
  return /^\/[^/]+$/.test(cwd) && /\/(home|Users|root)$/.test(cwd)
}

function shortPath(p) {
  if (!p) return ''
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

function formatSize(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

function relTime(ms) {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 0) return ''
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.floor(mo / 12)}y`
}

function memHint(text) {
  const d = document.createElement('div')
  d.className = 'mem-hint'
  d.textContent = text
  return d
}
function memError(text) {
  const d = document.createElement('div')
  d.className = 'mem-hint mem-error'
  d.textContent = text
  return d
}

function flashStatus(pane, msg, isError = false) {
  if (!pane) return
  let status = pane.querySelector('.rp-flash')
  if (!status) {
    status = document.createElement('div')
    status.className = 'rp-flash'
    pane.appendChild(status)
  }
  status.textContent = msg
  status.classList.toggle('error', isError)
  status.classList.add('show')
  clearTimeout(status._timer)
  status._timer = setTimeout(() => status.classList.remove('show'), 3500)
}
