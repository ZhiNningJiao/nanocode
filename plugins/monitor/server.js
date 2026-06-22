/**
 * Monitor plugin — server side.
 *
 * Each lane maps a Linear issue to a local worktree + tmux loop.  The plugin
 * aggregates:
 *   - Local health: git branch, minutes since last commit, tmux session life,
 *     codex_work/.failcount_<prefix>, codex_work/FLAG_<prefix>, and the last
 *     line of codex_work/loop_<prefix>.log.
 *   - Linear progress: issue state, description checkbox milestone %, sub-issue
 *     rollup %, and the latest comment.
 *   - Team health: active Claude instances per team, what they are working on,
 *     last activity, and rate-limit/usage-limit/429 signals parsed from recent
 *     Claude output logs.
 *
 * Results are pushed to the browser via the notify WebSocket as
 * `plugin:monitor:update` events.  A snapshot is also available at
 * GET /api/monitor/snapshot.
 */

import { readFileSync, existsSync, statSync, watch, mkdirSync, readdirSync, openSync, readSync, closeSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const LANES_PATH = join(__dirname, 'lanes.json')
const CONFIG_PATH = join(__dirname, 'config.json')

/**
 * Load the optional local config file (plugins/monitor/config.json).  It is
 * gitignored and must never be committed.  Values here take precedence over
 * settings stored via the host settings API so that secrets can live outside
 * the repository and outside the persisted settings store.
 *
 * The path can be overridden via `process.env.MONITOR_CONFIG_PATH` so tests
 * can run without reading the real local config or issuing network calls.
 */
export function loadLocalConfig(path = process.env.MONITOR_CONFIG_PATH || CONFIG_PATH) {
  try {
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.warn('[monitor] failed to load local config:', err.message)
    return {}
  }
}

/** Resolve the Linear API key with the documented precedence. Exported for tests. */
export function resolveLinearApiKey(localConfig, host) {
  return localConfig?.linearApiKey || host?.getSetting?.('linear_api_key') || null
}

/** Active collectors so tests can tear down the plugin without killing the process. */
const activeTimers = []
let activeWatcher = null

export function stop() {
  while (activeTimers.length) {
    const t = activeTimers.pop()
    try { clearInterval(t) } catch {}
  }
  if (activeWatcher) {
    try { activeWatcher.close() } catch {}
    activeWatcher = null
  }
}

const LINEAR_POLL_MS = 20_000
const LOCAL_POLL_MS = 5_000
const DEFAULT_FAILCOUNT_THRESHOLD = 3
const DEFAULT_GIT_STALE_MIN = 30
const DEFAULT_FLAG_STALE_MIN = 30

const HOME = homedir()
const CODE_DIR = process.env.NANOCODE_CODE_DIR || join(HOME, 'code')
const CODEX_WORK = process.env.NANOCODE_CODEX_WORK || join(HOME, 'codex_work')

/** Load the lane mapping table.  Exported so tests and tooling can read it. */
export function parseLanes(path = LANES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Compute a milestone completion % from a Linear issue description.
 * Only top-level markdown checkboxes (`- [ ]` / `- [x]`) are counted.
 * Returns null when no checkboxes are found.
 */
export function computeMilestonePercent(description) {
  if (!description) return null
  const items = description.match(/^\s*[-*]\s+\[[xX ]\]/gm) || []
  const done = items.filter((line) => /^\s*[-*]\s+\[[xX]\]/.test(line)).length
  if (items.length === 0) return null
  return Math.round((done / items.length) * 100)
}

/**
 * Derive a health emoji/level from local signals.
 * Red triggers: failcount over threshold, tmux loop dead, git stale longer than
 * the configured window, or a FLAG file older than the configured window.
 * Yellow is a warning pre-state (non-zero failcount, fresh FLAG, quiet git).
 */
export function computeHealth(local, thresholds = {}) {
  const failThreshold = thresholds.failcount ?? DEFAULT_FAILCOUNT_THRESHOLD
  const gitStale = thresholds.gitStale ?? DEFAULT_GIT_STALE_MIN
  const flagStale = thresholds.flagStale ?? DEFAULT_FLAG_STALE_MIN

  const redReasons = []
  if (local.failcount >= failThreshold) redReasons.push(`failcount ${local.failcount}`)
  if (!local.tmuxAlive) redReasons.push('loop dead')
  if (local.lastCommitMin != null && local.lastCommitMin > gitStale) {
    redReasons.push(`git stale ${Math.round(local.lastCommitMin)}m`)
  }
  if (local.flagExists && local.flagAgeMin != null && local.flagAgeMin > flagStale) {
    redReasons.push(`flag stale ${local.flagAgeMin}m`)
  }
  if (redReasons.length) return { emoji: '🔴', level: 'red', reasons: redReasons }

  const yellowReasons = []
  if (local.failcount > 0) yellowReasons.push(`failcount ${local.failcount}`)
  if (local.flagExists) yellowReasons.push('flag set')
  if (local.lastCommitMin != null && local.lastCommitMin > 10) {
    yellowReasons.push(`git quiet ${Math.round(local.lastCommitMin)}m`)
  }
  if (yellowReasons.length) return { emoji: '🟡', level: 'yellow', reasons: yellowReasons }

  return { emoji: '🟢', level: 'green', reasons: [] }
}

// ── Teams -------------------------------------------------------------------

/**
 * Two Claude Teams are monitored:
 *   - Team1 uses the default ~/.claude config (this conversation / patrol).
 *   - Team2 uses ~/.claude-team2 (Opus assault lane).
 *
 * Credentials are never read; only their existence is checked so the UI can
 * degrade gracefully when Team2 is not logged in.
 */
const TEAMS = [
  { key: 'team1', name: 'Team1', configDir: join(HOME, '.claude') },
  { key: 'team2', name: 'Team2', configDir: join(HOME, '.claude-team2') },
]

const CREDENTIALS_FILE_NAMES = ['.credentials.json', 'credentials.json']
const TEAM_HISTORY_FILE = 'history.jsonl'
const TEAM_LOG_TAIL_BYTES = 16 * 1024

/**
 * A Team is considered "configured" when its config directory exists and
 * contains a credentials file.  The contents of that file are never inspected.
 */
export function isTeamConfigured(configDir) {
  if (!existsSync(configDir)) return false
  return CREDENTIALS_FILE_NAMES.some((name) => existsSync(join(configDir, name)))
}

/**
 * Decide whether a ps line belongs to Team1, Team2, or is not a Claude
 * process at all.  Team2 is detected either by an explicit
 * CLAUDE_CONFIG_DIR environment value pointing at the team2 directory or by
 * the config path appearing in the command line itself.
 */
export function classifyClaudeProcess(cmdLine, envConfigDir = '') {
  if (!cmdLine || !/\bclaude\b/i.test(cmdLine)) return null
  if (envConfigDir && envConfigDir.includes('claude-team2')) return 'team2'
  if (/claude-team2/.test(cmdLine)) return 'team2'
  return 'team1'
}

/**
 * Parse raw `ps -eo pid,comm,etimes,args` output into structured records.
 * The header line is ignored automatically because it does not start with a
 * numeric PID.
 */
export function parsePsLines(output) {
  if (!output) return []
  const lines = output.split('\n')
  const records = []
  const lineRe = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/
  for (const line of lines) {
    const m = line.match(lineRe)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const comm = m[2]
    const etimes = parseInt(m[3], 10)
    const args = m[4].trim()
    records.push({ pid, comm, etimes, args })
  }
  return records
}

function parseEnviron(buf) {
  const map = {}
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
    for (const entry of text.split('\0')) {
      const idx = entry.indexOf('=')
      if (idx > 0) map[entry.slice(0, idx)] = entry.slice(idx + 1)
    }
  } catch {}
  return map
}

function readProcessCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

function readProcessEnviron(pid) {
  try {
    return readFileSync(`/proc/${pid}/environ`)
  } catch {
    return null
  }
}

/**
 * Enumerate live Claude processes and classify each into a team.
 * Only the process command name (`comm`) is used to decide whether the record
 * is a Claude instance; wrappers like `bash -lc claude` are excluded.
 */
async function listClaudeProcesses() {
  let stdout = ''
  try {
    const result = await execFileAsync('ps', ['-eo', 'pid,comm,etimes,args'], { timeout: 5000 })
    stdout = result.stdout || ''
  } catch (err) {
    console.warn('[monitor] ps failed:', err?.message)
    return []
  }

  const records = parsePsLines(stdout)
  const processes = []
  for (const rec of records) {
    if (!/claude/i.test(rec.comm)) continue
    const env = parseEnviron(readProcessEnviron(rec.pid))
    const cwd = readProcessCwd(rec.pid)
    const team = classifyClaudeProcess(rec.args, env.CLAUDE_CONFIG_DIR || '')
    if (!team) continue
    processes.push({
      pid: rec.pid,
      team,
      cwd,
      cmdLine: rec.args,
      lastActivity: Date.now() - rec.etimes * 1000,
    })
  }
  return processes
}

function truncate(str, n = 70) {
  const s = String(str ?? '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

function summarizeProcess(proc) {
  const cwdName = proc.cwd ? basename(proc.cwd) : ''
  // Strip the full binary path and the common skip-permissions noise so the
  // summary fits on one line.
  const args = proc.cmdLine
    .replace(/^\S+\//, '')
    .replace(/\s*--allow-dangerously-skip-permissions/g, '')
    .replace(/\s*--dangerously-skip-permissions/g, '')
    .trim()
  const summary = truncate(args, 80)
  return cwdName ? `${cwdName}: ${summary}` : summary
}

function summarizeTeamProcesses(processes) {
  if (!processes.length) return 'idle'
  const items = processes.slice(0, 2).map(summarizeProcess)
  if (processes.length > 2) items.push(`+${processes.length - 2} more`)
  return items.join('; ')
}

/**
 * Read the tail of a file without loading it entirely.  Used for recent-log
 * scanning so large history files do not slow the collector down.
 */
function readTail(path, maxBytes) {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    if (start >= size) return ''
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Search recent text for rate-limit/usage-limit/429 signals and any
 * accompanying reset time.  Only the derived status and reset timestamp are
 * returned; the raw log content is never forwarded to the browser.
 */
export function parseRateLimitSignals(text) {
  if (!text) return { limited: false, resetAt: null, reason: null }
  const haystack = text.split('\n').slice(-80).join('\n')

  let reason = null
  if (/429|too many requests/i.test(haystack)) reason = '429'
  else if (/usage[ _-]limit/i.test(haystack)) reason = 'usage limit'
  else if (/rate[ _-]limit/i.test(haystack)) reason = 'rate limit'
  else if (/throttled/i.test(haystack)) reason = 'throttled'

  if (!reason) return { limited: false, resetAt: null, reason: null }

  let resetAt = null
  const iso = haystack.match(
    /reset[s]?\s*(?:at|in)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  )
  if (iso) {
    resetAt = new Date(iso[1]).toISOString()
  } else {
    const clock = haystack.match(/reset[s]?\s*(?:at)?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i)
    if (clock) {
      const today = new Date().toISOString().slice(0, 10)
      resetAt = new Date(`${today}T${clock[1]}`).toISOString()
    } else {
      const minutes = haystack.match(/reset[s]?\s*(?:in)?\s*(\d+)\s*(?:minutes?|mins?|m)\b/i)
      if (minutes) {
        resetAt = new Date(Date.now() + parseInt(minutes[1], 10) * 60000).toISOString()
      }
    }
  }

  return { limited: true, resetAt, reason }
}

/**
 * Scan the most recently modified log/history file inside a team's config
 * directory for rate-limit signals.  Credentials files are never read.
 */
async function scanTeamRateLimit(configDir) {
  const candidates = []
  try {
    const entries = readdirSync(configDir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isFile()) continue
      if (CREDENTIALS_FILE_NAMES.includes(ent.name)) continue
      if (ent.name.endsWith('.log') || ent.name === TEAM_HISTORY_FILE) {
        candidates.push(join(configDir, ent.name))
      }
    }
  } catch {
    return { limited: false, resetAt: null, reason: null }
  }

  if (!candidates.length) return { limited: false, resetAt: null, reason: null }

  let latest = null
  let latestMtime = 0
  for (const p of candidates) {
    try {
      const st = statSync(p)
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs
        latest = p
      }
    } catch {}
  }
  if (!latest) return { limited: false, resetAt: null, reason: null }

  const tail = readTail(latest, TEAM_LOG_TAIL_BYTES)
  return parseRateLimitSignals(tail)
}

/**
 * Derive the quota health emoji/level for a team.  Rate-limit/usage-limit/429
 * signals map to yellow; normal operation is green.  No invented percentages
 * are computed.
 */
export function computeTeamHealth(rate, activeCount) {
  if (rate?.limited) {
    return { emoji: '🟡', level: 'yellow', reason: rate.reason || 'limited' }
  }
  return { emoji: '🟢', level: 'green', reason: activeCount > 0 ? 'active' : 'idle' }
}

/**
 * Collect the two-team snapshot.  Credentials are never read; only their
 * existence, process presence, and recent non-credential log output are used.
 */
async function collectTeams() {
  const processes = await listClaudeProcesses()
  const byTeam = new Map(TEAMS.map((t) => [t.key, []]))
  for (const proc of processes) {
    byTeam.get(proc.team)?.push(proc)
  }

  return Promise.all(
    TEAMS.map(async (team) => {
      const procs = byTeam.get(team.key) || []
      const configured = isTeamConfigured(team.configDir)
      const rate = configured ? await scanTeamRateLimit(team.configDir) : { limited: false, resetAt: null, reason: null }
      const health = computeTeamHealth(rate, procs.length)
      const lastActivity = procs.length ? Math.max(...procs.map((p) => p.lastActivity)) : null

      return {
        key: team.key,
        name: team.name,
        configDir: team.configDir,
        configured,
        activeCount: procs.length,
        what: configured ? summarizeTeamProcesses(procs) : 'Team2 未配置',
        lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
        rateLimit: { ...rate, emoji: health.emoji, level: health.level, reason: health.reason },
      }
    }),
  )
}

export function register(host) {
  // The Linear API key can be supplied in two ways, in order of precedence:
  //   1. plugins/monitor/config.json (gitignored local file, never committed)
  //   2. The 'linear_api_key' setting registered below (set through the UI)
  // If neither is present, Linear-side collection gracefully degrades to null
  // and the panel still shows local worktree health.  The key is never
  // hardcoded in source, never sent to Linear as part of any query body beyond
  // the Authorization header, and never written into Linear comments.
  host.registerSetting({
    key: 'linear_api_key',
    type: 'secret',
    default: '',
    label: 'Linear API key',
  })
  host.registerSetting({
    key: 'monitor_failcount_threshold',
    type: 'number',
    default: DEFAULT_FAILCOUNT_THRESHOLD,
    label: 'Failcount red threshold',
  })
  host.registerSetting({
    key: 'monitor_git_stale_minutes',
    type: 'number',
    default: DEFAULT_GIT_STALE_MIN,
    label: 'Git stale red threshold (min)',
  })
  host.registerSetting({
    key: 'monitor_flag_stale_minutes',
    type: 'number',
    default: DEFAULT_FLAG_STALE_MIN,
    label: 'FLAG stale red threshold (min)',
  })

  let lanes
  try {
    lanes = parseLanes()
  } catch (err) {
    console.warn('[monitor] failed to load lanes.json:', err.message)
    return
  }
  if (!lanes.length) {
    console.warn('[monitor] no lanes configured')
    return
  }

  const linearCache = new Map()
  let linearTimer = null

  const lastAggregate = {
    lanes: lanes.map((lane) => ({
      key: lane.key,
      issue: lane.issue,
      tmux: lane.tmux,
      linearUrl: `https://linear.app/meshy/issue/${lane.issue}`,
      local: {
        branch: 'unknown',
        lastCommitMin: null,
        tmuxAlive: false,
        failcount: 0,
        flagExists: false,
        flagAgeMin: null,
        lastLog: '',
      },
      linear: null,
      health: { emoji: '🟢', level: 'green', reasons: [] },
    })),
    teams: [],
    generatedAt: Date.now(),
  }

  function resolveWorktree(wt) {
    return isAbsolute(wt) ? wt : join(CODE_DIR, wt)
  }

  function failcountPath(prefix) {
    return join(CODEX_WORK, `.failcount_${prefix}`)
  }

  function flagPath(prefix) {
    return join(CODEX_WORK, `FLAG_${prefix}`)
  }

  function logPath(prefix) {
    return join(CODEX_WORK, `loop_${prefix}.log`)
  }

  function readLastLine(path) {
    try {
      if (!existsSync(path)) return ''
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      return lines[lines.length - 1] || ''
    } catch {
      return ''
    }
  }

  async function collectLocal(lane) {
    const wt = resolveWorktree(lane.worktree)
    let branch = 'unknown'
    let lastCommitMin = null
    let tmuxAlive = false
    let failcount = 0
    let flagExists = false
    let flagAgeMin = null

    try {
      branch = (await execFileAsync('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 })).stdout.trim()
    } catch { /* worktree may not exist */ }

    try {
      const ts = parseInt(
        (await execFileAsync('git', ['-C', wt, 'log', '-1', '--format=%ct'], { timeout: 2000 })).stdout.trim(),
        10,
      )
      if (ts) lastCommitMin = (Date.now() / 1000 - ts) / 60
    } catch { /* not a repo or no commits */ }

    try {
      await execFileAsync('tmux', ['has-session', '-t', lane.tmux], { timeout: 2000 })
      tmuxAlive = true
    } catch { /* tmux session not running */ }

    const fp = failcountPath(lane.markerPrefix)
    if (existsSync(fp)) {
      try {
        const v = parseInt(readFileSync(fp, 'utf8').trim(), 10)
        if (!Number.isNaN(v)) failcount = v
      } catch { /* ignore unreadable marker */ }
    }

    const fl = flagPath(lane.markerPrefix)
    if (existsSync(fl)) {
      flagExists = true
      try {
        flagAgeMin = Math.floor((Date.now() - statSync(fl).mtimeMs) / 60000)
      } catch { /* ignore unreadable marker */ }
    }

    return {
      branch,
      lastCommitMin,
      tmuxAlive,
      failcount,
      flagExists,
      flagAgeMin,
      lastLog: readLastLine(logPath(lane.markerPrefix)),
    }
  }

  const LINEAR_QUERY = `
    query ($team: String!, $number: Float!) {
      issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }) {
        nodes {
          id
          identifier
          title
          state { name color }
          description
          children { nodes { identifier state { name color } } }
          comments(last: 1) { nodes { body createdAt user { displayName } } }
        }
      }
    }
  `

  /**
   * Parse a Linear identifier like "MES-13256" into { team, number }.
   * Returns null if the identifier does not match the expected TEAM-NUMBER shape.
   */
  function parseLinearIdentifier(identifier) {
    const m = String(identifier || '').match(/^([A-Za-z]+)-(\d+)$/)
    if (!m) return null
    return { team: m[1], number: parseInt(m[2], 10) }
  }

  const localConfig = loadLocalConfig()

  async function fetchLinear(lane) {
    // API key resolution order: 1) local gitignored config file, 2) host
    // setting (set through the settings UI), 3) no key → gracefully degrade.
    const apiKey = resolveLinearApiKey(localConfig, host)
    if (!apiKey) return null

    const parsed = parseLinearIdentifier(lane.issue)
    if (!parsed) {
      console.warn(`[monitor] invalid Linear identifier: ${lane.issue}`)
      return null
    }

    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: apiKey,
        },
        body: JSON.stringify({ query: LINEAR_QUERY, variables: parsed }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const issue = json?.data?.issues?.nodes?.[0]
      if (!issue) return null

      const milestone = computeMilestonePercent(issue.description)
      const sub = issue.children?.nodes || []
      const completed = sub.filter((s) => {
        const name = s.state?.name?.toLowerCase() || ''
        return name === 'done' || name === 'canceled'
      }).length
      const rollup = sub.length ? Math.round((completed / sub.length) * 100) : null
      const latestComment = issue.comments?.nodes?.[0]

      const data = {
        title: issue.title,
        stateName: issue.state?.name || 'Unknown',
        stateColor: issue.state?.color || '#888888',
        milestonePercent: milestone,
        rollupPercent: rollup,
        subIssueCount: sub.length,
        completedSubIssueCount: completed,
        latestComment: latestComment
          ? {
              body: latestComment.body,
              createdAt: latestComment.createdAt,
              author: latestComment.user?.displayName || 'Unknown',
            }
          : null,
      }
      linearCache.set(lane.issue, data)
      return data
    } catch (err) {
      console.warn(`[monitor] Linear fetch failed for ${lane.issue}:`, err.message)
      return linearCache.get(lane.issue) || null
    }
  }

  function readThresholds() {
    return {
      failcount: host.getSetting('monitor_failcount_threshold') ?? DEFAULT_FAILCOUNT_THRESHOLD,
      gitStale: host.getSetting('monitor_git_stale_minutes') ?? DEFAULT_GIT_STALE_MIN,
      flagStale: host.getSetting('monitor_flag_stale_minutes') ?? DEFAULT_FLAG_STALE_MIN,
    }
  }

  async function refreshLocal() {
    const locals = await Promise.all(lanes.map(collectLocal))
    const thresholds = readThresholds()
    for (let i = 0; i < lastAggregate.lanes.length; i++) {
      lastAggregate.lanes[i].local = locals[i]
      lastAggregate.lanes[i].health = computeHealth(locals[i], thresholds)
    }
    lastAggregate.teams = await collectTeams()
    lastAggregate.generatedAt = Date.now()
    broadcast()
  }

  async function refreshLinear() {
    for (const lane of lastAggregate.lanes) {
      lane.linear = await fetchLinear(lane)
    }
    lastAggregate.generatedAt = Date.now()
    broadcast()
  }

  function broadcast() {
    try {
      host.broadcastNotify({ type: 'plugin:monitor:update', ...lastAggregate })
    } catch {}
  }

  // Routes ------------------------------------------------------------------

  host.registerRoute('get', '/monitor/snapshot', (_req, res) => {
    res.json(lastAggregate)
  })

  host.registerRoute('post', '/monitor/tmux-focus', async (req, res) => {
    const { target } = req.body || {}
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ error: 'target required' })
    }
    try {
      if (process.env.TMUX) {
        // Already inside tmux: switch the attached client to the target session.
        await execFileAsync('tmux', ['switch-client', '-t', target], { timeout: 3000 })
      } else {
        // Best-effort attach when no tmux client is active in this process.
        await execFileAsync('tmux', ['attach', '-t', target], { timeout: 3000 })
      }
      res.json({ ok: true, target })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  // Start collectors ---------------------------------------------------------

  if (!existsSync(CODEX_WORK)) {
    try { mkdirSync(CODEX_WORK, { recursive: true }) } catch {}
  }

  try {
    // fs.watch on the codex_work directory gives near-instant local marker
    // updates without polling every file.  We watch non-recursively because all
    // lane markers live at the top level of codex_work.
    activeWatcher = watch(CODEX_WORK, { recursive: false }, () => refreshLocal())
    activeWatcher.on('error', (err) => {
      console.warn('[monitor] fs.watch error:', err?.message || err)
    })
  } catch (err) {
    console.warn('[monitor] fs.watch failed:', err.message)
  }

  refreshLocal().then(() => {
    refreshLinear()
    linearTimer = setInterval(refreshLinear, LINEAR_POLL_MS)
    activeTimers.push(linearTimer)
  })
  activeTimers.push(setInterval(refreshLocal, LOCAL_POLL_MS))

  console.log(`[monitor] watching ${lanes.length} lanes + ${TEAMS.length} teams`)
}
