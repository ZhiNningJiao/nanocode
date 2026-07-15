/**
 * Tasks plugin render core — MES-14031 S5 (agent task list / TODO panel).
 *
 * Both Claude Code (TodoWrite tool) and Codex (todo_list structured events)
 * maintain a live task list during agent turns. Until now that list was
 * buried in the terminal scrollback; this panel surfaces it as a dedicated
 * right-side tab so the user can see what the agent is working on at a glance.
 *
 * Data flow (purely client-side, no backend route):
 *   claude-block-renderer  →  TodoWrite tool_use  →  nanocode:todo-update
 *   codex-block-renderer   →  todo_list event     →  nanocode:todo-update
 *   tasks-panel (this)     ←  nanocode:todo-update  →  re-render list
 *
 * The panel listens for `nanocode:todo-update` CustomEvents on `document`.
 * Each event carries { source, tabId, todos }. The panel stores the latest
 * todos and renders them. Since only one pane is active at a time, the latest
 * todos always belong to the active agent — no explicit tab routing needed
 * for this prototype.
 *
 * Normalization: Claude and Codex use slightly different field names for the
 * todo content (content / title / subject / text) and status values. The
 * `normalizeTodos` pure function maps both into a common shape so the renderer
 * is source-agnostic. It is exported for unit testing.
 */

import { t } from './i18n.js'

let activePane = null
let currentTodos = []      // normalized [{ content, status, priority }]
let currentSource = null   // 'claude' | 'codex'
let listener = null

export async function renderTasksPane(pane) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  _wireListener()
  renderList()
}

export function resetTasksLoadState() {
  activePane = null
  currentTodos = []
  currentSource = null
  if (listener) {
    document.removeEventListener('nanocode:todo-update', listener)
    listener = null
  }
}

// ── event wiring ─────────────────────────────────────────────────────────────

function _wireListener() {
  if (listener) return
  listener = (e) => {
    const detail = e.detail || {}
    if (!detail.todos || !Array.isArray(detail.todos)) return
    currentTodos = normalizeTodos(detail.todos)
    currentSource = detail.source || null
    if (activePane) renderList()
  }
  document.addEventListener('nanocode:todo-update', listener)
}

// ── normalization (exported for testing) ──────────────────────────────────────

const STATUS_MAP = {
  pending: 'pending',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  in_progress_: 'in_progress',
  completed: 'completed',
  done: 'completed',
  finish: 'completed',
  finished: 'completed',
  blocked: 'blocked',
}

export function normalizeTodos(rawTodos) {
  if (!Array.isArray(rawTodos)) return []
  return rawTodos.map((item) => {
    if (item == null) return null
    const content =
      item.content || item.title || item.subject || item.text || item.task || ''
    const rawStatus = item.status || item.state || ''
    const status = STATUS_MAP[String(rawStatus).toLowerCase()] || 'pending'
    const priority = item.priority || ''
    return { content: String(content), status, priority: String(priority) }
  }).filter(Boolean)
}

export function summarizeTodos(todos) {
  const counts = { completed: 0, in_progress: 0, pending: 0, blocked: 0 }
  for (const todo of todos) {
    if (counts[todo.status] != null) counts[todo.status]++
  }
  return counts
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderShell(pane) {
  pane.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'tk-head'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('tasks.heading')
  head.appendChild(title)
  const intro = document.createElement('div')
  intro.className = 'rp-hint'
  intro.textContent = t('tasks.intro')
  head.appendChild(intro)
  pane.appendChild(head)

  const summary = document.createElement('div')
  summary.className = 'tk-summary'
  summary.id = 'tk-summary'
  pane.appendChild(summary)

  const body = document.createElement('div')
  body.className = 'tk-body'
  body.id = 'tk-body'
  pane.appendChild(body)
}

function renderList() {
  const body = document.getElementById('tk-body')
  if (!body) return
  body.innerHTML = ''
  renderSummary()

  if (!currentTodos.length) {
    const hint = document.createElement('div')
    hint.className = 'tk-hint'
    hint.textContent = t('tasks.empty')
    body.appendChild(hint)
    return
  }

  const list = document.createElement('div')
  list.className = 'tk-list'
  for (const todo of currentTodos) list.appendChild(renderRow(todo))
  body.appendChild(list)
}

function renderSummary() {
  const el = document.getElementById('tk-summary')
  if (!el) return
  el.innerHTML = ''
  if (!currentTodos.length) return
  const counts = summarizeTodos(currentTodos)
  const parts = []
  if (counts.completed) parts.push(fmtKey('tasks.done', { n: counts.completed }))
  if (counts.in_progress) parts.push(fmtKey('tasks.inProgress', { n: counts.in_progress }))
  if (counts.pending) parts.push(fmtKey('tasks.pending', { n: counts.pending }))
  if (counts.blocked) parts.push(fmtKey('tasks.blocked', { n: counts.blocked }))
  if (!parts.length) return
  const span = document.createElement('span')
  span.className = 'tk-summary-text'
  span.textContent = parts.join(' · ')
  el.appendChild(span)
  if (currentSource) {
    const badge = document.createElement('span')
    badge.className = 'tk-source-badge'
    badge.textContent = currentSource
    el.appendChild(badge)
  }
}

function renderRow(todo) {
  const row = document.createElement('div')
  row.className = `tk-row tk-${todo.status}`

  const icon = document.createElement('span')
  icon.className = 'tk-icon'
  icon.textContent = _statusIcon(todo.status)
  row.appendChild(icon)

  const text = document.createElement('div')
  text.className = 'tk-text'
  text.textContent = todo.content || t('tasks.untitled')
  row.appendChild(text)

  if (todo.priority) {
    const pri = document.createElement('span')
    pri.className = `tk-priority tk-pri-${todo.priority}`
    pri.textContent = todo.priority
    row.appendChild(pri)
  }
  return row
}

function _statusIcon(status) {
  switch (status) {
    case 'completed': return '\u2713'
    case 'in_progress': return '\u2192'
    case 'blocked': return '!'
    default: return '\u25CB'
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtKey(key, vars) {
  let s = t(key)
  if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]))
  return s
}
