/**
 * Cockpit top quota strip — one compact row above the big-events list showing
 * every pool's 5h / 7d usage as a mini bar (B2 design direction: owner wants
 * all pools visible at a glance, not buried in a side card list / tab).
 * Pure "data → HTML"; data + polling stay in command-center-quota-panel.js
 * (subscribeQuotaStrip reuses its single poll/cache, see that file).
 */
import { esc } from './command-center-format.js'
import { quotaSeverity } from './quota-levels.js'

function level(pct) {
  const sev = quotaSeverity(pct)
  return sev == null ? 'none' : sev === 'critical' ? 'hot' : sev === 'warning' ? 'warn' : 'ok'
}

function miniWin(w) {
  if (!w || w.expired || w.pct == null) return `<span class="ck-qs-win"><span class="ck-qs-wlabel">${esc(w?.key || '')}</span><span class="ck-qs-dash">—</span></span>`
  const lv = level(w.pct)
  return `<span class="ck-qs-win"><span class="ck-qs-wlabel">${esc(w.key)}</span><span class="ck-qs-bar"><span class="ck-qs-fill ck-qs-${lv}" style="width:${Math.min(100, w.pct)}%"></span></span><span class="ck-qs-pct ck-qs-t-${lv}">${w.pct}%</span></span>`
}

/** `last`/`lastError` straight from command-center-quota-panel.js's cache; '' when there is nothing worth a strip (not configured / source down / empty). */
export function quotaStripHtml(last) {
  if (!last || !last.configured || !last.source?.ok || !last.pools?.length) return ''
  return `<div class="ck-quota-strip">${last.pools.map((p) => {
    const w5 = p.windows.find((w) => w.key === '5h')
    const w7 = p.windows.find((w) => w.key === '7d')
    return `<span class="ck-qs-pool" title="${esc(p.pool)}"><span class="ck-qs-name">${esc(p.pool)}</span>${miniWin(w5)}${miniWin(w7)}</span>`
  }).join('')}</div>`
}
