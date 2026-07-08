/**
 * Unified personal-config loader (MES-13740 nano-personal-config).
 *
 * Consolidates the scattered personal sources (linear-api key, meshy-aigw key,
 * claude team config dirs, ntfy url) into one repo-OUTSIDE, portable, never-
 * committed config file: `~/.config/nanocode/personal.json` (chmod 600).
 *
 * Backward compatibility is the whole point: every field falls back to the
 * existing scattered source when the personal file is absent or the field is
 * missing, so the current behaviour never regresses:
 *
 *   aigw.key       -> personal.aigw.key            -> ~/.config/meshy-aigw.key
 *   aigw.base      -> personal.aigw.base           -> $MESHY_AIGW_BASE -> https://aigw.meshy.team
 *   aigw.budgetUsd -> personal.aigw.budgetUsd      -> 1000 (default; key-side max_budget is null)
 *   linear.apiKey  -> personal.linear.apiKey       -> ~/.config/linear-api.key
 *   claude.teams   -> personal.claude.teams[]       -> null (auto-discover ~/.claude + ~/.claude-team*)
 *   ntfy.url       -> personal.ntfy.url            -> null (backend still reads store setting ntfy_url)
 *
 * The loader NEVER throws — a missing/parse-broken personal file degrades to
 * the scattered fallbacks. Secrets are only the same secrets the caller could
 * already read; nothing new is surfaced. The personal file lives under
 * ~/.config (outside every git worktree) and is gitignored as a belt-and-
 * braces measure (see .gitignore: the personal.json and .nanocode-personal
 * patterns).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const PERSONAL_CONFIG_DIR = join(homedir(), '.config', 'nanocode')
export const PERSONAL_CONFIG_PATH = join(PERSONAL_CONFIG_DIR, 'personal.json')

export const DEFAULT_AIGW_BASE = 'https://aigw.meshy.team'
export const DEFAULT_AIGW_BUDGET_USD = 1000

// Cache keyed by resolved path so repeated calls in one request don't re-read
// the tiny file. Reset via `resetPersonalConfigCache()` in tests.
const _cache = new Map()

/**
 * Read a secret file (chmod 600 expected) and return its trimmed contents, or
 * '' if absent / unreadable. Never throws.
 */
function readKeyFile(filePath) {
  if (!filePath) return ''
  try {
    return readFileSync(filePath, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Read + JSON-parse the personal config file at `path`. Returns the parsed
 * object or null when the file is absent / unparseable. Never throws.
 */
function readPersonalFile(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Resolve the personal config path for a given home. Honours an explicit
 * `configPath` (used by tests), then `<home>/.config/nanocode/personal.json`.
 */
export function personalConfigPath({ home, configPath } = {}) {
  if (configPath) return configPath
  const homeDir = home || homedir()
  return join(homeDir, '.config', 'nanocode', 'personal.json')
}

/**
 * Load the unified personal config. Reads `~/.config/nanocode/personal.json`
 * first, then falls back to the scattered sources. Returns a frozen object:
 *   {
 *     aigw:   { base, key, budgetUsd },
 *     linear: { apiKey },
 *     claude: { teams: [{name,configDir}] | null },   // null => auto-discover
 *     ntfy:   { url: string | null },
 *     _source:{ personalFileExists, path, home }
 *   }
 *
 * `claude.teams` is null when the user did not declare teams in the personal
 * file — the caller (usage.js listTeams) then auto-discovers ~/.claude +
 * ~/.claude-team* and MERGES any declared teams in (union by path). This keeps
 * the existing Team1/Team2 discovery intact while letting the user add/label
 * extra teams.
 *
 * Never throws; safe to call at module load and per-request.
 */
export function loadPersonalConfig({ home, configPath } = {}) {
  const homeDir = home || homedir()
  const path = personalConfigPath({ home, configPath })
  const cacheKey = path
  if (_cache.has(cacheKey)) return _cache.get(cacheKey)

  const file = readPersonalFile(path)

  // AIGW ---------------------------------------------------------------
  const aigwBase =
    (typeof file?.aigw?.base === 'string' && file.aigw.base.trim()) ||
    process.env.MESHY_AIGW_BASE ||
    DEFAULT_AIGW_BASE
  const aigwKey =
    (typeof file?.aigw?.key === 'string' && file.aigw.key.trim()) ||
    readKeyFile(join(homeDir, '.config', 'meshy-aigw.key'))
  const aigwBudgetUsdRaw = file?.aigw?.budgetUsd
  const aigwBudgetUsd = Number.isFinite(Number(aigwBudgetUsdRaw))
    ? Number(aigwBudgetUsdRaw)
    : DEFAULT_AIGW_BUDGET_USD

  // linear -------------------------------------------------------------
  const linearApiKey =
    (typeof file?.linear?.apiKey === 'string' && file.linear.apiKey.trim()) ||
    readKeyFile(join(homeDir, '.config', 'linear-api.key'))

  // claude teams -------------------------------------------------------
  // Accept either [{name, configDir}] or [{name, path}] (configDir preferred).
  // Validate + normalize; null means "auto-discover in usage.js".
  let claudeTeams = null
  if (Array.isArray(file?.claude?.teams) && file.claude.teams.length) {
    claudeTeams = []
    for (const t of file.claude.teams) {
      if (!t || typeof t !== 'object') continue
      const dir = typeof t.configDir === 'string' ? t.configDir.trim() : (typeof t.path === 'string' ? t.path.trim() : '')
      if (!dir) continue
      claudeTeams.push({
        name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : dir,
        configDir: dir,
      })
    }
    if (!claudeTeams.length) claudeTeams = null
  }

  // ntfy ---------------------------------------------------------------
  const ntfyUrl =
    typeof file?.ntfy?.url === 'string' && file.ntfy.url.trim()
      ? file.ntfy.url.trim()
      : null

  const cfg = Object.freeze({
    aigw: Object.freeze({ base: aigwBase, key: aigwKey, budgetUsd: aigwBudgetUsd }),
    linear: Object.freeze({ apiKey: linearApiKey }),
    claude: Object.freeze({ teams: claudeTeams }),
    ntfy: Object.freeze({ url: ntfyUrl }),
    _source: Object.freeze({
      personalFileExists: !!file,
      path,
      home: homeDir,
    }),
  })
  _cache.set(cacheKey, cfg)
  return cfg
}

/** Drop the in-memory cache (tests with a fake home / configPath). */
export function resetPersonalConfigCache() {
  _cache.clear()
}
