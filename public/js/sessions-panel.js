/**
 * Sessions plugin render core — MES-14031 (抄 codex resume/fork).
 *
 * Browse past Codex + Claude Code sessions on this machine, preview the tail
 * of the conversation, and fork/resume a previous session into a new tab.
 * This ports Codex CLI's `codex resume` (picker) + `codex fork` to nanocode.
 *
 * Data comes from /api/sessions/list + /api/sessions/preview (read-only). The
 * panel is mobile-readable (≥480px): rows are ≥44px touch targets. "Fork"
 * dispatches a custom event the app shell can turn into a new codex/claude
 * tab resuming that session; if no shell listener is present the button shows
 * the command the user can paste instead (honest degradation — 防假过).
 *
 * This is a render core ("芯"); right-panel.js mounts/unmounts it via the
 * registry. The manifest is passed as the 2nd arg so the default limit can be
 * read from `plugin.settings.defaultLimit`.
 */

import { t } from './i18n.js'

const LIMIT_KEY = 'sessions:listLimit'

let activePane = null
let sessions = []
let total = 0
let source = ''        // '' | 'codex' | 'claude'
let limit = 50
let loading = false
let preview = null     // { turns, ... } | { error }
let previewId = ''
let loadingPreview = false

export async function renderSessionsPane(pane, plugin) {
  if (!pane) return
  activePane = pane
  const def = plugin && plugin.settings && Number(plugin.settings.defaultLimit)
  if (Number.isFinite(def) && def > 0) limit = Math.min(200, Math.max(10, Math.floor(def)))
  try {
    const saved = Number(localStorage.getItem(LIMIT_KEY))
    if (Number.isFinite(saved) && saved > 0) limit = Math.min(200, Math.max(10, Math.floor(saved)))
  } catch {}
  renderShell(pane)
  await loadSessions()
}

export function resetSessionsLoadState() {
  activePane = null
  sessions = []
  total = 0
  source = ''
  loading = false
  preview = null
  previewId = ''
  loadingPreview = false
}

// ── data loading ────────────────────────────────────────────────────────────

async function loadSessions() {
  loading = true
  renderStatus(t('sessions.loading'))
  try {
    const params = new URLSearchParams()
    if (source) params.set('source', source)
    params.set('limit', String(limit))
    const data = await fetch(`/api/sessions/list?${params}`).then((r) => r.json())
    loading = false
    if (data.error) {
      sessions = []
      renderStatus(`${t('sessions.error')}: ${data.error}`, true)
      renderControls()
      return
    }
    sessions = Array.isArray(data.sessions) ? data.sessions : []
    total = data.total || sessions.length
    renderControls()
    renderList()
  } catch (err) {
    loading = false
    renderStatus(String(err.message || err), true)
    renderControls()
  }
}

async function loadPreview(s) {
  if (!s) return
  previewId = s.id
  preview = null
  loadingPreview = true
  renderPreview({ loading: true })
  try {
    const params = new URLSearchParams()
    params.set('source', s.source)
    if (s.id) params.set('id', s.id)
    if (s.file) params.set('file', s.file)
    const data = await fetch(`/api/sessions/preview?${params}`).then((r) => r.json())
    loadingPreview = false
    preview = data
    renderPreview()
  } catch (err) {
    loadingPreview = false
    preview = { error: String(err.message || err) }
    renderPreview()
  }
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderShell(pane) {
  pane.innerHTML = ''
  const controls = document.createElement('div')
  controls.className = 'ses-controls'
  controls.id = 'ses-controls'
  pane.appendChild(controls)
  const body = document.createElement('div')
  body.className = 'ses-body'
  body.id = 'ses-body'
  pane.appendChild(body)
}

function renderStatus(msg, isError = false) {
  const body = document.getElementById('ses-body')
  if (!body) return
  body.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'ses-hint' + (isError ? ' ses-error' : '')
  el.textContent = msg
  body.appendChild(el)
}

function renderControls() {
  const el = document.getElementById('ses-controls')
  if (!el) return
  el.innerHTML = ''

  const row = document.createElement('div')
  row.className = 'ses-row'

  const filter = document.createElement('label')
  filter.className = 'ses-field'
  const lab = document.createElement('span')
  lab.className = 'ses-field-label'
  lab.textContent = t('sessions.filter')
  const sel = document.createElement('select')
  sel.className = 'rp-select'
  for (const [val, key] of [['', 'sessions.all'], ['codex', 'sessions.codex'], ['claude', 'sessions.claude']]) {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = t(key)
    if (val === source) opt.selected = true
    sel.appendChild(opt)
  }
  sel.addEventListener('change', async () => { source = sel.value; await loadSessions() })
  filter.appendChild(lab)
  filter.appendChild(sel)
  row.appendChild(filter)

  const lim = document.createElement('label')
  lim.className = 'ses-field ses-limit'
  const lab2 = document.createElement('span')
  lab2.className = 'ses-field-label'
  lab2.textContent = t('sessions.limit')
  const sel2 = document.createElement('select')
  sel2.className = 'rp-select'
  for (const n of [20, 50, 100, 200]) {
    const opt = document.createElement('option')
    opt.value = n
    opt.textContent = String(n)
    if (n === limit) opt.selected = true
    sel2.appendChild(opt)
  }
  sel2.addEventListener('change', async () => {
    limit = Number(sel2.value) || 50
    try { localStorage.setItem(LIMIT_KEY, String(limit)) } catch {}
    await loadSessions()
  })
  lim.appendChild(lab2)
  lim.appendChild(sel2)
  row.appendChild(lim)

  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'rp-btn rp-btn-sm'
  refresh.textContent = t('sessions.refresh')
  refresh.addEventListener('click', () => loadSessions())
  row.appendChild(refresh)

  el.appendChild(row)
}

function renderList() {
  const body = document.getElementById('ses-body')
  if (!body) return
  body.innerHTML = ''

  if (!sessions.length) {
    body.appendChild(sesHint(t('sessions.empty')))
    return
  }

  const count = document.createElement('div')
  count.className = 'ses-count'
  count.textContent = fmtKey('sessions.count', { shown: sessions.length, total })
  body.appendChild(count)

  const list = document.createElement('div')
  list.className = 'ses-list'
  for (const s of sessions) list.appendChild(renderSessionRow(s))
  body.appendChild(list)
}

function renderSessionRow(s) {
  const row = document.createElement('div')
  row.className = 'ses-row-card'
  row.dataset.id = s.id
  row.dataset.source = s.source

  const head = document.createElement('div')
  head.className = 'ses-card-head'
  const badge = document.createElement('span')
  badge.className = 'ses-badge ses-badge-' + s.source
  badge.textContent = s.source
  const ts = document.createElement('span')
  ts.className = 'ses-ts'
  ts.textContent = fmtTime(s.timestamp)
  head.appendChild(badge)
  head.appendChild(ts)
  row.appendChild(head)

  const cwd = document.createElement('div')
  cwd.className = 'ses-cwd'
  cwd.textContent = s.cwd || t('sessions.unknownCwd')
  cwd.title = s.cwd || ''
  row.appendChild(cwd)

  const msg = document.createElement('div')
  msg.className = 'ses-msg'
  msg.textContent = s.firstMessage || t('sessions.noPreview')
  row.appendChild(msg)

  const meta = document.createElement('div')
  meta.className = 'ses-card-meta'
  const bits = []
  if (s.model) bits.push(s.model)
  if (s.cliVersion) bits.push(`cli ${s.cliVersion}`)
  if (s.turns) bits.push(fmtKey('sessions.turns', { n: s.turns }))
  meta.textContent = bits.join(' · ')
  row.appendChild(meta)

  const actions = document.createElement('div')
  actions.className = 'ses-card-actions'
  const previewBtn = document.createElement('button')
  previewBtn.type = 'button'
  previewBtn.className = 'rp-btn rp-btn-sm'
  previewBtn.textContent = t('sessions.preview')
  previewBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    loadPreview(s)
    const list = document.querySelector('#ses-body .ses-list')
    if (list) list.querySelectorAll('.ses-row-card').forEach((r) =>
      r.classList.toggle('active', r.dataset.id === s.id && r.dataset.source === s.source))
  })
  actions.appendChild(previewBtn)

  const forkBtn = document.createElement('button')
  forkBtn.type = 'button'
  forkBtn.className = 'rp-btn rp-btn-sm ses-fork-btn'
  forkBtn.textContent = t('sessions.fork')
  forkBtn.title = t('sessions.forkHint')
  forkBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    forkSession(s)
  })
  actions.appendChild(forkBtn)
  row.appendChild(actions)

  row.addEventListener('click', () => {
    loadPreview(s)
    const list = document.querySelector('#ses-body .ses-list')
    if (list) list.querySelectorAll('.ses-row-card').forEach((r) =>
      r.classList.toggle('active', r.dataset.id === s.id && r.dataset.source === s.source))
  })

  return row
}

function renderPreview(state = {}) {
  const body = document.getElementById('ses-body')
  if (!body) return
  body.innerHTML = ''

  const bar = document.createElement('div')
  bar.className = 'ses-preview-bar'
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'rp-btn rp-btn-sm'
  back.textContent = '← ' + t('sessions.back')
  back.addEventListener('click', () => { previewId = ''; preview = null; renderList() })
  bar.appendChild(back)
  const crumb = document.createElement('div')
  crumb.className = 'ses-preview-crumb'
  crumb.textContent = fmtKey('sessions.previewFor', { id: previewId ? previewId.slice(0, 8) : '' })
  bar.appendChild(crumb)
  body.appendChild(bar)

  if (loadingPreview || state.loading) {
    body.appendChild(sesHint(t('sessions.loading')))
    return
  }
  if (!preview) {
    body.appendChild(sesHint(t('sessions.pickSession')))
    return
  }
  if (preview.error) {
    const e = document.createElement('div')
    e.className = 'ses-hint ses-error'
    e.textContent = `${t('sessions.error')}: ${preview.error}`
    body.appendChild(e)
    return
  }

  const meta = document.createElement('div')
  meta.className = 'ses-preview-meta'
  const bits = []
  if (preview.cwd) bits.push(preview.cwd)
  if (preview.model) bits.push(preview.model)
  if (preview.cliVersion) bits.push(`cli ${preview.cliVersion}`)
  if (preview.totalTurns != null) bits.push(fmtKey('sessions.totalTurns', { n: preview.totalTurns }))
  meta.textContent = bits.join(' · ')
  body.appendChild(meta)

  const turns = Array.isArray(preview.turns) ? preview.turns : []
  if (!turns.length) {
    body.appendChild(sesHint(t('sessions.noTurns')))
    return
  }

  const wrap = document.createElement('div')
  wrap.className = 'ses-turns'
  for (const turn of turns) {
    const el = document.createElement('div')
    el.className = 'ses-turn ses-turn-' + turn.role
    const role = document.createElement('div')
    role.className = 'ses-turn-role'
    role.textContent = turn.role === 'assistant' ? '🤖' : '👤'
    const text = document.createElement('div')
    text.className = 'ses-turn-text'
    text.textContent = turn.text || ''
    el.appendChild(role)
    el.appendChild(text)
    wrap.appendChild(el)
  }
  body.appendChild(wrap)

  const forkBar = document.createElement('div')
  forkBar.className = 'ses-fork-bar'
  const forkBtn = document.createElement('button')
  forkBtn.type = 'button'
  forkBtn.className = 'rp-btn rp-btn-sm ses-fork-btn'
  forkBtn.textContent = t('sessions.fork')
  forkBtn.title = t('sessions.forkHint')
  const s = sessions.find((x) => x.id === previewId)
  forkBtn.addEventListener('click', () => forkSession(s || { id: previewId, source: preview.source }))
  forkBar.appendChild(forkBtn)
  body.appendChild(forkBar)
}

// ── fork dispatch ────────────────────────────────────────────────────────────

function forkSession(s) {
  if (!s || !s.id) return
  const cmd = s.source === 'codex'
    ? `codex resume ${s.id}`
    : `claude --resume ${s.id}`
  const detail = { source: s.source, id: s.id, cwd: s.cwd || '', cmd }
  // dispatchEvent returns true when NOT cancelled (no listener called
  // preventDefault) → that means nobody handled the fork → show the command
  // fallback. Returns false when a listener called preventDefault → handled.
  let notHandled = true
  try {
    notHandled = document.dispatchEvent(new CustomEvent('nanocode:fork-session', { detail, cancelable: true }))
  } catch { notHandled = true }
  if (notHandled) {
    const body = document.getElementById('ses-body')
    if (body) {
      body.appendChild(sesHint(fmtKey('sessions.forkCmd', { cmd })))
      const pre = document.createElement('pre')
      pre.className = 'ses-cmd preview-code'
      pre.textContent = cmd
      body.appendChild(pre)
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtKey(key, vars) {
  let s = t(key)
  if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]))
  return s
}

function fmtTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ts
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return ts }
}

function sesHint(text) {
  const d = document.createElement('div')
  d.className = 'ses-hint'
  d.textContent = text
  return d
}
