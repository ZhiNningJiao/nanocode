/**
 * Services (Port Health) plugin — MES-13740 需求13.
 *
 * Tab plugin (ops domain): a live grid of monitored service ports with
 * add / edit / delete. Migrated out of the Settings page. The server side
 * (`/api/services-config`, `/api/services`, 30s polling → WebSocket
 * `service_status`) is unchanged.
 *
 * Live updates: app.js dispatches `nanocode:service-status` custom events from
 * its WS handler; this pane listens and refreshes the dot for that service
 * without refetching. Legacy Settings grid (during the transition commit)
 * still reads `svc-dot-<name>` ids — this pane uses `pm-svc-dot-<name>` ids so
 * the two coexist.
 *
 * Mobile (≤480px): every control is a ≥44px touch target; the add form stacks
 * vertically.
 */
import { t } from './i18n.js'

let activePane = null
let services = []
let managed = []
let status = {}
let loaded = false
let loading = false
let statusListener = null

export async function renderServicesPane(pane) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  _wireStatusListener()
  await loadServices()
}

export function resetServicesLoadState() {
  activePane = null
  services = []
  managed = []
  status = {}
  loaded = false
  loading = false
  if (statusListener) {
    document.removeEventListener('nanocode:service-status', statusListener)
    statusListener = null
  }
}

// ── data ─────────────────────────────────────────────────────────────────────

async function loadServices() {
  loading = true
  renderGrid({ loading: true })
  try {
    const [cfgRes, statusRes] = await Promise.all([
      fetch('/api/services-config').then((r) => r.json()),
      fetch('/api/services').then((r) => r.json()),
    ])
    services = cfgRes.services || []
    managed = cfgRes.managed || []
    status = statusRes || {}
    loaded = true
    loading = false
    renderGrid()
    renderManaged()
    renderMeta(cfgRes)
  } catch (err) {
    loading = false
    renderGrid({ error: String(err.message || err) })
  }
}

async function saveServicesConfig() {
  try {
    await fetch('/api/services-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ services }),
    })
    await loadServices()
  } catch {}
}

function _wireStatusListener() {
  if (statusListener) return
  statusListener = (e) => {
    const { name, status: st, checkedAt } = e.detail || {}
    status[name] = { status: st, checkedAt }
    const dot = activePane?.querySelector(`#pm-svc-dot-${cssEscape(name)}`)
    if (dot) {
      dot.className = `service-dot ${st}`
      dot.title = `${name}: ${st}${checkedAt ? ' (checked ' + checkedAt.slice(11, 16) + ' UTC)' : ''}`
    }
  }
  document.addEventListener('nanocode:service-status', statusListener)
}

// ── render ───────────────────────────────────────────────────────────────────

function renderShell(pane) {
  pane.innerHTML = ''
  const section = document.createElement('div')
  section.className = 'rp-section'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('plugin.services.label')
  section.appendChild(title)
  const desc = document.createElement('div')
  desc.className = 'rp-section-desc'
  desc.textContent = t('settings.services.hint')
  section.appendChild(desc)

  const meta = document.createElement('p')
  meta.className = 'services-local-ip'
  meta.id = 'pm-services-local-ip'
  section.appendChild(meta)

  const grid = document.createElement('div')
  grid.className = 'services-grid'
  grid.id = 'pm-services-grid'
  section.appendChild(grid)

  // MES-14049: managed (read-only) services — e.g. the akari dispatch server,
  // whose up/down is probed via /api/health by the server. Injected fresh on
  // every read; never editable/deletable here.
  const mTitle = document.createElement('div')
  mTitle.className = 'services-managed-title'
  mTitle.textContent = 'Managed'
  const mGrid = document.createElement('div')
  mGrid.className = 'services-grid'
  mGrid.id = 'pm-services-managed'
  section.appendChild(mTitle)
  section.appendChild(mGrid)

  const form = document.createElement('form')
  form.className = 'services-add-form'
  form.id = 'pm-services-add-form'
  form.autocomplete = 'off'
  const nameI = _addInput('text', 'Name')
  const hostI = _addInput('text', 'IP / host')
  const portI = _addInput('number', 'Port')
  portI.min = '1'; portI.max = '65535'
  const addBtn = document.createElement('button')
  addBtn.type = 'submit'
  addBtn.className = 'btn btn-secondary'
  addBtn.textContent = t('settings.services.add')
  form.appendChild(nameI)
  form.appendChild(hostI)
  form.appendChild(portI)
  form.appendChild(addBtn)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = nameI.value.trim()
    const host = hostI.value.trim()
    const port = parseInt(portI.value, 10)
    if (!name || !host || !port) return
    services = [...services, { name, host, port }]
    nameI.value = ''; hostI.value = ''; portI.value = ''
    await saveServicesConfig()
  })
  section.appendChild(form)

  const checked = document.createElement('p')
  checked.className = 'services-checked-at'
  checked.id = 'pm-services-checked-at'
  section.appendChild(checked)

  pane.appendChild(section)
}

function renderMeta(cfgRes) {
  const ipEl = activePane?.querySelector('#pm-services-local-ip')
  if (ipEl && cfgRes.localIPs?.length) ipEl.textContent = `Local: ${cfgRes.localIPs.join(', ')}`
  let lastChecked = null
  for (const info of Object.values(status)) {
    if (info.checkedAt && (!lastChecked || info.checkedAt > lastChecked)) lastChecked = info.checkedAt
  }
  const el = activePane?.querySelector('#pm-services-checked-at')
  if (el && lastChecked) el.textContent = `Last checked: ${lastChecked.slice(0, 16).replace('T', ' ')} UTC`
}

function renderGrid({ loading: isLoading, error } = {}) {
  const grid = activePane?.querySelector('#pm-services-grid')
  if (!grid) return
  grid.innerHTML = ''
  if (isLoading) {
    const el = document.createElement('div')
    el.className = 'rp-hint'
    el.textContent = '…'
    grid.appendChild(el)
    return
  }
  if (error) {
    const el = document.createElement('div')
    el.className = 'rp-hint'
    el.style.color = '#ff6b6b'
    el.textContent = error
    grid.appendChild(el)
    return
  }
  for (const svc of services) {
    const info = status[svc.name] || { status: 'unknown' }
    const row = document.createElement('div')
    row.className = 'service-item'
    row.dataset.svc = svc.name
    const dot = document.createElement('span')
    dot.className = `service-dot ${info.status}`
    dot.id = `pm-svc-dot-${cssEscape(svc.name)}`
    dot.title = `${svc.name}: ${info.status}`
    const nm = document.createElement('span')
    nm.className = 'service-name'
    nm.innerHTML = `${escapeHtml(svc.name)} <span class="service-port">${escapeHtml(svc.host)}:${escapeHtml(svc.port)}</span>`
    const actions = document.createElement('span')
    actions.className = 'service-actions'
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'svc-btn svc-edit-btn'
    edit.innerHTML = '&#9998;'
    edit.title = 'Edit'
    edit.addEventListener('click', () => _editRow(row, svc, info.status))
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'svc-btn svc-del-btn'
    del.innerHTML = '&#10005;'
    del.title = 'Delete'
    del.addEventListener('click', async () => {
      services = services.filter((s) => s.name !== svc.name)
      await saveServicesConfig()
    })
    actions.appendChild(edit)
    actions.appendChild(del)
    row.appendChild(dot)
    row.appendChild(nm)
    row.appendChild(actions)
    grid.appendChild(row)
  }
}

// MES-14049: managed services (read-only) — rendered without edit/delete. The
// dot id reuses the `pm-svc-dot-<name>` scheme so the live `service_status` WS
// listener updates the akari dot in place, same as user services.
function renderManaged() {
  const grid = activePane?.querySelector('#pm-services-managed')
  if (!grid) return
  grid.innerHTML = ''
  for (const svc of managed) {
    const info = status[svc.name] || { status: 'unknown' }
    const row = document.createElement('div')
    row.className = 'service-item managed'
    row.dataset.svc = svc.name
    const dot = document.createElement('span')
    dot.className = `service-dot ${info.status}`
    dot.id = `pm-svc-dot-${cssEscape(svc.name)}`
    dot.title = `${svc.name}: ${info.status}`
    const nm = document.createElement('span')
    nm.className = 'service-name'
    nm.innerHTML = `${escapeHtml(svc.name)} <span class="service-port">${escapeHtml(svc.host)}:${escapeHtml(svc.port)}</span>`
    const actions = document.createElement('span')
    actions.className = 'service-actions'
    row.appendChild(dot)
    row.appendChild(nm)
    row.appendChild(actions)
    grid.appendChild(row)
  }
}

function _editRow(row, svc, dotStatus) {
  row.innerHTML = ''
  const dot = document.createElement('span')
  dot.className = `service-dot ${dotStatus}`
  dot.id = `pm-svc-dot-${cssEscape(svc.name)}`
  const nameI = document.createElement('input')
  nameI.type = 'text'; nameI.className = 'settings-input svc-edit-name'; nameI.value = svc.name; nameI.style.width = '90px'
  const hostI = document.createElement('input')
  hostI.type = 'text'; hostI.className = 'settings-input svc-edit-host'; hostI.value = svc.host; hostI.style.width = '120px'
  const portI = document.createElement('input')
  portI.type = 'number'; portI.className = 'settings-input svc-edit-port'; portI.value = svc.port; portI.min = '1'; portI.max = '65535'; portI.style.width = '60px'
  const save = document.createElement('button')
  save.type = 'button'; save.className = 'btn btn-primary svc-save-btn'; save.style.cssText = 'padding:2px 8px;font-size:12px'
  save.textContent = t('btn.save')
  save.addEventListener('click', async () => {
    const newName = nameI.value.trim()
    const newHost = hostI.value.trim()
    const newPort = parseInt(portI.value, 10)
    if (!newName || !newHost || !newPort) return
    const idx = services.findIndex((s) => s.name === svc.name)
    if (idx >= 0) services[idx] = { name: newName, host: newHost, port: newPort }
    await saveServicesConfig()
  })
  const cancel = document.createElement('button')
  cancel.type = 'button'; cancel.className = 'svc-btn svc-cancel-btn'
  cancel.innerHTML = '&#10005;'
  cancel.addEventListener('click', () => renderGrid())
  row.appendChild(dot)
  row.appendChild(nameI)
  row.appendChild(hostI)
  row.appendChild(portI)
  row.appendChild(save)
  row.appendChild(cancel)
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _addInput(type, ph) {
  const i = document.createElement('input')
  i.type = type
  i.className = 'settings-input'
  i.placeholder = ph
  return i
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
}
