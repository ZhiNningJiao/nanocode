/**
 * Historian — nanocode plugin backend (per HISTORIAN_WAKER.md v4).
 *
 * Full-sweep data collector: reads loop logs, tmux panes, FLAG/FAILSIG files,
 * and port health to produce structured briefings. Read-only: never modifies
 * anything outside its own state/log.
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

/**
 * Full sweep: collect state of all running tasks, tmux sessions, ports, signals.
 * Returns a structured briefing object (no side effects).
 */
export async function collectBriefing(opts = {}) {
  const now = new Date()
  const [loops, signals, tmuxPanes, ports] = await Promise.all([
    scanLoopLogs(),
    scanSignals(),
    captureTmuxPanes(),
    checkPorts(opts.ports || [9475, 9476, 9477, 9481]),
  ])

  const stalled = loops.filter(l => l.ageMinutes > 25)

  return {
    time: now.toISOString(),
    timeShort: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
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
        // Read last 500 bytes for the tail line
        const content = await readFile(fp, 'utf8')
        const lines = content.trimEnd().split('\n')
        const lastLine = lines[lines.length - 1] || ''
        const tag = f.replace(/^loop_/, '').replace(/\.log$/, '')
        // Try to extract iteration count from content
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
 * Quick TCP port check.
 */
async function checkPorts(portList) {
  const results = {}
  for (const port of portList) {
    try {
      const resp = await fetchWithTimeout(`http://127.0.0.1:${port}/api/health`, 2000)
      results[port] = resp.ok ? 'up' : 'down'
    } catch {
      results[port] = 'down'
    }
  }
  return results
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Format a human-readable briefing string (matches waker_core.py output format).
 */
function formatBriefing({ loops, stalled, signals, tmuxPanes, ports, timeShort }) {
  const parts = [`[historian ${timeShort}]`]

  // New signals
  const newSigs = []
  if (signals.flags.length) newSigs.push(...signals.flags.map(f => `FLAG_${f}`))
  if (signals.failsigs.length) newSigs.push(...signals.failsigs.map(f => `FAILSIG_${f}`))
  if (newSigs.length) parts.push(`signals: ${newSigs.join(', ')}`)

  // Stalled warnings
  if (stalled.length) {
    parts.push(`stalled(>25m): ${stalled.map(s => s.tag).join(', ')}`)
  }

  // Running tasks
  if (loops.length) {
    parts.push(`running(${loops.length}):`)
    for (const l of loops) {
      const iterStr = l.iter != null ? `|iter${l.iter}` : ''
      const stallMark = l.stalled ? ' STALL' : ''
      parts.push(`  ${l.tag}(${l.ageMinutes}m${iterStr})${stallMark} ${l.lastLine}`)
    }
  }

  // tmux
  if (tmuxPanes.length) {
    parts.push(`tmux: ${tmuxPanes.map(p => p.session).join(' ')}`)
  }

  // ports
  const portStr = Object.entries(ports).map(([p, s]) => `${p}${s === 'up' ? '\u2713' : '\u2717'}`).join(' ')
  if (portStr) parts.push(`ports: ${portStr}`)

  return parts.join('\n')
}
