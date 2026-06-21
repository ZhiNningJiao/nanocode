/**
 * TTS plugin — browser side.
 *
 * Renders settings UI in the settings panel, listens for plugin:tts:enqueue
 * messages from the server, fetches synthesized audio from /api/tts, and
 * plays it.  Respects the global mute button.
 */

export function register(ui) {
  let ttsEnabled = localStorage.getItem('ttsEnabled') === 'true'
  let ttsStreaming = localStorage.getItem('ttsStreaming') === 'true'
  let ttsAvailable = false
  let ttsAudioUnlocked = false
  let ttsAudio = null
  let ttsQueue = []
  let ttsPlaying = false
  let ttsFirstCheck = true

  function isGloballyMuted() {
    try { return localStorage.getItem('nanocodeMuted') === 'true' } catch { return false }
  }

  function log(msg, level = 'ok') {
    const panel = document.getElementById('tts-log-panel')
    const ts = new Date().toLocaleTimeString()
    console.log('[TTS]', msg)
    if (panel) {
      const el = document.createElement('div')
      el.className = 'tts-log-entry ' + level
      el.textContent = `[${ts}] ${msg}`
      panel.appendChild(el)
      if (panel.children.length > 100) panel.removeChild(panel.firstChild)
      panel.scrollTop = panel.scrollHeight
    }
  }

  function unlockAudio() {
    if (ttsAudioUnlocked) return
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const buf = ctx.createBuffer(1, 1, 22050)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0)
    ttsAudioUnlocked = true
  }

  document.addEventListener('click', unlockAudio, { once: false })
  document.addEventListener('touchstart', unlockAudio, { once: false })

  function stopTts() {
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null }
    ttsQueue = []
    ttsPlaying = false
  }

  async function playNonStreaming(text) {
    log('Requesting: ' + text.slice(0, 50))
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) { log('Fetch failed: ' + res.status, 'err'); throw new Error(`TTS fetch ${res.status}`) }
    const blob = await res.blob()
    log('Received: ' + blob.size + ' bytes, type: ' + blob.type)
    const url = URL.createObjectURL(blob)
    ttsAudio = new Audio(url)
    await new Promise((resolve, reject) => {
      ttsAudio.onended = () => { log('Playback ended', 'ok'); URL.revokeObjectURL(url); ttsAudio = null; resolve() }
      ttsAudio.onerror = () => { URL.revokeObjectURL(url); ttsAudio = null; reject(new Error('Audio decode error')) }
      ttsAudio.play().then(() => log('Playing...', 'ok')).catch((e) => { log('Play blocked: ' + e.message, 'err'); reject(e) })
    })
  }

  async function playStreaming(text) {
    log('Streaming: ' + text.slice(0, 50))
    ttsAudio = new Audio('/api/tts/stream?' + new URLSearchParams({ text }))
    await new Promise((resolve, reject) => {
      ttsAudio.onended = () => { log('Stream ended', 'ok'); ttsAudio = null; resolve() }
      ttsAudio.onerror = () => { ttsAudio = null; reject(new Error('Stream decode error')) }
      ttsAudio.play().then(() => log('Stream playing...', 'ok')).catch((e) => { log('Play blocked: ' + e.message, 'err'); reject(e) })
    })
  }

  async function playNext() {
    if (ttsPlaying || !ttsQueue.length) return
    if (isGloballyMuted()) { ttsQueue = []; ttsPlaying = false; return }
    const text = ttsQueue.shift()
    if (!text.trim()) { playNext(); return }
    ttsPlaying = true
    try {
      if (ttsStreaming) await playStreaming(text)
      else await playNonStreaming(text)
    } catch (e) {
      log('Failed: ' + e.message, 'err')
    }
    ttsPlaying = false
    playNext()
  }

  function enqueueText(text) {
    if (!ttsEnabled || !ttsAvailable || isGloballyMuted()) return
    log('Enqueued: ' + text.slice(0, 50))
    ttsQueue.push(text)
    playNext()
  }

  ui.onMessage((msg) => {
    if (msg.type === 'plugin:tts:enqueue') {
      enqueueText(msg.text)
    }
  })

  // Settings UI
  ui.registerSetting({
    id: 'tts-settings',
    render(container) {
      container.innerHTML = `
        <div class="settings-subsection">
          <div class="settings-label-row"><span data-i18n="settings.tts.label">TTS (GPT-SoVITS)</span>
            <span class="settings-hint-inline"><span class="tts-status-dot" id="tts-status-dot"></span><span class="tts-status-text" id="tts-status-text"></span></span>
          </div>
          <div class="settings-toggle-row">
            <label class="toggle-label"><input type="checkbox" id="tts-enabled" /> <span data-i18n="settings.tts.enabled">Enable TTS</span></label>
          </div>
          <div class="settings-toggle-row">
            <label class="toggle-label"><input type="checkbox" id="tts-streaming" /> <span data-i18n="settings.tts.streaming">Streaming mode (low latency)</span></label>
          </div>
          <div class="settings-field">
            <label class="settings-label" data-i18n="settings.tts.refaudio">Reference audio path</label>
            <input type="text" id="tts-ref-audio" class="settings-input" placeholder="/path/to/voice.wav" />
          </div>
          <div class="settings-field">
            <label class="settings-label" data-i18n="settings.tts.prompttext">Reference text</label>
            <input type="text" id="tts-prompt-text" class="settings-input" placeholder="Reference audio transcript" />
          </div>
          <div class="settings-actions">
            <button type="button" class="btn btn-primary" id="tts-save-btn" data-i18n="btn.save">Save</button>
            <button type="button" class="btn btn-secondary" id="tts-test-btn" data-i18n="btn.test">Test</button>
            <span class="settings-status" id="tts-status"></span>
          </div>
          <details class="tts-log-details">
            <summary class="tts-log-summary" data-i18n="settings.tts.debuglog">TTS Debug Log</summary>
            <div class="tts-log-panel" id="tts-log-panel"></div>
          </details>
        </div>
      `

      const checkbox = container.querySelector('#tts-enabled')
      const streamingCheckbox = container.querySelector('#tts-streaming')
      const statusDot = container.querySelector('#tts-status-dot')
      const statusText = container.querySelector('#tts-status-text')
      const refInput = container.querySelector('#tts-ref-audio')
      const promptInput = container.querySelector('#tts-prompt-text')
      const saveBtn = container.querySelector('#tts-save-btn')
      const testBtn = container.querySelector('#tts-test-btn')
      const saveStatus = container.querySelector('#tts-status')

      function updateUi() {
        if (checkbox) checkbox.checked = ttsEnabled
        if (streamingCheckbox) streamingCheckbox.checked = ttsStreaming
      }

      async function checkStatus() {
        try {
          const res = await fetch('/api/tts/status')
          const data = await res.json()
          ttsAvailable = data.available
          if (data.config) {
            if (refInput && !refInput.value) refInput.value = data.config.ref_audio_path || ''
            if (promptInput && !promptInput.value) promptInput.value = data.config.prompt_text || ''
          }
        } catch { ttsAvailable = false }
        if (statusDot) statusDot.className = 'tts-status-dot ' + (ttsAvailable ? 'available' : 'unavailable')
        if (statusText) {
          statusText.textContent = ttsAvailable ? 'Service connected' : 'Service unavailable'
          statusText.style.color = ttsAvailable ? '#4caf50' : 'var(--fg-3)'
        }
        if (ttsFirstCheck && ttsAvailable && !ttsEnabled) {
          showToast('TTS available — tap the speaker icon to enable voice')
        }
        updateUi()
        ttsFirstCheck = false
      }

      function showToast(msg, duration = 4000) {
        let el = document.getElementById('tts-toast')
        if (!el) {
          el = document.createElement('div')
          el.id = 'tts-toast'
          el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(30,30,30,0.95);color:#f0f0f0;padding:10px 20px;border-radius:10px;font-size:14px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);'
          document.body.appendChild(el)
        }
        el.textContent = msg
        el.style.opacity = '1'
        clearTimeout(el._timer)
        el._timer = setTimeout(() => { el.style.opacity = '0' }, duration)
      }

      if (checkbox) {
        checkbox.checked = ttsEnabled
        checkbox.addEventListener('change', () => {
          ttsEnabled = checkbox.checked
          localStorage.setItem('ttsEnabled', ttsEnabled)
          if (!ttsEnabled) stopTts()
        })
      }
      if (streamingCheckbox) {
        streamingCheckbox.checked = ttsStreaming
        streamingCheckbox.addEventListener('change', () => {
          ttsStreaming = streamingCheckbox.checked
          localStorage.setItem('ttsStreaming', ttsStreaming)
        })
      }
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const ref = refInput?.value?.trim()
          const prompt = promptInput?.value?.trim()
          if (!ref) { if (saveStatus) saveStatus.textContent = 'Reference audio path required'; return }
          try {
            const res = await fetch('/api/tts/voice', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ref_audio_path: ref, prompt_text: prompt, prompt_lang: 'zh' }),
            })
            const data = await res.json()
            if (saveStatus) saveStatus.textContent = data.ok ? 'Saved!' : (data.error || 'Error')
          } catch {
            if (saveStatus) saveStatus.textContent = 'Failed to save'
          }
        })
      }
      if (testBtn) {
        testBtn.addEventListener('click', async () => {
          unlockAudio()
          if (saveStatus) saveStatus.textContent = 'Fetching audio...'
          try {
            await playNonStreaming('你好，TTS 语音测试成功了喵。')
            if (saveStatus) saveStatus.textContent = 'Test OK! Audio played.'
          } catch (e) {
            log('Test failed: ' + e.message, 'err')
            if (saveStatus) saveStatus.textContent = 'Failed: ' + e.message
          }
        })
      }

      updateUi()
      checkStatus()
      setInterval(checkStatus, 30000)
    },
  })
}
