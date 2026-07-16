/**
 * Waker control — start/stop, LIVE/DRY toggle, day/night interval switching.
 *
 * All controls operate via tmux session management and env vars — does NOT
 * reimplement the waker logic, just manages the existing waker.sh + waker_core.py.
 *
 * Red line: read-only on waker internals. Controls only modify the tmux session
 * lifecycle and environment variables that waker_core.py reads on next tick.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()
const WAKER_SH = path.join(HOME, 'code', 'waker.sh')
const WAKER_STATE_DIR = path.join(HOME, 'codex_work', '.waker')

/**
 * Start the waker tmux session. If already running, returns ok with a note.
 * @param {object} opts - { live?: boolean }
 */
export async function startWaker(opts = {}) {
  // Check if already running
  try {
    await execFileAsync('tmux', ['has-session', '-t', 'waker'], { timeout: 2000 })
    return { ok: true, action: 'already_running' }
  } catch { /* not running, proceed */ }

  const env = opts.live ? 'WAKE_LIVE=1 ' : ''
  try {
    await execFileAsync('tmux', [
      'new-session', '-d', '-s', 'waker',
      `${env}bash ${WAKER_SH}`,
    ], { timeout: 5000 })
    return { ok: true, action: 'started', live: !!opts.live }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Stop the waker tmux session.
 */
export async function stopWaker() {
  try {
    await execFileAsync('tmux', ['kill-session', '-t', 'waker'], { timeout: 5000 })
    return { ok: true, action: 'stopped' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Restart with a new mode (LIVE or DRY). Kills old session, starts fresh.
 */
export async function restartWaker(opts = {}) {
  await stopWaker()
  // Brief pause for cleanup
  await new Promise(r => setTimeout(r, 1500))
  return startWaker(opts)
}

/**
 * Set the day/night interval override. Writes to the waker state dir so
 * waker_core.py picks it up on next tick. Interval 0 = dynamic (default).
 */
export async function setInterval(intervalSeconds) {
  try {
    // The waker reads WAKE_WORK_INTERVAL and WAKE_OFF_INTERVAL env vars.
    // We write to a config file that waker.sh sources if it exists.
    const envFile = path.join(HOME, 'code', '.waker_env')
    let content = ''
    try {
      content = await readFile(envFile, 'utf8')
    } catch { /* doesn't exist yet */ }

    // Update or add the interval lines
    const lines = content.split('\n').filter(l =>
      !l.startsWith('export WAKE_WORK_INTERVAL=') &&
      !l.startsWith('export WAKE_OFF_INTERVAL=')
    )
    if (intervalSeconds > 0) {
      lines.push(`export WAKE_WORK_INTERVAL=${intervalSeconds}`)
      lines.push(`export WAKE_OFF_INTERVAL=${intervalSeconds}`)
    }
    await writeFile(envFile, lines.filter(Boolean).join('\n') + '\n')
    return { ok: true, interval: intervalSeconds || 'dynamic' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Get the current waker configuration state.
 */
export async function getWakerControlState() {
  let tmuxAlive = false
  try {
    await execFileAsync('tmux', ['has-session', '-t', 'waker'], { timeout: 2000 })
    tmuxAlive = true
  } catch { /* not running */ }

  let autoLive = false
  try {
    const al = await readFile(path.join(WAKER_STATE_DIR, 'auto_live'), 'utf8')
    autoLive = al.trim() === '1' || al.trim() === 'true'
  } catch { /* no file */ }

  return {
    tmuxAlive,
    autoLive,
    wakerShPath: WAKER_SH,
  }
}
