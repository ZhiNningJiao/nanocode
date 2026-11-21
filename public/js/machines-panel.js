/**
 * Machine Board plugin (nanomach_1645) — "还能放多少" resource dashboard.
 *
 * One card per watched machine: a big headline (free cores / available
 * memory / free GPU memory) plus detail rows, color-coded against the same
 * thresholds the backend uses for the recommendation (server/machines.js
 * THRESHOLDS — single source, not re-guessed here). Polls /api/machines
 * every 60s while the tab, a cockpit block or the header chip ("机器 3/4 ·
 * 建议放 X") is up — one fetch feeds all of them; each machine degrades
 * independently (unreachable shows "unreachable + last success", never
 * blanks the grid).
 */
import { t } from './i18n.js'
import { ensureCss, headerChip, removeHeaderChip, openPluginTab } from './command-center-format.js'

const POLL_MS = 60_000
const MEM_LOW_PCT = 15
const DISK_HIGH_PCT = 90
const CHIP = 'machines'
const TAB_ID = 'machines'

const views = new Set() // right-panel tab + cockpit block
let chipOn = false
let pollTimer = null
let pollInFlight = false
let last = null
let lastError = null
let lastAt = 0 // ms of the last successful fetch
const FRESH_MS = 10_000 // a view / chip mounting within this reuses the last fetch

export async function renderMachinesPane(pane) {
  if (!pane) return
  views.add(pane)
  renderShell(pane)
  if (last) renderState(pane, last)
  syncTimer()
  await pollIfStale()
}

/** Drop one view (`pane`), or every view when the plugin is turned off. */
export function resetMachinesLoadState(pane) {
  if (pane) views.delete(pane)
  else views.clear()
  syncTimer()
}

// ─── header chip ("机器速览") ───────────────────────────────────────────────

export function mountMachinesChip() {
  ensureCss()
  chipOn = true
  const chip = headerChip(CHIP)
  if (chip && !chip.dataset.wired) {
    chip.dataset.wired = '1'
    chip.addEventListener('click', () => openPluginTab(TAB_ID))
  }
  renderChip()
  syncTimer()
  pollIfStale()
}

export function unmountMachinesChip() {
  chipOn = false
  removeHeaderChip(CHIP)
  syncTimer()
}

function renderChip() {
  if (!chipOn) return
  const chip = headerChip(CHIP)
  if (!chip) return
  chip.classList.remove('cc-hchip-warn', 'cc-hchip-down')
  const list = last?.machines
  if (lastError || !Array.isArray(list)) {
    chip.classList.add('cc-hchip-down')
    chip.textContent = `${t('plugin.machines.chip')} ?`
    chip.title = lastError || t('plugin.machines.chipNone')
    return
  }
  if (!list.length) {
    // nothing configured (machines.local.json absent) — say so, don't look broken
    chip.textContent = `${t('plugin.machines.chip')} ${t('plugin.machines.chipNotConnected')}`
    chip.title = t('plugin.machines.chipNone')
    return
  }
  const up = list.filter((m) => m.reachable).length
  const rec = last.recommended ? list.find((m) => m.id === last.recommended) : null
  if (up < list.length || !rec) chip.classList.add('cc-hchip-warn')
  chip.textContent = `${t('plugin.machines.chip')} ${up}/${list.length}${rec ? ` · ${t('plugin.machines.chipRec', rec.label || rec.id)}` : ''}`
  chip.title = rec ? `${t('plugin.machines.recommend')} ${rec.label || rec.id}` : t('plugin.machines.recommendNone')
}

// ─── data ───────────────────────────────────────────────────────────────────

function pollIfStale() {
  return Date.now() - lastAt > FRESH_MS ? pollOnce() : undefined
}

function syncTimer() {
  const want = chipOn || views.size > 0
  if (want && !pollTimer) pollTimer = setInterval(pollOnce, POLL_MS)
  if (!want && pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function pollOnce() {
  if (pollInFlight) return
  pollInFlight = true
  try {
    const r = await fetch('/api/machines')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    last = await r.json()
    lastAt = Date.now()
    lastError = null
    for (const v of views) renderState(v, last)
  } catch (err) {
    lastError = String(err.message || err)
    for (const v of views) renderError(v, lastError)
  } finally {
    pollInFlight = false
  }
  renderChip()
}

function renderShell(pane) {
  pane.innerHTML = ''
  const section = document.createElement('div')
  section.className = 'rp-section mach-pane'

  const banner = document.createElement('div')
  banner.className = 'mach-banner'
  section.appendChild(banner)

  const grid = document.createElement('div')
  grid.className = 'mach-grid'
  section.appendChild(grid)

  pane.appendChild(section)
}

function renderError(pane, msg) {
  const grid = pane.querySelector('.mach-grid')
  if (!grid) return
  grid.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'rp-hint rp-error'
  el.textContent = msg
  grid.appendChild(el)
}

function renderState(pane, data) {
  renderBanner(pane, data)
  renderGrid(pane, data?.machines || [])
}

function renderBanner(pane, data) {
  const banner = pane.querySelector('.mach-banner')
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

function renderGrid(pane, machines) {
  const grid = pane.querySelector('.mach-grid')
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

function fmtDurationSec(sec) {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

function fmtAge(iso) {
  if (!iso) return '—'
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return fmtDurationSec(sec)
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
  const dstateWarn = s.dstate.stuckCount > 0
  const loadWarn = s.cores != null && s.load1 != null && s.load1 > s.cores
  const diskWarn = s.disks.some((d) => d.usedPct > DISK_HIGH_PCT)
  const anyWarn = memWarn || dstateWarn || loadWarn || diskWarn

  const card = document.createElement('div')
  card.className = `mach-card ${anyWarn ? 'mach-card-warn' : 'mach-card-ok'}`

  const title = document.createElement('div')
  title.className = 'mach-card-title'
  title.innerHTML = `<span class="service-dot ${anyWarn ? 'degraded' : 'up'}"></span> ${escapeHtml(m.label)}`
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
  rows.push(row(t('plugin.machines.dstate'), `${s.dstate.stuckCount}${s.dstate.stuckCount ? ` (oldest ${fmtDurationSec(s.dstate.stuckOldestSec)})` : ''}`, dstateWarn))
  if (s.dstate.transientCount > 0) {
    rows.push(row(t('plugin.machines.dstateTransient'), `${s.dstate.transientCount} (newest ${fmtDurationSec(s.dstate.transientOldestSec)})`, false, ' mach-row-sub'))
  }
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

function row(label, value, warn, extraClass = '') {
  return `<div class="mach-row${warn ? ' mach-row-warn' : ''}${extraClass}"><span class="mach-row-label">${escapeHtml(label)}</span><span class="mach-row-value">${escapeHtml(value)}</span></div>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
