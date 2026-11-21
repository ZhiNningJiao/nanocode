/**
 * Shared rendering helpers for the Command Center panels (phase 1 events,
 * phase 2 waiting / quota / chat drawer) — one copy of escaping, time
 * formatting, the "source unreachable + last success" block, the lazy CSS
 * link and the app-header chip slot.
 */
import { t } from './i18n.js'
import { safeHttpUrl } from './command-center-url.js'
import { showRightPanelTab } from './right-panel.js'

const CSS_HREF = '/command-center.css'

export function ensureCss() {
  if (document.querySelector('link[data-cc-css]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = CSS_HREF
  link.dataset.ccCss = '1'
  document.head.appendChild(link)
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function pad2(n) { return String(n).padStart(2, '0') }

export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  const today = new Date()
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}-${pad2(d.getDate())} ${hm}`
}

export function fmtAgo(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  return fmtDuration(Math.max(0, Math.round((Date.now() - ms) / 1000)), 'ago')
}

/** Seconds → "N 分钟前" (mode 'ago') or "N 分钟" (mode 'for'). */
export function fmtDuration(sec, mode = 'for') {
  const p = mode === 'ago' ? 'plugin.cc.ago' : 'plugin.cc.for'
  if (sec < 60) return t(`${p}Sec`, sec)
  if (sec < 3600) return t(`${p}Min`, Math.round(sec / 60))
  if (sec < 86400) return t(`${p}Hour`, Math.round(sec / 3600))
  return t(`${p}Day`, Math.round(sec / 86400))
}

/** A dead source's block: title + last success + error (PRD P0-8). */
export function downBlock(title, s) {
  const last = s?.lastOkAt ? `${fmtTime(s.lastOkAt)}（${fmtAgo(s.lastOkAt)}）` : t('plugin.cc.never')
  return `<div class="cc-block-down"><span class="service-dot down"></span> ${esc(title)}<div class="cc-sub">${esc(t('plugin.cc.lastSuccess'))}: ${esc(last)}</div>${s?.error ? `<div class="cc-sub cc-err">${esc(s.error)}</div>` : ''}</div>`
}

/** <a> only for http(s); anything else is plain text (review P1). */
export function linkHtml(url, label, cls = '') {
  const safe = safeHttpUrl(url)
  if (!safe) return `<span class="cc-unsafe-link${cls ? ` ${cls}` : ''}" title="${esc(t('plugin.cc.unsafeLink'))}">${esc(label)}</span>`
  return `<a${cls ? ` class="${cls}"` : ''} href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`
}

/** The app-header slot the phase-2 chips live in (created on first use). */
export function headerChip(name) {
  const pills = document.querySelector('.app-header .header-pills')
  if (!pills) return null
  let slot = pills.querySelector('.cc-header-chips')
  if (!slot) {
    slot = document.createElement('span')
    slot.className = 'cc-header-chips'
    pills.insertBefore(slot, pills.firstChild)
  }
  let chip = slot.querySelector(`[data-cc-chip="${name}"]`)
  if (!chip) {
    chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'cc-hchip'
    chip.dataset.ccChip = name
    slot.appendChild(chip)
  }
  return chip
}

export function removeHeaderChip(name) {
  const chip = document.querySelector(`.cc-header-chips [data-cc-chip="${name}"]`)
  const slot = chip?.parentNode
  chip?.remove()
  if (slot && !slot.children.length) slot.remove()
}

/**
 * Jump to a plugin's view. On the cockpit (body.cockpit-active) the cockpit
 * scrolls to its block (cockpit.js listens); in the workspace → the plugin
 * tab, and on a phone also flip the pane switch to the panel.
 */
export function openPluginTab(tabId) {
  if (document.body.classList.contains('cockpit-active')) {
    document.dispatchEvent(new CustomEvent('nanocode:cockpit-focus', { detail: { plugin: tabId } }))
    return
  }
  showRightPanelTab(tabId)
  if (document.body.classList.contains('mobile-pane-left')) {
    document.querySelector('.mobile-pane-btn[data-pane="right"]')?.click()
  }
}
