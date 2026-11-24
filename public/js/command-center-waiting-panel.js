/**
 * Command Center P0-4 — "waiting on you" (等你) plugin.
 *
 * Two surfaces, one data fetch (GET /api/command-center/waiting):
 *   - an app-header chip "等你 N" (global mount while the plugin is enabled);
 *     click → this plugin's tab;
 *   - the tab: one list, longest wait first; each row says what is stuck,
 *     who is waiting and on whom (owner decision / secretary to accept or
 *     unblock a car), for how long, plus the recommendation / options / link
 *     the secretary wrote for owner decisions.
 *
 * Each source degrades on its own (PRD P0-8): car signals down → that part
 * says "unreachable + last success"; the owner file missing → "not connected"
 * (never shown as "nothing pending").
 */
import { t } from './i18n.js'
import { ensureCss, esc, fmtTime, fmtAgo, fmtDuration, downBlock, linkHtml, headerChip, removeHeaderChip, openPluginTab } from './command-center-format.js'

const POLL_MS = 60_000
const CHIP = 'waiting'
const TAB_ID = 'cc-waiting'

// view element → { only: 'owner' | 'cars' | null } (right-panel tab + cockpit blocks)
const views = new Map()
let chipOn = false
let timer = null
let inFlight = false
let last = null // last response
let lastError = null
let lastAt = 0 // ms of the last successful fetch
const FRESH_MS = 10_000 // a view / chip mounting within this reuses the last fetch

// ─── data ───────────────────────────────────────────────────────────────────

async function poll() {
  if (inFlight) return
  inFlight = true
  try {
    const r = await fetch('/api/command-center/waiting')
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
  renderViews()
}

function pollIfStale() {
  return Date.now() - lastAt > FRESH_MS ? poll() : undefined
}

function syncTimer() {
  const want = chipOn || views.size > 0
  if (want && !timer) timer = setInterval(poll, POLL_MS)
  if (!want && timer) { clearInterval(timer); timer = null }
}

// ─── header chip ────────────────────────────────────────────────────────────

export function mountWaitingChip() {
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

export function unmountWaitingChip() {
  chipOn = false
  removeHeaderChip(CHIP)
  syncTimer()
}

function renderChip() {
  if (!chipOn) return
  const chip = headerChip(CHIP)
  if (!chip) return
  const c = last?.configured ? last.counts : null
  const down = lastError || !last?.configured || !last.sources?.cars?.ok
  const n = c?.total
  chip.classList.toggle('cc-hchip-hot', !!n)
  chip.classList.toggle('cc-hchip-down', !!down && n == null)
  chip.textContent = `${t('plugin.ccw.chip')} ${n ?? '?'}`
  chip.title = down ? t('plugin.ccw.chipDown') : t('plugin.ccw.chipTitle', c?.owner ?? '?', c?.cars ?? '?')
}

// ─── tab ────────────────────────────────────────────────────────────────────

/**
 * Render into `el` (the plugin tab, or a cockpit block). `only`: 'owner' =
 * owner decisions only (cockpit "今日待批"), 'cars' = the car queue only,
 * default both. `title` overrides the block title.
 */
export async function renderWaitingPane(el, { only = null, title = null } = {}) {
  if (!el) return
  ensureCss()
  views.set(el, { only })
  if (!el.querySelector('.ccw-root')) {
    el.innerHTML = `<div class="ccw-root cc-mod"><div class="cc-mod-head"><span class="cc-top-title">${esc(title || t('plugin.ccw.title'))}</span><span class="cc-mod-meta ccw-meta"></span><button class="rp-btn-sm ccw-refresh" title="${esc(t('plugin.cc.refresh'))}">↻</button></div><div class="ccw-body"></div></div>`
    el.querySelector('.ccw-refresh').addEventListener('click', () => poll())
    // 批准 = put a one-line approval into the secretary chat (the owner still
    // presses send); cockpit.js owns the chat on/off check + the toast.
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('.ccw-approve')
      if (!b) return
      document.dispatchEvent(new CustomEvent('nanocode:cockpit-quote', { detail: { text: b.dataset.text } }))
    })
  }
  syncTimer()
  renderView(el, views.get(el))
  await pollIfStale()
}

/** Drop one view (`el`), or every view when the plugin is turned off. */
export function resetWaitingLoadState(el) {
  if (el) views.delete(el)
  else views.clear()
  syncTimer()
}

function renderViews() {
  for (const [el, opts] of views) renderView(el, opts)
}

function renderView(pane, { only }) {
  const body = pane.querySelector('.ccw-body')
  if (!body) return
  if (lastError && !last) { body.innerHTML = `<div class="rp-hint rp-error">${esc(lastError)}</div>`; return }
  if (!last) { body.innerHTML = `<div class="rp-empty">…</div>`; return }
  if (!last.configured) { body.innerHTML = `<div class="cc-block-down">${esc(t('plugin.cc.notConfigured'))}<div class="cc-sub">${esc(last.error || '')}</div></div>`; return }
  const s = last.sources
  pane.querySelector('.ccw-meta').textContent = lastError ? `${t('plugin.cc.unreachable')}: ${lastError}` : ''
  const wantOwner = only !== 'cars'
  const wantCars = only !== 'owner'
  const parts = []
  // owner decisions first, then the car queue; each block degrades alone
  if (!wantOwner) { /* car queue only */ }
  else if (s.owner.notConnected) parts.push(`<div class="cc-note">${esc(t('plugin.ccw.ownerNotConnected'))}</div>`)
  else if (!s.owner.ok) parts.push(downBlock(t('plugin.ccw.ownerDown'), s.owner))
  else if (s.owner.invalid) parts.push(`<div class="cc-note">${esc(t('plugin.ccw.ownerInvalid', s.owner.invalid))}</div>`)
  if (!wantCars) { /* owner decisions only */ }
  else if (!s.cars.ok) parts.push(downBlock(t('plugin.ccw.carsDown'), s.cars))
  else {
    const notes = []
    if (!s.cars.flagsChecked) notes.push(t('plugin.ccw.flagsUnchecked'))
    if (!s.cars.carsKnown) notes.push(t('plugin.ccw.carsUnknown'))
    if (s.cars.hidden) notes.push(t('plugin.ccw.hidden', s.cars.hidden))
    if (notes.length) parts.push(`<div class="cc-note">${notes.map(esc).join(' · ')}</div>`)
  }
  const items = (last.items || []).filter((i) => (i.waitingOn === 'owner' ? wantOwner : wantCars))
  if (items.length) parts.push(`<ul class="ccw-list">${items.map(itemHtml).join('')}</ul>`)
  else if ((wantCars && s.cars.ok) || (wantOwner && s.owner.ok)) parts.push(`<div class="rp-empty">${esc(t('plugin.ccw.empty'))}</div>`)
  const scanned = wantCars && s.cars.scannedAt ? `${t('plugin.ccw.scanned')} ${fmtTime(s.cars.scannedAt)}` : ''
  const updated = wantOwner && s.owner.updatedAt ? `${t('plugin.ccw.ownerUpdated')} ${fmtAgo(s.owner.updatedAt)}` : ''
  if (scanned || updated) parts.push(`<div class="cc-sub ccw-foot">${esc([scanned, updated].filter(Boolean).join(' · '))}</div>`)
  body.innerHTML = parts.join('')
}

function itemHtml(i) {
  const waitedSec = Math.max(0, Math.round((Date.now() - Date.parse(i.since)) / 1000))
  const waited = Number.isFinite(waitedSec) ? fmtDuration(waitedSec) : '—'
  const on = i.waitingOn === 'owner' ? t('plugin.ccw.onOwner') : t(`plugin.ccw.onSecretary.${i.kind}`)
  const who = i.waiter ? t('plugin.ccw.who', i.waiter) : ''
  const extra = []
  if (i.recommendation) extra.push(`<div class="ccw-rec">${esc(t('plugin.ccw.recommend'))}：${esc(i.recommendation)}</div>`)
  if (i.options?.length) extra.push(`<div class="ccw-opts">${i.options.map((o) => `<span class="cc-chip">${esc(o)}</span>`).join('')}</div>`)
  if (i.deadline) extra.push(`<div class="cc-sub">${esc(t('plugin.ccw.deadline'))} ${esc(fmtTime(i.deadline))}</div>`)
  const link = i.url ? linkHtml(i.url, t('plugin.ccw.open')) : ''
  const approve = i.waitingOn === 'owner'
    ? `<button type="button" class="ccw-approve" data-text="${esc(t('plugin.ccw.approveText', i.title, i.id.replace(/^owner:/, '')))}" title="${esc(t('plugin.ccw.approveTitle'))}">${esc(t('plugin.ccw.approve'))}</button>`
    : ''
  return `
    <li class="ccw-item ccw-${esc(i.kind)}">
      <div class="ccw-top"><span class="ccw-kind">${esc(t(`plugin.ccw.kind.${i.kind}`))}</span><span class="ccw-title">${esc(i.title)}</span><span class="ccw-wait" title="${esc(fmtTime(i.since))}">${esc(t('plugin.ccw.waited', waited))}</span>${approve}</div>
      <div class="ccw-meta">${esc(on)}${who ? ` · ${esc(who)}` : ''}${i.traceId ? ` · <code>${esc(i.traceId)}</code>` : ''}${link ? ` · ${link}` : ''}</div>
      ${i.detail ? `<div class="ccw-detail">${esc(i.detail)}</div>` : ''}
      ${extra.join('')}
    </li>`
}
