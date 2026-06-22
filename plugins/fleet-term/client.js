/**
 * Fleet Term browser plugin.
 *
 * Renders a two-pane panel: tmux session list on the left, xterm on the right.
 */

const { Terminal } = window
const { FitAddon } = window.FitAddon

const THEME_LIGHT = {
  background: '#fbf6ec',
  foreground: '#2D2824',
  cursor: '#0C7E94',
  cursorAccent: '#fbf6ec',
  selectionBackground: 'rgba(45, 191, 211, 0.30)',
  selectionForeground: '#2D2824',
}
const THEME_DARK = {
  background: '#1a1714',
  foreground: '#ECE6DD',
  cursor: '#2DBFD3',
  cursorAccent: '#1a1714',
  selectionBackground: 'rgba(45, 191, 211, 0.32)',
  selectionForeground: '#ECE6DD',
}
function currentTheme() {
  return document.documentElement && document.documentElement.dataset.theme === 'dark' ? THEME_DARK : THEME_LIGHT
}

export function register(ui) {
  ui.registerPanel('fleet-term', {
    title: 'Fleet Term',
    render(container) {
      new FleetTermPanel(container, ui)
    },
  })
}

class FleetTermPanel {
  constructor(container, _ui) {
    this.container = container
    this.activeSession = null
    this.term = null
    this.fitAddon = null
    this.ws = null
    this.resizeTimer = null
    this.resizeObserver = null

    this._buildLayout()
    this._loadSessions()
    this._startLiveUpdates(_ui)
  }

  _buildLayout() {
    this.container.innerHTML = ''
    this.container.classList.add('fleet-term-layout')

    this.sessionsEl = document.createElement('div')
    this.sessionsEl.className = 'fleet-term-sessions'
    this.sessionsEl.innerHTML = '<h4>Sessions</h4><div class="fleet-term-session-list"></div>'

    this.terminalEl = document.createElement('div')
    this.terminalEl.className = 'fleet-term-terminal'
    this.emptyEl = document.createElement('div')
    this.emptyEl.className = 'fleet-term-empty'
    this.emptyEl.textContent = 'Select a tmux session'
    this.terminalEl.appendChild(this.emptyEl)

    this.container.appendChild(this.sessionsEl)
    this.container.appendChild(this.terminalEl)
  }

  async _loadSessions() {
    const list = this.sessionsEl.querySelector('.fleet-term-session-list')
    try {
      const res = await fetch('/api/fleet-term/sessions')
      if (!res.ok) throw new Error((await res.text()) || 'fetch failed')
      const data = await res.json()
      this._renderSessions(data.sessions || [])
    } catch (err) {
      list.innerHTML = `<div class="fleet-term-error">${escapeHtml(err.message || 'Could not load sessions')}</div>`
    }
  }

  _renderSessions(sessions) {
    const list = this.sessionsEl.querySelector('.fleet-term-session-list')
    list.innerHTML = ''
    if (sessions.length === 0) {
      list.innerHTML = '<div class="fleet-term-empty">No tmux sessions</div>'
      return
    }
    for (const session of sessions) {
      const item = document.createElement('div')
      item.className = 'fleet-term-session-item'
      item.dataset.session = session.name
      item.dataset.attached = session.attached ? 'true' : 'false'
      item.innerHTML = `
        <span>${escapeHtml(session.name)}</span>
        <span class="fleet-term-session-status"></span>
      `
      item.addEventListener('click', () => this._attach(session.name))
      if (this.activeSession === session.name) item.classList.add('active')
      list.appendChild(item)
    }
  }

  _startLiveUpdates(ui) {
    ui.onMessage((msg) => {
      if (msg?.type === 'plugin:fleet-term:sessions') {
        this._renderSessions(msg.sessions || [])
      }
    })
  }

  _attach(sessionName) {
    if (this.activeSession === sessionName && this.ws?.readyState === WebSocket.OPEN) return

    if (!window.Terminal || !window.FitAddon) {
      this._showTerminalError('xterm.js is not loaded; reload the page and try again.')
      return
    }

    this.activeSession = sessionName
    this._updateActiveState()
    this._closeTerminal()

    if (this.emptyEl) {
      this.emptyEl.remove()
      this.emptyEl = null
    }

    const xtermContainer = document.createElement('div')
    xtermContainer.className = 'fleet-term-xterm'
    this.terminalEl.appendChild(xtermContainer)

    try {
      this.term = new Terminal({
        theme: currentTheme(),
        fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
        fontSize: 14,
        scrollback: 5000,
        cursorBlink: true,
        allowProposedApi: true,
      })
      this.fitAddon = new FitAddon()
      this.term.loadAddon(this.fitAddon)
      this.term.open(xtermContainer)
    } catch (err) {
      console.error('[fleet-term] xterm init failed:', err)
      this._showTerminalError(`Terminal init failed: ${err?.message || err}`)
      return
    }

    requestAnimationFrame(() => {
      this._fit()
    })

    this.term.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
    })

    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => this._fit(), 80)
    })
    this.resizeObserver.observe(xtermContainer)

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws/fleet-term/${encodeURIComponent(sessionName)}`
    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'

    this.ws.addEventListener('open', () => {
      this._fit()
      try { this.term.focus() } catch {}
    })

    this.ws.addEventListener('message', (ev) => {
      try {
        const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data
        this.term.write(data)
      } catch {}
    })

    this.ws.addEventListener('close', () => {
      this.term.writeln('\r\n\x1b[90m[disconnected]\x1b[0m')
    })

    this.ws.addEventListener('error', () => {
      this.term.writeln('\r\n\x1b[31m[connection error]\x1b[0m')
    })
  }

  _closeTerminal() {
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect() } catch {}
      this.resizeObserver = null
    }
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
    if (this.term) {
      try { this.term.dispose() } catch {}
      this.term = null
      this.fitAddon = null
    }
    this.terminalEl.innerHTML = ''
    this.emptyEl = document.createElement('div')
    this.emptyEl.className = 'fleet-term-empty'
    this.emptyEl.textContent = 'Select a tmux session'
    this.terminalEl.appendChild(this.emptyEl)
  }

  _fit() {
    if (!this.fitAddon || !this.term) return
    try {
      this.fitAddon.fit()
      const dims = this.fitAddon.proposeDimensions()
      if (dims && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    } catch {}
  }

  _showTerminalError(message) {
    this._closeTerminal()
    const err = document.createElement('div')
    err.className = 'fleet-term-error'
    err.textContent = message
    this.terminalEl.appendChild(err)
  }

  _updateActiveState() {
    this.sessionsEl.querySelectorAll('.fleet-term-session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.session === this.activeSession)
    })
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
