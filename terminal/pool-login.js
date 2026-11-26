/**
 * One-click pool login (nanologin_2250) — owner ask: "nanocode 也最好有一键
 * 登录跳转 okta 的功能". Replaces the manual flow where a secretary starts
 * `claude auth login --sso` in a PTY by hand and the owner pastes the
 * authorization code back over chat (~/.config/claude-oauth/setup_token_run.py,
 * t3_sso_login_wait.py — read as reference, never imported: those scripts
 * drive `claude setup-token` / a single hardcoded pool, this drives any pool
 * through one shared state machine).
 *
 * Pure state machine + process IO, no express/HTTP here (layering: the HTTP
 * route in server/pool-login-routes.js only parses/calls/responds) — unit
 * tests inject a fake PTY/execFile and never spawn a real `claude` process.
 *
 * Secrets discipline: the owner's email, the pasted auth code and any
 * token/credential value are never logged and never appear in a returned
 * status object. The PTY's output is kept in a capped in-memory buffer only
 * (never written to a file) and is discarded once the auth link has been
 * found in it.
 */
import pty from 'node-pty'
import { execFile, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { timedFs } from './bounded-scan.js'
import { listTeamsAsync, readClaudeOAuthCredentials } from './usage.js'

export const VERIFY_MODEL = 'claude-haiku-4-5-20251001'
export const VERIFY_PROMPT = 'Reply with exactly one short word to prove you are alive.'

export const URL_WAIT_MS = 90_000 // CLI start -> auth link appears
export const CODE_WAIT_MS = 10 * 60_000 // auth link shown -> owner pastes a code back
export const AFTER_CODE_MS = 60_000 // code submitted -> CLI accepts/rejects it
export const VERIFY_TIMEOUT_MS = 30_000
const PTY_BUF_CAP = 16_000 // rolling chars kept in memory; plenty for one auth link + prompt text

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g
const AUTH_URL_RE = /https:\/\/[^\s"'<>]*(?:claude\.com\/(?:cai\/)?oauth\/authorize|okta)[^\s"'<>]*/i
const PASTE_HINT_RE = /paste[^.\n]{0,24}(?:code|here)/i
const SUCCESS_RE = /login successful|logged in successfully|successfully authenticated/i
const FAIL_RE = /invalid code|code (?:is|has) expired|login failed|authentication failed/i

const IN_FLIGHT_STATES = new Set(['starting', 'awaiting_code', 'submitting', 'verifying'])

/** ".claude" -> "T1", ".claude-team4" -> "T4" (same convention command-center-quota.js reads off usage_snap.log). */
export function poolLabel(teamId) {
  if (teamId === 'team1') return 'T1'
  const m = /^team(\d+)$/.exec(teamId || '')
  return m ? `T${m[1]}` : teamId
}

/** The owner's email from this machine's own git config — never hardcoded, never stored in the repo. */
export function resolveOwnerEmail({ exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }) } = {}) {
  try {
    const out = exec('git', ['config', '--global', 'user.email']).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * Every team pool nanocode already knows about (terminal/usage.js), existing
 * dirs only. Deduped by id: on a host where both `~/.claude` and a literal
 * `~/.claude-team1` exist, terminal/usage.js's own composeTeamList() hands
 * back two distinct directories that both resolve to id "team1" (one
 * hardcoded, one regex-derived) — keeping the first occurrence matches what
 * a plain `.find(p => p.id === id)` pool lookup would already pick, so a
 * start()/submitCode() call can never land on the "other" directory than
 * whichever one the pool list just showed the owner.
 */
export async function discoverLoginPools({ home = homedir(), store = null, listTeams = listTeamsAsync } = {}) {
  const { teams } = await listTeams(home, store)
  const seen = new Set()
  const out = []
  for (const t of teams || []) {
    if (!t.exists || seen.has(t.id)) continue
    seen.add(t.id)
    out.push({ id: t.id, label: poolLabel(t.id), name: t.name, configDir: t.path })
  }
  return out
}

/** Interactive OAuth credential present for this pool? (boolean only — the token itself never leaves readClaudeOAuthCredentials.) */
export async function interactiveCredStatus(configDir) {
  return !!(await readClaudeOAuthCredentials(configDir))
}

/** Long-term token file present and non-empty for this pool label? Same judgement as seats.sh _lt_only — file size only, contents never read. */
export async function longTokenStatus(label, { oauthDir = join(homedir(), '.config', 'claude-oauth') } = {}) {
  try {
    const st = await timedFs.stat(join(oauthDir, `${label}.token`))
    return st.size > 0
  } catch {
    return false
  }
}

/** The on-duty secretary's CLAUDE_CONFIG_DIR, or null (missing/unreadable file = "unknown", never guessed). */
export async function readDutyConfigDir(dutyStatusPath) {
  try {
    const raw = await timedFs.readFile(dutyStatusPath, 'utf8')
    const d = JSON.parse(raw)
    return typeof d?.config_dir === 'string' ? d.config_dir : null
  } catch {
    return null
  }
}

/**
 * Per-pool login + token + last-real-call surface for the pool list UI.
 * `quotaByLabel`: Map<label, { ok: boolean|null, error, at }> — the command
 * center's existing quota reading (command-center-quota.js), passed in by the
 * route so this module never reads the quota cache dir a second time.
 */
export async function buildPoolLoginView({
  home = homedir(),
  dutyStatusPath,
  quotaByLabel = new Map(),
  discover = discoverLoginPools,
  credCheck = interactiveCredStatus,
  tokenCheck = longTokenStatus,
} = {}) {
  const pools = await discover({ home })
  const dutyDir = dutyStatusPath ? await readDutyConfigDir(dutyStatusPath) : null
  return Promise.all(pools.map(async (p) => {
    const [interactiveCred, longToken] = await Promise.all([credCheck(p.configDir), tokenCheck(p.label)])
    return {
      id: p.id,
      label: p.label,
      name: p.name,
      isDutyPool: !!dutyDir && dutyDir === p.configDir,
      interactiveCred,
      longToken,
      lastRealCall: quotaByLabel.get(p.label) || null,
    }
  }))
}

/**
 * The login state machine, one entry per pool id. `get()` only ever returns
 * plain JSON-safe fields (no PTY handle, no timer handles) — callers may
 * serialize it straight into an HTTP response.
 */
export function createPoolLoginDriver({
  spawnPty = (cmd, args, opts) => pty.spawn(cmd, args, opts),
  execFileImpl = execFile,
  now = () => Date.now(),
  resolveEmail = resolveOwnerEmail,
  urlWaitMs = URL_WAIT_MS,
  codeWaitMs = CODE_WAIT_MS,
  afterCodeMs = AFTER_CODE_MS,
} = {}) {
  const states = new Map() // poolId -> internal state (includes _proc/_timer, stripped by get())

  function raw(poolId) {
    return states.get(poolId) || { state: 'idle' }
  }

  function patch(poolId, fields) {
    const cur = states.get(poolId) || { state: 'idle' }
    const next = { ...cur, ...fields, updatedAt: now() }
    states.set(poolId, next)
    return next
  }

  function clearStageTimer(st) {
    if (st?._timer) clearTimeout(st._timer)
  }

  function killProc(st) {
    try { st?._proc?.kill() } catch { /* already gone */ }
  }

  // Exactly one pending stage-timeout per pool at a time: setting the next
  // stage's timer always clears whichever one came before it, so a finished
  // login never leaves a 10-minute setTimeout dangling in the event loop.
  function setStageTimer(poolId, ms, onFire) {
    clearStageTimer(raw(poolId))
    const timer = setTimeout(() => onFire(raw(poolId)), ms)
    timer.unref?.() // a pending login must never keep the nanocode process alive by itself
    patch(poolId, { _timer: timer })
  }

  function finishWithError(poolId, error) {
    const st = raw(poolId)
    clearStageTimer(st)
    killProc(st)
    patch(poolId, { state: 'error', error, _proc: null, _timer: null })
  }

  /** @returns the public (JSON-safe) status for a pool, 'idle' if never touched. */
  function get(poolId) {
    const { _proc, _timer, ...pub } = raw(poolId)
    return pub
  }

  async function start(pool) {
    const cur = raw(pool.id)
    if (IN_FLIGHT_STATES.has(cur.state)) return get(pool.id) // idempotent: already running

    const email = resolveEmail()
    if (!email) {
      patch(pool.id, { state: 'error', error: 'owner email not configured on this host (git config --global user.email is empty)', url: null, _proc: null, _timer: null })
      return get(pool.id)
    }

    let proc
    try {
      proc = spawnPty('claude', ['auth', 'login', '--claudeai', '--sso', '--email', email], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: homedir(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: pool.configDir, BROWSER: 'echo', TERM: 'xterm-256color' },
      })
    } catch (err) {
      finishWithError(pool.id, `spawn failed: ${err.message}`)
      return get(pool.id)
    }

    patch(pool.id, { state: 'starting', url: null, error: null, verify: null, startedAt: now(), _proc: proc, _timer: null })
    setStageTimer(pool.id, urlWaitMs, (s) => { if (s.state === 'starting') finishWithError(pool.id, 'timed out waiting for the auth link') })

    let buf = ''
    let urlSeen = false
    proc.onData((chunk) => {
      buf += chunk
      if (buf.length > PTY_BUF_CAP) buf = buf.slice(-PTY_BUF_CAP)
      const plain = buf.replace(ANSI_RE, '')

      if (!urlSeen) {
        const m = AUTH_URL_RE.exec(plain)
        if (m || PASTE_HINT_RE.test(plain)) {
          urlSeen = true
          patch(pool.id, { state: 'awaiting_code', url: m ? m[0] : null })
          setStageTimer(pool.id, codeWaitMs, (s) => { if (s.state === 'awaiting_code') finishWithError(pool.id, 'timed out waiting for the pasted-back code') })
        }
      }
      if (raw(pool.id).state === 'submitting') {
        if (SUCCESS_RE.test(plain)) { patch(pool.id, { state: 'verifying' }); runVerify(pool) }
        else if (FAIL_RE.test(plain)) finishWithError(pool.id, 'login rejected (bad or expired code)')
      }
    })

    proc.onExit(({ exitCode }) => {
      const s = raw(pool.id)
      clearStageTimer(s)
      if (s.state === 'submitting' && exitCode === 0) { patch(pool.id, { state: 'verifying', _proc: null, _timer: null }); runVerify(pool) }
      else if (!['done', 'error', 'verifying'].includes(s.state)) finishWithError(pool.id, `login process exited (code ${exitCode})`)
    })

    return get(pool.id)
  }

  function submitCode(poolId, code) {
    const s = raw(poolId)
    if (s.state !== 'awaiting_code') return { ok: false, error: `not awaiting a code right now (state=${s.state})` }
    const trimmed = String(code ?? '').trim()
    if (!trimmed || trimmed.length > 200) return { ok: false, error: 'bad code' }
    try {
      s._proc.write(`${trimmed}\r\n`)
    } catch (err) {
      finishWithError(poolId, `could not send the code to the login process: ${err.message}`)
      return { ok: false, error: 'login process is gone' }
    }
    patch(poolId, { state: 'submitting' })
    setStageTimer(poolId, afterCodeMs, (cur) => { if (cur.state === 'submitting') finishWithError(poolId, 'timed out after submitting the code') })
    return { ok: true }
  }

  async function runVerify(pool) {
    const verify = await verifyPool(pool.configDir, { execFileImpl })
    patch(pool.id, { state: 'done', verify, _proc: null, _timer: null })
  }

  function cancel(poolId) {
    const s = raw(poolId)
    clearStageTimer(s)
    killProc(s)
    states.delete(poolId)
  }

  return { get, start, submitCode, cancel }
}

/** One cheap, one-sentence real call through this pool's own CLAUDE_CONFIG_DIR — proves the pool is actually alive post-login. Never throws. */
export function verifyPool(configDir, { execFileImpl = execFile, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      'claude',
      ['-p', VERIFY_PROMPT, '--model', VERIFY_MODEL],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 300), at: new Date().toISOString() })
        resolve({ ok: true, reply: String(stdout || '').trim().slice(0, 300), at: new Date().toISOString() })
      },
    )
  })
}
