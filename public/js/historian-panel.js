/**
 * Historian plugin render core — monitor group.
 *
 * Displays the historian sweep output: running tasks, stalled alerts,
 * signal flags, tmux sessions, port health, and waker status.
 * Polls /api/historian/briefing every 30s for fresh data.
 */

import { t } from './i18n.js'

let activePane = null
let pollTimer = null
let lastBriefing = null
let wakerStatus = null

const POLL_INTERVAL = 30_000

export async function renderHistorianPane(pane) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  await refresh()
  startPoll()
}

export function resetHistorianLoadState() {
  activePane = null
  lastBriefing = null
  wakerStatus = null
  stopPoll()
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(() => refresh(), POLL_INTERVAL)
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function refresh() {
  try {
    const [briefResp, wakerResp] = await Promise.all([
      fetch('/api/historian/briefing'),
      fetch('/api/waker/status'),
    ])
    if (briefResp.ok) lastBriefing = await briefResp.json()
    if (wakerResp.ok) wakerStatus = await wakerResp.json()
  } catch { /* network error, keep stale data */ }
  if (activePane) renderContent()
}

function renderShell(pane) {
  pane.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'rp-section-title'
  head.textContent = t('historian.heading')
  pane.appendChild(head)

  const hint = document.createElement('div')
  hint.className = 'rp-hint'
  hint.textContent = t('historian.intro')
  pane.appendChild(hint)

  const wakerSection = document.createElement('div')
  wakerSection.id = 'hist-waker'
  wakerSection.className = 'rp-section'
  pane.appendChild(wakerSection)

  const body = document.createElement('div')
  body.id = 'hist-body'
  body.className = 'rp-section'
  pane.appendChild(body)
}

function renderContent() {
  renderWakerSection()
  renderBriefingSection()
}

function renderWakerSection() {
  const el = document.getElementById('hist-waker')
  if (!el) return
  el.innerHTML = ''

  const title = document.createElement('div')
  title.className = 'hist-subtitle'
  title.textContent = t('historian.waker')
  el.appendChild(title)

  if (!wakerStatus) {
    el.appendChild(mkHint(t('historian.loading')))
    return
  }

  const grid = document.createElement('div')
  grid.className = 'hist-grid'

  grid.appendChild(mkKV(t('historian.enabled'), wakerStatus.enabled ? '\u2713' : '\u2717'))
  if (wakerStatus.lastInjectTime) {
    const ago = Math.round((Date.now() - new Date(wakerStatus.lastInjectTime).getTime()) / 60000)
    grid.appendChild(mkKV(t('historian.lastInject'), `${ago}m ago`))
  }
  grid.appendChild(mkKV(t('historian.hourly'), `${wakerStatus.hourlyCount}/${wakerStatus.hourlyCap}`))
  if (wakerStatus.tmuxTarget) {
    grid.appendChild(mkKV('tmux', wakerStatus.tmuxTarget))
  }
  el.appendChild(grid)
}

function renderBriefingSection() {
  const el = document.getElementById('hist-body')
  if (!el) return
  el.innerHTML = ''

  if (!lastBriefing) {
    el.appendChild(mkHint(t('historian.loading')))
    return
  }

  // Signals
  const sigs = lastBriefing.signals
  if (sigs && (sigs.flags.length || sigs.failsigs.length)) {
    const sigDiv = document.createElement('div')
    sigDiv.className = 'hist-signals'
    const sigTitle = document.createElement('div')
    sigTitle.className = 'hist-subtitle'
    sigTitle.textContent = t('historian.signals')
    sigDiv.appendChild(sigTitle)
    for (const f of sigs.flags) sigDiv.appendChild(mkBadge(`FLAG_${f}`, 'hist-flag'))
    for (const f of sigs.failsigs) sigDiv.appendChild(mkBadge(`FAILSIG_${f}`, 'hist-failsig'))
    el.appendChild(sigDiv)
  }

  // Stalled warnings
  if (lastBriefing.stalled && lastBriefing.stalled.length) {
    const stallDiv = document.createElement('div')
    stallDiv.className = 'hist-stalled'
    const stallTitle = document.createElement('div')
    stallTitle.className = 'hist-subtitle hist-warn'
    stallTitle.textContent = t('historian.stalled')
    stallDiv.appendChild(stallTitle)
    for (const s of lastBriefing.stalled) {
      stallDiv.appendChild(mkRow(`${s.tag} (${s.ageMinutes}m)`, s.lastLine, 'hist-stall-row'))
    }
    el.appendChild(stallDiv)
  }

  // Running tasks
  if (lastBriefing.loops && lastBriefing.loops.length) {
    const loopDiv = document.createElement('div')
    loopDiv.className = 'hist-loops'
    const loopTitle = document.createElement('div')
    loopTitle.className = 'hist-subtitle'
    loopTitle.textContent = `${t('historian.running')} (${lastBriefing.loops.length})`
    loopDiv.appendChild(loopTitle)
    for (const l of lastBriefing.loops) {
      const iterStr = l.iter != null ? ` iter${l.iter}` : ''
      const label = `${l.tag} (${l.ageMinutes}m${iterStr})`
      loopDiv.appendChild(mkRow(label, l.lastLine, l.stalled ? 'hist-row hist-stall-row' : 'hist-row'))
    }
    el.appendChild(loopDiv)
  }

  // Ports
  if (lastBriefing.ports) {
    const portDiv = document.createElement('div')
    portDiv.className = 'hist-ports'
    const portTitle = document.createElement('div')
    portTitle.className = 'hist-subtitle'
    portTitle.textContent = t('historian.ports')
    portDiv.appendChild(portTitle)
    const portGrid = document.createElement('div')
    portGrid.className = 'hist-grid'
    for (const [port, status] of Object.entries(lastBriefing.ports)) {
      const cls = status === 'up' ? 'hist-port-up' : 'hist-port-down'
      portGrid.appendChild(mkBadge(`${port} ${status === 'up' ? '\u2713' : '\u2717'}`, cls))
    }
    portDiv.appendChild(portGrid)
    el.appendChild(portDiv)
  }

  // tmux sessions
  if (lastBriefing.tmuxPanes && lastBriefing.tmuxPanes.length) {
    const tmuxDiv = document.createElement('div')
    tmuxDiv.className = 'hist-tmux'
    const tmuxTitle = document.createElement('div')
    tmuxTitle.className = 'hist-subtitle'
    tmuxTitle.textContent = `tmux (${lastBriefing.tmuxPanes.length})`
    tmuxDiv.appendChild(tmuxTitle)
    for (const p of lastBriefing.tmuxPanes) {
      tmuxDiv.appendChild(mkRow(p.session, p.lastLines, 'hist-row'))
    }
    el.appendChild(tmuxDiv)
  }

  // Timestamp
  if (lastBriefing.timeShort) {
    const ts = document.createElement('div')
    ts.className = 'hist-ts'
    ts.textContent = `${t('historian.updated')} ${lastBriefing.timeShort}`
    el.appendChild(ts)
  }
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function mkHint(text) {
  const el = document.createElement('div')
  el.className = 'rp-hint'
  el.textContent = text
  return el
}

function mkKV(key, value) {
  const el = document.createElement('div')
  el.className = 'hist-kv'
  const k = document.createElement('span')
  k.className = 'hist-key'
  k.textContent = key
  const v = document.createElement('span')
  v.className = 'hist-val'
  v.textContent = value
  el.appendChild(k)
  el.appendChild(v)
  return el
}

function mkBadge(text, cls) {
  const el = document.createElement('span')
  el.className = `hist-badge ${cls}`
  el.textContent = text
  return el
}

function mkRow(label, detail, cls) {
  const row = document.createElement('div')
  row.className = cls || 'hist-row'
  const lbl = document.createElement('div')
  lbl.className = 'hist-row-label'
  lbl.textContent = label
  row.appendChild(lbl)
  if (detail) {
    const det = document.createElement('div')
    det.className = 'hist-row-detail'
    det.textContent = detail
    row.appendChild(det)
  }
  return row
}
