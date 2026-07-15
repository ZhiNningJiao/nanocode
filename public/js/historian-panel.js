/**
 * Historian health plugin — MES-14049 extension.
 *
 * Monitor tab for the historian waker system. Displays:
 *   - Army status table (from ~/codex_work/army_status.json, updated every tick)
 *   - Recent briefing stream (waker.log tail)
 *   - Waker self-health (tmux session alive, singleton lock, last tick age, mode)
 *   - akari status row (up/down from same poll)
 *   - Controls: start/stop waker, LIVE/DRY toggle, day/night interval switch
 *
 * Polls /api/historian/state every 15s. Graceful degradation: when the waker
 * is not running, the panel shows a calm "stopped" state and offers a start button.
 */
import { t } from './i18n.js'

const POLL_MS = 15_000

let activePane = null
let pollTimer = null
let pollInFlight = false
let lastState = null

export async function renderHistorianPane(pane) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  await pollOnce()
  startPolling()
}

export function resetHistorianLoadState() {
  activePane = null
  stopPolling()
  pollInFlight = false
  lastState = null
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => { if (activePane) pollOnce() }, POLL_MS)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function pollOnce() {
  if (pollInFlight) return
  pollInFlight = true
  try {
    const r = await fetch('/api/historian/state')
    lastState = await r.json()
    if (activePane) renderState(lastState)
  } catch {
    if (activePane && lastState) renderState(lastState)
  } finally {
    pollInFlight = false
  }
}

// ── render ───────────────────────────────────────────────────────────────────

function renderShell(pane) {
  pane.innerHTML = ''
  const section = document.createElement('div')
  section.className = 'rp-section'
  section.id = 'historian-pane'

  const head = document.createElement('div')
  head.className = 'historian-head'
  head.id = 'historian-head'
  section.appendChild(head)

  const state = document.createElement('div')
  state.id = 'historian-state'
  section.appendChild(state)

  pane.appendChild(section)
}

function renderState(state) {
  const el = activePane?.querySelector('#historian-state')
  if (!el || !state) return
  el.innerHTML = ''

  // Header with waker health dot
  renderHeader(state.wakerHealth, state.akariUp)

  // Waker health card
  el.appendChild(renderWakerHealth(state.wakerHealth, state.akariUp))

  // Waker usage/stats row
  el.appendChild(renderWakerUsage(state.wakerHealth))

  // Army status table
  el.appendChild(renderArmyStatus(state.army))

  // Briefing stream
  el.appendChild(renderBriefingStream(state.logTail))

  // Controls
  el.appendChild(renderControls(state.wakerHealth))
}

function renderHeader(health, akariUp) {
  const head = activePane?.querySelector('#historian-head')
  if (!head) return
  head.innerHTML = ''

  const title = document.createElement('div')
  title.className = 'historian-title'
  const dot = document.createElement('span')
  const alive = health?.tmuxAlive
  const stale = health?.lastTickAgeSeconds != null && health.lastTickAgeSeconds > 600
  dot.className = `service-dot ${alive ? (stale ? 'degraded' : 'up') : 'down'}`
  dot.id = 'historian-dot'
  const label = document.createElement('span')
  label.textContent = t('plugin.historian.label')
  title.appendChild(dot)
  title.appendChild(label)
  head.appendChild(title)

  const refresh = document.createElement('button')
  refresh.className = 'svc-btn'
  refresh.type = 'button'
  refresh.innerHTML = '&#8635;'
  refresh.title = 'Refresh'
  refresh.addEventListener('click', () => pollOnce())
  head.appendChild(refresh)

  const meta = document.createElement('div')
  meta.className = 'historian-meta'
  meta.id = 'historian-meta'
  const modeStr = health?.mode || 'unknown'
  const ageStr = health?.lastTickAgeSeconds != null
    ? fmtAge(health.lastTickAgeSeconds)
    : 'never'
  const akariStr = akariUp ? 'up' : 'down'
  meta.textContent = `mode: ${modeStr} | last tick: ${ageStr} | akari: ${akariStr}`
  head.appendChild(meta)
}

// ── Waker health card ────────────────────────────────────────────────────────

function renderWakerHealth(h, akariUp) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section historian-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  title.textContent = t('plugin.historian.wakerHealth')
  wrap.appendChild(title)

  if (!h) {
    const empty = document.createElement('div')
    empty.className = 'rp-hint'
    empty.textContent = t('plugin.historian.noData')
    wrap.appendChild(empty)
    return wrap
  }

  const grid = document.createElement('div')
  grid.className = 'rp-stats-grid'
  grid.appendChild(stat('tmux', h.tmuxAlive ? 'alive' : 'dead'))
  grid.appendChild(stat('lock', h.singletonLock ? 'held' : 'free'))
  grid.appendChild(stat('mode', h.mode || '?'))
  grid.appendChild(stat('auto-live', h.autoLive ? 'yes' : 'no'))
  grid.appendChild(stat('last tick', h.lastTickAgeSeconds != null ? fmtAge(h.lastTickAgeSeconds) : '?'))
  grid.appendChild(stat('akari', akariUp ? 'up' : 'down'))
  wrap.appendChild(grid)

  // Timeout warning
  if (h.lastTickAgeSeconds != null && h.lastTickAgeSeconds > 600) {
    const warn = document.createElement('div')
    warn.className = 'historian-warn'
    warn.textContent = t('plugin.historian.staleWarn')
    wrap.appendChild(warn)
  }

  return wrap
}

// ── Waker usage / stats row ──────────────────────────────────────────────────

function renderWakerUsage(h) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section historian-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  title.textContent = t('plugin.historian.usageTitle')
  wrap.appendChild(title)

  if (!h) {
    const empty = document.createElement('div')
    empty.className = 'rp-hint'
    empty.textContent = t('plugin.historian.noData')
    wrap.appendChild(empty)
    return wrap
  }

  const grid = document.createElement('div')
  grid.className = 'rp-stats-grid historian-usage-grid'

  // Parse structured stats (beat count, skip reasons)
  const s = h.stats
  if (s && typeof s === 'object') {
    grid.appendChild(stat('beats', String(s.beat ?? '?')))
    const skip = s.skip || {}
    const totalSkip = Object.values(skip).reduce((a, b) => a + (Number(b) || 0), 0)
    grid.appendChild(stat('skipped', String(totalSkip)))
    if (skip.busy) grid.appendChild(stat('skip:busy', String(skip.busy)))
    if (skip.hb_quiet) grid.appendChild(stat('skip:quiet', String(skip.hb_quiet)))
    if (skip.rate) grid.appendChild(stat('skip:rate', String(skip.rate)))
  } else if (typeof s === 'string') {
    grid.appendChild(stat('stats', s.slice(0, 60)))
  }

  // Dry count (ticks before auto-promote)
  if (h.dryCount != null) {
    grid.appendChild(stat('dry ticks', String(h.dryCount)))
  }

  // Coverage (agent tags the waker monitors)
  if (Array.isArray(h.coverage) && h.coverage.length) {
    grid.appendChild(stat('coverage', String(h.coverage.length)))
  }

  wrap.appendChild(grid)

  // Show coverage list as a compact line
  if (Array.isArray(h.coverage) && h.coverage.length) {
    const covLine = document.createElement('div')
    covLine.className = 'rp-hint historian-mono'
    covLine.textContent = h.coverage.join(', ')
    covLine.title = 'Agents in waker coverage'
    wrap.appendChild(covLine)
  }

  return wrap
}

// ── Army status table ────────────────────────────────────────────────────────

function renderArmyStatus(army) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section historian-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  const agents = army?.agents || []
  title.textContent = `${t('plugin.historian.armyTitle')} (${agents.length})`
  wrap.appendChild(title)

  if (!agents.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-hint'
    empty.textContent = t('plugin.historian.noAgents')
    wrap.appendChild(empty)
    return wrap
  }

  if (army.updatedAt) {
    const meta = document.createElement('div')
    meta.className = 'rp-hint'
    const age = Math.round((Date.now() - army.updatedAt) / 1000)
    meta.textContent = `updated ${fmtAge(age)}`
    wrap.appendChild(meta)
  }

  const tbl = document.createElement('table')
  tbl.className = 'historian-table'
  tbl.appendChild(tableHead(['tag', 'iter', 'last active', 'status', 'last line']))
  const body = document.createElement('tbody')
  for (const a of agents) {
    const tr = document.createElement('tr')
    if (a.stalled) tr.className = 'historian-stalled'
    if (a.flag) tr.className = 'historian-flagged'

    tr.appendChild(td(a.tag || '?', 'historian-mono'))
    tr.appendChild(td(a.iter != null ? String(a.iter) : '?'))
    tr.appendChild(td(fmtAge(a.last_active_s)))

    const statusCell = document.createElement('td')
    const dot = document.createElement('span')
    if (a.flag) {
      dot.className = 'historian-status-dot flagged'
      statusCell.appendChild(dot)
      statusCell.appendChild(document.createTextNode('FLAG'))
    } else if (a.stalled) {
      dot.className = 'historian-status-dot stalled'
      statusCell.appendChild(dot)
      statusCell.appendChild(document.createTextNode('STALL'))
    } else {
      dot.className = 'historian-status-dot running'
      statusCell.appendChild(dot)
      statusCell.appendChild(document.createTextNode('running'))
    }
    tr.appendChild(statusCell)

    const lineCell = td(a.last_line?.slice(0, 80) || '', 'historian-line')
    lineCell.title = a.last_line || ''
    tr.appendChild(lineCell)

    body.appendChild(tr)
  }
  tbl.appendChild(body)
  wrap.appendChild(scrollWrap(tbl))
  return wrap
}

// ── Briefing stream ──────────────────────────────────────────────────────────

function renderBriefingStream(logTail) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section historian-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  title.textContent = t('plugin.historian.briefingTitle')
  wrap.appendChild(title)

  const lines = logTail || []
  if (!lines.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-hint'
    empty.textContent = t('plugin.historian.noLogs')
    wrap.appendChild(empty)
    return wrap
  }

  const pre = document.createElement('pre')
  pre.className = 'historian-log'
  // Show most recent entries first
  pre.textContent = lines.slice().reverse().join('\n')
  wrap.appendChild(pre)
  return wrap
}

// ── Controls ─────────────────────────────────────────────────────────────────

function renderControls(health) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section historian-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  title.textContent = t('plugin.historian.controlsTitle')
  wrap.appendChild(title)

  const btnRow = document.createElement('div')
  btnRow.className = 'historian-controls'

  const alive = health?.tmuxAlive

  // Start/Stop toggle
  const toggleBtn = document.createElement('button')
  toggleBtn.className = `rp-btn ${alive ? 'rp-btn-warn' : 'rp-btn-ok'}`
  toggleBtn.textContent = alive
    ? t('plugin.historian.stop')
    : t('plugin.historian.start')
  toggleBtn.addEventListener('click', async () => {
    toggleBtn.disabled = true
    try {
      const action = alive ? 'stop' : 'start'
      const r = await fetch(`/api/historian/waker/${action}`, { method: 'POST' })
      const d = await r.json()
      flashMsg(wrap, d.ok ? (d.action || 'ok') : (d.error || 'failed'), !d.ok)
      setTimeout(() => pollOnce(), 2000)
    } catch (err) {
      flashMsg(wrap, err.message, true)
    } finally {
      toggleBtn.disabled = false
    }
  })
  btnRow.appendChild(toggleBtn)

  // LIVE/DRY toggle
  const modeBtn = document.createElement('button')
  modeBtn.className = 'rp-btn'
  const isLive = health?.mode === 'live' || health?.autoLive
  modeBtn.textContent = isLive
    ? t('plugin.historian.switchDry')
    : t('plugin.historian.switchLive')
  modeBtn.addEventListener('click', async () => {
    modeBtn.disabled = true
    try {
      const r = await fetch('/api/historian/waker/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live: !isLive }),
      })
      const d = await r.json()
      flashMsg(wrap, d.ok ? `restarted (${!isLive ? 'LIVE' : 'DRY'})` : (d.error || 'failed'), !d.ok)
      setTimeout(() => pollOnce(), 3000)
    } catch (err) {
      flashMsg(wrap, err.message, true)
    } finally {
      modeBtn.disabled = false
    }
  })
  btnRow.appendChild(modeBtn)

  wrap.appendChild(btnRow)

  // Day/Night interval row
  const intervalRow = document.createElement('div')
  intervalRow.className = 'historian-controls'
  intervalRow.style.marginTop = '6px'

  const dayBtn = document.createElement('button')
  dayBtn.className = 'rp-btn'
  dayBtn.textContent = t('plugin.historian.dayMode')
  dayBtn.title = 'WAKE_WORK_INTERVAL=270 WAKE_OFF_INTERVAL=270'
  dayBtn.addEventListener('click', () => setIntervalBtn(270, dayBtn, wrap))
  intervalRow.appendChild(dayBtn)

  const nightBtn = document.createElement('button')
  nightBtn.className = 'rp-btn'
  nightBtn.textContent = t('plugin.historian.nightMode')
  nightBtn.title = 'WAKE_WORK_INTERVAL=1200 WAKE_OFF_INTERVAL=1200'
  nightBtn.addEventListener('click', () => setIntervalBtn(1200, nightBtn, wrap))
  intervalRow.appendChild(nightBtn)

  const autoBtn = document.createElement('button')
  autoBtn.className = 'rp-btn'
  autoBtn.textContent = t('plugin.historian.autoMode')
  autoBtn.title = 'Dynamic interval (default)'
  autoBtn.addEventListener('click', () => setIntervalBtn(0, autoBtn, wrap))
  intervalRow.appendChild(autoBtn)

  wrap.appendChild(intervalRow)

  const hint = document.createElement('div')
  hint.className = 'rp-hint'
  hint.textContent = t('plugin.historian.controlsHint')
  wrap.appendChild(hint)

  return wrap
}

async function setIntervalBtn(seconds, btn, container) {
  btn.disabled = true
  try {
    const r = await fetch('/api/historian/waker/interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds }),
    })
    const d = await r.json()
    flashMsg(container, d.ok ? `interval: ${d.interval}` : (d.error || 'failed'), !d.ok)
  } catch (err) {
    flashMsg(container, err.message, true)
  } finally {
    btn.disabled = false
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function stat(label, value) {
  const s = document.createElement('div')
  s.className = 'rp-stat'
  const lab = document.createElement('div')
  lab.className = 'rp-stat-label'
  lab.textContent = label
  const val = document.createElement('div')
  val.className = 'rp-stat-value'
  val.textContent = String(value)
  s.appendChild(lab)
  s.appendChild(val)
  return s
}

function tableHead(labels) {
  const thead = document.createElement('thead')
  const tr = document.createElement('tr')
  for (const l of labels) {
    const th = document.createElement('th')
    th.textContent = l
    tr.appendChild(th)
  }
  thead.appendChild(tr)
  return thead
}

function scrollWrap(tbl) {
  const d = document.createElement('div')
  d.className = 'historian-table-scroll'
  d.appendChild(tbl)
  return d
}

function td(text, cls) {
  const c = document.createElement('td')
  if (cls) c.className = cls
  c.textContent = String(text ?? '')
  return c
}

function fmtAge(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '?'
  const s = Number(seconds)
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

function flashMsg(container, msg, isError) {
  let flash = container.querySelector('.historian-flash')
  if (!flash) {
    flash = document.createElement('div')
    flash.className = 'historian-flash'
    container.appendChild(flash)
  }
  flash.textContent = msg
  flash.classList.toggle('error', !!isError)
  flash.classList.add('show')
  clearTimeout(flash._timer)
  flash._timer = setTimeout(() => flash.classList.remove('show'), 3000)
}
