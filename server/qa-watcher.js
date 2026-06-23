/**
 * Signal watchers using fs.watchFile (poll-based, works on CephFS/NFS).
 *   qa-signal.json   → notify reviewer tmux pane + WS broadcast + ntfy push
 *   done-signal.json → append [DONE_SIGNAL] to agent-status.md + WS broadcast + ntfy push
 *   {repo}/evidence.md → aggregate latest entry to activity-feed.json + WS broadcast
 */

import { watchFile, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'
import path from 'node:path'

// ─── ntfy push notification ──────────────────────────────────────────────────

let _ntfyStore = null

/** Called by server/index.js after the store is initialized. */
export function setNtfyStore(store) {
  _ntfyStore = store
}

function getNtfyConfig() {
  if (!_ntfyStore) return null
  const url = _ntfyStore.getSetting('ntfy_url')
  const topic = _ntfyStore.getSetting('ntfy_topic')
  if (!url || !topic) return null
  return { url, topic }
}

export function isNtfyConfigured() {
  return getNtfyConfig() !== null
}

/**
 * POST a push notification to ntfy.
 * See https://docs.ntfy.sh/publish/ for header spec.
 *
 * Exported so the Linear notification bridge can reuse the same server-side
 * push path while keeping ntfy URL/topic out of callers and logs.
 *
 * Returns { ok: true } on success or { ok: false, error: string } on failure so
 * callers (e.g. the ntfy test endpoint) can report reachability without logging
 * the ntfy URL or topic.
 */
// HTTP headers must be Latin-1 (ByteString).  ntfy Title/Tags headers crash
// with "Cannot convert argument to a ByteString" if they contain CJK or other
// code points > 255.  Sanitize to ASCII-safe strings so the push never throws
// regardless of what a caller passes in.
function sanitizeHeader(str) {
  return String(str || '').replace(/[^\x20-\x7E]/g, '').trim() || 'notification'
}

export async function pushNtfy({ title, message, priority = 3, tags = [] }) {
  const cfg = getNtfyConfig()
  if (!cfg) return { ok: false, reason: 'not-configured', error: 'ntfy not configured' }
  const endpoint = cfg.url.replace(/\/$/, '') + '/' + cfg.topic
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Title': sanitizeHeader(title),
        'Priority': String(priority),
        'Tags': sanitizeHeader(tags.join(',')),
        'Content-Type': 'text/plain',
      },
      body: message,
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) {
      console.warn(`[ntfy] push non-OK: HTTP ${resp.status}`)
      return { ok: false, reason: `HTTP ${resp.status}`, error: `HTTP ${resp.status}` }
    }
    console.log(`[ntfy] sent: ${title}`)
    return { ok: true }
  } catch (err) {
    console.warn('[ntfy] push failed:', err.message)
    return { ok: false, reason: err.message, error: err.message }
  }
}

const HOME = homedir()
const CODE_DIR = path.join(HOME, 'code')
const QA_SIGNAL_PATH = path.join(CODE_DIR, 'qa-signal.json')
const DONE_SIGNAL_PATH = path.join(CODE_DIR, 'done-signal.json')
const ACTIVITY_FEED_PATH = path.join(CODE_DIR, 'activity-feed.json')
const AGENT_STATUS_PATH = path.join(CODE_DIR, 'agent-status.md')

const WATCHED_REPOS = ['mblend', 'meshy-dcc-pipeline', 'muse-webapp', 'nanocode']
const ACTIVITY_MAX = 100
const POLL_INTERVAL_MS = 2000

// Per-file line counters for JSONL signal files
const lineCounters = { qa: 0, done: 0 }

// ─── helpers ────────────────────────────────────────────────────────────────

function readNewJsonlEntries(filePath, counterKey) {
  try {
    if (!existsSync(filePath)) return []
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const newLines = lines.slice(lineCounters[counterKey])
    lineCounters[counterKey] = lines.length
    return newLines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {
    return []
  }
}

function tmux(target, message) {
  exec(`tmux send-keys -t ${target} "${message}" Enter`, (err) => {
    if (err) console.warn(`[watcher] tmux ${target}:`, err.message)
    else console.log(`[watcher] tmux → ${target}: ${message}`)
  })
}

// ─── QA signal ──────────────────────────────────────────────────────────────

function handleQaEntries(broadcast) {
  const entries = readNewJsonlEntries(QA_SIGNAL_PATH, 'qa')
  for (const entry of entries) {
    if (entry.status === 'blocked') {
      console.log('[watcher] blocked signal:', entry.repo, entry.task, entry.reason || '')
      tmux('watchdog:nanocode', `有 agent blocked 了：[${entry.repo}] ${entry.task} — ${entry.reason || ''}`)
      const blockedMsg = {
        type: 'blocked_notify',
        repo: entry.repo,
        task: entry.task,
        reason: entry.reason || '',
        summary: entry.summary || '',
        time: entry.time,
      }
      broadcast(blockedMsg)
      pushNtfy({
        title: `[BLOCKED] ${entry.repo}`,
        message: `${entry.task}${entry.reason ? ' — ' + entry.reason : ''}`,
        priority: 4,
        tags: ['warning', 'robot'],
      })
    } else {
      console.log('[watcher] QA signal:', entry.repo, entry.task)
      tmux('watchdog:reviewer', '新 QA 到了，读 TODO')
      const qaMsg = {
        type: 'qa_notify',
        repo: entry.repo,
        task: entry.task,
        summary: entry.summary || '',
        time: entry.time,
      }
      broadcast(qaMsg)
      pushNtfy({
        title: `[QA] ${entry.repo}`,
        message: `${entry.task}${entry.summary ? ' — ' + entry.summary.slice(0, 100) : ''}`,
        priority: 3,
        tags: ['white_check_mark', 'robot'],
      })
    }
  }
}

// ─── Done signal ─────────────────────────────────────────────────────────────

function handleDoneEntries(broadcast) {
  const entries = readNewJsonlEntries(DONE_SIGNAL_PATH, 'done')
  for (const entry of entries) {
    console.log('[watcher] done signal:', entry.repo, entry.task)
    try {
      const line = `[DONE_SIGNAL] ${new Date().toISOString().slice(0, 16)} | ${entry.repo}: ${entry.task} — ${entry.reviewer || 'PASS'}\n`
      appendFileSync(AGENT_STATUS_PATH, line)
    } catch (e) {
      console.warn('[watcher] agent-status write:', e.message)
    }
    const doneMsg = {
      type: 'done_notify',
      repo: entry.repo,
      task: entry.task,
      reviewer: entry.reviewer || 'PASS',
      time: entry.time,
    }
    broadcast(doneMsg)
    pushNtfy({
      title: `[DONE] ${entry.repo}`,
      message: `${entry.task} (reviewer: ${entry.reviewer || 'PASS'})`,
      priority: 3,
      tags: ['tada', 'robot'],
    })
  }
}

// ─── Evidence aggregation ────────────────────────────────────────────────────

function extractLastEvidence(content) {
  const sections = content.split(/^## /m).filter(Boolean)
  if (!sections.length) return null
  const last = sections[sections.length - 1]
  const lines = last.split('\n')
  const heading = lines[0].trim()
  const body = lines.slice(1).join('\n').trim()
  return { heading, content: body.slice(0, 400) }
}

function appendActivityFeed(entry) {
  try {
    let feed = []
    if (existsSync(ACTIVITY_FEED_PATH)) {
      const raw = readFileSync(ACTIVITY_FEED_PATH, 'utf-8').trim()
      if (raw) feed = JSON.parse(raw)
    }
    feed.push(entry)
    if (feed.length > ACTIVITY_MAX) feed = feed.slice(feed.length - ACTIVITY_MAX)
    writeFileSync(ACTIVITY_FEED_PATH, JSON.stringify(feed, null, 2))
  } catch (e) {
    console.warn('[watcher] activity-feed write:', e.message)
  }
}

function handleEvidenceChange(repo, broadcast) {
  const filePath = path.join(CODE_DIR, repo, 'evidence.md')
  try {
    if (!existsSync(filePath)) return
    const content = readFileSync(filePath, 'utf-8')
    const ev = extractLastEvidence(content)
    if (!ev) return
    const time = new Date().toISOString()
    appendActivityFeed({ time, repo, type: 'evidence', heading: ev.heading, content: ev.content })
    console.log(`[watcher] evidence updated: ${repo} — ${ev.heading.slice(0, 60)}`)
    broadcast({ type: 'activity', repo, heading: ev.heading, time })
  } catch (e) {
    console.warn('[watcher] evidence read:', e.message)
  }
}

// ─── Linear important-post ntfy ─────────────────────────────────────────────

const IMPORTANT_KEYWORDS = [
  // 过审 / 通过 / PASS
  /\bpass\b/i, /\bapproved?\b/i, /过审/, /通过/, /验收通过/,
  // 卡点 / 阻塞 / blocker
  /\bblocker\b/i, /\bblocked\b/i, /卡点/, /阻塞/, /堵住/,
  // 需主人拍板 / 决策
  /\bneeds? (?:your|owner|manual|human) (?:approval|review|decision)\b/i,
  /\brequires? (?:your|owner|manual|human) (?:approval|review|decision)\b/i,
  /需主人拍板/, /需要主人/, /主人确认/, /等待决策/,
]

// Keep a short in-memory record of important pushes so the background Linear
// poller (C) does not re-notify the same comment that B just pushed.
const RECENT_IMPORTANT_TTL_MS = 10 * 60 * 1000
const recentImportantPushes = new Map()

function recordImportantPush(identifier, summary) {
  recentImportantPushes.set(identifier, { summary: String(summary || ''), at: Date.now() })
}

/**
 * Return true if `body` looks like a comment that was just pushed as important
 * by the B endpoint.  This is a lightweight B/C cross-dedup guard; the C path
 * still relies on persisted comment IDs for its primary deduplication.
 */
export function isRecentImportantPush(identifier, body) {
  const rec = recentImportantPushes.get(identifier)
  if (!rec) return false
  if (Date.now() - rec.at > RECENT_IMPORTANT_TTL_MS) {
    recentImportantPushes.delete(identifier)
    return false
  }
  if (!body || typeof body !== 'string') return false
  return body.toLowerCase().includes(rec.summary.toLowerCase())
}

/**
 * Decide whether a Linear comment summary counts as "important" enough to
 * interrupt the owner immediately.  Only PASS/blocker/owner-decision posts
 * are pushed; routine progress chatter is silently ignored.
 */
export function classifyLinearImportance(text) {
  if (!text || typeof text !== 'string') return { important: false, reason: null }
  for (const re of IMPORTANT_KEYWORDS) {
    if (re.test(text)) {
      const match = text.match(re)?.[0] || 'keyword'
      return { important: true, reason: match }
    }
  }
  return { important: false, reason: null }
}

/**
 * Push an ntfy notification for an important Linear post.
 * Called by /api/notify/linear-important (server-side only) when an AI agent
 * posts a comment that needs the owner's attention.
 */
export async function pushNtfyLinearImportant({ identifier, summary, reason, priority = 4 }) {
  const classification = reason
    ? { important: true, reason }
    : classifyLinearImportance(summary)
  if (!classification.important) {
    console.log(`[linear-notif] suppressed routine post ${identifier}: ${summary?.slice(0, 60) || ''}`)
    return { pushed: false, reason: 'not important' }
  }
  // Remember this important post so the background Linear poller can skip
  // re-notifying the same comment a few minutes later.
  recordImportantPush(identifier, summary)
  const pushResult = await pushNtfy({
    title: `Linear ${identifier}`,
    message: `${summary?.slice(0, 120) || 'important update'}`,
    priority,
    tags: ['linear', 'warning'],
  })
  return {
    pushed: pushResult.ok,
    reason: classification.reason,
    error: pushResult.ok ? undefined : pushResult.error,
  }
}

// ─── Turn-complete ntfy ──────────────────────────────────────────────────────

/**
 * Push a turn-complete notification to ntfy.
 * Called by the /api/notify/turn-complete route when the frontend decides
 * a turn exceeded the user-configured threshold.
 */
export async function pushNtfyTurnComplete({ elapsedSec }) {
  await pushNtfy({
    title: 'Claude turn complete',
    message: `Turn finished after ${elapsedSec}s`,
    priority: 3,
    tags: ['bell', 'robot'],
  })
}

export async function pushNtfyMessage({ title, message, priority, tags }) {
  return pushNtfy({
    title: title || 'Nanocode',
    message: message || '',
    priority: Number.isFinite(priority) ? priority : 3,
    tags: Array.isArray(tags) ? tags : [],
  })
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function startQaWatcher(broadcast) {
  // Snapshot current line counts (don't fire for pre-existing entries)
  readNewJsonlEntries(QA_SIGNAL_PATH, 'qa')
  readNewJsonlEntries(DONE_SIGNAL_PATH, 'done')

  // Watch signal files with poll-based watchFile (works on CephFS/NFS)
  const opts = { persistent: true, interval: POLL_INTERVAL_MS }

  watchFile(QA_SIGNAL_PATH, opts, () => handleQaEntries(broadcast))
  console.log('[watcher] polling', QA_SIGNAL_PATH)

  watchFile(DONE_SIGNAL_PATH, opts, () => handleDoneEntries(broadcast))
  console.log('[watcher] polling', DONE_SIGNAL_PATH)

  for (const repo of WATCHED_REPOS) {
    const filePath = path.join(CODE_DIR, repo, 'evidence.md')
    watchFile(filePath, opts, () => handleEvidenceChange(repo, broadcast))
    console.log(`[watcher] polling ${filePath}`)
  }
}
