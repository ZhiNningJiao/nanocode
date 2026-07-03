/**
 * Shared helpers for building the env of a spawned Claude Code process.
 *
 * Used by the CLI driver (claude-session-controller.js), the SDK driver
 * (claude-sdk-driver.js) and the tmux bridge so that the Team switch
 * (需求1) and cross-team resume (需求5) both honour CLAUDE_CONFIG_DIR no
 * matter which driver is active. Without this, only the CLI driver applied
 * the team config dir and the SDK/tmux drivers silently ignored it.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

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
export function buildClaudeSpawnEnv(baseEnv, { configDir } = {}) {
  const env = {}
  const src = baseEnv && typeof baseEnv === 'object' ? baseEnv : process.env
  for (const [k, v] of Object.entries(src)) {
    if (!STRIP_KEYS.has(k)) env[k] = v
  }
  if (configDir && typeof configDir === 'string' && configDir.trim()) {
    env.CLAUDE_CONFIG_DIR = configDir.trim()
  } else {
    delete env.CLAUDE_CONFIG_DIR
  }
  return env
}
