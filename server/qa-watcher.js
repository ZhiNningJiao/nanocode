/** Watches ~/code/qa-signal.json and notifies reviewer tmux pane + WS clients */

import { watch, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'
import path from 'node:path'

const QA_SIGNAL_PATH = path.join(homedir(), 'code', 'qa-signal.json')
const TMUX_TARGET = 'watchdog:reviewer'

let lastLineCount = 0

function readNewEntries() {
  try {
    if (!existsSync(QA_SIGNAL_PATH)) return []
    const content = readFileSync(QA_SIGNAL_PATH, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const newLines = lines.slice(lastLineCount)
    lastLineCount = lines.length
    return newLines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {
    return []
  }
}

function notifyReviewer(entry) {
  exec(`tmux send-keys -t ${TMUX_TARGET} "新 QA 到了，读 TODO" Enter`, (err) => {
    if (err) console.warn('[qa-watcher] tmux:', err.message)
    else console.log('[qa-watcher] notified reviewer:', entry.repo, entry.task)
  })
}

export function startQaWatcher(broadcast) {
  // Record current line count without triggering notifications for old entries
  readNewEntries()

  const dir = path.dirname(QA_SIGNAL_PATH)
  if (!existsSync(dir)) {
    console.warn('[qa-watcher] directory not found:', dir)
    return
  }

  watch(dir, (eventType, filename) => {
    if (filename !== 'qa-signal.json') return
    const entries = readNewEntries()
    for (const entry of entries) {
      console.log('[qa-watcher] new QA signal:', JSON.stringify(entry))
      notifyReviewer(entry)
      broadcast({ type: 'qa_notify', repo: entry.repo, task: entry.task, time: entry.time })
    }
  })

  console.log('[qa-watcher] watching', QA_SIGNAL_PATH)
}
