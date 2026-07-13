/**
 * team-failover.js — quota failover for secretary sessions (opt-in per tab).
 *
 * When a claude session with `allowTeamFailover` hits a 429 / usage-limit, the
 * driver switches CLAUDE_CONFIG_DIR to the other team, COPIES the transcript
 * into that team's projects dir, upgrades the model to that team's default
 * (Team1 ~/.claude → fable/high, others → opus/high), and resumes the same
 * session on the other org's quota. When the original team recovers (OAuth 5h +
 * weekly windows have headroom) the next turn switches back.
 *
 * Session-id / transcript are LOCAL files, not server-bound — verified 2026-07-13
 * (copy jsonl to team2 dir + CLAUDE_CONFIG_DIR=team2 --resume → continues on
 * team2). See memory project_nanocode_team_failover.
 *
 * Workers never fail over: the flag defaults OFF; only sessions the user opts in
 * (secretary) carry it, and child tabs inherit it.
 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { listTeams, fetchClaudeOAuthUsage } from './usage.js'

// claude project-dir slug: cwd with '/' and '.' → '-'
export function cwdSlug(cwd) {
  return String(cwd || '').replace(/[/.]/g, '-')
}

// True when an error message looks like a rate-limit / usage-limit / org spend
// cap. IMPORTANT: Team1/Fable burns the org's MONTHLY credits (not the sub
// pool), so its real wall is an "org monthly spend limit" error, not a classic
// 429 — catch that too. See memory feedback_team1_fable_burns_org_credits.
export function isRateLimitError(text) {
  const s = String(text || '')
  return /\b429\b/.test(s)
    || /rate[\s_-]?limit/i.test(s)
    || /too many requests/i.test(s)
    || /usage limit|quota|out of (credits|usage)/i.test(s)
    || /5-?hour limit|weekly limit|resets_at/i.test(s)
    || /(monthly |org(anization)?[\s_-]?)?spend limit/i.test(s)
    || /credit balance|insufficient credit|monthly limit/i.test(s)
}

// The other existing team's configDir (the one that is not `currentConfigDir`).
// Returns null when there is no distinct second team to fail over to.
export function pickFallbackTeam(currentConfigDir, { home = homedir(), store } = {}) {
  const cur = currentConfigDir || join(home, '.claude')
  const { teams } = listTeams(home, store)
  const other = (teams || []).find((t) => t.exists && t.path !== cur)
  return other ? other.path : null
}

// Per-team default model/effort. personal.json can override per team
// (claude.teams[].model / .effort). Default: primary ~/.claude → fable-5/high,
// any other team → opus-4-8/high (so failover from fable upgrades to opus).
export function teamModelDefaults(configDir, { home = homedir(), personalTeams = [] } = {}) {
  const t = (personalTeams || []).find((x) => (x.configDir || x.path) === configDir)
  if (t && t.model) return { model: t.model, effort: t.effort || 'high' }
  const isPrimary = configDir === join(home, '.claude')
  return { model: isPrimary ? 'claude-fable-5' : 'claude-opus-4-8', effort: 'high' }
}

// Copy a session transcript into a target team's projects dir (same slug) so
// `claude --resume <sid>` finds it under CLAUDE_CONFIG_DIR=targetDir.
// Returns true on success. Never throws.
export function copyTranscriptToTeam(sid, cwd, fromConfigDir, toConfigDir) {
  try {
    if (!sid || !fromConfigDir || !toConfigDir) return false
    const slug = cwdSlug(cwd)
    const src = join(fromConfigDir, 'projects', slug, `${sid}.jsonl`)
    if (!existsSync(src)) return false
    const dstDir = join(toConfigDir, 'projects', slug)
    mkdirSync(dstDir, { recursive: true })
    copyFileSync(src, join(dstDir, `${sid}.jsonl`))
    return true
  } catch { return false }
}

// True when a team's OAuth 5h + weekly windows both have headroom (< threshold%),
// i.e. it has recovered enough to switch back. Degrades to false (stay on
// fallback) if OAuth usage is unavailable. Never throws.
export async function teamHasHeadroom(configDir, { threshold = 95, fetchImpl } = {}) {
  try {
    const res = await fetchClaudeOAuthUsage(configDir, { fetchImpl })
    if (!res || !res.data) return false
    const util = (w) => (w && typeof w.utilization === 'number') ? w.utilization : 0
    const five = util(res.data.five_hour)
    const week = util(res.data.seven_day)
    return five < threshold && week < threshold
  } catch { return false }
}
