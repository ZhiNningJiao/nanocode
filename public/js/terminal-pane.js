/**
 * TerminalPane — reusable xterm + WebSocket + PTY bridge.
 * Optimized for high-latency / low-bandwidth networks.
 */

import { LocalEcho } from './local-echo.js'

const { Terminal } = window
const { FitAddon } = window.FitAddon
const { WebLinksAddon } = window.WebLinksAddon

// xterm theme — two palettes, picked by body[data-theme]. Switched
// dynamically on the 'nanocode:theme' event the theme module dispatches.
const THEME_LIGHT = {
  background: '#fbf6ec',
  foreground: '#2D2824',
  cursor: '#0C7E94',
  cursorAccent: '#fbf6ec',
  selectionBackground: 'rgba(45, 191, 211, 0.30)',
  selectionForeground: '#2D2824',
  black: '#2D2824',
  red: '#c4433b',
  green: '#3d9a5a',
  yellow: '#b88a3a',
  blue: '#0C7E94',
  magenta: '#9a4eb0',
  cyan: '#13A1B8',
  white: '#5C5550',
  brightBlack: '#7D776F',
  brightRed: '#e26159',
  brightGreen: '#5fb87a',
  brightYellow: '#d3a45a',
  brightBlue: '#2DBFD3',
  brightMagenta: '#b870c8',
  brightCyan: '#5DDCE9',
  brightWhite: '#2D2824',
}
const THEME_DARK = {
  background: '#1a1714',
  foreground: '#ECE6DD',
  cursor: '#2DBFD3',
  cursorAccent: '#1a1714',
  selectionBackground: 'rgba(45, 191, 211, 0.32)',
  selectionForeground: '#ECE6DD',
  black: '#1a1714',
  red: '#e26159',
  green: '#5fb87a',
  yellow: '#d3a45a',
  blue: '#5DDCE9',
  magenta: '#b870c8',
  cyan: '#2DBFD3',
  white: '#B5AEA3',
  brightBlack: '#847E72',
  brightRed: '#ff8a82',
  brightGreen: '#7fd699',
  brightYellow: '#f0c170',
  brightBlue: '#98F0F5',
  brightMagenta: '#d8a0e8',
  brightCyan: '#98F0F5',
  brightWhite: '#FFFFFF',
}
function currentTheme() {
  return document.documentElement && document.documentElement.dataset.theme === 'dark' ? THEME_DARK : THEME_LIGHT
}

// Track all open panes so a theme change can update every xterm instance.
const PANES = new Set()
document.addEventListener('nanocode:theme', () => {
  const theme = currentTheme()
  for (const pane of PANES) {
    try { pane.term.options.theme = theme } catch {}
  }
})

// When the JetBrains Mono webfont arrives AFTER xterm has already measured
// its cellWidth against the fallback monospace, every live xterm needs to
// remeasure and refit — otherwise the cached fallback cellWidth × cols ends
// up wider than the pane and the last character of each line clips (bleed).
//
// fontSize toggle is the most reliable public-API remeasure trigger: it
// ALWAYS fires the option-change event (xterm recomputes both cellWidth AND
// cellHeight when fontSize changes), even if the numeric value differs by
// less than a pixel. letterSpacing/fontFamily toggles were both being
// short-circuited by xterm's option-change handler. The +1 / restore
// round-trip happens within a single animation frame so the visible glitch
// is sub-perceptible.
if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    for (const pane of PANES) {
      try {
        const fs = pane.term.options.fontSize
        pane.term.options.fontSize = fs + 1
        pane.term.options.fontSize = fs
        pane._fit()
      } catch {}
    }
  })
}

// Reconnect backoff: 500ms → 1s → 2s → 4s → 8s → 10s cap
const BACKOFF_BASE = 500
const BACKOFF_MAX = 10000

// Debounce resize messages — on drag, dozens fire per second.
// Only the final size matters.
const RESIZE_DEBOUNCE_MS = 80

// Latency measurement for adaptive local echo
const PING_INTERVAL_MS = 5000
const RTT_EWMA_ALPHA = 0.2
const LOCAL_ECHO_ENABLE_RTT_MS = 50
const LOCAL_ECHO_DISABLE_RTT_MS = 30

// Single WebSocket endpoint for all sessions
const WS_PATH = '/ws/terminal'

export class TerminalPane {
  /**
   * @param {HTMLElement} container — the .pane-terminal element
   * @param {{
   *   projectId: string,
   *   tabId: string,
   *   onStatusChange?: (connected: boolean) => void,
   *   wsPath?: string,            // override WS endpoint (default '/ws/terminal')
   *   attachExtra?: object,       // extra fields merged into the 'attach' message
   *   skipTouchScroll?: boolean,  // true when this pane is a transient placeholder
   *                               // that a block renderer will replace — skips
   *                               // attaching the non-passive touchmove listener
   *                               // so iOS never "poisons" the gesture (once
   *                               // preventDefault fires, iOS commits the current
   *                               // touch to a non-scroll gesture even after the
   *                               // listener is removed). Call initTouchScroll()
   *                               // later if the block renderer fails to load.
   * }} opts
   */
  constructor(container, opts = {}) {
    this.container = container
    this.projectId = opts.projectId
    this.tabId = opts.tabId
    this.onStatusChange = opts.onStatusChange || (() => {})
    // The remote-ssh terminal overlay reuses this class with a different WS
    // endpoint + an sshMachineId in the attach payload. Default keeps the
    // original project-tab behaviour so existing callers are unaffected.
    this._wsPath = opts.wsPath || WS_PATH
    this._attachExtra = opts.attachExtra || null
    this._skipTouchScroll = opts.skipTouchScroll || false

    this._ws = null
    this._exited = false
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._resizeTimer = null
    this._pingInterval = null
    this._rttEwma = null

    // Create xterm — reduced scrollback saves memory on constrained clients
    const mobile = window.matchMedia('(max-width: 768px)').matches
    this.term = new Terminal({
      theme: currentTheme(),
      fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
      fontSize: mobile ? 13 : 14,
      scrollback: mobile ? 2000 : 4000,
      cursorBlink: true,
      allowProposedApi: true,
      // OSC 8 hyperlinks (some programs, including claude code, wrap URLs
      // in OSC 8 markers instead of relying on link autodetection). xterm
      // parses the markers but does nothing on click unless a handler is
      // registered — open the URI in a real browser tab, stripping opener.
      linkHandler: {
        activate(_event, uri) {
          try { window.open(uri, '_blank', 'noopener,noreferrer') } catch {}
        },
      },
    })
    PANES.add(this)

    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
    // Custom URL handler: nanocode runs in a browser, so workers have no
    // system clipboard or xdg-open equivalent. When the user taps a URL in
    // the terminal, open it in a real browser tab and strip opener so the
    // new tab can't reach back into this origin. window.open(uri, '_blank',
    // 'noopener,noreferrer') is more reliable than the addon's default
    // window.open() + location.href dance, which iOS Safari blocks as a
    // synthetic popup.
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer')
      })
    )

    // Local echo for high-latency: show typed chars immediately, reconcile with server output
    this.localEcho = new LocalEcho({
      write: (s) => this.term.write(s),
    })

    // Open in container
    this.term.open(container)

    // OSC 52 — programmatic clipboard write. Claude Code's "press c to copy
    // URL" prompt emits `ESC ] 52 ; c ; <base64-of-text> BEL`. The worker
    // has no system clipboard (headless), so the sequence must be handled
    // here on the browser side and routed through the user's browser
    // clipboard. xterm.js doesn't enable OSC 52 by default for security
    // (a remote program writing the user's clipboard is a real risk on a
    // multi-user host), but in nanocode the only program writing to the PTY
    // is one the user explicitly launched, so the trust model covers it.
    // Read requests (payload === '?') are refused — we never echo the
    // user's clipboard back to the program.
    try {
      this.term.parser.registerOscHandler(52, (data) => {
        // Payload format: <selection>;<base64-data>
        // - selection: c=clipboard, p=primary, q,s=others. Treat all as clipboard.
        // - data == '?'  → read request; refuse (don't echo the user's clipboard).
        const sep = data.indexOf(';')
        if (sep < 0) return true
        const payload = data.slice(sep + 1)
        if (payload === '?' || payload === '') return true
        try {
          const text = atob(payload)
          if (text) navigator.clipboard.writeText(text).catch(() => {})
        } catch {}
        return true   // handled; don't let xterm pass to default
      })
    } catch {}

    // Mobile: fix touch scrolling — xterm.js sets inline touch-action:none on
    // .xterm-screen which blocks all touch gestures. Override it and add manual
    // touch scroll handling for the viewport.
    // SKIPPED when skipTouchScroll is set: this pane is a transient placeholder
    // that a block renderer will replace once its JS lazily loads. Attaching a
    // non-passive touchmove with preventDefault here would let iOS "poison" the
    // gesture — once preventDefault fires, iOS commits the current touch to a
    // non-scroll gesture even after the listener is removed and the block
    // renderer takes over. By not attaching it, the placeholder terminal can't
    // be touch-scrolled (xterm's own touch-action:none blocks it), but that's a
    // 1-3 s loading window, far better than a permanently poisoned gesture.
    if (mobile && !this._skipTouchScroll) {
      this._initTouchScroll(container)
    }

    // Initial fit
    requestAnimationFrame(() => this._fit())

    // Resize observer — debounced to avoid flooding WS on drag
    this._resizeObserver = new ResizeObserver(() => {
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => this._fit(), RESIZE_DEBOUNCE_MS)
    })
    this._resizeObserver.observe(container)

    // Terminal input → WS (with local echo when enabled — instant feedback on high latency)
    this._dataDisposable = this.term.onData((data) => {
      // Filter out focus report sequences (CSI I / CSI O). xterm.js emits these
      // via onData when a program enables focus tracking mode (DECSET 1004) and
      // the terminal gains or loses focus. Forwarding them to the PTY causes
      // literal "[I" / "[O" to appear when clicking outside the terminal region.
      if (data === '\x1b[I' || data === '\x1b[O') return

      if (this._exited) {
        if (data === '\r') {
          const { cols, rows } = this._dimensions()
          this._send({ type: 'restart', cols, rows })
          this._exited = false
        }
        return
      }
      const echo = this.localEcho.predict(data)
      if (echo) this.term.write(echo)
      this._send({ type: 'input', data })
    })

    // Paste / copy handlers.
    this._keyDisposable = this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Ctrl+V / Cmd+V — paste from system clipboard into the PTY.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) this._send({ type: 'input', data: text })
          })
          .catch(() => {})
        return false
      }
      // Copy semantics:
      //   Ctrl+Shift+C / Cmd+Shift+C → ALWAYS copy current selection, never
      //   forward to the PTY. The standard terminal convention.
      //   Ctrl+C / Cmd+C with an active selection → copy the selection and
      //   suppress \x03 so the running program isn't interrupted.
      //   Ctrl+C / Cmd+C with no selection → fall through (xterm sends \x03).
      const isCopyChord =
        (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')
      if (isCopyChord) {
        const wantsExplicitCopy = e.shiftKey
        const hasSelection = this.term.hasSelection && this.term.hasSelection()
        if (wantsExplicitCopy || hasSelection) {
          const sel = this.term.getSelection ? this.term.getSelection() : ''
          if (sel) {
            try { navigator.clipboard.writeText(sel) } catch {}
          }
          return false
        }
      }
      return true
    })

    // Connect
    this._connect()
  }

  /**
   * Fix touch scrolling on mobile. xterm.js sets inline touch-action:none on
   * .xterm-screen which blocks all touch gestures. We override that and handle
   * vertical swipes by scrolling the terminal programmatically.
   */
  _initTouchScroll(container) {
    // Remove xterm's inline touch-action:none on the screen element
    const screen = container.querySelector('.xterm-screen')
    if (screen) {
      screen.style.touchAction = 'none'
    }

    // Also lock the viewport — we handle scrolling ourselves
    const viewport = container.querySelector('.xterm-viewport')
    if (viewport) {
      viewport.style.touchAction = 'none'
      viewport.style.overscrollBehavior = 'none'
    }

    // Manual touch scroll — intercept vertical swipes, scroll the terminal,
    // and preventDefault to stop iOS from also scrolling the page.
    let touchStartY = 0
    let touchActive = false
    let accumDy = 0

    this._touchStartHandler = (e) => {
      if (e.touches.length !== 1) return
      touchStartY = e.touches[0].clientY
      touchActive = true
      accumDy = 0
    }

    // MUST be non-passive so we can preventDefault and stop page scroll
    this._touchMoveHandler = (e) => {
      if (!touchActive || e.touches.length !== 1) return

      // Always prevent default to stop iOS page scroll
      e.preventDefault()

      const dy = touchStartY - e.touches[0].clientY
      touchStartY = e.touches[0].clientY

      // Accumulate sub-line pixel deltas for smooth scrolling
      accumDy += dy
      const cellHeight = container.clientHeight / (this.term.rows || 24) || 17
      const lines = Math.trunc(accumDy / cellHeight)
      if (lines !== 0) {
        this.term.scrollLines(lines)
        accumDy -= lines * cellHeight
      }
    }

    this._touchEndHandler = () => {
      touchActive = false
      accumDy = 0
    }

    this._touchContainer = container
    container.addEventListener('touchstart', this._touchStartHandler, { passive: true })
    container.addEventListener('touchmove', this._touchMoveHandler, { passive: false })
    container.addEventListener('touchend', this._touchEndHandler, { passive: true })
  }

  /** Retroactively enable touch scroll on a pane that was created with
   *  skipTouchScroll. Used when a block renderer fails to lazy-load and the
   *  TerminalPane stays as the permanent pane — without this the terminal
   *  can't be touch-scrolled on mobile. No-op if already initialized or not
   *  mobile. */
  initTouchScroll() {
    if (this._touchContainer) return
    if (!window.matchMedia('(max-width: 768px)').matches) return
    this._skipTouchScroll = false
    this._initTouchScroll(this.container)
  }

  _connect() {
    this._exited = false
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this._ws = new WebSocket(`${proto}//${location.host}${this._wsPath}`)

    this._ws.onopen = () => {
      this._reconnectAttempts = 0 // reset backoff on success
      this.onStatusChange(true)
      const { cols, rows } = this._dimensions()
      this._send({
        type: 'attach',
        projectId: this.projectId,
        sessionType: 'bash',
        tabId: this.tabId,
        cols,
        rows,
        ...(this._attachExtra || {}),
      })
      this._startPing()
      this.localEcho.enabled = true
    }

    this._ws.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }

      if (msg.type === 'history') {
        if (msg.data) this.term.write(msg.data)
      } else if (msg.type === 'output') {
        const toWrite = this.localEcho.reconcile(msg.data)
        if (toWrite) {
          this.term.write(toWrite)
          // Broadcast output for TTS and other listeners
          document.dispatchEvent(new CustomEvent('nanocode:terminal-output', { detail: toWrite }))
        }
      } else if (msg.type === 'pong') {
        this._onPong(msg.id)
      } else if (msg.type === 'exit') {
        this._exited = true
        this.term.write(
          '\r\n\x1b[90m[Process exited with code ' +
            (msg.exitCode ?? '?') +
            '. Press Enter to restart]\x1b[0m\r\n'
        )
      } else if (msg.type === 'error') {
        this.term.write(
          '\r\n\x1b[90m[Error: ' + (msg.error || 'unknown') + ']\x1b[0m\r\n'
        )
      }
    }

    this._ws.onclose = () => {
      this._stopPing()
      this.onStatusChange(false)
      if (!this._exited) {
        this._scheduleReconnect()
      }
    }

    this._ws.onerror = () => {
      // onclose fires after this
    }
  }

  /** Auto-reconnect with exponential backoff */
  _scheduleReconnect() {
    const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_MAX)
    this._reconnectAttempts++
    this.term.write(
      `\r\n\x1b[90m[Connection lost. Reconnecting in ${(delay / 1000).toFixed(1)}s...]\x1b[0m\r\n`
    )
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = setTimeout(() => {
      if (this._ws) {
        this._ws.onclose = null
        this._ws.close()
      }
      this._connect()
    }, delay)
  }

  /**
   * Send text from the unified input bar with local echo prediction.
   * On high-latency connections, the printable characters appear in the
   * terminal immediately; the LocalEcho reconciler suppresses duplicates
   * when the server echoes them back.
   *
   * @param {string} text — the command text (without trailing \r)
   */
  sendInputWithEcho(text) {
    if (this.localEcho.enabled) {
      for (let i = 0; i < text.length; i++) {
        const echo = this.localEcho.predict(text[i])
        if (echo) this.term.write(echo)
      }
    }
    // Split text and Enter into two writes with a small gap. Plain bash treats
    // them identically to a single write, but full-screen TUIs (Claude Code,
    // opencode, htop, etc.) need the \r as its own input event — when text+\r
    // arrives in one chunk they populate their input box but don't submit.
    this._send({ type: 'input', data: text })
    setTimeout(() => this._send({ type: 'input', data: '\r' }), 50)
  }

  /**
   * Send raw data to the PTY without local echo (for control sequences,
   * Tab completion requests, Ctrl+C, etc.).
   *
   * @param {string} data — raw bytes to write
   */
  sendRaw(data) {
    this._send({ type: 'input', data })
  }

  /**
   * Switch to another project; reconnects to that project's session (with history).
   * @param {string} projectId
   * @param {string} [tabId] — new tab ID (defaults to existing tabId)
   */
  switchProject(projectId, tabId) {
    if (projectId === this.projectId && (!tabId || tabId === this.tabId)) return
    this.projectId = projectId
    if (tabId) this.tabId = tabId
    this._reconnectNow()
  }

  _reconnectNow() {
    clearTimeout(this._reconnectTimer)
    this._stopPing()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
    this.term.clear()
    this._connect()
  }

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg))
    }
  }

  _startPing() {
    this._stopPing()
    const sendPing = () => {
      this._send({ type: 'ping', id: Date.now() })
    }
    sendPing()
    this._pingInterval = setInterval(sendPing, PING_INTERVAL_MS)
  }

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval)
      this._pingInterval = null
    }
  }

  _onPong(sentAt) {
    const rtt = Date.now() - sentAt
    if (this._rttEwma === null) {
      this._rttEwma = rtt
    } else {
      this._rttEwma = RTT_EWMA_ALPHA * rtt + (1 - RTT_EWMA_ALPHA) * this._rttEwma
    }
    if (this._rttEwma > LOCAL_ECHO_ENABLE_RTT_MS) {
      this.localEcho.enabled = true
    } else if (this._rttEwma < LOCAL_ECHO_DISABLE_RTT_MS) {
      this.localEcho.enabled = false
    }
  }

  _dimensions() {
    return {
      cols: this.term.cols || 80,
      rows: this.term.rows || 24,
    }
  }

  _fit() {
    try {
      this.fitAddon.fit()
      if (!this._exited) {
        const { cols, rows } = this._dimensions()
        this._send({ type: 'resize', cols, rows })
      }
    } catch {
      // ignore fit errors during teardown
    }
  }

  dispose() {
    // Remove touch scroll handlers FIRST so they can't leak onto the
    // container when a block renderer replaces this pane. Must run
    // before any potentially-throwing call below — if _keyDisposable
    // (void from attachCustomKeyEventHandler) or term.dispose() throws,
    // these listeners would otherwise stay attached and block native
    // scroll on the block renderer that takes over the same element.
    if (this._touchContainer) {
      this._touchContainer.removeEventListener('touchstart', this._touchStartHandler)
      this._touchContainer.removeEventListener('touchmove', this._touchMoveHandler)
      this._touchContainer.removeEventListener('touchend', this._touchEndHandler)
      this._touchContainer = null
    }
    this._stopPing()
    clearTimeout(this._reconnectTimer)
    clearTimeout(this._resizeTimer)
    this._resizeObserver.disconnect()
    this._dataDisposable.dispose()
    // attachCustomKeyEventHandler returns void (not IDisposable), so
    // _keyDisposable is undefined — use optional chaining to avoid a
    // throw that would abort the rest of dispose().
    this._keyDisposable?.dispose()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
    }
    PANES.delete(this)
    this.term.dispose()
  }
}

/** Drag-to-resize divider between two panes. Sets --split CSS custom property. */
export function initSplitPane(container, divider, onResize) {
  if (!divider) return
  let dragging = false

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    divider.classList.add('active')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = (x / rect.width) * 100
    const clamped = Math.min(80, Math.max(20, pct))
    container.style.setProperty('--split', `${clamped}%`)
    if (onResize) onResize()
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    divider.classList.remove('active')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (onResize) onResize()
  })
}
