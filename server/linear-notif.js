/**
 * Linear → ntfy notification bridge.
 *
 * Background polling (no webhook) so the internal nanocode box never needs to be
 * exposed to Linear Cloud.  Watches configured Linear issues, remembers the last
 * seen comments and state per issue, and pushes ntfy notifications for new
 * comments or state changes.
 *
 * Security:
 *   - Linear API key lives only in plugins/monitor/config.json (gitignored) or
 *     the host 'linear_api_key' setting, exactly like plugins/monitor.
 *   - ntfy URL/topic is read server-side from the store and never logged.
 *   - No key or ntfy config is ever sent to the browser or written to Linear.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { pushNtfy, isRecentImportantPush } from './qa-watcher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LANES_PATH = join(__dirname, '..', 'plugins', 'monitor', 'lanes.json')
const CONFIG_PATH = join(__dirname, '..', 'plugins', 'monitor', 'config.json')
const STATE_PATH = join(__dirname, '..', 'data', 'linear-notif-state.json')

const DEFAULT_POLL_MINUTES = 5
const HOME = homedir()
const CODE_DIR = process.env.NANOCODE_CODE_DIR || join(HOME, 'code')

let _store = null
let _timer = null
let _running = false

export function stopLinearNotifier() {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
  _running = false
}

function loadLocalConfig(path = CONFIG_PATH) {
  try {
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.warn('[linear-notif] failed to load local config:', err.message)
    return {}
  }
}

function resolveLinearApiKey() {
  const local = loadLocalConfig()
  const fromFile = local?.linearApiKey || null
  const fromStore = _store?.getSetting?.('linear_api_key') || null
  return fromFile || fromStore || null
}

function getPollMinutes() {
  const raw = _store?.getSetting?.('linear_poll_minutes')
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : DEFAULT_POLL_MINUTES
}

function parseLanes(path = LANES_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.warn('[linear-notif] failed to read lanes:', err.message)
    return []
  }
}

function parseLinearIdentifier(identifier) {
  const m = String(identifier || '').match(/^([A-Za-z]+)-(\d+)$/)
  if (!m) return null
  return { team: m[1], number: parseInt(m[2], 10) }
}

function atomicWriteJson(path, obj) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)
}

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { issues: {}, initializedAt: Date.now() }
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch (err) {
    console.warn('[linear-notif] failed to load state:', err.message)
    return { issues: {}, initializedAt: Date.now() }
  }
}

function saveState(state) {
  try {
    atomicWriteJson(STATE_PATH, state)
  } catch (err) {
    console.warn('[linear-notif] failed to save state:', err.message)
  }
}

const LINEAR_QUERY = `
  query ($team: String!, $number: Float!) {
    issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }) {
      nodes {
        id
        identifier
        title
        url
        state { name color }
        comments(last: 20) {
          nodes { id body createdAt user { displayName } }
        }
      }
    }
  }
`

async function fetchLinearIssue(parsed) {
  const apiKey = resolveLinearApiKey()
  if (!apiKey) return null
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query: LINEAR_QUERY, variables: parsed }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json?.data?.issues?.nodes?.[0] || null
}

function stripMarkdown(body) {
  return String(body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(str, n = 120) {
  const s = String(str || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

async function pushCommentNotification(issue, comment) {
  const author = comment.user?.displayName || 'Someone'
  const body = truncate(stripMarkdown(comment.body))
  // Skip re-notifying a comment that the B endpoint just pushed as important.
  if (isRecentImportantPush(issue.identifier, comment.body)) {
    console.log(`[linear-notif] skipping duplicate of important B push for ${issue.identifier}`)
    return
  }
  await pushNtfy({
    title: `Linear ${issue.identifier}`,
    message: `${author}: ${body}`,
    priority: 3,
    tags: ['linear', 'speech_balloon'],
  })
}

async function pushStateNotification(issue, oldState, newState) {
  await pushNtfy({
    title: `Linear ${issue.identifier}`,
    message: `状态 ${oldState} → ${newState}`,
    priority: 3,
    tags: ['linear', 'arrows_counterclockwise'],
  })
}

async function pollIssue(identifier, state) {
  const parsed = parseLinearIdentifier(identifier)
  if (!parsed) {
    console.warn(`[linear-notif] invalid identifier: ${identifier}`)
    return
  }

  let issue
  try {
    issue = await fetchLinearIssue(parsed)
  } catch (err) {
    console.warn(`[linear-notif] fetch failed ${identifier}:`, err.message)
    return
  }
  if (!issue) return

  const issueState = state.issues[identifier] || {
    commentIds: [],
    lastState: null,
    firstSeen: true,
  }

  const comments = issue.comments?.nodes || []
  const newComments = comments.filter((c) => !issueState.commentIds.includes(c.id))

  // On the very first poll for an issue we only record state, we do NOT push,
  // otherwise restarting the server would spam every historical comment.
  if (!issueState.firstSeen) {
    for (const comment of newComments) {
      await pushCommentNotification(issue, comment)
    }
    if (issueState.lastState && issueState.lastState !== issue.state?.name) {
      await pushStateNotification(issue, issueState.lastState, issue.state?.name)
    }
  }

  issueState.commentIds = comments.map((c) => c.id)
  issueState.lastState = issue.state?.name || issueState.lastState
  issueState.firstSeen = false
  issueState.polledAt = Date.now()
  state.issues[identifier] = issueState
}

export async function runLinearPoll() {
  const apiKey = resolveLinearApiKey()
  if (!apiKey) {
    console.log('[linear-notif] no Linear API key configured, skipping poll')
    return { polled: false, reason: 'no linear api key' }
  }

  const lanes = parseLanes()
  if (!lanes.length) {
    console.log('[linear-notif] no lanes configured, skipping poll')
    return { polled: false, reason: 'no lanes' }
  }

  const state = loadState()
  for (const lane of lanes) {
    await pollIssue(lane.issue, state)
  }
  saveState(state)
  console.log(`[linear-notif] polled ${lanes.length} issue(s)`)
  return { polled: true, count: lanes.length }
}

/**
 * Push a harmless test notification so the owner can verify the ntfy channel
 * and server reachability before enabling real Linear alerts.
 */
export async function pushNtfyTest() {
  const result = await pushNtfy({
    title: 'nanocode',
    message: 'ntfy 通道测试：服务端可连',
    priority: 3,
    tags: ['robot', 'white_check_mark'],
  })
  return { pushed: result.ok, error: result.ok ? undefined : result.error }
}

export function startLinearNotifier({ store }) {
  if (_running) return
  _running = true
  _store = store

  // One immediate poll, then recurring every N minutes.
  runLinearPoll().catch((err) => console.warn('[linear-notif] initial poll failed:', err.message))

  const ms = getPollMinutes() * 60_000
  _timer = setInterval(() => {
    runLinearPoll().catch((err) => console.warn('[linear-notif] poll failed:', err.message))
  }, ms)

  console.log(`[linear-notif] started, polling every ${ms / 60000} minute(s)`)
}
