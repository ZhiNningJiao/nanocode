import express from 'express'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import path from 'path'
import { WebSocketServer } from 'ws'
import { getStore } from './store.js'
import { createTerminalRoutes } from '../terminal/routes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const PORT = process.env.PORT || 3000

const app = express()
app.use(express.json())
app.use(express.static(path.join(root, 'public')))

const vendorOpts = { maxAge: '365d', immutable: true }
const vendorMap = {
  '/vendor/xterm': path.join(root, 'node_modules/@xterm/xterm'),
  '/vendor/xterm-addon-fit': path.join(root, 'node_modules/@xterm/addon-fit'),
  '/vendor/xterm-addon-web-links': path.join(root, 'node_modules/@xterm/addon-web-links'),
}
for (const [route, dir] of Object.entries(vendorMap)) {
  app.use(route, express.static(dir, vendorOpts))
}

const store = getStore()
store.migrateProjectsJson(path.join(root, 'terminal', 'projects.json'))
store.ensureStarterProject()

const { router: terminalRouter, handleTerminalWs } = createTerminalRoutes(store)
app.use(terminalRouter)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

const VALID_CLI_PROVIDERS = new Set(['claude', 'agent', 'opencode'])

app.get('/api/settings', (_req, res) => {
  res.json(store.getAllSettings())
})

app.put('/api/settings', (req, res) => {
  const { key, value } = req.body || {}
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value required' })
  }
  if (key === 'cli_provider' && !VALID_CLI_PROVIDERS.has(value)) {
    return res.status(400).json({ error: `Invalid cli_provider: ${value}` })
  }
  store.setSetting(key, value)
  res.json({ ok: true })
})

// TTS proxy — forwards text to a local GPT-SoVITS v3 service
const TTS_BASE = process.env.TTS_URL || 'http://127.0.0.1:9880'

// TTS settings stored in nanocode settings
function getTtsConfig() {
  const s = store.getAllSettings()
  return {
    ref_audio_path: s.tts_ref_audio || '/storage/home/zhiningjiao/code/GPT-SoVITS/ref_audio.wav',
    prompt_text: s.tts_prompt_text || '这是猫娘秘书的声音喵，主人你好呀',
    prompt_lang: s.tts_prompt_lang || 'zh',
    text_lang: s.tts_text_lang || 'auto',
    media_type: s.tts_media_type || 'wav',
  }
}

// Non-streaming TTS — POST /tts, returns full audio
app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text required' })
  const cfg = getTtsConfig()
  try {
    const ttsRes = await fetch(`${TTS_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        text_lang: cfg.text_lang,
        ref_audio_path: cfg.ref_audio_path,
        prompt_text: cfg.prompt_text,
        prompt_lang: cfg.prompt_lang,
        media_type: cfg.media_type,
        streaming_mode: false,
      }),
    })
    if (!ttsRes.ok) {
      return res.status(502).json({ error: `TTS service returned ${ttsRes.status}` })
    }
    res.set('Content-Type', ttsRes.headers.get('content-type') || 'audio/wav')
    const arrayBuf = await ttsRes.arrayBuffer()
    res.send(Buffer.from(arrayBuf))
  } catch (err) {
    res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
  }
})

// Streaming TTS — proxies chunked audio from GPT-SoVITS GET /tts endpoint
app.get('/api/tts/stream', async (req, res) => {
  const { text } = req.query
  if (!text) return res.status(400).json({ error: 'text required' })
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
  try {
    const ttsRes = await fetch(`${TTS_BASE}/tts?${params}`)
    if (!ttsRes.ok) {
      return res.status(502).json({ error: `TTS service returned ${ttsRes.status}` })
    }
    res.set('Content-Type', ttsRes.headers.get('content-type') || `audio/${cfg.media_type}`)
    res.set('Transfer-Encoding', 'chunked')
    // Pipe the stream directly to the client
    const reader = ttsRes.body.getReader()
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { res.end(); return }
        if (!res.write(value)) {
          await new Promise(resolve => res.once('drain', resolve))
        }
      }
    }
    pump().catch(() => res.end())
    req.on('close', () => reader.cancel())
  } catch (err) {
    res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
  }
})

// Voice reference configuration
app.post('/api/tts/voice', async (req, res) => {
  const { ref_audio_path, prompt_text, prompt_lang } = req.body || {}
  if (!ref_audio_path) return res.status(400).json({ error: 'ref_audio_path required' })
  try {
    // Set reference audio on GPT-SoVITS
    const r = await fetch(`${TTS_BASE}/change_refer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refer_wav_path: ref_audio_path,
        prompt_text: prompt_text || '',
        prompt_language: prompt_lang || 'zh',
      }),
    })
    if (!r.ok) return res.status(502).json({ error: `change_refer returned ${r.status}` })
    // Persist in nanocode settings
    store.setSetting('tts_ref_audio', ref_audio_path)
    if (prompt_text) store.setSetting('tts_prompt_text', prompt_text)
    if (prompt_lang) store.setSetting('tts_prompt_lang', prompt_lang)
    res.json({ ok: true })
  } catch (err) {
    res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
  }
})

app.get('/api/tts/status', async (_req, res) => {
  try {
    // GPT-SoVITS returns 400 on /tts without params (not 404), proving the service is up
    const r = await fetch(`${TTS_BASE}/tts`, { signal: AbortSignal.timeout(2000) })
    // Any response (even 400/405) means the service is reachable
    res.json({ available: true, config: getTtsConfig() })
  } catch {
    res.json({ available: false, config: getTtsConfig() })
  }
})

const server = createServer(app)

const deflateOpts = {
  zlibDeflateOptions: { level: 1 },
  zlibInflateOptions: { chunkSize: 16 * 1024 },
  threshold: 128,
}
const terminalWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: deflateOpts,
})

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  if (pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

terminalWss.on('connection', (ws) => {
  handleTerminalWs(ws)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nanocode running on http://0.0.0.0:${PORT}`)
})

export { app, server, store }
