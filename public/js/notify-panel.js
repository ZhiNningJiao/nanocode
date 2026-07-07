/**
 * Notify plugin (MES-13740 需求13).
 *
 * Settings-only plugin (no tab): surfaces a per-plugin settings panel in the
 * plugin manager. Migrates the three side-channel notification controls out of
 * the Settings page:
 *   - ntfy push        (server keys: ntfy_url / ntfy_topic — unchanged)
 *   - notification sounds (localStorage: notifySoundPrefs — unchanged)
 *   - turn-complete alert (localStorage: nanocodeTurnNotify — unchanged)
 *
 * Storage keys are intentionally identical to the old Settings UI so existing
 * configs carry over with no migration step. DOM ids are pm-*-prefixed so the
 * panel can coexist with the legacy Settings UI during the transition commit.
 *
 * Runtime playback (playNotifySound / _onTurnComplete) stays in app.js and reads
 * the same keys; this panel only owns the configuration UI + test buttons.
 */
import { t } from './i18n.js'
import { fetchSettings, updateSetting } from './api.js'

const NOTIFY_SOUND_KEY = 'notifySoundPrefs'
const TURN_NOTIFY_KEY = 'nanocodeTurnNotify'
const DEFAULT_SOUNDS = { done: 'bamboo', blocked: 'thud', qa: 'ding' }

function _readNotifyPrefs() {
  try { return JSON.parse(localStorage.getItem(NOTIFY_SOUND_KEY)) || {} } catch { return {} }
}
function _writeNotifyPrefs(p) {
  try { localStorage.setItem(NOTIFY_SOUND_KEY, JSON.stringify(p)) } catch {}
}
function _readTurnPrefs() {
  try { return JSON.parse(localStorage.getItem(TURN_NOTIFY_KEY)) || {} } catch { return {} }
}
function _writeTurnPrefs(p) {
  try { localStorage.setItem(TURN_NOTIFY_KEY, JSON.stringify(p)) } catch {}
}

function _flash(el, msg, ok) {
  if (!el) return
  el.textContent = msg
  el.className = 'pm-status ' + (ok ? 'ok' : 'err')
  setTimeout(() => { if (el) el.textContent = '' }, 3000)
}

function _field(labelKey, inner) {
  const f = document.createElement('div')
  f.className = 'pm-setting-field'
  const lbl = document.createElement('label')
  lbl.className = 'pm-setting-label'
  lbl.textContent = t(labelKey)
  f.appendChild(lbl)
  f.appendChild(inner)
  return f
}

function _soundSelect(type, currentValue) {
  const sel = document.createElement('select')
  sel.className = 'pm-input'
  for (const v of ['bamboo', 'ding', 'thud']) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = v[0].toUpperCase() + v.slice(1)
    sel.appendChild(o)
  }
  sel.value = currentValue ?? DEFAULT_SOUNDS[type]
  return sel
}

function _renderNtfyBlock(section) {
  const block = document.createElement('div')
  block.className = 'pm-settings-block'

  const urlInput = document.createElement('input')
  urlInput.type = 'text'
  urlInput.className = 'pm-input'
  urlInput.placeholder = 'http://localhost'
  const topicInput = document.createElement('input')
  topicInput.type = 'text'
  topicInput.className = 'pm-input'
  topicInput.placeholder = 'yourname'

  const status = document.createElement('span')
  status.className = 'pm-status'

  const initInput = document.createElement('input')
  initInput.type = 'text'
  initInput.className = 'pm-input pm-init-input'
  initInput.placeholder = t('settings.ntfy.initialize_url')

  const initHint = document.createElement('div')
  initHint.className = 'pm-hint'
  initHint.textContent = t('settings.ntfy.initialize_hint')

  const initBtn = document.createElement('button')
  initBtn.type = 'button'
  initBtn.className = 'btn btn-primary pm-btn pm-init-btn'
  initBtn.textContent = t('settings.ntfy.initialize')

  function _parseNtfyUrl(raw) {
    let s = (raw || '').trim()
    if (!s) return { base: '', topic: null, ok: false, err: 'empty' }
    if (!/^[a-zA-Z]+:\/\//.test(s)) s = 'http://' + s
    let u
    try { u = new URL(s) } catch { return { base: '', topic: null, ok: false, err: 'bad url' } }
    if (!u.hostname) return { base: '', topic: null, ok: false, err: 'no host' }
    const base = u.origin
    const segs = u.pathname.split('/').map((x) => decodeURIComponent(x)).filter(Boolean)
    const topic = segs.length ? segs[0] : null
    return { base, topic, ok: true }
  }

  initBtn.addEventListener('click', async () => {
    const raw = initInput.value.trim()
    if (!raw) { _flash(status, t('settings.ntfy.init_fail') + 'empty', false); return }
    const parsed = _parseNtfyUrl(raw)
    if (!parsed.ok) { _flash(status, t('settings.ntfy.init_fail') + parsed.err, false); return }
    let topic = parsed.topic
    if (!topic) {
      const existing = topicInput.value.trim()
      topic = existing || 'nanocode'
      _flash(status, t('settings.ntfy.init_derived_topic') + topic, true)
    }
    const base = parsed.base
    urlInput.value = base
    topicInput.value = topic
    initInput.value = base + '/' + topic
    try {
      await updateSetting('ntfy_url', base)
      await updateSetting('ntfy_topic', topic)
    } catch (e) { _flash(status, t('settings.ntfy.init_fail') + (e.message || 'save'), false); return }
    _flash(status, t('settings.ntfy.init_probing'), true)
    try {
      const endpoint = base.replace(/\/$/, '') + '/' + topic
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { Title: 'Nanocode initialized', Tags: 'tada', Priority: '3', 'Content-Type': 'text/plain' },
        body: 'Nanocode ntfy configured — Initialize succeeded. Tap Test anytime.',
      })
      if (resp.ok) {
        _flash(status, t('settings.ntfy.init_ok'), true)
      } else {
        _flash(status, t('settings.ntfy.init_fail') + 'HTTP ' + resp.status, false)
      }
    } catch (e) {
      _flash(status, t('settings.ntfy.init_fail') + (e.message || 'unreachable'), false)
    }
  })

  const initRow = document.createElement('div')
  initRow.className = 'pm-init-row'
  initRow.appendChild(initInput)
  initRow.appendChild(initBtn)
  block.appendChild(initRow)
  block.appendChild(initHint)

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'btn btn-primary pm-btn'
  saveBtn.textContent = t('btn.save')
  saveBtn.addEventListener('click', async () => {
    try {
      await updateSetting('ntfy_url', urlInput.value.trim())
      await updateSetting('ntfy_topic', topicInput.value.trim())
      _flash(status, 'Saved', true)
    } catch (e) { _flash(status, e.message || 'Error', false) }
  })

  const testBtn = document.createElement('button')
  testBtn.type = 'button'
  testBtn.className = 'btn btn-secondary pm-btn'
  testBtn.textContent = t('settings.ntfy.test')
  testBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim()
    const topic = topicInput.value.trim()
    if (!url || !topic) { _flash(status, 'Fill in URL and topic first', false); return }
    try {
      const endpoint = url.replace(/\/$/, '') + '/' + topic
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { Title: 'Nanocode test', Tags: 'tada', Priority: '3', 'Content-Type': 'text/plain' },
        body: 'Nanocode ntfy test notification',
      })
      _flash(status, resp.ok ? 'Sent!' : `HTTP ${resp.status}`, resp.ok)
    } catch (e) { _flash(status, e.message || 'Error', false) }
  })

  const hookTestBtn = document.createElement('button')
  hookTestBtn.type = 'button'
  hookTestBtn.className = 'btn btn-secondary pm-btn pm-hook-test-btn'
  hookTestBtn.textContent = t('settings.ntfy.hook_test')
  hookTestBtn.title = t('settings.ntfy.hook_test_hint')
  hookTestBtn.addEventListener('click', () => {
    const msg = 'AI hook test — [NTFY] tag extracted and pushed to your topic.'
    document.dispatchEvent(new CustomEvent('nanocode:terminal-output', { detail: '[NTFY]' + msg + '[/NTFY]' }))
    _flash(status, 'Hook event dispatched — check your topic', true)
  })

  block.appendChild(_field('settings.ntfy.url', urlInput))
  block.appendChild(_field('settings.ntfy.topic', topicInput))
  const actions = document.createElement('div')
  actions.className = 'pm-setting-actions'
  actions.appendChild(saveBtn)
  actions.appendChild(testBtn)
  actions.appendChild(hookTestBtn)
  actions.appendChild(status)
  block.appendChild(actions)

  // Load current values from server.
  fetchSettings().then((s) => {
    urlInput.value = s?.ntfy_url || ''
    topicInput.value = s?.ntfy_topic || ''
    if (s?.ntfy_url && s?.ntfy_topic) initInput.value = s.ntfy_url.replace(/\/$/, '') + '/' + s.ntfy_topic
  }).catch(() => {})

  section.appendChild(block)
}

function _renderSoundsBlock(section) {
  const block = document.createElement('div')
  block.className = 'pm-settings-block'

  const prefs = _readNotifyPrefs()
  const enabledCb = document.createElement('input')
  enabledCb.type = 'checkbox'
  enabledCb.id = 'pm-notify-sound-enabled'
  enabledCb.checked = prefs.enabled !== false
  const enabledLbl = document.createElement('label')
  enabledLbl.className = 'pm-toggle-line'
  enabledLbl.appendChild(enabledCb)
  enabledLbl.appendChild(document.createTextNode(t('settings.notify.enabled')))
  block.appendChild(enabledLbl)

  const volInput = document.createElement('input')
  volInput.type = 'range'
  volInput.min = '0'; volInput.max = '1'; volInput.step = '0.05'
  volInput.value = prefs.volume ?? 0.7
  volInput.className = 'pm-range'
  const volVal = document.createElement('span')
  volVal.className = 'pm-range-value'
  volVal.textContent = Math.round((parseFloat(volInput.value)) * 100) + '%'
  volInput.addEventListener('input', () => {
    volVal.textContent = Math.round(parseFloat(volInput.value) * 100) + '%'
  })
  block.appendChild(_field('settings.notify.volume', (() => {
    const wrap = document.createElement('div')
    wrap.className = 'pm-range-row'
    wrap.appendChild(volInput)
    wrap.appendChild(volVal)
    return wrap
  })()))

  const selects = {}
  for (const type of ['done', 'blocked', 'qa']) {
    const sel = _soundSelect(type, prefs[type + '_sound'])
    selects[type] = sel
    const test = document.createElement('button')
    test.type = 'button'
    test.className = 'btn btn-secondary pm-btn pm-btn-icon'
    test.textContent = '\u25B6'
    test.title = t('settings.ntfy.test')
    test.addEventListener('click', () => {
      const vol = parseFloat(volInput.value ?? 0.7)
      document.dispatchEvent(new CustomEvent('nanocode:play-sound', { detail: { key: sel.value, volume: vol } }))
    })
    const row = document.createElement('div')
    row.className = 'pm-select-test-row'
    row.appendChild(sel)
    row.appendChild(test)
    block.appendChild(_field('settings.notify.' + type, row))
  }

  const status = document.createElement('span')
  status.className = 'pm-status'
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'btn btn-primary pm-btn'
  saveBtn.textContent = t('btn.save')
  saveBtn.addEventListener('click', () => {
    _writeNotifyPrefs({
      enabled: enabledCb.checked,
      volume: parseFloat(volInput.value ?? 0.7),
      done_sound: selects.done.value,
      blocked_sound: selects.blocked.value,
      qa_sound: selects.qa.value,
    })
    _flash(status, 'Saved', true)
  })
  const actions = document.createElement('div')
  actions.className = 'pm-setting-actions'
  actions.appendChild(saveBtn)
  actions.appendChild(status)
  block.appendChild(actions)

  section.appendChild(block)
}

function _renderTurnBlock(section) {
  const block = document.createElement('div')
  block.className = 'pm-settings-block'

  const prefs = _readTurnPrefs()
  const threshInput = document.createElement('input')
  threshInput.type = 'number'
  threshInput.min = '1'; threshInput.max = '300'
  threshInput.value = prefs.threshold ?? 10
  threshInput.className = 'pm-input pm-input-narrow'
  block.appendChild(_field('settings.notify.turn_threshold_label', threshInput))

  const ntfyCb = document.createElement('input')
  ntfyCb.type = 'checkbox'
  ntfyCb.id = 'pm-turn-notify-ntfy'
  ntfyCb.checked = prefs.ntfy !== false
  const ntfyLbl = document.createElement('label')
  ntfyLbl.className = 'pm-toggle-line'
  ntfyLbl.appendChild(ntfyCb)
  ntfyLbl.appendChild(document.createTextNode(t('settings.notify.turn_ntfy_label')))
  block.appendChild(ntfyLbl)

  const status = document.createElement('span')
  status.className = 'pm-status'
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'btn btn-primary pm-btn'
  saveBtn.textContent = t('btn.save')
  saveBtn.addEventListener('click', () => {
    const threshold = parseFloat(threshInput.value)
    _writeTurnPrefs({ threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 10, ntfy: ntfyCb.checked })
    _flash(status, 'Saved', true)
  })
  const actions = document.createElement('div')
  actions.className = 'pm-setting-actions'
  actions.appendChild(saveBtn)
  actions.appendChild(status)
  block.appendChild(actions)

  section.appendChild(block)
}

export function renderNotifySettings(container) {
  if (!container) return
  container.innerHTML = ''
  const ntfyTitle = document.createElement('div')
  ntfyTitle.className = 'pm-settings-subhead'
  ntfyTitle.textContent = t('settings.ntfy.label')
  container.appendChild(ntfyTitle)
  _renderNtfyBlock(container)

  const soundsTitle = document.createElement('div')
  soundsTitle.className = 'pm-settings-subhead'
  soundsTitle.textContent = t('settings.notify.label')
  container.appendChild(soundsTitle)
  _renderSoundsBlock(container)

  const turnTitle = document.createElement('div')
  turnTitle.className = 'pm-settings-subhead'
  turnTitle.textContent = t('settings.notify.turn_threshold_label')
  container.appendChild(turnTitle)
  _renderTurnBlock(container)
}
