/**
 * Command Center P0-5 — quota (额度) plugin.
 *
 * GET /api/command-center/quota (the server only reads the on-disk header
 * cache; nothing here or there calls a model API). Two surfaces:
 *   - an app-header chip with the tightest 1–2 pools ("最紧 T3 7天 97%");
 *   - the tab: one card per pool — 5h / 7d used %, reset time, logged in or
 *     not, source + read time. A reading older than the stale limit is marked
 *     "旧"; a window past its reset time shows "已重置，读数作废" instead of a %.
 */
import { t } from './i18n.js'
import { quotaSeverity } from './quota-levels.js'
import { ensureCss, esc, fmtTime, fmtAgo, downBlock, headerChip, removeHeaderChip, openPluginTab } from './command-center-format.js'

const POLL_MS = 60_000
const CHIP = 'quota'
const TAB_ID = 'cc-quota'

const views = new Set() // right-panel tab + the cockpit 额度 page's per-pool detail
let chipOn = false
let timer = null
let inFlight = false
let last = null
let lastError = null
let lastAt = 0 // ms of the last successful fetch
const FRESH_MS = 10_000 // a view / chip mounting within this reuses the last fetch

async function poll() {
  if (inFlight) return
  inFlight = true
  try {
    const r = await fetch('/api/command-center/quota')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    last = await r.json()
    lastAt = Date.now()
    lastError = null
  } catch (err) {
    lastError = String(err.message || err)
  } finally {
    inFlight = false
  }
  renderChip()
  for (const el of views) renderView(el)
}

function pollIfStale() {
  return Date.now() - lastAt > FRESH_MS ? poll() : undefined
}

function syncTimer() {
  const want = chipOn || views.size > 0
  if (want && !timer) timer = setInterval(poll, POLL_MS)
  if (!want && timer) { clearInterval(timer); timer = null }
}

function level(pct) {
  const sev = quotaSeverity(pct)
  return sev == null ? 'none' : sev === 'critical' ? 'hot' : sev === 'warning' ? 'warn' : 'ok'
}

// ─── header chip ────────────────────────────────────────────────────────────

export function mountQuotaChip() {
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

export function unmountQuotaChip() {
  chipOn = false
  removeHeaderChip(CHIP)
  syncTimer()
}

function renderChip() {
  if (!chipOn) return
  const chip = headerChip(CHIP)
  if (!chip) return
  const ok = !lastError && last?.configured && last.source?.ok
  const top = ok ? last.tightest || [] : []
  chip.classList.remove('cc-hchip-hot', 'cc-hchip-warn', 'cc-hchip-down')
  if (!ok) {
    chip.classList.add('cc-hchip-down')
    chip.textContent = `${t('plugin.ccq.chip')} ?`
    chip.title = lastError || last?.source?.error || last?.error || t('plugin.ccq.chipDown')
    return
  }
  if (!top.length) {
    chip.textContent = `${t('plugin.ccq.chip')} —`
    chip.title = t('plugin.ccq.noLive')
    return
  }
  const lv = level(top[0].pct)
  if (lv === 'hot' || lv === 'warn') chip.classList.add(`cc-hchip-${lv}`)
  chip.textContent = `${t('plugin.ccq.tightest')} ${top.map((x) => `${x.pool} ${t(`plugin.ccq.win.${x.key}`)} ${x.pct}%${x.stale ? `（${t('plugin.ccq.stale')}）` : ''}`).join(' · ')}`
  chip.title = t('plugin.ccq.chipTitle')
}

// ─── tab ────────────────────────────────────────────────────────────────────

export async function renderQuotaPane(el) {
  if (!el) return
  ensureCss()
  views.add(el)
  if (!el.querySelector('.ccq-root')) {
    el.innerHTML = `<div class="ccq-root cc-mod"><div class="cc-mod-head"><span class="cc-top-title">${esc(t('plugin.ccq.title'))}</span><span class="cc-mod-meta ccq-meta"></span><button class="rp-btn-sm ccq-refresh" title="${esc(t('plugin.cc.refresh'))}">↻</button></div><div class="ccq-body"></div></div>`
    el.querySelector('.ccq-refresh').addEventListener('click', () => poll())
  }
  syncTimer()
  renderView(el)
  await pollIfStale()
}

/** Drop one view (`el`), or every view when the plugin is turned off. */
export function resetQuotaLoadState(el) {
  if (el) views.delete(el)
  else views.clear()
  syncTimer()
}

function renderView(pane) {
  const body = pane.querySelector('.ccq-body')
  if (!body) return
  if (lastError && !last) { body.innerHTML = `<div class="rp-hint rp-error">${esc(lastError)}</div>`; return }
  if (!last) { body.innerHTML = `<div class="rp-empty">…</div>`; return }
  if (!last.configured) { body.innerHTML = `<div class="cc-block-down">${esc(t('plugin.cc.notConfigured'))}<div class="cc-sub">${esc(last.error || '')}</div></div>`; return }
  pane.querySelector('.ccq-meta').textContent = lastError ? `${t('plugin.cc.unreachable')}: ${lastError}` : ''
  const src = last.source || {}
  if (src.notConnected) { body.innerHTML = `<div class="cc-note">${esc(t('plugin.ccq.notConnected'))}</div>`; return }
  if (!src.ok) { body.innerHTML = downBlock(t('plugin.ccq.down'), src); return }
  if (!last.pools.length) { body.innerHTML = `<div class="rp-empty">${esc(t('plugin.ccq.empty'))}</div>`; return }
  body.innerHTML = `
    <div class="cc-sub ccq-legend">${esc(t('plugin.ccq.legend', Math.round((last.staleSec || 900) / 60)))}</div>
    <div class="ccq-grid">${last.pools.map(poolHtml).join('')}</div>`
}

function loginHtml(p) {
  if (p.loggedIn === true) return `<span class="ccq-login ccq-login-yes">${esc(t('plugin.ccq.loggedIn'))}</span>`
  if (p.loggedIn === false) return `<span class="ccq-login ccq-login-no">${esc(t('plugin.ccq.loggedOut'))}</span>`
  return `<span class="ccq-login ccq-login-unknown">${esc(t('plugin.ccq.loginUnknown'))}</span>`
}

function windowHtml(w) {
  const name = t(`plugin.ccq.win.${w.key}`)
  if (w.expired) return `<div class="ccq-win ccq-void"><span class="ccq-wname">${esc(name)}</span><span class="ccq-wval">${esc(t('plugin.ccq.void'))}</span><span class="ccq-reset">${esc(t('plugin.ccq.resetAt'))} ${esc(fmtTime(w.resetAt))}</span></div>`
  if (w.pct == null) return `<div class="ccq-win"><span class="ccq-wname">${esc(name)}</span><span class="ccq-wval">${esc(t('plugin.ccq.noReading'))}</span></div>`
  const lv = level(w.pct)
  return `
    <div class="ccq-win">
      <span class="ccq-wname">${esc(name)}</span>
      <span class="ccq-bar"><span class="ccq-fill ccq-${lv}" style="width:${Math.min(100, w.pct)}%"></span></span>
      <span class="ccq-wval ccq-t-${lv}">${w.pct}%</span>
      <span class="ccq-reset">${w.resetAt ? `${esc(t('plugin.ccq.resetAt'))} ${esc(fmtTime(w.resetAt))}` : ''}</span>
    </div>`
}

function poolHtml(p) {
  const stale = p.stale ? `<span class="ccq-stale" title="${esc(t('plugin.ccq.staleTitle'))}">${esc(t('plugin.ccq.stale'))}</span>` : ''
  const status = p.status ? t(`plugin.ccq.status.${p.status}`) : ''
  const statusTxt = status && !status.startsWith('plugin.') ? status : (p.status || '')
  return `
    <div class="ccq-card${p.stale ? ' ccq-card-stale' : ''}">
      <div class="ccq-head"><span class="ccq-pool">${esc(p.pool)}</span>${loginHtml(p)}${stale}${statusTxt ? `<span class="cc-chip">${esc(statusTxt)}</span>` : ''}</div>
      ${p.error ? `<div class="cc-sub cc-err">${esc(p.error)}</div>` : ''}
      ${p.windows.map(windowHtml).join('')}
      <div class="cc-sub ccq-src">${esc(t('plugin.ccq.source'))} · ${esc(t('plugin.ccq.readAt'))} ${esc(fmtTime(p.fetchedAt))}${p.fetchedAt ? `（${esc(fmtAgo(p.fetchedAt))}）` : ''}</div>
    </div>`
}
