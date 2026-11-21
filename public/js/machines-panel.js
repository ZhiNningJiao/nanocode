/**
 * Machine Board plugin (nanomach_1645) — "还能放多少" resource dashboard.
 *
 * One card per watched machine: a big headline (free cores / available
 * memory / free GPU memory) plus detail rows, color-coded against the same
 * thresholds the backend uses for the recommendation (server/machines.js
 * THRESHOLDS — single source, not re-guessed here). Polls /api/machines
 * every 60s while the tab is active; each machine degrades independently
 * (unreachable shows "unreachable + last success", never blanks the grid).
 */
import { t } from './i18n.js'

const POLL_MS = 60_000
const MEM_LOW_PCT = 15
const DISK_HIGH_PCT = 90

let activePane = null
let pollTimer = null
let pollInFlight = false

export async function renderMachinesPane(pane) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  await pollOnce()
  startPolling()
}

export function resetMachinesLoadState() {
  activePane = null
  stopPolling()
  pollInFlight = false
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
    const r = await fetch('/api/machines')
    const data = await r.json()
    if (activePane) renderState(data)
  } catch (err) {
    if (activePane) renderError(String(err.message || err))
  } finally {
    pollInFlight = false
  }
}

function renderShell(pane) {
  pane.innerHTML = ''
  const section = document.createElement('div')
  section.className = 'rp-section'
  section.id = 'mach-pane'

  const banner = document.createElement('div')
  banner.className = 'mach-banner'
  banner.id = 'mach-banner'
  section.appendChild(banner)

  const grid = document.createElement('div')
  grid.className = 'mach-grid'
  grid.id = 'mach-grid'
  section.appendChild(grid)

  pane.appendChild(section)
}

function renderError(msg) {
  const grid = activePane?.querySelector('#mach-grid')
  if (!grid) return
  grid.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'rp-hint rp-error'
  el.textContent = msg
  grid.appendChild(el)
}

function renderState(data) {
  renderBanner(data)
  renderGrid(data?.machines || [])
}

function renderBanner(data) {
  const banner = activePane?.querySelector('#mach-banner')
  if (!banner) return
  banner.innerHTML = ''
  const label = document.createElement('span')
  label.className = 'mach-banner-label'
  if (data?.recommended) {
    const m = (data.machines || []).find((x) => x.id === data.recommended)
    label.textContent = `${t('plugin.machines.recommend')} ${m?.label || data.recommended}`
    label.classList.add('mach-banner-ok')
  } else {
    label.textContent = t('plugin.machines.recommendNone')
    label.classList.add('mach-banner-warn')
  }
  banner.appendChild(label)
}

function renderGrid(machines) {
  const grid = activePane?.querySelector('#mach-grid')
  if (!grid) return
  grid.innerHTML = ''
  if (machines.length === 0) {
    const el = document.createElement('div')
    el.className = 'rp-empty'
    el.textContent = t('plugin.machines.desc')
    grid.appendChild(el)
    return
  }
  for (const m of machines) {
    grid.appendChild(m.reachable ? renderCard(m) : renderUnreachableCard(m))
  }
}

function fmtAge(iso) {
  if (!iso) return '—'
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

function fmtUptime(sec) {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  return d > 0 ? `${d}d ${h}h` : `${h}h`
}

function renderUnreachableCard(m) {
  const card = document.createElement('div')
  card.className = 'mach-card mach-card-down'
  const title = document.createElement('div')
  title.className = 'mach-card-title'
  title.innerHTML = `<span class="service-dot down"></span> ${escapeHtml(m.label)}`
  card.appendChild(title)
  const headline = document.createElement('div')
  headline.className = 'mach-headline mach-headline-down'
  headline.textContent = t('plugin.machines.unreachable')
  card.appendChild(headline)
  const detail = document.createElement('div')
  detail.className = 'mach-detail'
  detail.textContent = `${t('plugin.machines.lastSuccess')}: ${fmtAge(m.lastSuccessAt)}${m.lastSuccessAt ? ' ago' : ''}`
  card.appendChild(detail)
  return card
}

function renderCard(m) {
  const s = m.stats
  const memWarn = s.mem.availablePct != null && s.mem.availablePct < MEM_LOW_PCT
  const dstateWarn = s.dstate.count > 0
  const loadWarn = s.cores != null && s.load1 != null && s.load1 > s.cores
  const diskWarn = s.disks.some((d) => d.usedPct > DISK_HIGH_PCT)
  const anyWarn = memWarn || dstateWarn || loadWarn || diskWarn

  const card = document.createElement('div')
  card.className = `mach-card ${anyWarn ? 'mach-card-warn' : 'mach-card-ok'}`

  const title = document.createElement('div')
  title.className = 'mach-card-title'
  title.innerHTML = `<span class="service-dot up"></span> ${escapeHtml(m.label)}`
  card.appendChild(title)

  const headline = document.createElement('div')
  headline.className = 'mach-headline'
  const freeCores = m.derived.freeCores
  const memPct = s.mem.availablePct
  headline.innerHTML = [
    freeCores != null ? `${freeCores} <span class="mach-headline-unit">cores</span>` : '—',
    memPct != null ? `<span class="${memWarn ? 'mach-warn-text' : ''}">${memPct}%</span> <span class="mach-headline-unit">mem</span>` : '',
  ].filter(Boolean).join(' · ')
  card.appendChild(headline)

  const detail = document.createElement('div')
  detail.className = 'mach-detail'
  const rows = []
  rows.push(row(t('plugin.machines.load'), `${s.load1 ?? '—'} / ${s.load5 ?? '—'} / ${s.load15 ?? '—'} (${s.cores ?? '?'} cores)`, loadWarn))
  rows.push(row(t('plugin.machines.memAvailable'), s.mem.availableMB != null ? `${(s.mem.availableMB / 1024).toFixed(1)} GB / ${(s.mem.totalMB / 1024).toFixed(1)} GB` : '—', memWarn))
  if (s.swap.usedMB) rows.push(row(t('plugin.machines.swapUsed'), `${s.swap.usedMB} MB`, s.swap.usedMB > 0))
  for (const d of s.disks) {
    rows.push(row(`${t('plugin.machines.disk')} ${d.mount}`, `${d.usedPct}% (${(d.availMB / 1024).toFixed(1)} GB free)`, d.usedPct > DISK_HIGH_PCT))
  }
  if (s.gpus.length) {
    for (const g of s.gpus) {
      rows.push(row(`${t('plugin.machines.gpu')} ${g.name}`, `${g.utilPct}% util, ${g.memUsedMB}/${g.memTotalMB} MB`, false))
    }
  } else {
    rows.push(row(t('plugin.machines.gpu'), t('plugin.machines.noGpu'), false))
  }
  rows.push(row(t('plugin.machines.dstate'), `${s.dstate.count}${s.dstate.count ? ` (oldest ${fmtUptime(s.dstate.oldestSec)})` : ''}`, dstateWarn))
  rows.push(row(t('plugin.machines.users'), String(s.usersCount), false))
  rows.push(row(t('plugin.machines.uptime'), fmtUptime(s.uptimeSec), false))
  rows.push(row(t('plugin.machines.ourAkari'), s.ours.tmuxSkipped ? t('plugin.machines.ourAkariSkipped') : String(s.ours.tmuxAkariCount), false))
  rows.push(row(t('plugin.machines.ourSystemd'), String(s.ours.systemdUserRunning), false))
  rows.push(row(t('plugin.machines.ourContainers'), String(s.ours.containerCount), false))
  detail.innerHTML = rows.join('')
  card.appendChild(detail)

  const meta = document.createElement('div')
  meta.className = 'mach-meta'
  meta.textContent = `${m.host} · ${fmtAge(m.checkedAt)} ago`
  card.appendChild(meta)

  return card
}

function row(label, value, warn) {
  return `<div class="mach-row${warn ? ' mach-row-warn' : ''}"><span class="mach-row-label">${escapeHtml(label)}</span><span class="mach-row-value">${escapeHtml(value)}</span></div>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
