/**
 * Fleet Term plugin — exposes live tmux sessions via the browser.
 *
 * Server side:
 *   - GET /api/fleet-term/sessions   list running tmux sessions
 *   - WS  /ws/fleet-term/<session>   attach to a tmux session with node-pty
 *
 * The plugin only attaches to existing sessions; it never creates or kills them.
 */

import pty from 'node-pty'
import { spawn } from 'node:child_process'
import { setInterval, clearInterval } from 'node:timers'

/** Active ptys keyed by session name. */
const ptys = new Map()

/** Buffered incoming messages for a session before the pty spawns. */
const pendingInput = new Map()

/**
 * Check whether tmux is available on the host.
 */
function hasTmux() {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['-V'])
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * List running tmux sessions.
 */
function listSessions() {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', ['list-sessions', '-F', '#{session_name}:#{session_attached}'])
    let out = ''
    let err = ''
    child.stdout.on('data', (data) => { out += data })
    child.stderr.on('data', (data) => { err += data })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        // No sessions is not necessarily an error; tmux returns 1 with "no sessions".
        if (err.toLowerCase().includes('no sessions')) return resolve([])
        return reject(new Error(err || `tmux list-sessions exited ${code}`))
      }
      const sessions = out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.lastIndexOf(':')
          const name = idx > 0 ? line.slice(0, idx) : line
          const attached = idx > 0 ? line.slice(idx + 1) === '1' : false
          return { name, attached }
        })
      resolve(sessions)
    })
  })
}

/**
 * Ensure a session exists before attaching.
 */
function sessionExists(name) {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['has-session', '-t', name])
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * Spawn a read-only-ish tmux attach pty for the given session.
 * We use `tmux attach -t <name>` (no -d) so existing clients stay connected.
 */
function attachSession(name) {
  // node-pty requires a shell command; wrap tmux attach in a login shell so
  // PATH is sane without having to replicate Core's exact environment.
  return pty.spawn('bash', ['-lc', `exec tmux attach -t ${JSON.stringify(name)}`], {
    name: 'xterm-256color',
    cwd: process.env.HOME || '/',
    env: process.env,
  })
}

export async function register(host) {
  if (!(await hasTmux())) {
    console.warn('[fleet-term] tmux not found; plugin disabled')
    return
  }

  host.registerRoute('get', '/api/fleet-term/sessions', async (_req, res) => {
    try {
      const sessions = await listSessions()
      res.json({ sessions })
    } catch (err) {
      console.warn('[fleet-term] list sessions failed:', err.message)
      res.status(500).json({ error: err.message || 'failed to list tmux sessions' })
    }
  })

  host.registerWebSocket('/ws/fleet-term', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const rawPath = url.pathname.replace(/^\/ws\/fleet-term\/?/, '')
    const sessionName = decodeURIComponent(rawPath)
    if (!sessionName) {
      ws.close(4000, 'session name required')
      return
    }

    let proc = ptys.get(sessionName)
    const sockets = proc ? proc.sockets : new Set()

    if (proc) {
      proc.sockets.add(ws)
      ws.send(proc.scrollback || '')
      flushPendingInput(sessionName, proc)
      wireSocket(ws, proc, sessionName)
      return
    }

    sessionExists(sessionName).then((exists) => {
      if (!exists) {
        ws.close(4001, `session ${sessionName} not found`)
        return
      }

      proc = attachSession(sessionName)
      proc.sockets = sockets
      proc.scrollback = ''
      ptys.set(sessionName, proc)
      sockets.add(ws)

      proc.onData((data) => {
        proc.scrollback += data
        // Keep bounded scrollback for new reconnecting clients.
        if (proc.scrollback.length > 200 * 1024) {
          proc.scrollback = proc.scrollback.slice(-100 * 1024)
        }
        for (const socket of proc.sockets) {
          if (socket.readyState === socket.OPEN) socket.send(data)
        }
      })

      proc.onExit(() => {
        for (const socket of proc.sockets) {
          try { socket.close(1000, 'session detached') } catch {}
        }
        ptys.delete(sessionName)
      })

      flushPendingInput(sessionName, proc)
      wireSocket(ws, proc, sessionName)
    }).catch((err) => {
      console.warn('[fleet-term] attach failed:', err.message)
      ws.close(4002, err.message)
    })
  })

  // Periodically refresh the session list via notify so connected browsers
  // can update without polling.  unref() so the plugin does not keep a test
  // process alive when no HTTP/WebSocket listeners are active.
  const refreshInterval = setInterval(async () => {
    try {
      const sessions = await listSessions()
      host.broadcastNotify({ type: 'plugin:fleet-term:sessions', sessions })
    } catch { /* ignore transient tmux errors */ }
  }, 5000)
  refreshInterval.unref()

  // Best-effort cleanup on host teardown (Core doesn't call this yet, but keep
  // the API honest).
  host.on?.('shutdown', () => {
    clearInterval(refreshInterval)
    for (const proc of ptys.values()) {
      try { proc.kill() } catch {}
    }
    ptys.clear()
  })
}

function flushPendingInput(sessionName, proc) {
  const queue = pendingInput.get(sessionName)
  if (!queue) return
  pendingInput.delete(sessionName)
  for (const data of queue) {
    try { proc.write(data) } catch {}
  }
}

function wireSocket(ws, proc, sessionName) {
  ws.on('message', (raw) => {
    let data
    if (Buffer.isBuffer(raw)) data = raw.toString('utf8')
    else if (typeof raw === 'string') data = raw
    else data = String(raw)
    try { proc.write(data) } catch (err) {
      // If pty is not ready yet, buffer one message.
      if (!pendingInput.has(sessionName)) pendingInput.set(sessionName, [])
      pendingInput.get(sessionName).push(data)
    }
  })

  ws.on('close', () => {
    proc.sockets.delete(ws)
    // When nobody is watching, kill the attach client but leave tmux session alive.
    if (proc.sockets.size === 0) {
      try { proc.kill() } catch {}
      ptys.delete(sessionName)
    }
  })

  ws.on('error', (err) => {
    console.warn('[fleet-term] ws error:', err?.message)
    proc.sockets.delete(ws)
  })
}
