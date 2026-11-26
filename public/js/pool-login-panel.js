/**
 * One-click pool login (nanologin_2250) — the sign-in control the quota tab
 * mounts under each pool card (command-center-quota-panel.js). Owns the
 * entire login widget (button / status / auth link / code box) as its own
 * module so the quota panel's pure poolHtml() render — and its existing
 * tests — never has to know this exists.
 *
 * GET  /api/pool-login/pools         — per-pool login/token/last-call status
 * POST /api/pool-login/:id/start     — spawn `claude auth login --sso` for one pool
 * POST /api/pool-login/:id/code      — submit the pasted-back auth code
 * POST /api/pool-login/:id/cancel    — give up / clean up an in-flight login
 *
 * The owner's email and any token/credential value never reach this module —
 * the API only ever returns booleans, an auth URL (not a secret) and a short
 * verify reply.
 */
import { t } from './i18n.js'
import { esc, fmtTime } from './command-center-format.js'

const IN_FLIGHT_STATES = new Set(['starting', 'awaiting_code', 'submitting', 'verifying'])
const FAST_POLL_MS = 2000
const IDLE_POLL_MS = 20_000

const mountedBodies = new Set()
let poolsByLabel = new Map()
let timer = null
let inflight = false

export function mountSignInControls(body) {
  mountedBodies.add(body)
  syncTimer()
  refresh()
}

export function unmountSignInControls(body) {
  mountedBodies.delete(body)
  syncTimer()
}

function anyInFlight() {
  for (const p of poolsByLabel.values()) if (IN_FLIGHT_STATES.has(p.login?.state)) return true
  return false
}

function syncTimer() {
  if (timer) { clearInterval(timer); timer = null }
  if (!mountedBodies.size) return
  timer = setInterval(refresh, anyInFlight() ? FAST_POLL_MS : IDLE_POLL_MS)
}

async function refresh() {
  if (inflight) return
  inflight = true
  try {
    const r = await fetch('/api/pool-login/pools')
    if (r.ok) {
      const d = await r.json()
      poolsByLabel = new Map((d.pools || []).map((p) => [p.label, p]))
    }
  } catch { /* keep the last known state; next tick tries again */ }
  inflight = false
  syncTimer()
  renderAll()
}

function renderAll() {
  for (const body of mountedBodies) renderInto(body)
}

function renderInto(body) {
  for (const card of body.querySelectorAll('.ccq-card')) {
    const label = card.querySelector('.ccq-pool')?.textContent?.trim()
    if (!label) continue
    let slot = card.querySelector('.ccq-signin-slot')
    if (!slot) {
      slot = document.createElement('div')
      slot.className = 'ccq-signin-slot'
      slot.dataset.label = label
      slot.addEventListener('click', onSlotClick)
      slot.addEventListener('keydown', onSlotKeydown)
      card.appendChild(slot)
    }
    slot.innerHTML = slotHtml(poolsByLabel.get(label))
  }
}

function lastCallText(lc) {
  if (!lc) return '—'
  if (lc.ok === true) return `✓ ${fmtTime(lc.at)}`
  if (lc.ok === false) return `✗ ${esc(lc.error || '')}`
  return '—'
}

/** Exported for the pure-render test — no DOM needed. */
export function slotHtml(info) {
  if (!info) return ''
  const login = info.login || { state: 'idle' }
  const identRow = `<div class="ccq-sub">${esc(t('plugin.ccq.signin.ident'))} ${info.interactiveCred ? '✓' : '—'} · ${esc(t('plugin.ccq.signin.ltoken'))} ${info.longToken ? '✓' : '—'} · ${esc(t('plugin.ccq.signin.lastcall'))} ${lastCallText(info.lastRealCall)}</div>`
  let action
  if (login.state === 'awaiting_code') {
    action = `
      ${login.url ? `<a href="${esc(login.url)}" target="_blank" rel="noopener noreferrer" class="rp-btn-sm">${esc(t('plugin.ccq.signin.openLink'))}</a>` : `<span class="ccq-sub">${esc(t('plugin.ccq.signin.waitingLink'))}</span>`}
      <input type="text" class="rp-input ccq-signin-code" placeholder="${esc(t('plugin.ccq.signin.codePh'))}" autocomplete="off" />
      <button type="button" class="rp-btn-sm" data-act="submit-code">${esc(t('plugin.ccq.signin.submit'))}</button>
      <button type="button" class="rp-btn-sm" data-act="cancel">${esc(t('plugin.ccq.signin.cancel'))}</button>`
  } else if (login.state === 'starting') {
    action = `<span class="ccq-sub">${esc(t('plugin.ccq.signin.starting'))}</span>`
  } else if (login.state === 'submitting' || login.state === 'verifying') {
    action = `<span class="ccq-sub">${esc(t('plugin.ccq.signin.verifying'))}</span>`
  } else {
    action = `<button type="button" class="rp-btn-sm" data-act="signin">${esc(t('plugin.ccq.signin.btn'))}</button>`
    if (login.state === 'error') action += ` <span class="ccq-sub cc-err">${esc(login.error || '')}</span>`
    if (login.state === 'done' && login.verify) {
      action += login.verify.ok
        ? ` <span class="ccq-sub">✓ ${esc(login.verify.reply || '')}</span>`
        : ` <span class="ccq-sub cc-err">✗ ${esc(login.verify.error || '')}</span>`
    }
  }
  return `${identRow}<div class="ccq-signin-row">${action}</div>`
}

async function onSlotClick(e) {
  const slot = e.currentTarget
  const act = e.target.closest('[data-act]')?.dataset.act
  if (!act) return
  const info = poolsByLabel.get(slot.dataset.label)
  if (!info) return
  if (act === 'signin') {
    if (info.isDutyPool && !window.confirm(t('plugin.ccq.signin.dutyConfirm'))) return
    await postAction(info.id, 'start')
  } else if (act === 'submit-code') {
    const code = slot.querySelector('.ccq-signin-code')?.value?.trim()
    if (!code) return
    await postAction(info.id, 'code', { code })
  } else if (act === 'cancel') {
    await postAction(info.id, 'cancel')
  }
}

function onSlotKeydown(e) {
  if (e.key === 'Enter' && e.target.classList.contains('ccq-signin-code')) {
    e.preventDefault()
    e.currentTarget.querySelector('[data-act="submit-code"]')?.click()
  }
}

async function postAction(id, kind, body) {
  const path = kind === 'start' ? 'start' : kind === 'cancel' ? 'cancel' : 'code'
  try {
    await fetch(`/api/pool-login/${encodeURIComponent(id)}/${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch { /* the next refresh reflects whatever actually happened server-side */ }
  await refresh()
}
