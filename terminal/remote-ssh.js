/**
 * WebSocket handler for the SSH dev-machine terminal Tab (MES-13781).
 *
 * Reuses the existing PTY/xterm terminal infrastructure (terminal/sessions.js)
 * — the only difference from a normal bash tab is the PTY command is `ssh …`
 * (or `sshpass -e ssh …`) instead of `bash`. The browser side is an xterm.js
 * TerminalPane pointed at `/ws/remote-ssh` (see public/js/remote-panel.js).
 *
 * Flow:
 *   1. browser opens `ws://…/ws/remote-ssh`
 *   2. first message: `{ type:'attach', sshMachineId, cols, rows }`
 *   3. server loads the machine from the remote address book (store), validates
 *      it is an ssh machine, resolves the ssh command (buildSshCommand), pre-
 *      checks the key path / sshpass presence, then `sessions.getOrCreate` a
 *      PTY and `session.attach(ws)`.
 *
 * One persistent PTY per machine (`remote:ssh:<machineId>`): reconnect /
 * reopen reattaches to the same scrollback + shell, exactly like a project
 * bash tab. The PTY is torn down by sessions.destroySession when the machine is
 * deleted (wired in routes.js).
 *
 * Security: the password (if any) is carried in the SSHPASS env var, never in
 * argv; sessions.js redacts the argv from its spawn log when `redactLog` is set.
 * The key is referenced by *path* only (never read into memory / logs).
 */

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import * as sessions from './sessions.js'
import { getMachine, buildSshCommand } from './remote.js'

let _sshpassPath = undefined // null = confirmed absent, string = path, undefined = not probed yet

/** Resolve sshpass once (cached). Returns the path or null. */
export function resolveSshpass() {
  if (_sshpassPath !== undefined) return _sshpassPath
  try {
    const out = execFileSync('which', ['sshpass'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
    _sshpassPath = out || null
  } catch {
    _sshpassPath = null
  }
  return _sshpassPath
}

export function createRemoteSshHandler(store) {
  const home = homedir()

  function handleRemoteSshWs(ws) {
    const once = (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type !== 'attach') return

      const { sshMachineId, cols, rows } = msg
      if (typeof sshMachineId !== 'string' || !sshMachineId) {
        ws.send(JSON.stringify({ type: 'error', error: 'sshMachineId required' }))
        return
      }

      const machine = getMachine(store, sshMachineId)
      if (!machine) {
        ws.send(JSON.stringify({ type: 'error', error: 'machine not found' }))
        return
      }
      if (machine.type !== 'ssh') {
        ws.send(JSON.stringify({ type: 'error', error: 'not an ssh machine' }))
        return
      }

      const opts = machine.sshPassword ? { sshpassPath: resolveSshpass() } : {}
      const built = buildSshCommand(machine, opts)
      if (!built.ok) {
        ws.send(JSON.stringify({ type: 'error', error: built.error }))
        return
      }

      const sessionKey = `remote:ssh:${machine.id}`
      // Password auth → SSHPASS env + redact the argv log. Key auth → the argv
      // only carries the key *path*, safe to log but we redact anyway for parity.
      const sessOpts = {
        env: built.env && Object.keys(built.env).length ? built.env : null,
        redactLog: true,
      }
      const session = sessions.getOrCreate(
        sessionKey,
        built.command,
        built.args,
        Math.max(1, cols || 80),
        Math.max(1, rows || 24),
        home,
        undefined,
        sessOpts,
      )
      console.log(`[remote-ssh] attach machine=${machine.alias} (${machine.user}@${machine.host}:${machine.port}) session=${sessionKey} summary=${built.logSummary}`)
      session.attach(ws, Math.max(1, cols || 80), Math.max(1, rows || 24))
    }

    ws.once('message', once)
  }

  return { handleRemoteSshWs }
}
