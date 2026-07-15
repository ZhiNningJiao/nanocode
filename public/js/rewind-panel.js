/**
 * Rewind plugin render core — MES-14031 S2 (抄 Claude Code checkpointing/rewind).
 *
 * Claude Code desktop auto-checkpoints before every user prompt and lets the
 * user /rewind to a prior turn — the recovery path when the agent goes off
 * track (vs /clear which loses all context). This ports that to nanocode.
 *
 * This prototype delivers CONVERSATION rewind: it lists every user prompt as a
 * checkpoint and, on apply, backs up the jsonl then truncates it at the chosen
 * turn boundary (atomic temp-write + rename). "Restore code" (per-turn file
 * snapshots) is the documented next step — the panel says so plainly instead of
 * faking a button that does nothing.
 *
 * Data: GET /api/rewind/checkpoints (read-only list) + POST /api/rewind/apply
 * (backup + atomic truncation; dryRun for a safe smoke-test). The active tab is
 * read from window.__nanocodeActiveClaudeTab (exposed by terminal-view, same
 * hook the per-session team switcher uses), so cross-team/cross-cwd tabs locate
 * the right transcript. Mobile-readable (≥480px): rows ≥44px.
 */

import { t } from './i18n.js'

let activePane = null
let checkpoints = []      // [{ index, preview, ts, line }]  (newest first)
let totalTurns = 0
let totalLines = 0
let loading = false
let lastCtx = ''          // `${projectId}|${tabId}` that produced current list

export async function renderRewindPane(pane, plugin) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  await loadCheckpoints()
}

export function resetRewindLoadState() {
  activePane = null
  checkpoints = []
  totalTurns = 0
  totalLines = 0
  loading = false
  lastCtx = ''
}

// ── active-tab context ──────────────────────────────────────────────────────

function activeTab() {
  const a = (typeof window !== 'undefined' && window.__nanocodeActiveClaudeTab) || null
  if (!a || !a.projectId || !a.tabId) return null
  return { projectId: a.projectId, tabId: a.tabId }
}

// ── data loading ────────────────────────────────────────────────────────────

async function loadCheckpoints() {
  loading = true
  renderControls()
  renderStatus(t('rewind.loading'))
  const ctx = activeTab()
  if (!ctx) {
    loading = false
    checkpoints = []
    renderStatus(t('rewind.noTab'))
    return
  }
  lastCtx = `${ctx.projectId}|${ctx.tabId}`
  try {
    const data = await fetch(
      `/api/rewind/checkpoints?projectId=${encodeURIComponent(ctx.projectId)}&tabId=${encodeURIComponent(ctx.tabId)}`,
    ).then((r) => r.json())
    loading = false
    if (data.error) {
      checkpoints = []
      renderStatus(`${t('rewind.error')}: ${data.error}`, true)
      return
    }
    checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : []
    totalTurns = Number(data.totalTurns) || checkpoints.length
    totalLines = Number(data.totalLines) || 0
    renderControls()
    renderList()
  } catch (err) {
    loading = false
    renderStatus(String(err.message || err), true)
  }
}

async function applyRewind(index, { dryRun = false } = {}) {
  const ctx = activeTab()
  if (!ctx) { renderStatus(t('rewind.noTab')); return }
  let res
  try {
    res = await fetch('/api/rewind/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ctx.projectId,
        tabId: ctx.tabId,
        toIndex: index,
        dryRun,
      }),
    }).then((r) => r.json())
  } catch (err) {
    renderStatus(String(err.message || err), true)
    return
  }
  if (res.error) { renderStatus(fmtKey('rewind.failed', { error: res.error }), true); return }
  if (dryRun) {
    renderStatus(fmtKey('rewind.dryRunResult', {
      n: index, kept: res.keptLines ?? '—', dropped: res.droppedLines ?? '—', backup: res.backup || '—',
    }))
    return
  }
  // Real rewind succeeded — reload the list so the dropped tail disappears.
  renderStatus(fmtKey('rewind.success', {
    n: index, dropped: res.droppedLines ?? '—', backup: res.backup || '—',
  }))
  await loadCheckpoints()
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderShell(pane) {
  pane.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'rw-head'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('rewind.heading')
  head.appendChild(title)
  const intro = document.createElement('div')
  intro.className = 'rp-hint'
  intro.textContent = t('rewind.intro')
  head.appendChild(intro)
  pane.appendChild(head)

  const controls = document.createElement('div')
  controls.className = 'rw-controls'
  controls.id = 'rw-controls'
  pane.appendChild(controls)

  const body = document.createElement('div')
  body.className = 'rw-body'
  body.id = 'rw-body'
  pane.appendChild(body)
}

function renderStatus(msg, isError = false) {
  const body = document.getElementById('rw-body')
  if (!body) return
  body.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'rw-hint' + (isError ? ' rw-error' : '')
  el.textContent = msg
  body.appendChild(el)
}

function renderControls() {
  const el = document.getElementById('rw-controls')
  if (!el) return
  el.innerHTML = ''
  const row = document.createElement('div')
  row.className = 'rw-row'

  const count = document.createElement('span')
  count.className = 'rw-count'
  count.textContent = checkpoints.length
    ? fmtKey('rewind.count', { n: checkpoints.length, lines: totalLines })
    : ''
  row.appendChild(count)

  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'rp-btn rp-btn-sm'
  refresh.textContent = t('rewind.refresh')
  refresh.addEventListener('click', () => loadCheckpoints())
  row.appendChild(refresh)
  el.appendChild(row)
}

function renderList() {
  const body = document.getElementById('rw-body')
  if (!body) return
  body.innerHTML = ''

  if (!checkpoints.length) {
    body.appendChild(rwHint(t('rewind.empty')))
    return
  }

  const list = document.createElement('div')
  list.className = 'rw-list'
  // checkpoints come newest-first; render newest at top (matches Claude Code's
  // /rewind menu where the most recent turn is at the bottom of the list but
  // here we want the user to scroll up to go back in time).
  for (const cp of checkpoints) list.appendChild(renderRow(cp))
  body.appendChild(list)

  const note = document.createElement('div')
  note.className = 'rp-hint rw-code-note'
  note.textContent = t('rewind.codeNote')
  body.appendChild(note)
}

function renderRow(cp) {
  const row = document.createElement('div')
  row.className = 'rw-row-item'

  const meta = document.createElement('div')
  meta.className = 'rw-meta'
  const tag = (cp.index === totalTurns - 1)
    ? fmtKey('rewind.turn', { n: cp.index }) + ' · ' + t('rewind.current')
    : fmtKey('rewind.turn', { n: cp.index })
  const label = document.createElement('div')
  label.className = 'rw-turn-label'
  label.textContent = tag
  meta.appendChild(label)
  if (cp.ts) {
    const time = document.createElement('div')
    time.className = 'rw-time'
    time.textContent = fmtTime(cp.ts)
    meta.appendChild(time)
  }
  row.appendChild(meta)

  const preview = document.createElement('div')
  preview.className = 'rw-preview'
  preview.textContent = cp.preview || ''
  row.appendChild(preview)

  const actions = document.createElement('div')
  actions.className = 'rw-actions'
  const rewindBtn = document.createElement('button')
  rewindBtn.type = 'button'
  rewindBtn.className = 'rp-btn rp-btn-sm'
  rewindBtn.textContent = t('rewind.rewindTo')
  rewindBtn.title = fmtKey('rewind.rewindHint', { n: cp.index })
  rewindBtn.disabled = (cp.index === totalTurns - 1)
  if (cp.index === totalTurns - 1) rewindBtn.title = t('rewind.alreadyLast')
  rewindBtn.addEventListener('click', () => {
    if (cp.index === totalTurns - 1) return
    const ok = window.confirm(fmtKey('rewind.confirm', { n: cp.index }))
    if (!ok) return
    applyRewind(cp.index, { dryRun: false })
  })
  actions.appendChild(rewindBtn)
  row.appendChild(actions)
  return row
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
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch { return ts }
}

function rwHint(text) {
  const d = document.createElement('div')
  d.className = 'rw-hint'
  d.textContent = text
  return d
}
