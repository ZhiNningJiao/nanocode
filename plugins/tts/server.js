/**
 * TTS plugin — server side.
 *
 * Subscribes to the agent output stream, extracts [TTS_START]...[TTS_END]
 * blocks, deduplicates them, and broadcasts tts:enqueue events to the
 * browser.  Also mounts the GPT-SoVITS proxy routes that the client uses to
 * fetch audio.
 */


const TTS_DEBOUNCE_MS = 1500
const TTS_BASE = process.env.TTS_URL || 'http://127.0.0.1:9880'

export function register(host) {
  // Register persisted settings.  Core stores values; we read them via getSetting().
  host.registerSetting({ key: 'tts_ref_audio', type: 'string', default: '/storage/home/zhiningjiao/code/GPT-SoVITS/ref_audio.wav', label: 'TTS reference audio path' })
  host.registerSetting({ key: 'tts_prompt_text', type: 'string', default: '这是猫娘秘书的声音喵，主人你好呀', label: 'TTS reference text' })
  host.registerSetting({ key: 'tts_prompt_lang', type: 'string', default: 'zh', label: 'TTS prompt language' })
  host.registerSetting({ key: 'tts_text_lang', type: 'string', default: 'en', label: 'TTS text language' })
  host.registerSetting({ key: 'tts_media_type', type: 'string', default: 'ogg', label: 'TTS audio format' })

  // ── State for extraction pipeline ────────────────────────────────────────────
  let buffer = ''
  let debounceTimer = null
  const playedHashes = new Set()

  function simpleHash(s) {
    let h = 0
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
    return h.toString(36)
  }

  function stripAnsi(s) {
    return s
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
      .replace(/\x1b[^[\]PX^_\r\n]/g, '')
      .replace(/\r/g, '')
  }

  function enqueue(text) {
    const hash = simpleHash(text)
    if (playedHashes.has(hash)) return
    if (playedHashes.size > 200) {
      const first = playedHashes.values().next().value
      playedHashes.delete(first)
    }
    playedHashes.add(hash)
    host.broadcastNotify({ type: 'plugin:tts:enqueue', text })
  }

  function flushBuffer() {
    const buf = stripAnsi(buffer)
    buffer = ''
    const re = /\[TTS_START\]([\s\S]*?)\[TTS_END\]/g
    const parts = []
    let match
    while ((match = re.exec(buf)) !== null) {
      const t = match[1].trim()
      if (t) parts.push(t)
    }
    for (const part of parts) enqueue(part)
  }

  host.on('agent:output', (rawData) => {
    if (!rawData) return
    buffer += rawData
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flushBuffer, TTS_DEBOUNCE_MS)
  })

  // Clear the debounce timer on shutdown so a pending flush doesn't fire
  // after the server has begun closing connections.
  host.registerLifecycle({
    onStop() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = null
    },
  })

  host.reportStatus('ok', 'TTS plugin ready')

  // ── GPT-SoVITS proxy routes (unchanged behavior from pre-plugin Core) ───────

  // P3: TTS circuit breaker — fast-reject when GPT-SoVITS is known-down.
  const TTS_CB = {
    failures: 0,
    threshold: 3,
    cooldownMs: 30_000,
    openAt: 0,
    isOpen() {
      if (this.openAt === 0) return false
      if (Date.now() - this.openAt > this.cooldownMs) {
        this.openAt = 0
        return false
      }
      return true
    },
    recordSuccess() { this.failures = 0; this.openAt = 0 },
    recordFailure() {
      this.failures++
      if (this.failures >= this.threshold) {
        this.openAt = Date.now()
        console.warn(`[TTS circuit] OPEN — ${this.failures} consecutive failures; fast-rejecting for ${this.cooldownMs / 1000}s`)
      }
    },
  }

  function getTtsConfig() {
    return {
      ref_audio_path: host.getSetting('tts_ref_audio') || '/storage/home/zhiningjiao/code/GPT-SoVITS/ref_audio.wav',
      prompt_text: host.getSetting('tts_prompt_text') || '这是猫娘秘书的声音喵，主人你好呀',
      prompt_lang: host.getSetting('tts_prompt_lang') || 'zh',
      text_lang: host.getSetting('tts_text_lang') || 'en',
      media_type: host.getSetting('tts_media_type') || 'ogg',
    }
  }

  // Serial queue for GPT-SoVITS (single-threaded inference).
  let ttsQueueTail = Promise.resolve()
  function ttsSerialize(fn) {
    const safeFn = async () => {
      try { return await fn() } catch (err) { console.warn('[TTS queue] task error:', err?.message) }
    }
    const p = ttsQueueTail.then(safeFn, safeFn)
    ttsQueueTail = p.catch(() => {})
    return p
  }

  async function handleTts(req, res) {
    try {
      if (TTS_CB.isOpen()) {
        const retryIn = Math.ceil((TTS_CB.cooldownMs - (Date.now() - TTS_CB.openAt)) / 1000)
        if (!res.headersSent) res.status(503).json({ error: 'TTS circuit open — service down', retryAfter: retryIn })
        return
      }
      const { text } = req.body || {}
      if (!text) {
        if (!res.headersSent) res.status(400).json({ error: 'text required' })
        return
      }
      const cfg = getTtsConfig()
      const payload = {
        text,
        text_lang: cfg.text_lang,
        ref_audio_path: cfg.ref_audio_path,
        prompt_text: cfg.prompt_text,
        prompt_lang: cfg.prompt_lang,
        media_type: cfg.media_type,
        streaming_mode: false,
      }
      const maxRetries = 2
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(new Error('TTS fetch timeout (15s)')), 15000)
          let ttsRes
          try {
            ttsRes = await fetch(`${TTS_BASE}/tts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: controller.signal,
            })
          } finally {
            clearTimeout(timeoutId)
          }
          if (!ttsRes.ok) {
            const detail = await ttsRes.text().catch(() => '')
            console.warn(`[TTS] attempt ${attempt}: service returned ${ttsRes.status}`, detail.slice(0, 200))
            if (attempt < maxRetries) continue
            TTS_CB.recordFailure()
            if (!res.headersSent) {
              return res.status(502).json({ error: `TTS service returned ${ttsRes.status}`, detail: detail.slice(0, 200) })
            }
            return
          }
          TTS_CB.recordSuccess()
          res.set('Content-Type', ttsRes.headers.get('content-type') || `audio/${cfg.media_type}`)
          const arrayBuf = await ttsRes.arrayBuffer()
          if (!res.headersSent) res.send(Buffer.from(arrayBuf))
          return
        } catch (err) {
          console.warn(`[TTS] attempt ${attempt}: ${err.message}`)
          if (attempt < maxRetries) continue
          TTS_CB.recordFailure()
          if (!res.headersSent) res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
        }
      }
    } catch (outerErr) {
      console.error('[TTS] handleTts unexpected error:', outerErr?.message, outerErr?.stack)
      try { if (!res.headersSent) res.status(500).json({ error: 'TTS internal error', detail: outerErr?.message }) } catch {}
    }
  }

  host.registerRoute('post', '/tts', (req, res) => ttsSerialize(() => handleTts(req, res)))

  host.registerRoute('get', '/tts/stream', async (req, res) => {
    try {
      const { text } = req.query
      if (!text) return res.status(400).json({ error: 'text required' })
      if (TTS_CB.isOpen()) {
        const retryIn = Math.ceil((TTS_CB.cooldownMs - (Date.now() - TTS_CB.openAt)) / 1000)
        return res.status(503).json({ error: 'TTS circuit open — service down', retryAfter: retryIn })
      }
      const cfg = getTtsConfig()
      const params = new URLSearchParams({
        text,
        text_lang: cfg.text_lang,
        ref_audio_path: cfg.ref_audio_path,
        prompt_text: cfg.prompt_text,
        prompt_lang: cfg.prompt_lang,
        media_type: cfg.media_type,
        streaming_mode: 'true',
      })
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(new Error('TTS stream connect timeout (15s)')), 15000)
      let ttsRes
      try {
        ttsRes = await fetch(`${TTS_BASE}/tts?${params}`, { signal: controller.signal })
      } finally {
        clearTimeout(timeoutId)
      }
      if (!ttsRes.ok) {
        if (!res.headersSent) return res.status(502).json({ error: `TTS service returned ${ttsRes.status}` })
        return
      }
      res.set('Content-Type', ttsRes.headers.get('content-type') || `audio/${cfg.media_type}`)
      res.set('Transfer-Encoding', 'chunked')
      const reader = ttsRes.body.getReader()
      req.on('close', () => { try { reader.cancel() } catch {} })
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) { if (!res.writableEnded) res.end(); return }
            if (res.writableEnded) { try { reader.cancel() } catch {}; return }
            if (!res.write(value)) {
              await new Promise(resolve => res.once('drain', resolve))
            }
          }
        } catch (pumpErr) {
          console.warn('[TTS stream] pump error:', pumpErr?.message)
          try { if (!res.writableEnded) res.end() } catch {}
        }
      }
      pump()
    } catch (err) {
      console.warn('[TTS stream] error:', err?.message)
      try {
        if (!res.headersSent) res.status(503).json({ error: 'TTS service unavailable', detail: err?.message })
        else if (!res.writableEnded) res.end()
      } catch {}
    }
  })

  host.registerRoute('post', '/tts/voice', async (req, res) => {
    const { ref_audio_path, prompt_text, prompt_lang } = req.body || {}
    if (!ref_audio_path) return res.status(400).json({ error: 'ref_audio_path required' })
    try {
      const params = new URLSearchParams({ refer_audio_path: ref_audio_path })
      const r = await fetch(`${TTS_BASE}/set_refer_audio?${params}`)
      if (!r.ok) return res.status(502).json({ error: `set_refer_audio returned ${r.status}` })
      host.setSetting('tts_ref_audio', ref_audio_path)
      if (prompt_text) host.setSetting('tts_prompt_text', prompt_text)
      if (prompt_lang) host.setSetting('tts_prompt_lang', prompt_lang)
      res.json({ ok: true })
    } catch (err) {
      res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
    }
  })

  host.registerRoute('get', '/tts/status', async (_req, res) => {
    try {
      await fetch(`${TTS_BASE}/tts`, { signal: AbortSignal.timeout(2000) })
      res.json({ available: true, config: getTtsConfig() })
    } catch {
      res.json({ available: false, config: getTtsConfig() })
    }
  })
}
