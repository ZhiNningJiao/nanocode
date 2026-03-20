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

// TTS proxy — forwards text to a local GPT-SoVITS (or compatible) service
const TTS_BASE = process.env.TTS_URL || 'http://127.0.0.1:9880'

app.post('/api/tts', async (req, res) => {
  const { text, lang } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text required' })
  try {
    const ttsRes = await fetch(`${TTS_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        text_lang: lang || 'auto',
        ref_audio_path: '',
        prompt_lang: '',
        prompt_text: '',
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

app.get('/api/tts/status', async (_req, res) => {
  try {
    const r = await fetch(TTS_BASE, { signal: AbortSignal.timeout(2000) })
    res.json({ available: r.ok })
  } catch {
    res.json({ available: false })
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
