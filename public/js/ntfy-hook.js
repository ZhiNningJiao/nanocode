const NTFY_DEBOUNCE_MS = 600
let ntfyBuffer = ''
let ntfyDebounceTimer = null
const ntfySeenHashes = new Set()

function ntfyHookLog(...args) { console.log('[ntfy-hook]', ...args) }

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[^[\]PX^_\r\n]/g, '')
    .replace(/\r/g, '')
}

function simpleHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h.toString(36)
}

async function publishNtfy(message) {
  try {
    const resp = await fetch('/api/notify/ntfy-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, title: 'Nanocode AI', tags: ['robot', 'bell'] }),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      ntfyHookLog('publish failed:', resp.status, data.error || '')
    } else {
      ntfyHookLog('published:', message.slice(0, 80))
    }
  } catch (e) {
    ntfyHookLog('publish error:', e.message)
  }
}

function onTerminalOutput(rawData) {
  if (!rawData) return
  const clean = stripAnsi(String(rawData))
  if (!clean.includes('[NTFY]')) return
  ntfyBuffer += clean
  if (ntfyDebounceTimer) clearTimeout(ntfyDebounceTimer)
  ntfyDebounceTimer = setTimeout(() => {
    const buf = ntfyBuffer
    ntfyBuffer = ''
    const re = /\[NTFY\]([\s\S]*?)\[\/NTFY\]/g
    let match
    while ((match = re.exec(buf)) !== null) {
      const text = match[1].trim()
      if (!text) continue
      const hash = simpleHash(text)
      if (ntfySeenHashes.has(hash)) { ntfyHookLog('skipped dup:', text.slice(0, 40)); continue }
      ntfySeenHashes.add(hash)
      if (ntfySeenHashes.size > 200) {
        const first = ntfySeenHashes.values().next().value
        ntfySeenHashes.delete(first)
      }
      ntfyHookLog('extracted:', text.slice(0, 80))
      publishNtfy(text)
    }
  }, NTFY_DEBOUNCE_MS)
}

document.addEventListener('nanocode:terminal-output', (e) => onTerminalOutput(e.detail))

window.ntfyHookTest = function (message) {
  const msg = message || 'AI hook manual test — [NTFY] tag extracted and pushed.'
  document.dispatchEvent(new CustomEvent('nanocode:terminal-output', { detail: '[NTFY]' + msg + '[/NTFY]' }))
  ntfyHookLog('test event dispatched:', msg.slice(0, 80))
  return 'dispatched'
}

ntfyHookLog('loaded — listening for [NTFY]...[/NTFY] markers')
