/**
 * Shared helpers for building the env of a spawned Claude Code process.
 *
 * Used by the CLI driver (claude-session-controller.js), the SDK driver
 * (claude-sdk-driver.js) and the tmux bridge so that the Team switch
 * (需求1) and cross-team resume (需求5) both honour CLAUDE_CONFIG_DIR no
 * matter which driver is active. Without this, only the CLI driver applied
 * the team config dir and the SDK/tmux drivers silently ignored it.
 */
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { timedFs } from './bounded-scan.js'

// Keys that identify the *nanocode server's own* Claude session. They must
// never leak into a child claude process or the child would think it is the
// server session (causing lock conflicts / wrong session-id resolution).
const STRIP_KEYS = new Set([
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_TMPDIR',
  'AI_AGENT',
])

// OAuth credentials handed to Claude Code through the environment. A token
// value in the nanocode server's own env must never reach a child, and an
// inherited fd-number var would point the child at whatever fd 3 happens to
// be. Only the long-token path below sets the fd var, and only to LONG_TOKEN_FD.
const TOKEN_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']

/** Copy of `env` without any OAuth token / token-fd variable. */
export function stripClaudeTokenEnv(env) {
  const out = { ...env }
  for (const k of TOKEN_ENV_KEYS) delete out[k]
  return out
}

/**
 * Resolve the effective CLAUDE_CONFIG_DIR for a spawn.
 *
 * A per-tab/per-session override wins (set by 需求5 cross-team resume so the
 * spawned claude reads the session's owning team), then the global store
 * setting (需求1 Team switch), then the default ~/.claude.
 *
 * Accepts either a `cs` (session-controller session) or a `tab` (store
 * metadata); both carry `claudeConfigDir` when set.
 */
export function resolveClaudeConfigDir({ cs, tab, store, home } = {}) {
  const dir = cs?.claudeConfigDir || tab?.claudeConfigDir
  if (dir && typeof dir === 'string' && dir.trim()) return dir.trim()
  const configured = store?.getSetting?.('claude_config_dir')
  if (configured && typeof configured === 'string' && configured.trim()) return configured.trim()
  return join(home || homedir(), '.claude')
}

/**
 * Build the child-process env for a spawned claude process.
 *
 * Starts from `baseEnv` (the SDK-provided env, or process.env for the CLI
 * driver), strips the nanocode-self identifiers, and sets CLAUDE_CONFIG_DIR
 * so the child reads the team the user picked (需求1) or the cross-team
 * session's owning team (需求5). When `configDir` is falsy the inherited
 * CLAUDE_CONFIG_DIR (if any) is removed so a stale server env never leaks.
 */
export function buildClaudeSpawnEnv(baseEnv, { configDir, auth } = {}) {
  const env = {}
  const src = baseEnv && typeof baseEnv === 'object' ? baseEnv : process.env
  for (const [k, v] of Object.entries(stripClaudeTokenEnv(src))) {
    if (!STRIP_KEYS.has(k)) env[k] = v
  }
  if (configDir && typeof configDir === 'string' && configDir.trim()) {
    env.CLAUDE_CONFIG_DIR = configDir.trim()
  } else {
    delete env.CLAUDE_CONFIG_DIR
  }
  if (auth?.authMode === 'long_token') env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = String(LONG_TOKEN_FD)
  return env
}

// ── Long-lived token for team-pool tabs ───────────────────────────────────
// A team pool (~/.claude-teamN) with a `claude setup-token` file T<N>.token is
// run on that token, exactly like the worker cars (run_team2_observable.sh):
// the file is opened read-only on the child's fd 3 and Claude Code is told
// CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3. The pool's interactive
// .credentials.json is then never read or refreshed by a tab — a refresh that
// fails makes Claude Code blank that file, which is how pools lost their login
// while another process was racing the same refresh token. The token value
// never enters argv, env or logs: nanocode only handles the file PATH, and the
// file is opened by the child's shell (no sync IO on the shared home mount
// inside the spawn call). Pools without a token file, and every non-pool dir
// (~/.claude), keep the interactive login. `claude auth login` (pool-login.js)
// never goes through here and always stays interactive.
export const LONG_TOKEN_FD = 3
const POOL_DIR_RE = /^\.claude-team(\d+)$/

/** Directory holding T<N>.token files (same default as the worker cars). */
export function claudeOAuthTokenDir({ env = process.env, home } = {}) {
  return env.CLAUDE_OAUTH_TOKEN_DIR || join(home || homedir(), '.config', 'claude-oauth')
}

/** Token file path for a team-pool config dir, or null when `configDir` is not ~/.claude-teamN. */
export function claudeOAuthTokenPath(configDir, { env = process.env, home } = {}) {
  const m = basename(String(configDir || '').replace(/\/+$/, '')).match(POOL_DIR_RE)
  return m ? join(claudeOAuthTokenDir({ env, home }), `T${m[1]}.token`) : null
}

/**
 * Decide which credential a claude spawned under `configDir` will use.
 * Returns { configDir, authMode: 'long_token', tokenFile }
 *      or { configDir, authMode: 'interactive', reason }.
 * Only stats the token file (never reads it). Async so a stalled home mount
 * costs a home-fs slot, not the event loop; callers resolve this before the
 * synchronous spawn hook runs.
 */
export async function resolveClaudeAuth(configDir, { env = process.env, home, statImpl = timedFs.stat } = {}) {
  const tokenFile = claudeOAuthTokenPath(configDir, { env, home })
  if (!tokenFile) return { configDir, authMode: 'interactive', reason: 'not a team pool dir (.claude-teamN)' }
  let st = null
  try { st = await statImpl(tokenFile) } catch {}
  if (st?.isFile() && st.size > 0) return { configDir, authMode: 'long_token', tokenFile }
  return { configDir, authMode: 'interactive', reason: `no long-lived token file ${tokenFile}` }
}

// The child shell opens the token file named by its $0 on fd 3; a missing or
// unreadable file fails the spawn loudly (exit 97) instead of silently falling
// back to the interactive login. The path travels as an argv word, never
// interpolated into the script, so no quoting is involved. `command` keeps a
// failed redirection from exiting the shell before `|| exit 97` (POSIX
// special-builtin rule, dash exits 2), so the failure code is stable.
const OPEN_TOKEN_FD = `command exec ${LONG_TOKEN_FD}<"$0" || exit 97; `

/**
 * Wrap a {command, args} spawn so the child gets the token file on fd 3:
 * /bin/sh opens it and execs the original command (argv of the final claude
 * process is unchanged). Interactive auth returns the spawn untouched.
 */
export function wrapSpawnForAuth({ command, args = [] }, auth) {
  if (auth?.authMode !== 'long_token') return { command, args }
  return { command: '/bin/sh', args: ['-c', `${OPEN_TOKEN_FD}exec "$@"`, auth.tokenFile, command, ...args] }
}

/** argv for `bash` running a CLI-driver launch script under `auth`. */
export function bashArgsForAuth(launchCmd, auth) {
  if (auth?.authMode !== 'long_token') return ['-lc', launchCmd]
  return ['-lc', `${OPEN_TOKEN_FD}${launchCmd}`, auth.tokenFile]
}

/**
 * Record on the tab which credential its claude process was actually spawned
 * with. Written at spawn time (not at resolve time) so the tab metadata always
 * describes the live process — ops (seat_auth_health) reads it from
 * GET /api/projects/:id/tabs. sessionKey is `<projectId>::<tabId>`.
 */
export function recordTabAuthMode(store, sessionKey, auth, { now = Date.now } = {}) {
  if (!auth?.authMode || !store?.updateTabMetadata || typeof sessionKey !== 'string') return
  const [projectId, , tabId] = sessionKey.split(':')
  if (!projectId || !tabId) return
  store.updateTabMetadata(projectId, tabId, {
    authMode: auth.authMode,
    authModeDetail: auth.authMode === 'long_token' ? auth.tokenFile : auth.reason,
    authModeAt: new Date(now()).toISOString(),
  })
}

/**
 * Resolve (async) the credential for cs's current config dir and keep it on
 * cs.claudeAuth for the synchronous spawn hook. Called at the start of every
 * turn, after anything that may move cs to another team.
 */
export async function prepareClaudeAuth(cs, { store, home, env = process.env } = {}) {
  const configDir = resolveClaudeConfigDir({ cs, store, home })
  cs.claudeAuth = await resolveClaudeAuth(configDir, { env, home })
  return cs.claudeAuth
}

/**
 * The credential a spawn under `configDir` must use. Throws when this turn did
 * not resolve one for that dir (a code path spawned without prepareClaudeAuth,
 * or the dir changed after it) — guessing here is how a seat ends up on a
 * credential nobody checked.
 */
export function claudeAuthForSpawn(cs, configDir) {
  const auth = cs?.claudeAuth
  if (!auth || auth.configDir !== configDir) {
    throw new Error(`[claude:auth] credential not resolved for ${configDir} before spawn (have ${auth?.configDir || 'none'})`)
  }
  return auth
}

/** One log line per spawn: which credential, and why interactive when it is. */
export function logClaudeAuth(prefix, sessionKey, auth, log = console.log) {
  if (auth?.authMode === 'long_token') log(`${prefix} ${sessionKey} authMode=long_token tokenFile=${auth.tokenFile}`)
  else log(`${prefix} ${sessionKey} authMode=interactive reason=${auth?.reason || 'unresolved'}`)
}
