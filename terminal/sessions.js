/** Persistent PTY sessions with scrollback. Sessions survive client disconnect. */

import pty from 'node-pty'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const OUTPUT_FLUSH_MS = 12
const SCROLLBACK_SIZE = 100 * 1024 // 100KB
const HEARTBEAT_TIMEOUT_MS = 30000 // 30s — disconnect if no ping received
const HEARTBEAT_CHECK_MS = 10000 // check interval
const SESSION_GC_DELAY_MS = 30 * 60 * 1000 // 30 min — GC exited sessions with no clients

/** Circular buffer for raw terminal output; replay on reconnect */
class ScrollbackBuffer {
  constructor(maxSize = SCROLLBACK_SIZE) {
    this._maxSize = maxSize
    this._data = ''
  }

  append(data) {
    this._data += data
    if (this._data.length > this._maxSize) {
      this._data = this._data.slice(-this._maxSize)
    }
  }

  getContents() {
    return this._data
  }

  clear() {
    this._data = ''
  }
}

/** Single persistent session: one PTY + scrollback + set of attached clients */
class Session {
  /**
   * @param {string} _key — session key (projectId:sessionType)
   * @param {string} command
   * @param {string[]} args
   * @param {number} cols
   * @param {number} rows
   * @param {string} cwd
   */
  constructor(_key, command, args, cols, rows, cwd) {
    this._key = _key
    this._command = command
    this._args = args
    this._cwd = cwd
    this._scrollback = new ScrollbackBuffer()
    /** @type {Set<import('ws').WebSocket>} */
    this._clients = new Set()
    /** @type {Map<import('ws').WebSocket, { lastPing: number, heartbeatTimer: ReturnType<typeof setInterval> | null }>} */
    this._clientMeta = new Map()
    this._exited = false
    this._gcTimer = null
    this._exitCode = null
    this._proc = null
    this._outBuf = ''
    this._flushTimer = null
    this._spawn(cols, rows)
  }

  _spawn(cols, rows) {
    // Validate cwd exists — node-pty throws "File not found" on Windows if it doesn't
    let cwd = this._cwd
    if (!cwd || !existsSync(cwd)) {
      console.warn(`[pty] cwd does not exist: ${cwd}, falling back to home`)
      cwd = homedir()
    }
    // Validate command exists
    let command = this._command
    if (!existsSync(command)) {
      console.warn(`[pty] command not found: ${command}`)
    }
    console.log(`[pty] spawn: command=${command} args=${JSON.stringify(this._args)} cwd=${cwd}`)
    this._proc = pty.spawn(command, this._args, {
      name: 'xterm-256color',
      cols: Math.max(1, cols || 80),
      rows: Math.max(1, rows || 24),
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3',
      },
    })

    this._proc.onData((data) => {
      this._scrollback.append(data)
      this._outBuf += data
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => this._flush(), OUTPUT_FLUSH_MS)
      }
    })

    this._proc.onExit(({ exitCode, signal }) => {
      this._flush()
      this._exited = true
      this._exitCode = exitCode
      const msg = JSON.stringify({ type: 'exit', exitCode, signal })
      for (const ws of this._clients) {
        if (ws.readyState === 1) ws.send(msg)
      }
      this._scheduleGc()
    })
  }

  _flush() {
    this._flushTimer = null
    if (!this._outBuf) return
    const data = this._outBuf
    this._outBuf = ''
    const msg = JSON.stringify({ type: 'output', data })
    for (const ws of this._clients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {number} cols
   * @param {number} rows
   */
  attach(ws, cols, rows) {
    // Flush any pending output to existing clients before snapshotting history.
    // This prevents the new client's history from overlapping with subsequent output
    // messages — which would cause TTS to re-read content already in the scrollback.
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
      this._flush()
    }
    const history = this._scrollback.getContents()
    // Always send history message (even empty) so client sets _historyDone=true immediately
    ws.send(JSON.stringify({ type: 'history', data: history || '' }))
    this._clients.add(ws)
    if (this._gcTimer) { clearTimeout(this._gcTimer); this._gcTimer = null }
    if (this._proc && !this._exited) {
      try {
        this._proc.resize(Math.max(1, cols), Math.max(1, rows))
      } catch {
        // ignore
      }
    }

    // Heartbeat: track last ping from this client
    const meta = { lastPing: Date.now(), heartbeatTimer: null }
    this._clientMeta.set(ws, meta)
    meta.heartbeatTimer = setInterval(() => {
      if (Date.now() - meta.lastPing > HEARTBEAT_TIMEOUT_MS) {
        ws.terminate()
      }
    }, HEARTBEAT_CHECK_MS)

    const onMessage = (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      switch (msg.type) {
        case 'input':
          if (this._proc) this._proc.write(msg.data)
          break
        case 'resize':
          if (this._proc && !this._exited) {
            const c = Math.max(1, msg.cols || 80)
            const r = Math.max(1, msg.rows || 24)
            try {
              this._proc.resize(c, r)
            } catch {
              // ignore
            }
          }
          break
        case 'ping':
          meta.lastPing = Date.now()
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong', id: msg.id }))
          break
        case 'restart':
          if (this._exited) this.restart(msg.cols || 80, msg.rows || 24)
          break
      }
    }

    ws.on('message', onMessage)
    ws.on('close', () => {
      ws.removeListener('message', onMessage)
      this.detach(ws)
    })
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  detach(ws) {
    const meta = this._clientMeta.get(ws)
    if (meta?.heartbeatTimer) clearInterval(meta.heartbeatTimer)
    this._clientMeta.delete(ws)
    this._clients.delete(ws)
    this._scheduleGc()
  }

  /**
   * @param {number} cols
   * @param {number} rows
   */
  restart(cols, rows) {
    if (this._proc) {
      try {
        this._proc.kill()
      } catch {
        // already dead
      }
      this._proc = null
    }
    this._scrollback.clear()
    this._exited = false
    this._exitCode = null
    this._spawn(cols, rows)
  }

  /** Schedule GC if session has exited and has no clients. */
  _scheduleGc() {
    if (this._gcTimer) return
    if (!this._exited || this._clients.size > 0) return
    this._gcTimer = setTimeout(() => {
      if (this._exited && this._clients.size === 0) {
        this.destroy()
        sessions.delete(this._key)
      }
    }, SESSION_GC_DELAY_MS)
  }

  destroy() {
    if (this._gcTimer) clearTimeout(this._gcTimer)
    if (this._flushTimer) clearTimeout(this._flushTimer)
    for (const meta of this._clientMeta.values()) {
      if (meta.heartbeatTimer) clearInterval(meta.heartbeatTimer)
    }
    this._clientMeta.clear()
    if (this._proc) {
      try {
        this._proc.kill()
      } catch {
        // ignore
      }
    }
    this._clients.clear()
  }
}

/** @type {Map<string, Session>} */
const sessions = new Map()

/**
 * @param {string} sessionKey — e.g. projectId:bash
 * @param {string} command
 * @param {string[]} args
 * @param {number} cols
 * @param {number} rows
 * @param {string} cwd
 * @returns {Session}
 */
export function getOrCreate(sessionKey, command, args, cols, rows, cwd) {
  let session = sessions.get(sessionKey)
  if (!session) {
    session = new Session(sessionKey, command, args, cols, rows, cwd)
    sessions.set(sessionKey, session)
  }
  return session
}

/**
 * @param {string} sessionKey
 * @returns {Session | null}
 */
export function get(sessionKey) {
  return sessions.get(sessionKey) ?? null
}

const CLI_PROVIDERS = ['claude', 'agent', 'opencode']

/**
 * List active CLI session IDs for a project.
 * Scans the sessions Map for keys matching `projectId:<provider>:*`.
 * @param {string} projectId
 * @param {string} [provider] — if omitted, lists sessions for all CLI providers
 * @returns {string[]} array of session ID strings
 */
export function listCliSessions(projectId, provider) {
  const prefixes = provider
    ? [`${projectId}:${provider}:`]
    : CLI_PROVIDERS.map((p) => `${projectId}:${p}:`)
  const ids = []
  for (const key of sessions.keys()) {
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) {
        ids.push(key.slice(prefix.length))
        break
      }
    }
  }
  return ids
}

/**
 * Destroy a single session by key.
 * @param {string} sessionKey
 * @returns {boolean} true if the session existed and was destroyed
 */
export function destroySession(sessionKey) {
  const session = sessions.get(sessionKey)
  if (session) {
    session.destroy()
    sessions.delete(sessionKey)
    return true
  }
  return false
}

/**
 * Destroy all sessions for a project (bash + all CLI provider sessions).
 * @param {string} projectId
 */
export function destroySessions(projectId) {
  const toDelete = []
  for (const key of sessions.keys()) {
    if (key === `${projectId}:bash`) {
      toDelete.push(key)
      continue
    }
    for (const p of CLI_PROVIDERS) {
      if (key.startsWith(`${projectId}:${p}:`)) {
        toDelete.push(key)
        break
      }
    }
  }
  for (const key of toDelete) {
    const session = sessions.get(key)
    if (session) {
      session.destroy()
      sessions.delete(key)
    }
  }
}
