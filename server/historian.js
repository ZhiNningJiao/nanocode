/**
 * Historian — nanocode plugin backend (per HISTORIAN_WAKER.md v4).
 *
 * Full-sweep data collector: reads army_status.json, loop logs, tmux panes,
 * FLAG/FAILSIG files, waker.log tail, and port health to produce structured
 * data for the historian panel. Read-only: never modifies anything outside
 * its own scope.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()
const CODEX_WORK = path.join(HOME, 'codex_work')
const WAKER_LOG = path.join(CODEX_WORK, 'waker.log')
const WAKER_STATE_DIR = path.join(CODEX_WORK, '.waker')
const ARMY_STATUS_JSON = path.join(CODEX_WORK, 'army_status.json')

/**
 * Read ~/codex_work/army_status.json — the waker writes this every tick.
 * Returns parsed array or null on failure.
 */
export async function readArmyStatus() {
  try {
    const raw = await readFile(ARMY_STATUS_JSON, 'utf8')
    const data = JSON.parse(raw)
    const st = await stat(ARMY_STATUS_JSON)
    return { agents: Array.isArray(data) ? data : [], updatedAt: st.mtimeMs }
  } catch {
    return { agents: [], updatedAt: null }
  }
}

/**
 * Read the last N lines of waker.log for the briefing stream.
 */
export async function readWakerLogTail(lines = 30) {
  try {
    const content = await readFile(WAKER_LOG, 'utf8')
    const allLines = content.trimEnd().split('\n')
    return allLines.slice(-lines)
  } catch {
    return []
  }
}

/**
 * Get waker process health: tmux session alive, singleton lock, last tick time.
 */
export async function getWakerHealth() {
  const result = {
    tmuxAlive: false,
    singletonLock: false,
    lastTickTime: null,
    lastTickAgeSeconds: null,
    mode: 'unknown', // 'live' | 'dry' | 'unknown'
    autoLive: false,
    stats: null,
  }

  // Check tmux session 'waker'
  try {
    await execFileAsync('tmux', ['has-session', '-t', 'waker'], { timeout: 2000 })
    result.tmuxAlive = true
  } catch { /* not running */ }

  // Check singleton lock
  try {
    await stat(path.join(WAKER_STATE_DIR, 'singleton.lock'))
    result.singletonLock = true
  } catch { /* no lock */ }

  // Check auto_live flag
  try {
    const al = await readFile(path.join(WAKER_STATE_DIR, 'auto_live'), 'utf8')
    result.autoLive = al.trim() === '1' || al.trim() === 'true'
  } catch { /* no file */ }

  // Determine mode from inject logs
  try {
    const liveSt = await stat(path.join(WAKER_STATE_DIR, 'inject_live.log'))
    const drySt = await stat(path.join(WAKER_STATE_DIR, 'inject_dry.log')).catch(() => null)
    if (drySt && drySt.mtimeMs > liveSt.mtimeMs) {
      result.mode = 'dry'
    } else {
      result.mode = 'live'
    }
    result.lastTickTime = liveSt.mtimeMs
    result.lastTickAgeSeconds = Math.round((Date.now() - liveSt.mtimeMs) / 1000)
  } catch {
    try {
      const drySt = await stat(path.join(WAKER_STATE_DIR, 'inject_dry.log'))
      result.mode = 'dry'
      result.lastTickTime = drySt.mtimeMs
      result.lastTickAgeSeconds = Math.round((Date.now() - drySt.mtimeMs) / 1000)
    } catch { /* no inject logs at all */ }
  }

  // Read stats if available — parse JSON for structured display
  try {
    const statsRaw = await readFile(path.join(WAKER_STATE_DIR, 'stats'), 'utf8')
    try {
      result.stats = JSON.parse(statsRaw.trim())
    } catch {
      result.stats = statsRaw.trim()
    }
  } catch { /* ok */ }

  // Read coverage (list of active agent tags the waker covers)
  try {
    const covRaw = await readFile(path.join(WAKER_STATE_DIR, 'coverage'), 'utf8')
    try {
      result.coverage = JSON.parse(covRaw.trim())
    } catch {
      result.coverage = covRaw.trim()
    }
  } catch { /* ok */ }

  // Read dry_count (number of dry ticks before auto-promote)
  try {
    const dcRaw = await readFile(path.join(WAKER_STATE_DIR, 'dry_count'), 'utf8')
    result.dryCount = parseInt(dcRaw.trim(), 10) || 0
  } catch { /* ok */ }

  // Read inject count (total successful injections)
  try {
    const icRaw = await readFile(path.join(WAKER_STATE_DIR, 'inject_count'), 'utf8')
    result.injectCount = parseInt(icRaw.trim(), 10) || 0
  } catch { /* ok */ }

  // Read gate stats (min_gap, hourly_cap, busy skip counts)
  try {
    const gateRaw = await readFile(path.join(WAKER_STATE_DIR, 'gate_stats'), 'utf8')
    try {
      result.gateStats = JSON.parse(gateRaw.trim())
    } catch {
      result.gateStats = gateRaw.trim()
    }
  } catch { /* ok */ }

  // Read current interval override from .waker_env
  try {
    const envContent = await readFile(path.join(HOME, 'code', '.waker_env'), 'utf8')
    const workMatch = envContent.match(/WAKE_WORK_INTERVAL=(\d+)/)
    const offMatch = envContent.match(/WAKE_OFF_INTERVAL=(\d+)/)
    if (workMatch) {
      const interval = parseInt(workMatch[1], 10)
      result.currentInterval = interval
      result.intervalLabel = interval === 270 ? 'day' : interval === 1200 ? 'night' : `${interval}s`
    } else {
      result.currentInterval = 0
      result.intervalLabel = 'auto'
    }
    if (offMatch) result.offInterval = parseInt(offMatch[1], 10)
  } catch {
    result.currentInterval = 0
    result.intervalLabel = 'auto'
  }

  return result
}

/**
 * Full sweep: collect state of all running tasks, tmux sessions, ports, signals.
 * Returns a structured briefing object (no side effects).
 */
export async function collectBriefing(opts = {}) {
  const now = new Date()
  const [army, loops, signals, tmuxPanes, ports] = await Promise.all([
    readArmyStatus(),
    scanLoopLogs(),
    scanSignals(),
    captureTmuxPanes(),
    checkPorts(opts.ports || [9475, 9476, 9477, 9481]),
  ])

  const stalled = loops.filter(l => l.ageMinutes > 25)

  return {
    time: now.toISOString(),
    timeShort: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    army,
    loops,
    stalled,
    signals,
    tmuxPanes,
    ports,
    summary: formatBriefing({ loops, stalled, signals, tmuxPanes, ports, timeShort: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` }),
  }
}

/**
 * Scan ~/codex_work/loop_*.log files for running task state.
 */
async function scanLoopLogs() {
  const results = []
  try {
    const files = await readdir(CODEX_WORK)
    const loopFiles = files.filter(f => f.startsWith('loop_') && f.endsWith('.log'))
    for (const f of loopFiles) {
      const fp = path.join(CODEX_WORK, f)
      try {
        const st = await stat(fp)
        const ageMs = Date.now() - st.mtimeMs
        const ageMinutes = Math.round(ageMs / 60000)
        const content = await readFile(fp, 'utf8')
        const lines = content.trimEnd().split('\n')
        const lastLine = lines[lines.length - 1] || ''
        const tag = f.replace(/^loop_/, '').replace(/\.log$/, '')
        const iterMatch = content.match(/iter(?:ation)?\s*[:=]?\s*(\d+)/i)
        const iter = iterMatch ? parseInt(iterMatch[1], 10) : null
        results.push({ tag, file: f, lastLine: lastLine.slice(0, 120), ageMinutes, iter, stalled: ageMinutes > 25 })
      } catch { /* skip unreadable */ }
    }
  } catch { /* codex_work may not exist */ }
  return results
}

/**
 * Scan ~/codex_work for FLAG_* and FAILSIG_* files.
 */
async function scanSignals() {
  const flags = []
  const failsigs = []
  try {
    const files = await readdir(CODEX_WORK)
    for (const f of files) {
      if (f.startsWith('FLAG_')) flags.push(f.replace('FLAG_', ''))
      if (f.startsWith('FAILSIG_')) failsigs.push(f.replace('FAILSIG_', ''))
    }
  } catch { /* ok */ }
  return { flags, failsigs }
}

/**
 * Capture last 3 lines from each tmux pane.
 */
async function captureTmuxPanes() {
  const panes = []
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 3000 })
    const sessions = stdout.trim().split('\n').filter(Boolean)
    for (const sess of sessions) {
      try {
        const { stdout: paneOut } = await execFileAsync(
          'tmux', ['capture-pane', '-t', sess, '-p', '-S', '-3'],
          { timeout: 2000 }
        )
        panes.push({ session: sess, lastLines: paneOut.trim() })
      } catch { /* pane may not exist */ }
    }
  } catch { /* tmux not running */ }
  return panes
}

/**
 * Quick HTTP port check.
 */
async function checkPorts(portList) {
  const results = {}
  for (const port of portList) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
        results[port] = resp.ok ? 'up' : 'down'
      } finally {
        clearTimeout(timer)
      }
    } catch {
      results[port] = 'down'
    }
  }
  return results
}

/**
 * Format a human-readable briefing string (matches waker_core.py output format).
 */
function formatBriefing({ loops, stalled, signals, tmuxPanes, ports, timeShort }) {
  const parts = [`[historian ${timeShort}]`]

  const newSigs = []
  if (signals.flags.length) newSigs.push(...signals.flags.map(f => `FLAG_${f}`))
  if (signals.failsigs.length) newSigs.push(...signals.failsigs.map(f => `FAILSIG_${f}`))
  if (newSigs.length) parts.push(`signals: ${newSigs.join(', ')}`)

  if (stalled.length) {
    parts.push(`stalled(>25m): ${stalled.map(s => s.tag).join(', ')}`)
  }

  if (loops.length) {
    parts.push(`running(${loops.length}):`)
    for (const l of loops) {
      const iterStr = l.iter != null ? `|iter${l.iter}` : ''
      const stallMark = l.stalled ? ' STALL' : ''
      parts.push(`  ${l.tag}(${l.ageMinutes}m${iterStr})${stallMark} ${l.lastLine}`)
    }
  }

  if (tmuxPanes.length) {
    parts.push(`tmux: ${tmuxPanes.map(p => p.session).join(' ')}`)
  }

  const portStr = Object.entries(ports).map(([p, s]) => `${p}${s === 'up' ? '\u2713' : '\u2717'}`).join(' ')
  if (portStr) parts.push(`ports: ${portStr}`)

  return parts.join('\n')
}
