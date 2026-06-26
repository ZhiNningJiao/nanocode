/**
 * Dual-team environment helpers for NanoCode.
 *
 * Two Claude "Teams" share one email but live in separate config dirs:
 *   - team1 → ~/.claude          (default; this patrol lane)
 *   - team2 → ~/.claude-team2    (Opus assault lane)
 *
 * Switching the "active team" makes NanoCode spawn its `claude` SDK sessions
 * with `CLAUDE_CONFIG_DIR` pointing at the chosen team's config so that
 * authentication, history, and project state stay isolated per team.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit-tested in isolation and imported by both the SDK driver (terminal/)
 * and the server-side team manager (server/).
 *
 * SECURITY: credentials are never read here. Only the config-dir *path* is
 * resolved; the contents of those dirs (including any credentials file) are
 * never inspected by this module.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()

/**
 * Canonical team definitions. `key` is the stable identifier used in settings
 * and API payloads; `configDir` is the absolute CLAUDE_CONFIG_DIR to use.
 */
export const TEAMS = [
  { key: 'team1', name: 'Team1', configDir: join(HOME, '.claude') },
  { key: 'team2', name: 'Team2', configDir: join(HOME, '.claude-team2') },
]

/** Map of team key → config dir for fast lookup. */
export const TEAM_DIRS = Object.fromEntries(TEAMS.map((t) => [t.key, t.configDir]))

/** Valid team keys (whitelist — used to reject unknown keys at API boundaries). */
export const TEAM_KEYS = TEAMS.map((t) => t.key)

/**
 * Resolve the env override for the active team.
 *
 * Returns an object suitable for merging into a child-process `env`, or `null`
 * when the active team is the default (team1) and therefore needs no override.
 *
 * @param {string|null|undefined} activeTeam  team key from the `nanocode_active_team` setting
 * @returns {{ CLAUDE_CONFIG_DIR: string } | null}
 */
export function resolveTeamEnv(activeTeam) {
  if (!activeTeam) return null
  const dir = TEAM_DIRS[activeTeam]
  if (!dir) return null
  // team1 is the implicit default; no env override needed (claude already uses
  // ~/.claude). Returning null lets the caller skip the merge entirely.
  if (activeTeam === 'team1') return null
  return { CLAUDE_CONFIG_DIR: dir }
}

/**
 * Read the active-team setting value from a store-like object and resolve it to
 * a team key, falling back to 'team1' when unset or invalid.
 *
 * @param {{ getSetting?: (key: string) => any }} store
 * @returns {string}  a valid team key
 */
export function readActiveTeam(store) {
  const raw = store?.getSetting?.('nanocode_active_team')
  return TEAM_KEYS.includes(raw) ? raw : 'team1'
}

/**
 * Wrap a `spawnClaudeCodeProcess` hook so the active team's CLAUDE_CONFIG_DIR is
 * injected into the spawned claude process's env. The wrapper is a thin layer:
 * it mutates `opts.env` only when a non-default team is active, then delegates
 * to the supplied base spawn hook.
 *
 * Exported so the SDK driver can apply it on both the streaming and the
 * CLI-fallback spawn paths, and so it can be unit-tested in isolation.
 *
 * @param {{ getSetting?: (key: string) => any }} store
 * @param {Function} baseSpawn  (opts) => SpawnedProcess
 * @returns {(opts: object) => SpawnedProcess}
 */
export function wrapSpawnWithTeamEnv(store, baseSpawn) {
  return (opts) => {
    const teamEnv = resolveTeamEnv(store?.getSetting?.('nanocode_active_team'))
    if (teamEnv) {
      opts.env = { ...(opts.env || process.env), ...teamEnv }
    }
    return baseSpawn(opts)
  }
}
