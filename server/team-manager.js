/**
 * Dual-team management for NanoCode (MES-13273).
 *
 * Owns the server-side surface for the plugin-management panel's "Dual-Team
 * login/switch" buttons:
 *   - GET  /api/teams           → team list with `configured` + the active team
 *   - POST /api/teams/switch     → set the active team (writes nanocode_active_team)
 *   - WS   /ws/team-login/:team  → interactive `claude` PTY with the team's
 *                                  CLAUDE_CONFIG_DIR so the user can log in
 *
 * The active-team setting is read by the SDK driver (terminal/claude-sdk-driver.js)
 * which injects CLAUDE_CONFIG_DIR into every spawned claude session.
 *
 * SECURITY: credentials are NEVER read, logged, or forwarded. Only the
 * *existence* of a credentials file is checked (to show configured/not-configured
 * in the UI). The login PTY is the user's own interactive terminal; NanoCode only
 * relays bytes between the browser WebSocket and the PTY — it never inspects,
 * stores, or transmits credential contents.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import pty from 'node-pty'
import { TEAMS, TEAM_DIRS, TEAM_KEYS, readActiveTeam } from '../terminal/team-env.js'

const HOME = homedir()

// Credential file names whose *existence* (never contents) indicates a team is
// logged in. Mirrors the monitor plugin's list.
const CREDENTIALS_FILE_NAMES = ['.credentials.json', 'credentials.json']

/**
 * A team is "configured" when its config dir exists and contains a credentials
 * file. The file contents are never inspected.
 */
export function isTeamConfigured(configDir) {
  if (!configDir || !existsSync(configDir)) return false
  return CREDENTIALS_FILE_NAMES.some((name) => existsSync(join(configDir, name)))
}

/**
 * Build the team status snapshot for the UI.
 *
 * @param {{ getSetting?: (key: string) => any }} store
 * @returns {{ teams: Array<{key,name,configured,active}>, activeTeam: string }}
 */
export function getTeamStatus(store) {
  const activeTeam = readActiveTeam(store)
  const teams = TEAMS.map((t) => ({
    key: t.key,
    name: t.name,
    configDir: t.configDir,
    configured: isTeamConfigured(t.configDir),
    active: t.key === activeTeam,
  }))
  return { teams, activeTeam }
}

/**
 * Validate a team key against the whitelist. Returns the key or throws.
 */
function requireValidTeam(team) {
  if (!TEAM_KEYS.includes(team)) {
    const err = new Error(`invalid team: ${team}`)
    err.code = 'INVALID_TEAM'
    return err
  }
  return null
}

/**
 * Register the team-management HTTP routes on an Express app.
 *
 * @param {import('express').Application} app
 * @param {object} store
 * @param {Function} [broadcastNotify]  (payload) => void — pushes to /ws/notify
 */
export function registerTeamRoutes(app, store, broadcastNotify) {
  app.get('/api/teams', (_req, res) => {
    res.json(getTeamStatus(store))
  })

  app.post('/api/teams/switch', (req, res) => {
    const { team } = req.body || {}
    const invalid = requireValidTeam(team)
    if (invalid) return res.status(400).json({ error: invalid.message })

    store.setSetting('nanocode_active_team', team)
    const status = getTeamStatus(store)
    // Inform connected browsers so the UI updates immediately. The actual
    // env injection happens on the next spawned claude session.
    try {
      broadcastNotify?.({ type: 'plugin:team:update', ...status })
    } catch {}
    res.json({ ok: true, ...status })
  })
}

/**
 * Extract the team key from a `/ws/team-login/:team` pathname.
 * Returns the team key or null if the path is malformed/unknown.
 */
export function parseTeamLoginPath(pathname) {
  if (!pathname) return null
  const m = pathname.match(/^\/ws\/team-login\/([A-Za-z0-9_-]+)\/?$/)
  if (!m) return null
  return TEAM_KEYS.includes(m[1]) ? m[1] : null
}

/**
 * The WebSocket URL prefix handled by team login. Used by the server's upgrade
 * handler to route the connection here.
 */
export const TEAM_LOGIN_WS_PREFIX = '/ws/team-login/'

/**
 * Should this upgrade request be handled by the team-login WS?
 */
export function isTeamLoginRequest(pathname) {
  return pathname.startsWith(TEAM_LOGIN_WS_PREFIX)
}

/**
 * Whether node-pty is importable (tests can stub this). We import it at the top
 * so the real path is exercised; tests inject a mock via the module's spawn.
 */

/**
 * Handle a team-login WebSocket: spawn an interactive `claude` PTY with the
 * team's CLAUDE_CONFIG_DIR and relay bytes between the browser and the PTY.
 *
 * The user completes the OAuth/device-code login in the browser terminal;
 * NanoCode never reads credentials — it only relays PTY bytes.
 *
 * @param {import('ws').WebSocket} ws
 * @param {object} req  Express-ish request with `.url`
 * @param {object} [opts]
 * @param {Function} [opts.spawnImpl]  pty.spawn replacement (for tests)
 */
export function handleTeamLoginWs(ws, req, opts = {}) {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const team = parseTeamLoginPath(pathname)
  if (!team) {
    try { ws.close(4000, 'invalid team') } catch {}
    return
  }

  const configDir = TEAM_DIRS[team]
  const spawnImpl = opts.spawnImpl || pty.spawn

  // Spawn claude in a login shell so PATH is sane (matches fleet-term). Set
  // CLAUDE_CONFIG_DIR so this claude instance uses the selected team's config.
  let proc
  try {
    proc = spawnImpl('bash', ['-lc', 'exec claude'], {
      name: 'xterm-256color',
      cwd: HOME || '/',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    })
  } catch (err) {
    console.warn('[team-login] spawn failed:', err?.message)
    try { ws.close(1011, 'failed to start login') } catch {}
    return
  }

  const sockets = new Set([ws])

  proc.onData((data) => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        try { socket.send(data) } catch {}
      }
    }
  })

  proc.onExit(({ exitCode }) => {
    for (const socket of sockets) {
      try { socket.close(1000, `claude exited (${exitCode})`) } catch {}
    }
  })

  // Browser → PTY: raw input, plus JSON resize messages.
  ws.on('message', (raw) => {
    let data
    if (Buffer.isBuffer(raw)) data = raw.toString('utf8')
    else if (typeof raw === 'string') data = raw
    else data = String(raw)

    if (data.startsWith('{')) {
      try {
        const msg = JSON.parse(data)
        if (msg?.type === 'resize' && typeof proc.resize === 'function') {
          try {
            proc.resize(Math.max(1, Math.floor(msg.cols || 80)), Math.max(1, Math.floor(msg.rows || 24)))
          } catch (err) {
            console.warn('[team-login] resize failed:', err?.message)
          }
          return
        }
      } catch { /* fall through to raw input */ }
    }

    try { proc.write(data) } catch (err) {
      console.warn('[team-login] write failed:', err?.message)
    }
  })

  ws.on('close', () => {
    sockets.delete(ws)
    // When nobody is watching, kill the login PTY. We do NOT kill any other
    // claude process — only this interactive login shell.
    if (sockets.size === 0) {
      try { proc.kill() } catch {}
    }
  })

  ws.on('error', () => {
    sockets.delete(ws)
    if (sockets.size === 0) {
      try { proc.kill() } catch {}
    }
  })
}
