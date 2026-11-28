// A private tmux server for tests. The driver only ever runs `$NANOCODE_TMUX_BIN
// <args>`; this writes a wrapper that pins every call to `-S <private socket>`
// (with $TMUX unset — when $TMUX is set, TMUX_TMPDIR/-L do not isolate) and
// swaps the real bridge script for tmux-stub-bridge.mjs. Nothing here can
// reach the tmux server the test runner itself may be running inside.
//
// Lifetime: the private tmux server daemonizes (PPID 1), so nothing reaps it
// if the test process ends without reaching killServer (killed by an outer
// timeout; a before() that fails, which makes node 18 skip after(); an after()
// that throws or hangs first). Every stub bridge
// started through the wrapper is therefore handed the test process's pid
// (--owner-pid) and exits once that process is gone; with its last session
// gone the tmux server exits too (owner-watch.mjs; tmux-isolated-owner.test.js
// checks it).
import { spawnSync } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pidAlive } from './owner-watch.mjs'

export const STUB_BRIDGE = fileURLToPath(new URL('./tmux-stub-bridge.mjs', import.meta.url))
const REAL_TMUX = '/usr/bin/tmux'

export function tmuxInstalled() {
  return existsSync(REAL_TMUX) && spawnSync(REAL_TMUX, ['-V'], { stdio: 'ignore' }).status === 0
}

export function createIsolatedTmux(dir) {
  const socket = join(dir, 'tmux.sock')
  const bin = join(dir, 'tmux-wrapper.sh')
  const callLog = join(dir, 'tmux-calls.log') // "<client HOME>\t<args>" per call
  writeFileSync(bin, `#!/bin/bash
args=()
for a in "$@"; do
  case "$a" in */claude-tmux-bridge.mjs|${JSON.stringify(STUB_BRIDGE)}) args+=(${JSON.stringify(STUB_BRIDGE)} --owner-pid ${process.pid}) ;; *) args+=("$a") ;; esac
done
printf '%s\t%s\n' "$HOME" "$*" >> ${JSON.stringify(callLog)}
exec env -u TMUX ${REAL_TMUX} -S ${JSON.stringify(socket)} "\${args[@]}"
`, { mode: 0o755 })
  const run = (...args) => spawnSync(bin, args, { encoding: 'utf8' })
  return {
    socket,
    bin,
    run,
    /** [{ home, args }] for every tmux client call made through the wrapper. */
    calls: () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [home, args] = l.split('\t'); return { home, args } }) : []),
    /** Start a session running the stub bridge on `socketPath` (a pre-existing session). */
    startBridge(name, socketPath, sessionId) {
      const r = run('new-session', '-d', '-s', name, process.execPath, STUB_BRIDGE, '--socket', socketPath, '--session-id', sessionId)
      if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
    },
    panePid(name) {
      const r = run('display-message', '-p', '-t', name, '#{pane_pid}')
      return r.status === 0 ? Number(r.stdout.trim()) : null
    },
    killServer() { run('kill-server') },
  }
}

/** The tmux server this process runs inside ($TMUX = "<socket>,<pid>,<session>") is still alive. */
export function outerTmuxAlive() {
  if (!process.env.TMUX) return true
  return pidAlive(Number(process.env.TMUX.split(',')[1]))
}
