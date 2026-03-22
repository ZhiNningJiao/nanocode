/**
 * Signal watchers for the nanocode agent coordination system:
 *   qa-signal.json   → notify reviewer tmux pane + WS broadcast
 *   done-signal.json → notify agent-status.md + WS broadcast
 *   {repo}/evidence.md → aggregate latest entry to activity-feed.json
 */

import { watch, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'
import path from 'node:path'

const HOME = homedir()
const CODE_DIR = path.join(HOME, 'code')
const QA_SIGNAL_PATH = path.join(CODE_DIR, 'qa-signal.json')
const DONE_SIGNAL_PATH = path.join(CODE_DIR, 'done-signal.json')
const ACTIVITY_FEED_PATH = path.join(CODE_DIR, 'activity-feed.json')
const AGENT_STATUS_PATH = path.join(CODE_DIR, 'agent-status.md')

const WATCHED_REPOS = ['mblend', 'meshy-dcc-pipeline', 'muse-webapp', 'nanocode']
const ACTIVITY_MAX = 100

// Per-file line counters for JSONL signal files
const lineCounters = { qa: 0, done: 0 }

// Per-repo mtime for evidence.md debounce
const evidenceMtimes = {}

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
    console.log('[watcher] QA signal:', entry.repo, entry.task)
    tmux('watchdog:reviewer', '新 QA 到了，读 TODO')
    broadcast({
      type: 'qa_notify',
      repo: entry.repo,
      task: entry.task,
      summary: entry.summary || '',
      time: entry.time,
    })
  }
}

// ─── Done signal ─────────────────────────────────────────────────────────────

function handleDoneEntries(broadcast) {
  const entries = readNewJsonlEntries(DONE_SIGNAL_PATH, 'done')
  for (const entry of entries) {
    console.log('[watcher] done signal:', entry.repo, entry.task)

    // Write DONE_SIGNAL line to agent-status.md so agents see it on next read
    try {
      const line = `[DONE_SIGNAL] ${new Date().toISOString().slice(0, 16)} | ${entry.repo}: ${entry.task} — ${entry.reviewer || 'PASS'}\n`
      appendFileSync(AGENT_STATUS_PATH, line)
    } catch (e) {
      console.warn('[watcher] agent-status write:', e.message)
    }

    broadcast({
      type: 'done_notify',
      repo: entry.repo,
      task: entry.task,
      reviewer: entry.reviewer || 'PASS',
      time: entry.time,
    })
  }
}

// ─── Evidence aggregation ────────────────────────────────────────────────────

function extractLastEvidence(content) {
  // Find the last ## section
  const sections = content.split(/^## /m).filter(Boolean)
  if (!sections.length) return null
  const last = sections[sections.length - 1]
  // First line is the heading, rest is body
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
    const feedEntry = { time, repo, type: 'evidence', heading: ev.heading, content: ev.content }
    appendActivityFeed(feedEntry)
    console.log(`[watcher] evidence updated: ${repo} — ${ev.heading.slice(0, 60)}`)

    broadcast({ type: 'activity', repo, heading: ev.heading, time })
  } catch (e) {
    console.warn('[watcher] evidence read:', e.message)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function startQaWatcher(broadcast) {
  if (!existsSync(CODE_DIR)) {
    console.warn('[watcher] ~/code not found, skipping')
    return
  }

  // Snapshot current line counts (don't fire for pre-existing entries)
  readNewJsonlEntries(QA_SIGNAL_PATH, 'qa')
  readNewJsonlEntries(DONE_SIGNAL_PATH, 'done')

  // Watch ~/code/ directory for qa-signal.json and done-signal.json
  watch(CODE_DIR, (eventType, filename) => {
    if (filename === 'qa-signal.json') handleQaEntries(broadcast)
    else if (filename === 'done-signal.json') handleDoneEntries(broadcast)
  })
  console.log('[watcher] watching', CODE_DIR, '(qa-signal / done-signal)')

  // Watch each repo's evidence.md
  for (const repo of WATCHED_REPOS) {
    const repoDir = path.join(CODE_DIR, repo)
    if (!existsSync(repoDir)) continue
    watch(repoDir, (eventType, filename) => {
      if (filename !== 'evidence.md') return
      // Simple debounce: skip if same mtime within 2s
      const now = Date.now()
      if (evidenceMtimes[repo] && now - evidenceMtimes[repo] < 2000) return
      evidenceMtimes[repo] = now
      handleEvidenceChange(repo, broadcast)
    })
    console.log(`[watcher] watching ${repoDir}/evidence.md`)
  }
}
