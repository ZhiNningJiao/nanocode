/**
 * TTS plugin (MES-13740 需求13).
 *
 * Settings-only plugin (no tab): surfaces a per-plugin settings panel in the
 * plugin manager. Migrates the GPT-SoVITS voice controls out of the Settings
 * page:
 *   - enable / streaming  (localStorage: ttsEnabled / ttsStreaming — unchanged)
 *   - ref audio + prompt  (server via POST /api/tts/voice — unchanged)
 *   - service status      (GET /api/tts/status — unchanged)
 *
 * Storage keys are intentionally identical to the old Settings UI so existing
 * configs carry over with no migration step. DOM ids are pm-*-prefixed so the
 * panel can coexist with the legacy Settings UI during the transition commit.
 *
 * Playback logic (tts.js: enqueueTts / onTerminalOutput) reads the same
 * localStorage keys; this panel only owns the configuration UI + status + test.
 */
import { t } from './i18n.js'

const TTS_ENABLED_KEY = 'ttsEnabled'
const TTS_STREAMING_KEY = 'ttsStreaming'

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

function _renderEnableBlock(section, statusDot, statusText) {
  const block = document.createElement('div')
  block.className = 'pm-settings-block'

  const enabledCb = document.createElement('input')
  enabledCb.type = 'checkbox'
  enabledCb.id = 'pm-tts-enabled'
  enabledCb.checked = localStorage.getItem(TTS_ENABLED_KEY) === 'true'
  enabledCb.addEventListener('change', () => {
    localStorage.setItem(TTS_ENABLED_KEY, enabledCb.checked)
    // 需求13: tts.js listens on this event to update its in-memory ttsEnabled
    // state + stop playback when disabled (setTtsEnabled handles both).
    document.dispatchEvent(new CustomEvent('nanocode:tts-enabled', { detail: { enabled: enabledCb.checked } }))
  })
  const enabledLbl = document.createElement('label')
  enabledLbl.className = 'pm-toggle-line'
  enabledLbl.appendChild(enabledCb)
  enabledLbl.appendChild(document.createTextNode(t('settings.tts.enabled')))
  block.appendChild(enabledLbl)

  const streamingCb = document.createElement('input')
  streamingCb.type = 'checkbox'
  streamingCb.id = 'pm-tts-streaming'
  streamingCb.checked = localStorage.getItem(TTS_STREAMING_KEY) === 'true'
  streamingCb.addEventListener('change', () => {
    localStorage.setItem(TTS_STREAMING_KEY, streamingCb.checked)
    document.dispatchEvent(new CustomEvent('nanocode:tts-streaming', { detail: { streaming: streamingCb.checked } }))
  })
  const streamingLbl = document.createElement('label')
  streamingLbl.className = 'pm-toggle-line'
  streamingLbl.appendChild(streamingCb)
  streamingLbl.appendChild(document.createTextNode(t('settings.tts.streaming')))
  block.appendChild(streamingLbl)

  const statusRow = document.createElement('div')
  statusRow.className = 'pm-setting-field pm-tts-status-row'
  statusRow.appendChild(statusDot)
  statusRow.appendChild(statusText)
  block.appendChild(statusRow)

  section.appendChild(block)
}

function _renderVoiceBlock(section) {
  const block = document.createElement('div')
  block.className = 'pm-settings-block'

  const refInput = document.createElement('input')
  refInput.type = 'text'
  refInput.className = 'pm-input'
  refInput.placeholder = '/path/to/voice.wav'

  const promptInput = document.createElement('input')
  promptInput.type = 'text'
  promptInput.className = 'pm-input'
  promptInput.placeholder = 'Reference audio transcript'

  const status = document.createElement('span')
  status.className = 'pm-status'

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'btn btn-primary pm-btn'
  saveBtn.textContent = t('btn.save')
  saveBtn.addEventListener('click', async () => {
    const ref = refInput.value.trim()
    const prompt = promptInput.value.trim()
    if (!ref) { _flash(status, 'Reference audio path required', false); return }
    try {
      const res = await fetch('/api/tts/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_audio_path: ref, prompt_text: prompt, prompt_lang: 'zh' }),
      })
      const data = await res.json()
      _flash(status, data.ok ? 'Saved' : (data.error || 'Error'), !!data.ok)
    } catch (e) { _flash(status, e.message || 'Error', false) }
  })

  const testBtn = document.createElement('button')
  testBtn.type = 'button'
  testBtn.className = 'btn btn-secondary pm-btn'
  testBtn.textContent = t('btn.test')
  testBtn.addEventListener('click', async () => {
    _flash(status, 'Fetching audio...', true)
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'TTS test.' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      await new Promise((resolve, reject) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve() }
        audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode error')) }
        audio.play().catch(reject)
      })
      _flash(status, 'Test OK', true)
    } catch (e) { _flash(status, e.message || 'Error', false) }
  })

  block.appendChild(_field('settings.tts.refaudio', refInput))
  block.appendChild(_field('settings.tts.prompttext', promptInput))
  const actions = document.createElement('div')
  actions.className = 'pm-setting-actions'
  actions.appendChild(saveBtn)
  actions.appendChild(testBtn)
  actions.appendChild(status)
  block.appendChild(actions)

  // Load current voice config from the server status endpoint.
  fetch('/api/tts/status').then((res) => res.json()).then((data) => {
    if (data?.config) {
      if (data.config.ref_audio_path) refInput.value = data.config.ref_audio_path
      if (data.config.prompt_text) promptInput.value = data.config.prompt_text
    }
  }).catch(() => {})

  section.appendChild(block)
}

export function renderTtsSettings(container) {
  if (!container) return
  container.innerHTML = ''

  const statusDot = document.createElement('span')
  statusDot.className = 'tts-status-dot unavailable'
  const statusText = document.createElement('span')
  statusText.className = 'tts-status-text'
  statusText.textContent = '…'

  const refreshStatus = async () => {
    try {
      const res = await fetch('/api/tts/status')
      const data = await res.json()
      statusDot.className = 'tts-status-dot ' + (data.available ? 'available' : 'unavailable')
      statusText.textContent = data.available
        ? (navigator.language?.startsWith('zh') ? '服务已连接' : 'Service connected')
        : (navigator.language?.startsWith('zh') ? '服务不可用' : 'Service unavailable')
    } catch {
      statusDot.className = 'tts-status-dot unavailable'
      statusText.textContent = 'Service unavailable'
    }
  }
  refreshStatus()
  const timer = setInterval(refreshStatus, 30000)
  // Stop polling when the panel is torn down (removed from DOM).
  const mo = new MutationObserver(() => {
    if (!container.isConnected) { clearInterval(timer); mo.disconnect() }
  })
  mo.observe(document.body, { childList: true, subtree: true })

  const headTitle = document.createElement('div')
  headTitle.className = 'pm-settings-subhead'
  headTitle.textContent = t('settings.tts.label')
  container.appendChild(headTitle)
  _renderEnableBlock(container, statusDot, statusText)

  const voiceTitle = document.createElement('div')
  voiceTitle.className = 'pm-settings-subhead'
  voiceTitle.textContent = t('settings.tts.refaudio')
  container.appendChild(voiceTitle)
  _renderVoiceBlock(container)
}
