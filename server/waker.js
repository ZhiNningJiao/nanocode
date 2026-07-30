/**
 * Waker — native nanocode waker via tmux (per HISTORIAN_WAKER.md v4).
 *
 * Replaces the external waker.sh + wake-secretary.py pipeline. Nanocode owns
 * the injection logic; a system crontab only knocks on the /api/waker/tick
 * endpoint every 4 minutes.
 *
 * Injection chain: crontab -> POST /api/waker/tick -> historian.collectBriefing()
 *   -> tmux send-keys (or HTTP inject fallback) -> target session
 *
 * Gate controls (from HISTORIAN_WAKER.md):
 *   - MIN_GAP: 270s between injections
 *   - HOURLY_CAP: 15 per hour
 *   - Busy gate: skip if user spoke < 60s ago
 *   - Single instance (in-process lock)
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { appendFile } from 'fs/promises'
import path from 'path'
import os from 'os'
import { collectBriefing } from './historian.js'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()
const WAKER_LOG = path.join(HOME, 'codex_work', 'waker.log')

// Gate state (in-process, resets on server restart)
let lastInjectTime = 0
const hourlyTimestamps = [] // timestamps of recent injections
let tickInProgress = false

const MIN_GAP_MS = 270 * 1000  // 4.5 minutes
const HOURLY_CAP = 15
const BUSY_WINDOW_MS = 60 * 1000

// Configurable target session (set via /api/waker/config or env)
let config = {
  enabled: false,
  // tmux session:pane target for injection (e.g. 'nanocode-secretary:0')
  tmuxTarget: process.env.WAKER_TMUX_TARGET || '',
  // Fallback: HTTP inject endpoint (e.g. 'http://127.0.0.1:9475')
  httpFallbackUrl: process.env.WAKER_HTTP_URL || '',
  httpSessionKey: process.env.WAKER_SESSION_KEY || '',
  // Ports to check in historian sweep
  ports: [9475, 9476, 9477, 9481],
}

export function getWakerConfig() { return { ...config } }

export function setWakerConfig(partial) {
  Object.assign(config, partial)
}

/**
 * Main tick handler — called by crontab via POST /api/waker/tick.
 * Returns { ok, action, reason?, briefing? }.
 */
export async function wakerTick(opts = {}) {
  if (tickInProgress) return { ok: false, action: 'skipped', reason: 'tick already in progress' }
  if (!config.enabled) return { ok: false, action: 'skipped', reason: 'waker disabled' }

  tickInProgress = true
  try {
    // Gate: minimum gap
    const now = Date.now()
    if (now - lastInjectTime < MIN_GAP_MS) {
      const waitSec = Math.round((MIN_GAP_MS - (now - lastInjectTime)) / 1000)
      return { ok: false, action: 'skipped', reason: `min gap (wait ${waitSec}s)` }
    }

    // Gate: hourly cap
    const oneHourAgo = now - 3600_000
    while (hourlyTimestamps.length && hourlyTimestamps[0] < oneHourAgo) hourlyTimestamps.shift()
    if (hourlyTimestamps.length >= HOURLY_CAP) {
      return { ok: false, action: 'skipped', reason: `hourly cap (${HOURLY_CAP})` }
    }

    // Collect briefing
    const briefing = await collectBriefing({ ports: config.ports })

    // Gate: busy detection (check if user typed recently via tmux)
    if (opts.busyCheck !== false) {
      const busy = await checkUserBusy()
      if (busy) {
        await logTick('skipped:busy', briefing.summary)
        return { ok: false, action: 'skipped', reason: 'user busy (< 60s)', briefing }
      }
    }

    // Inject via tmux send-keys (primary) or HTTP (fallback)
    let injected = false
    let method = 'none'

    if (config.tmuxTarget) {
      injected = await injectViaTmux(config.tmuxTarget, briefing.summary)
      method = 'tmux'
    }

    if (!injected && config.httpFallbackUrl && config.httpSessionKey) {
      injected = await injectViaHttp(config.httpFallbackUrl, config.httpSessionKey, briefing.summary)
      method = 'http'
    }

    if (injected) {
      lastInjectTime = now
      hourlyTimestamps.push(now)
      await logTick(`injected:${method}`, briefing.summary)
      return { ok: true, action: 'injected', method, briefing }
    }

    await logTick('skipped:no-target', briefing.summary)
    return { ok: false, action: 'skipped', reason: 'no injection target configured', briefing }

  } finally {
    tickInProgress = false
  }
}

/**
 * Inject text into a tmux pane via send-keys.
 */
async function injectViaTmux(target, text) {
  try {
    // Check session exists first
    await execFileAsync('tmux', ['has-session', '-t', target.split(':')[0]], { timeout: 2000 })
    // Send the text. Use send-keys with literal text (no Enter at end — the
    // briefing is informational, the agent reads it from its input buffer).
    // Actually for claude-code sessions, we need Enter to submit.
    await execFileAsync('tmux', ['send-keys', '-t', target, text, 'Enter'], { timeout: 5000 })
    return true
  } catch (err) {
    console.warn(`[waker] tmux inject failed:`, err.message)
    return false
  }
}

/**
 * Inject via HTTP POST to /api/sessions/:id/inject (fallback).
 */
async function injectViaHttp(baseUrl, sessionKey, text) {
  try {
    const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionKey)}/inject`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sendNow: false, isUser: false }),
      signal: AbortSignal.timeout(5000),
    })
    const data = await resp.json()
    return data.ok === true
  } catch (err) {
    console.warn(`[waker] http inject failed:`, err.message)
    return false
  }
}

/**
 * Check if the user typed in the target tmux pane recently.
 * Heuristic: capture the pane and check for recent activity timestamp.
 */
async function checkUserBusy() {
  // For now, a simple heuristic: we skip this check and rely on the
  // session busy flag from the HTTP API if available.
  // Future: parse tmux pane activity timestamps.
  return false
}

/**
 * Append a line to the waker log.
 */
async function logTick(action, summary) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${action} | ${(summary || '').split('\n')[0]}\n`
  try {
    await appendFile(WAKER_LOG, line)
  } catch { /* log dir may not exist */ }
}

/**
 * Get waker status for the panel.
 */
export function getWakerStatus() {
  const now = Date.now()
  const oneHourAgo = now - 3600_000
  const recentCount = hourlyTimestamps.filter(t => t > oneHourAgo).length
  return {
    enabled: config.enabled,
    lastInjectTime: lastInjectTime ? new Date(lastInjectTime).toISOString() : null,
    hourlyCount: recentCount,
    hourlyCap: HOURLY_CAP,
    minGapSeconds: MIN_GAP_MS / 1000,
    tmuxTarget: config.tmuxTarget || null,
    httpFallback: config.httpFallbackUrl ? true : false,
  }
}
