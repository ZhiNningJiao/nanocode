/**
 * Remote machines plugin render core — MES-13740 需求10 + MES-13781 SSH dev machine.
 *
 * Two machine types share one address book:
 *   - `rustdesk` (original): Connect navigates to `rustdesk://connect/<peerId>`
 *     so the user's *local* native RustDesk client opens.
 *   - `ssh` (MES-13781): Connect opens a *web terminal Tab* — an xterm.js
 *     overlay backed by `/ws/remote-ssh`, whose server-side PTY runs
 *     `ssh -i <key> user@host` (or `sshpass -e ssh …` for password auth).
 *     The nanocode server runs on the dev box and can reach the target, so
 *     the server-side SSH → frontend xterm path reuses the existing
 *     terminal infrastructure (terminal/sessions.js + public/js/terminal-pane.js).
 *
 * Mobile (≤480px): every control is a ≥44px touch target; the form stacks
 * vertically. This is a render core ("芯"); right-panel.js mounts it via the
 * registry (ops domain).
 */

import { t } from './i18n.js'
import { TerminalPane } from './terminal-pane.js'

let activePane = null
let machines = []
let loaded = false
let loading = false
let editingId = null // '' = add mode, '<uuid>' = edit mode
let formType = 'rustdesk' // current form type selector: 'rustdesk' | 'ssh'
let formAuthType = 'key' // ssh auth selector: 'key' | 'password'
let activeOverlay = null // the open SSH terminal overlay { modal, pane, close }

export async function renderRemotePane(pane) {
  if (!pane) return
  activePane = pane
  renderShell(pane)
  await loadMachines()
}

export function resetRemoteLoadState() {
  activePane = null
  machines = []
  loaded = false
  loading = false
  editingId = null
  formType = 'rustdesk'
  formAuthType = 'key'
  closeOverlay()
}

// ── data ─────────────────────────────────────────────────────────────────────

async function loadMachines() {
  loading = true
  renderList({ loading: true })
  try {
    const data = await fetch('/api/remote/machines').then((r) => r.json())
    loading = false
    machines = Array.isArray(data.machines) ? data.machines : []
    loaded = true
    renderList()
  } catch (err) {
    loading = false
    renderList({ error: String(err.message || err) })
  }
}

async function submitForm(formData) {
  const type = formData.type || 'rustdesk'
  const body = { type, alias: formData.alias || '', note: formData.note || '' }
  if (type === 'ssh') {
    body.host = formData.host || ''
    body.user = formData.user || ''
    body.port = formData.port || 22
    body.key = formData.key || ''
    body.sshPassword = formData.sshPassword || ''
  } else {
    body.peerId = formData.peerId || ''
    body.password = formData.password || ''
    body.relay = !!formData.relay
  }
  const url = editingId ? `/api/remote/machines/${encodeURIComponent(editingId)}` : '/api/remote/machines'
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json())
    if (resp.error) {
      renderFormError(resp.error)
      return
    }
    editingId = null
    renderForm()
    await loadMachines()
  } catch (err) {
    renderFormError(String(err.message || err))
  }
}

async function removeMachine(recId) {
  if (!recId) return
  try {
    const resp = await fetch(`/api/remote/machines/${encodeURIComponent(recId)}`, { method: 'DELETE' }).then((r) => r.json())
    if (resp.error) {
      renderList({ error: resp.error })
      return
    }
    if (editingId === recId) {
      editingId = null
      renderForm()
    }
    await loadMachines()
  } catch (err) {
    renderList({ error: String(err.message || err) })
  }
}

// Pre-flight check for an ssh machine: POST /connect returns a clear error
// (key missing / sshpass missing) before we open a dead terminal.
async function preflightSsh(machine) {
  try {
    const resp = await fetch(`/api/remote/machines/${encodeURIComponent(machine.id)}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).then((r) => r.json())
    if (resp.error) return { ok: false, error: resp.error }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

function connectUri(m) {
  let uri = `rustdesk://connect/${encodeURIComponent(m.peerId || '')}`
  const params = []
  if (m.password) params.push(`password=${encodeURIComponent(m.password)}`)
  if (m.relay) params.push('relay=true')
  if (params.length) uri += `?${params.join('&')}`
  return uri
}

// ── SSH terminal overlay ─────────────────────────────────────────────────────

function openSshOverlay(machine) {
  closeOverlay()
  const modal = document.createElement('div')
  modal.className = 'rm-ssh-overlay'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-label', `SSH ${machine.alias}`)

  const card = document.createElement('div')
  card.className = 'rm-ssh-card'

  const head = document.createElement('div')
  head.className = 'rm-ssh-head'
  const title = document.createElement('div')
  title.className = 'rm-ssh-title'
  title.textContent = `SSH · ${machine.alias}`
  const sub = document.createElement('div')
  sub.className = 'rm-ssh-sub'
  sub.textContent = `${machine.user}@${machine.host}${machine.port && machine.port !== 22 ? ':' + machine.port : ''}`
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'rp-btn rp-btn-sm rm-ssh-close'
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', t('remote.close'))
  closeBtn.addEventListener('click', () => closeOverlay())
  head.appendChild(title)
  head.appendChild(sub)
  head.appendChild(closeBtn)

  const termHost = document.createElement('div')
  termHost.className = 'rm-ssh-term'

  card.appendChild(head)
  card.appendChild(termHost)
  modal.appendChild(card)
  document.body.appendChild(modal)

  // Click on the backdrop (not the card) closes the overlay.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeOverlay()
  })
  // Esc closes.
  const onKey = (e) => { if (e.key === 'Escape') closeOverlay() }
  document.addEventListener('keydown', onKey)

  const pane = new TerminalPane(termHost, {
    projectId: `remote:${machine.id}`,
    tabId: 'ssh',
    wsPath: '/ws/remote-ssh',
    attachExtra: { sessionType: 'remote-ssh', sshMachineId: machine.id },
  })
  activeOverlay = { modal, pane, close: () => {
    document.removeEventListener('keydown', onKey)
    try { pane.dispose() } catch {}
    if (modal.parentNode) modal.parentNode.removeChild(modal)
    activeOverlay = null
  } }
  // Focus the terminal once xterm mounts.
  requestAnimationFrame(() => { try { pane.term && pane.term.focus() } catch {} })
}

function closeOverlay() {
  if (activeOverlay) activeOverlay.close()
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderShell(pane) {
  pane.innerHTML = ''
  const info = document.createElement('div')
  info.className = 'rm-info'
  info.appendChild(infoBlock())
  pane.appendChild(info)

  const formWrap = document.createElement('div')
  formWrap.className = 'rm-form-wrap'
  formWrap.id = 'rm-form-wrap'
  pane.appendChild(formWrap)
  renderForm()

  const listWrap = document.createElement('div')
  listWrap.className = 'rm-list-wrap'
  listWrap.id = 'rm-list-wrap'
  pane.appendChild(listWrap)
  renderList()
}

function infoBlock() {
  const wrap = document.createElement('div')
  wrap.className = 'rm-info-grid'

  const cli = document.createElement('div')
  cli.className = 'rm-info-item'
  cli.innerHTML = `<div class="rm-info-k">${t('remote.info.cli')}</div><div class="rm-info-v"><code>rustdesk --connect &lt;id&gt; [--password &lt;pw&gt;] [--relay]</code><br/><span class="rm-info-sub">${t('remote.info.cliSub')}</span></div>`

  const ssh = document.createElement('div')
  ssh.className = 'rm-info-item'
  ssh.innerHTML = `<div class="rm-info-k">${t('remote.info.ssh')}</div><div class="rm-info-v">${t('remote.info.sshV')}</div>`

  const web = document.createElement('div')
  web.className = 'rm-info-item'
  web.innerHTML = `<div class="rm-info-k">${t('remote.info.web')}</div><div class="rm-info-v">${t('remote.info.webV')}</div>`

  const relay = document.createElement('div')
  relay.className = 'rm-info-item'
  relay.innerHTML = `<div class="rm-info-k">${t('remote.info.relay')}</div><div class="rm-info-v">${t('remote.info.relayV')}</div>`

  const agpl = document.createElement('div')
  agpl.className = 'rm-info-item'
  agpl.innerHTML = `<div class="rm-info-k">${t('remote.info.agpl')}</div><div class="rm-info-v">${t('remote.info.agplV')}</div>`

  wrap.appendChild(cli)
  wrap.appendChild(ssh)
  wrap.appendChild(web)
  wrap.appendChild(relay)
  wrap.appendChild(agpl)
  return wrap
}

function renderForm() {
  const wrap = document.getElementById('rm-form-wrap')
  if (!wrap) return
  wrap.innerHTML = ''
  const card = document.createElement('div')
  card.className = 'rm-form-card'
  const title = document.createElement('div')
  title.className = 'rm-form-title'
  title.textContent = editingId ? t('remote.editTitle') : t('remote.addTitle')
  card.appendChild(title)

  const m = editingId ? machines.find((x) => x.id === editingId) : null
  // When editing, seed the selector from the record; otherwise keep last choice.
  if (m && m.type === 'ssh') formType = 'ssh'
  else if (m && m.type === 'rustdesk') formType = 'rustdesk'
  if (m && m.sshPassword) formAuthType = 'password'
  else if (m && m.key) formAuthType = 'key'

  // Type selector (rustdesk | ssh)
  const typeRow = document.createElement('div')
  typeRow.className = 'rm-field rm-type-row'
  const typeLabel = document.createElement('span')
  typeLabel.className = 'rm-field-label'
  typeLabel.textContent = t('remote.type')
  typeRow.appendChild(typeLabel)
  const typeGroup = document.createElement('div')
  typeGroup.className = 'rm-type-group'
  const rustOpt = typeOption('rustdesk', t('remote.typeRustdesk'), formType === 'rustdesk', () => {
    formType = 'rustdesk'; renderForm()
  })
  const sshOpt = typeOption('ssh', t('remote.typeSsh'), formType === 'ssh', () => {
    formType = 'ssh'; renderForm()
  })
  typeGroup.appendChild(rustOpt.wrap)
  typeGroup.appendChild(sshOpt.wrap)
  typeRow.appendChild(typeGroup)
  card.appendChild(typeRow)

  const aliasIn = field('text', 'alias', m?.alias || '', t('remote.alias'))

  if (formType === 'ssh') {
    const hostIn = field('text', 'host', m?.host || '', t('remote.host'))
    const userIn = field('text', 'user', m?.user || '', t('remote.user'))
    const portIn = field('number', 'port', String(m?.port || 22), t('remote.port'))
    portIn.input.min = 1
    portIn.input.max = 65535

    // Auth selector (key | password)
    const authRow = document.createElement('div')
    authRow.className = 'rm-field rm-type-row'
    const authLabel = document.createElement('span')
    authLabel.className = 'rm-field-label'
    authLabel.textContent = t('remote.auth')
    authRow.appendChild(authLabel)
    const authGroup = document.createElement('div')
    authGroup.className = 'rm-type-group'
    const keyOpt = typeOption('key', t('remote.authKey'), formAuthType === 'key', () => {
      formAuthType = 'key'; renderForm()
    })
    const pwOpt = typeOption('password', t('remote.authPassword'), formAuthType === 'password', () => {
      formAuthType = 'password'; renderForm()
    })
    authGroup.appendChild(keyOpt.wrap)
    authGroup.appendChild(pwOpt.wrap)
    authRow.appendChild(authGroup)

    const noteIn = field('text', 'note', m?.note || '', t('remote.note'))

    const errBox = mkErrBox()
    const actions = mkActions(
      () => submitForm({
        type: 'ssh',
        alias: aliasIn.input.value.trim(),
        host: hostIn.input.value.trim(),
        user: userIn.input.value.trim(),
        port: parseInt(portIn.input.value, 10) || 22,
        key: formAuthType === 'key' ? keyInput.value.trim() : '',
        sshPassword: formAuthType === 'password' ? sshPwInput.value : '',
        note: noteIn.input.value.trim(),
      }),
    )

    card.appendChild(aliasIn.wrap)
    card.appendChild(hostIn.wrap)
    card.appendChild(userIn.wrap)
    card.appendChild(portIn.wrap)
    card.appendChild(authRow)

    let keyInput, sshPwInput
    if (formAuthType === 'key') {
      const keyIn = field('text', 'key', m?.key || '', t('remote.key'))
      keyInput = keyIn.input
      card.appendChild(keyIn.wrap)
    } else {
      const pwIn = field('password', 'sshPassword', '', t('remote.sshPassword'))
      sshPwInput = pwIn.input
      card.appendChild(pwIn.wrap)
    }
    card.appendChild(noteIn.wrap)
    card.appendChild(errBox)
    card.appendChild(actions)
  } else {
    const peerIn = field('text', 'peerId', m?.peerId || '', t('remote.peerId'))
    const pwIn = field('password', 'password', m?.password || '', t('remote.password'))

    const relayLabel = document.createElement('label')
    relayLabel.className = 'rm-check'
    const relayCb = document.createElement('input')
    relayCb.type = 'checkbox'
    relayCb.id = 'rm-field-relay'
    relayCb.checked = !!(m && m.relay)
    const relaySpan = document.createElement('span')
    relaySpan.textContent = t('remote.relay')
    relayLabel.appendChild(relayCb)
    relayLabel.appendChild(relaySpan)

    const noteIn = field('text', 'note', m?.note || '', t('remote.note'))

    const errBox = mkErrBox()
    const actions = mkActions(
      () => submitForm({
        type: 'rustdesk',
        alias: aliasIn.input.value.trim(),
        peerId: peerIn.input.value.trim(),
        password: pwIn.input.value,
        relay: relayCb.checked,
        note: noteIn.input.value.trim(),
      }),
    )

    card.appendChild(aliasIn.wrap)
    card.appendChild(peerIn.wrap)
    card.appendChild(pwIn.wrap)
    card.appendChild(relayLabel)
    card.appendChild(noteIn.wrap)
    card.appendChild(errBox)
    card.appendChild(actions)
  }
  wrap.appendChild(card)
}

function typeOption(value, label, checked, onPick) {
  const wrap = document.createElement('label')
  wrap.className = 'rm-type-opt'
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = 'rm-type-' + (value === 'key' || value === 'password' ? 'auth' : 'machine')
  input.value = value
  input.checked = !!checked
  const span = document.createElement('span')
  span.textContent = label
  wrap.appendChild(input)
  wrap.appendChild(span)
  input.addEventListener('change', () => { if (input.checked) onPick() })
  return { wrap, input }
}

function mkErrBox() {
  const errBox = document.createElement('div')
  errBox.className = 'rm-form-error'
  errBox.id = 'rm-form-error'
  errBox.style.display = 'none'
  return errBox
}

function mkActions(onSave) {
  const actions = document.createElement('div')
  actions.className = 'rm-form-actions'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'rp-btn'
  save.textContent = t('remote.save')
  save.addEventListener('click', onSave)
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'rp-btn rp-btn-sm'
  cancel.textContent = t('remote.cancel')
  cancel.addEventListener('click', () => {
    editingId = null
    renderForm()
  })
  actions.appendChild(save)
  if (editingId) actions.appendChild(cancel)
  return actions
}

function renderFormError(msg) {
  const el = document.getElementById('rm-form-error')
  if (!el) return
  el.textContent = msg
  el.style.display = ''
}

function field(type, name, value, label) {
  const wrap = document.createElement('label')
  wrap.className = 'rm-field'
  const lab = document.createElement('span')
  lab.className = 'rm-field-label'
  lab.textContent = label
  const inp = document.createElement('input')
  inp.type = type
  inp.className = 'rp-input'
  inp.id = `rm-field-${name}`
  inp.value = value
  if (type === 'password') inp.autocomplete = 'new-password'
  wrap.appendChild(lab)
  wrap.appendChild(inp)
  return { wrap, input: inp }
}

function renderList(state = {}) {
  const wrap = document.getElementById('rm-list-wrap')
  if (!wrap) return
  wrap.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'rm-list-head'
  head.textContent = `${t('remote.listHead')} (${machines.length})`
  wrap.appendChild(head)

  if (loading || state.loading) {
    wrap.appendChild(hint(t('remote.loading')))
    return
  }
  if (state.error) {
    const e = document.createElement('div')
    e.className = 'rm-hint rm-error'
    e.textContent = `${t('remote.error')}: ${state.error}`
    wrap.appendChild(e)
    return
  }
  if (!machines.length) {
    wrap.appendChild(hint(t('remote.empty')))
    return
  }
  for (const m of machines) wrap.appendChild(renderRow(m))
}

function renderRow(m) {
  const row = document.createElement('div')
  row.className = 'rm-row'
  const head = document.createElement('div')
  head.className = 'rm-row-head'
  const name = document.createElement('div')
  name.className = 'rm-name'
  const badge = document.createElement('span')
  badge.className = 'rm-type-badge rm-type-badge-' + (m.type || 'rustdesk')
  badge.textContent = m.type === 'ssh' ? 'SSH' : 'RustDesk'
  name.appendChild(badge)
  const nameText = document.createElement('span')
  nameText.textContent = m.alias || (m.type === 'ssh' ? m.host : m.peerId)
  name.appendChild(nameText)

  const meta = document.createElement('div')
  meta.className = 'rm-meta'
  meta.textContent = rowMeta(m)
  head.appendChild(name)
  head.appendChild(meta)

  const actions = document.createElement('div')
  actions.className = 'rm-row-actions'
  if (m.type === 'ssh') {
    const connect = document.createElement('button')
    connect.type = 'button'
    connect.className = 'rp-btn rm-connect rm-connect-ssh'
    connect.textContent = t('remote.connect')
    connect.addEventListener('click', () => onSshConnect(m))
    actions.appendChild(connect)
  } else {
    const connect = document.createElement('a')
    connect.className = 'rp-btn rm-connect'
    connect.textContent = t('remote.connect')
    connect.href = connectUri(m)
    // open in a new context so the current nanocode tab is not replaced by the
    // (failed, on machines without the handler) navigation.
    connect.target = '_blank'
    connect.rel = 'noopener noreferrer'
    connect.title = connectUri(m)
    actions.appendChild(connect)
  }
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'rp-btn rp-btn-sm'
  edit.textContent = t('remote.edit')
  edit.addEventListener('click', () => {
    editingId = m.id
    renderForm()
  })
  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'rp-btn rp-btn-sm rm-del'
  del.textContent = t('remote.delete')
  del.addEventListener('click', () => {
    const msg = t('remote.confirmDelete').replace('{name}', m.alias || (m.type === 'ssh' ? m.host : m.peerId))
    if (window.confirm(msg)) removeMachine(m.id)
  })
  actions.appendChild(edit)
  actions.appendChild(del)

  row.appendChild(head)
  row.appendChild(actions)
  return row
}

function rowMeta(m) {
  if (m.type === 'ssh') {
    const auth = m.key ? 'key' : (m.sshPassword ? 'password' : '')
    return `${m.user}@${m.host}${m.port && m.port !== 22 ? ':' + m.port : ''}${auth ? ' · ' + auth : ''}${m.note ? ' · ' + m.note : ''}`
  }
  return `${m.peerId}${m.relay ? ' · relay' : ''}${m.note ? ' · ' + m.note : ''}`
}

async function onSshConnect(m) {
  // Pre-flight: surface key-missing / sshpass-missing as an inline list error
  // instead of opening a dead terminal. Host-unreachable / auth-failure are
  // reported by ssh inside the terminal itself.
  const check = await prelightOrOpen(m)
  if (!check.ok) {
    renderList({ error: check.error })
    return
  }
  openSshOverlay(m)
}

async function prelightOrOpen(m) {
  return preflightSsh(m)
}

function hint(text) {
  const d = document.createElement('div')
  d.className = 'rm-hint'
  d.textContent = text
  return d
}
