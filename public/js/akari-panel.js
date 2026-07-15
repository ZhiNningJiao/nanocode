/**
 * akari 检察 plugin — MES-14049.
 *
 * Dedicated monitor tab for the self-hosted akari dispatch server. Polls the
 * nanocode same-origin proxy (`/api/akari/state`) every 10s (≥10s, gentle) and
 * renders:
 *   - health summary  — version / build_commit / dispatch_caps / agent_concurrency
 *     / provider_fallback_enabled / instance tokens (aligned to akari-server
 *     small_handlers.rs::health, NOT guessed)
 *   - concurrency    — running / peak / open_lanes (/api/concurrency)
 *   - workers table  — live worker status (/api/workers)
 *   - lane fleet     — lane pool state (/api/lanes): id / state / marker /
 *     head_short / at_main / occupant / reserved
 * A one-click button opens the akari lens dashboard (personal.akari.lensUrl).
 *
 * Graceful degradation (主人要求: akari 停时降级显示不报错刷屏): when akari is
 * unreachable the panel renders a calm "unreachable" state with the server URL
 * and a dimmed dot — NO console spam, NO red error banner. The 10s poll keeps
 * running silently and auto-recovers the moment akari comes back. fetch errors
 * are swallowed into the structured `reachable:false` bundle from the proxy.
 */
import { t } from './i18n.js'

const POLL_MS = 10_000 // ≥10s — gentle on the dispatch server

let activePane = null
let pollTimer = null
let pollInFlight = false
let lensUrl = ''
let serverUrl = ''
let lastState = null

export async function renderAkariPane(pane) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  // Config (lens URL for the jump button + server URL for display) is fetched
  // once via the permission-gated plugin-injection path (/api/plugin/config).
  try {
    const r = await fetch('/api/plugin/config?plugin=akari')
    const d = await r.json()
    const a = d?.config?.akari
    if (a) { serverUrl = a.serverUrl || ''; lensUrl = a.lensUrl || '' }
  } catch { /* config is optional; panel still works with proxy defaults */ }
  renderHeader()
  await pollOnce()
  startPolling()
}

export function resetAkariLoadState() {
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
    const r = await fetch('/api/akari/state')
    lastState = await r.json()
    if (activePane) renderState(lastState)
  } catch {
    // Network error talking to the nanocode server itself (not akari): render a
    // calm degraded state rather than spamming. The proxy already swallows akari
    // errors into reachable:false, so this is only for nanocode-server hiccups.
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
  section.id = 'akari-pane'

  const head = document.createElement('div')
  head.className = 'akari-head'
  head.id = 'akari-head'
  section.appendChild(head)

  const state = document.createElement('div')
  state.id = 'akari-state'
  section.appendChild(state)

  pane.appendChild(section)
}

function renderHeader() {
  const head = activePane?.querySelector('#akari-head')
  if (!head) return
  head.innerHTML = ''
  const title = document.createElement('div')
  title.className = 'akari-title'
  const dot = document.createElement('span')
  dot.className = 'service-dot unknown'
  dot.id = 'akari-dot'
  const label = document.createElement('span')
  label.textContent = t('plugin.akari.label')
  title.appendChild(dot)
  title.appendChild(label)
  head.appendChild(title)

  const lens = document.createElement('a')
  lens.className = 'btn btn-secondary akari-lens-btn'
  lens.target = '_blank'
  lens.rel = 'noopener'
  lens.href = lensUrl || '#'
  lens.textContent = 'Lens ↗'
  lens.title = lensUrl || ''
  if (!lensUrl) lens.style.display = 'none'
  head.appendChild(lens)

  const refresh = document.createElement('button')
  refresh.className = 'svc-btn'
  refresh.type = 'button'
  refresh.innerHTML = '&#8635;'
  refresh.title = 'Refresh'
  refresh.addEventListener('click', () => pollOnce())
  head.appendChild(refresh)

  const meta = document.createElement('div')
  meta.className = 'akari-meta'
  meta.id = 'akari-meta'
  if (serverUrl) meta.textContent = serverUrl
  head.appendChild(meta)
}

function renderState(state) {
  const el = activePane?.querySelector('#akari-state')
  if (!el || !state) return
  el.innerHTML = ''

  const dot = activePane?.querySelector('#akari-dot')
  const reachable = !!state.reachable
  if (dot) dot.className = `service-dot ${reachable ? 'up' : 'down'}`

  const meta = activePane?.querySelector('#akari-meta')
  if (meta) {
    const when = state.fetchedAt ? state.fetchedAt.slice(11, 16) : ''
    meta.textContent = reachable
      ? `${state.serverUrl || serverUrl} · ${when}`
      : `${state.serverUrl || serverUrl} · unreachable${when ? ' · ' + when : ''}`
  }

  if (!reachable) {
    const note = document.createElement('div')
    note.className = 'rp-hint'
    note.textContent = t('plugin.akari.unreachable')
    el.appendChild(note)
    // Surface the per-section errors quietly (one line each) for diagnosis,
    // without a loud red banner.
    const errs = state.errors || {}
    const parts = ['health', 'concurrency', 'workers', 'lanes']
      .map((k) => errs[k] ? `${k}: ${errs[k]}` : null)
      .filter(Boolean)
    if (parts.length) {
      const det = document.createElement('div')
      det.className = 'akari-errors'
      det.textContent = parts.join(' · ')
      el.appendChild(det)
    }
    return
  }

  el.appendChild(renderHealth(state.health))
  el.appendChild(renderConcurrency(state.concurrency))
  el.appendChild(renderWorkers(state.workers))
  el.appendChild(renderLanes(state.lanes))
}

function renderHealth(h) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section akari-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  title.textContent = 'Health'
  wrap.appendChild(title)

  const caps = h?.dispatch_caps || {}
  const ac = h?.agent_concurrency || {}
  const grid = document.createElement('div')
  grid.className = 'rp-stats-grid'
  grid.appendChild(stat('version', h?.version || '–'))
  grid.appendChild(stat('build', (h?.build_commit || '–').slice(0, 12)))
  grid.appendChild(stat('workers cap', caps.max_concurrent_workers ?? '–'))
  grid.appendChild(stat('vision cap', caps.max_vision_workers ?? '–'))
  grid.appendChild(stat('lane cap', caps.lane_cap ?? '–'))
  grid.appendChild(stat('in-flight', ac.in_flight ?? '–'))
  grid.appendChild(stat('permits', ac.permits_available ?? '–'))
  grid.appendChild(stat('fallback', h?.provider_fallback_enabled ? 'on' : 'off'))
  grid.appendChild(stat('tok in', fmtNum(h?.instance_tokens_in)))
  grid.appendChild(stat('tok out', fmtNum(h?.instance_tokens_out)))
  wrap.appendChild(grid)

  if (caps.default_worker_model) {
    const m = document.createElement('div')
    m.className = 'akari-model'
    m.textContent = `model: ${caps.default_worker_model}`
    wrap.appendChild(m)
  }
  return wrap
}

function renderConcurrency(c) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section akari-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  title.textContent = 'Concurrency'
  wrap.appendChild(title)
  const grid = document.createElement('div')
  grid.className = 'rp-stats-grid'
  grid.appendChild(stat('running', c?.running ?? '–'))
  grid.appendChild(stat('peak', c?.peak ?? '–'))
  grid.appendChild(stat('open lanes', c?.open_lanes ?? '–'))
  wrap.appendChild(grid)
  return wrap
}

function renderWorkers(w) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section akari-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  const list = (w?.workers || [])
  title.textContent = `Workers (${list.length})`
  wrap.appendChild(title)
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-hint'
    empty.textContent = 'no active workers'
    wrap.appendChild(empty)
    return wrap
  }
  const tbl = document.createElement('table')
  tbl.className = 'akari-table'
  tbl.appendChild(tableHead(['id', 'state', 'model', 'turn', 'tool', 'elapsed', 'tokens↑↓', 'activity']))
  const body = document.createElement('tbody')
  for (const wk of list) {
    const tr = document.createElement('tr')
    if (wk.needs_attention) tr.className = 'akari-attention'
    tr.appendChild(td(wk.worker_id, 'akari-mono'))
    tr.appendChild(tdState(wk.state, wk.needs_attention))
    tr.appendChild(td(wk.model_id || '–', 'akari-mono'))
    tr.appendChild(td(String(wk.turn ?? 0)))
    tr.appendChild(td(String(wk.tool_calls ?? 0)))
    tr.appendChild(td(fmtSecs(wk.elapsed_secs)))
    tr.appendChild(td(`${fmtNum(wk.tokens_in)}/${fmtNum(wk.tokens_out)}`, 'akari-mono'))
    tr.appendChild(td(wk.current_activity || wk.last_tool || (wk.stage ? `stage:${wk.stage}` : '–')))
    body.appendChild(tr)
  }
  tbl.appendChild(body)
  wrap.appendChild(tbl)
  return wrap
}

function renderLanes(l) {
  const wrap = document.createElement('div')
  wrap.className = 'rp-section akari-block'
  const title = document.createElement('div')
  title.className = 'rp-subtitle'
  const lanes = l?.lanes || []
  title.textContent = `Lanes / Fleet (${lanes.length})`
  wrap.appendChild(title)
  if (!lanes.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-hint'
    empty.textContent = 'no lanes open'
    wrap.appendChild(empty)
    return wrap
  }
  const tbl = document.createElement('table')
  tbl.className = 'akari-table'
  tbl.appendChild(tableHead(['id', 'state', 'marker', 'head', '@main', 'occupant', 'reserved']))
  const body = document.createElement('tbody')
  for (const ln of lanes) {
    const tr = document.createElement('tr')
    tr.appendChild(td(ln.id || '–', 'akari-mono'))
    tr.appendChild(tdState(ln.state))
    tr.appendChild(td(ln.marker || '–'))
    tr.appendChild(td(ln.head_short || '–', 'akari-mono'))
    tr.appendChild(td(ln.at_main ? '✓' : ''))
    tr.appendChild(td(ln.occupant || '–'))
    tr.appendChild(td(ln.reserved ? '🔒' : ''))
    body.appendChild(tr)
  }
  tbl.appendChild(body)
  wrap.appendChild(tbl)
  return wrap
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

function td(text, cls) {
  const c = document.createElement('td')
  if (cls) c.className = cls
  c.textContent = String(text ?? '–')
  return c
}

function tdState(state, attention) {
  const c = document.createElement('td')
  c.className = 'akari-state'
  const dot = document.createElement('span')
  dot.className = `akari-state-dot ${stateClass(state)}`
  c.appendChild(dot)
  const span = document.createElement('span')
  span.textContent = String(state || '–')
  if (attention) {
    span.className = 'akari-attention-text'
    span.title = `needs attention: ${attention}`
  }
  c.appendChild(span)
  return c
}

// State values aligned to the akari-server serde wire format (NOT guessed):
//   WorkerState  — #[serde(rename_all = "snake_case")] → running/done/failed/
//                  cancelled/queued/waiting (worker_status.rs::WorkerState)
//   LaneState    — #[serde(rename_all = "PascalCase")] → Free/InUse/Finishing/
//                  Error, with legacy deserialization aliases Idle/Busy/
//                  AwaitingMerge/Quarantined (lane.rs::LaneState). Both the
//                  current PascalCase names and the legacy aliases are mapped so
//                  the colored dot lights up whichever build is deployed.
function stateClass(s) {
  switch (s) {
    case 'running': case 'Busy': case 'InUse': return 'busy'
    case 'done': case 'Idle': case 'Free': return 'idle'
    case 'failed': case 'timed_out': case 'cancelled': case 'Quarantined': case 'Error': return 'bad'
    case 'queued': case 'waiting': case 'AwaitingMerge': case 'Finishing': return 'wait'
    default: return ''
  }
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '0'
  const v = Number(n)
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(v)
}

function fmtSecs(s) {
  if (s == null || !Number.isFinite(Number(s))) return '–'
  const v = Number(s)
  if (v >= 60) return `${Math.floor(v / 60)}m${Math.round(v % 60)}s`
  return `${v.toFixed(0)}s`
}
