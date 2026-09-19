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
 *   remote.machines -> personal.remote.machines[]  -> null (no dev machines declared)
 *   claude.teams   -> personal.claude.teams[]       -> null (auto-discover ~/.claude + ~/.claude-team*)
 *   ntfy.url       -> personal.ntfy.url            -> null (backend still reads store setting ntfy_url)
 *   akari.serverUrl-> personal.akari.serverUrl     -> $AKARI_SERVER_URL -> http://10.18.8.55:9481
 *   akari.lensUrl  -> personal.akari.lensUrl       -> $AKARI_LENS_URL   -> http://10.18.8.55:9482
 *
 * The loader NEVER throws — a missing/parse-broken personal file degrades to
 * the scattered fallbacks. Secrets are only the same secrets the caller could
 * already read; nothing new is surfaced. The personal file lives under
 * ~/.config (outside every git worktree) and is gitignored as a belt-and-
 * braces measure (see .gitignore: the personal.json and .nanocode-personal
 * patterns).
 *
 * MES-13824 — permission-gated plugin injection:
 *   projectForPlugin(config, manifest)  -> masked, frontend-safe projection
 *     (secrets replaced by hasKey + masked form; never plaintext in DOM/logs)
 *   resolvePluginSecrets(config, manifest) -> real secret values, SERVER-SIDE
 *     only (used by server-side plugin data sources; never serialized to the
 *     browser). Only the fields whose 'personal.*' permission the plugin's
 *     manifest declares are projected — no permission, no field.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const PERSONAL_CONFIG_DIR = join(homedir(), '.config', 'nanocode')
export const PERSONAL_CONFIG_PATH = join(PERSONAL_CONFIG_DIR, 'personal.json')

export const DEFAULT_AIGW_BASE = 'https://aigw.meshy.team'
export const DEFAULT_AIGW_BUDGET_USD = 1000

// MES-14049 — akari 检察插件 defaults. The akari server URL is NOT a secret (it's
// an internal dispatch server), so it is projected to the frontend in full for
// display + the lens jump button. Env overrides let operators repoint without a
// personal.json edit.
export const DEFAULT_AKARI_SERVER_URL = 'http://10.18.8.55:9481'
export const DEFAULT_AKARI_LENS_URL = 'http://10.18.8.55:9482'

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
 *     remote: { machines: [...] | null },             // null = no dev machines
 *     claude: { teams: [{name,configDir}] | null },   // null => auto-discover
 *     ntfy:   { url: string | null },
 *     akari:  { serverUrl, lensUrl },                  // dispatch + lens URLs (not secrets)
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

  // remote dev machines ------------------------------------------------
  // Loaded raw (array of {alias, type?, host, user, port?, key?, note?}); full
  // validation/sanitization happens at the merge step in remote.js
  // (mergePersonalMachines -> sanitizeMachine) so validation stays DRY and this
  // leaf loader stays decoupled from the remote plugin module. Only objects
  // with a non-empty alias+host+user are kept; others dropped silently. These
  // are READ-ONLY seeds (the user's real address book stays in the settings
  // store); the key is referenced by *path* only — its content is never read
  // here, and sshPassword (if ever declared) is stripped from the frontend
  // projection (see projectForPlugin) and surfaced only via resolvePluginSecrets.
  let remoteMachines = null
  if (Array.isArray(file?.remote?.machines)) {
    remoteMachines = []
    for (const m of file.remote.machines) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue
      const alias = typeof m.alias === 'string' ? m.alias.trim() : ''
      const host = typeof m.host === 'string' ? m.host.trim() : ''
      const user = typeof m.user === 'string' ? m.user.trim() : ''
      if (!alias || !host || !user) continue
      remoteMachines.push({ ...m })
    }
    if (!remoteMachines.length) remoteMachines = null
  }

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

  // akari (MES-14049) --------------------------------------------------
  // The dispatch server URL + lens dashboard URL. Not secrets — projected in
  // full to the frontend (display + lens jump). Env overrides take precedence
  // over the personal file so an operator can repoint without editing it.
  const akariServerUrl =
    (typeof file?.akari?.serverUrl === 'string' && file.akari.serverUrl.trim()) ||
    process.env.AKARI_SERVER_URL ||
    DEFAULT_AKARI_SERVER_URL
  const akariLensUrl =
    (typeof file?.akari?.lensUrl === 'string' && file.akari.lensUrl.trim()) ||
    process.env.AKARI_LENS_URL ||
    DEFAULT_AKARI_LENS_URL

  const cfg = Object.freeze({
    aigw: Object.freeze({ base: aigwBase, key: aigwKey, budgetUsd: aigwBudgetUsd }),
    linear: Object.freeze({ apiKey: linearApiKey }),
    remote: Object.freeze({ machines: remoteMachines }),
    claude: Object.freeze({ teams: claudeTeams }),
    ntfy: Object.freeze({ url: ntfyUrl }),
    akari: Object.freeze({ serverUrl: akariServerUrl, lensUrl: akariLensUrl }),
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

// ── MES-13824 permission-gated plugin injection ───────────────────────────
//
// Only plugins whose manifest declares the matching 'personal.*' permission
// receive the corresponding field. Secrets (linear.apiKey / aigw.key) are
// NEVER included in the frontend projection (projectForPlugin) — only their
// masked form + a hasKey boolean. Real secret values are available ONLY via
// resolvePluginSecrets(), which server-side plugin data sources call (never
// serialized to the browser / DOM / logs). This is the "权限门": no declared
// permission, no field; and key values never land in the frontend in plaintext.

export const PERSONAL_CONFIG_PERMISSIONS = {
  'personal.linear': ['linear'],
  'personal.aigw': ['aigw'],
  'personal.remote': ['remote'],
  'personal.claude': ['claude'],
  'personal.ntfy': ['ntfy'],
  'personal.akari': ['akari'],
}

/**
 * Mask a secret for display. Keeps the first 4 + last 4 chars with an ellipsis
 * in between; short secrets collapse to '••••'. Never returns the plaintext.
 */
export function maskSecret(s) {
  if (typeof s !== 'string' || !s) return ''
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

function _permSet(manifest) {
  const perms = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : []
  return new Set(perms)
}

/**
 * Frontend-safe projection of the personal config for a plugin. Returns ONLY
 * the fields the plugin's manifest permissions allow, with every secret
 * replaced by its masked form + a hasKey boolean — never plaintext. Safe to
 * serialize to the browser / DOM / logs.
 */
export function projectForPlugin(config, manifest) {
  const perms = _permSet(manifest)
  const out = {}
  if (perms.has('personal.linear')) {
    out.linear = { hasKey: !!config.linear.apiKey, apiKeyMasked: maskSecret(config.linear.apiKey) }
  }
  if (perms.has('personal.aigw')) {
    out.aigw = {
      base: config.aigw.base,
      budgetUsd: config.aigw.budgetUsd,
      hasKey: !!config.aigw.key,
      keyMasked: maskSecret(config.aigw.key),
    }
  }
  if (perms.has('personal.remote')) {
    // No secrets here: remote machines carry a key *path* + host/user/port
    // (never key content). sshPassword is stripped — only resolvePluginSecrets
    // surfaces it (server-side). The id is stable: `personal:<alias>`.
    out.remote = {
      machines: (config.remote.machines || []).map((m) => ({
        id: `personal:${m.alias}`,
        alias: m.alias,
        type: m.type || 'ssh',
        host: m.host,
        user: m.user,
        port: m.port || 22,
        keyPath: m.key || '',
        note: m.note || '',
        personal: true,
        readOnly: true,
      })),
    }
  }
  if (perms.has('personal.claude')) {
    out.claude = { teams: config.claude.teams }
  }
  if (perms.has('personal.ntfy')) {
    out.ntfy = { url: config.ntfy.url }
  }
  // MES-14049: akari server/lens URLs are NOT secrets — projected in full so
  // the panel can show the server address and render a one-click lens jump.
  if (perms.has('personal.akari')) {
    out.akari = { serverUrl: config.akari.serverUrl, lensUrl: config.akari.lensUrl }
  }
  return Object.freeze(out)
}

/**
 * Real secret values for a plugin — SERVER-SIDE ONLY. Used by server-side
 * plugin data sources (e.g. the SSH spawner, a Linear helper) to act on the
 * user's behalf. Never serialize this to the browser / DOM / logs; callers
 * must not log the returned values.
 */
export function resolvePluginSecrets(config, manifest) {
  const perms = _permSet(manifest)
  const out = {}
  if (perms.has('personal.linear')) {
    out.linear = { apiKey: config.linear.apiKey }
  }
  if (perms.has('personal.aigw')) {
    out.aigw = { key: config.aigw.key }
  }
  if (perms.has('personal.remote')) {
    // Surface per-machine sshPassword (server-side only) so the SSH spawner can
    // use it; key-path auth needs no secret. Key content is never read here.
    const machines = (config.remote.machines || [])
      .filter((m) => m && typeof m.sshPassword === 'string' && m.sshPassword)
      .map((m) => ({ id: `personal:${m.alias}`, alias: m.alias, sshPassword: m.sshPassword }))
    if (machines.length) out.remote = { machines }
  }
  return Object.freeze(out)
}
