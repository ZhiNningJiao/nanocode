/**
 * Remote machines plugin render core — MES-13740 需求10 (minimal integration).
 *
 * Address book of RustDesk peers. Each row has a "Connect" button that navigates
 * to `rustdesk://connect/<peerId>?password=<pw>&relay=true` — the browser hands
 * the custom scheme to the OS, which opens the native RustDesk client on the
 * user's *local* device (desktop GUI, or the RustDesk mobile app). The headless
 * nanocode server never renders a desktop; it only stores the book.
 *
 * The panel also surfaces the research conclusions (CLI / web client / relay /
 * AGPL) inline so the master can decide on the heavier iframe-web-client path.
 *
 * Mobile (≤480px): every control is a ≥44px touch target; the form stacks
 * vertically. This is a render core ("芯"); right-panel.js mounts it via the
 * registry (ops domain).
 */

import { t } from './i18n.js'

let activePane = null
let machines = []
let loaded = false
let loading = false
let editingId = null // '' = add mode, '<uuid>' = edit mode

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
  const body = {
    alias: formData.alias || '',
    peerId: formData.peerId || '',
    password: formData.password || '',
    relay: !!formData.relay,
    note: formData.note || '',
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

function connectUri(m) {
  let uri = `rustdesk://connect/${encodeURIComponent(m.peerId || '')}`
  const params = []
  if (m.password) params.push(`password=${encodeURIComponent(m.password)}`)
  if (m.relay) params.push('relay=true')
  if (params.length) uri += `?${params.join('&')}`
  return uri
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
  const aliasIn = field('text', 'alias', m?.alias || '', t('remote.alias'))
  const peerIn = field('text', 'peerId', m?.peerId || '', t('remote.peerId'))
  const pwIn = field('password', 'password', m?.password || '', t('remote.password'))
  const noteIn = field('text', 'note', m?.note || '', t('remote.note'))

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

  const errBox = document.createElement('div')
  errBox.className = 'rm-form-error'
  errBox.id = 'rm-form-error'
  errBox.style.display = 'none'

  const actions = document.createElement('div')
  actions.className = 'rm-form-actions'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'rp-btn'
  save.textContent = t('remote.save')
  save.addEventListener('click', () =>
    submitForm({
      alias: aliasIn.input.value.trim(),
      peerId: peerIn.input.value.trim(),
      password: pwIn.input.value,
      relay: relayCb.checked,
      note: noteIn.input.value.trim(),
    }),
  )
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

  card.appendChild(aliasIn.wrap)
  card.appendChild(peerIn.wrap)
  card.appendChild(pwIn.wrap)
  card.appendChild(relayLabel)
  card.appendChild(noteIn.wrap)
  card.appendChild(errBox)
  card.appendChild(actions)
  wrap.appendChild(card)
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
  name.textContent = m.alias || m.peerId
  const meta = document.createElement('div')
  meta.className = 'rm-meta'
  meta.textContent = `${m.peerId}${m.relay ? ' · relay' : ''}${m.note ? ' · ' + m.note : ''}`
  head.appendChild(name)
  head.appendChild(meta)

  const actions = document.createElement('div')
  actions.className = 'rm-row-actions'
  const connect = document.createElement('a')
  connect.className = 'rp-btn rm-connect'
  connect.textContent = t('remote.connect')
  connect.href = connectUri(m)
  // open in a new context so the current nanocode tab is not replaced by the
  // (failed, on machines without the handler) navigation.
  connect.target = '_blank'
  connect.rel = 'noopener noreferrer'
  connect.title = connectUri(m)
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
    const msg = t('remote.confirmDelete').replace('{name}', m.alias || m.peerId)
    if (window.confirm(msg)) removeMachine(m.id)
  })
  actions.appendChild(connect)
  actions.appendChild(edit)
  actions.appendChild(del)

  row.appendChild(head)
  row.appendChild(actions)
  return row
}

function hint(text) {
  const d = document.createElement('div')
  d.className = 'rm-hint'
  d.textContent = text
  return d
}
