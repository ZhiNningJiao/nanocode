/**
 * Plugins & Usage render cores — MES-13740 需求1 (rendered via 需求6 registry).
 *
 * Two render functions are exported, each taking the pane element to fill:
 *   - renderTeamModelPane(pane): Team switch (CLAUDE_CONFIG_DIR) + Model switch
 *   - renderUsagePane(pane):    Claude JSONL token aggregation + AIGW cost probe
 *
 * Data is fetched when the pane is rendered and refreshed on demand via the
 * refresh buttons. All sources are labelled honestly: unavailable sources show
 * "该源无用量接口" instead of pretending.
 *
 * These are render cores only (the "芯"). The 需求6 right-panel.js registry is
 * the shell that mounts/unmounts them; their internal logic is unchanged.
 */

import { fetchSettings, updateSetting } from './api.js'
import { t } from './i18n.js'

const AIGW_KEY = 'aigw_model'
const CLAUDE_MODEL_KEY = 'claude_model'
const CODEX_MODEL_KEY = 'codex_model'
const CLAUDE_EFFORT_KEY = 'claude_effort'
const TEAM_KEY = 'claude_config_dir'

let pluginsLoaded = false
let usageLoaded = false
let settings = {}

async function ensureSettings() {
  if (!Object.keys(settings).length) {
    settings = await fetchSettings()
  }
  return settings
}

// ── Team & Model pane (Session domain) ────────────────────────────────────────

export async function renderTeamModelPane(pane) {
  if (!pane) return
  if (!pluginsLoaded) {
    pane.innerHTML = ''
    pane.appendChild(buildSkeleton())
    pluginsLoaded = true
  }
  try {
    await ensureSettings()
    // Fetch all model-domain sources in parallel. Each degrades gracefully
    // (never rejects) so a missing source doesn't hide the others. MES-13740 R2:
    // init-snapshot (Claude CLI model hint) + codex/config (Codex model options)
    // migrated here from the Settings page so the model domain has a single home.
    const [teamsRes, modelsRes, snapshotRes, codexRes] = await Promise.all([
      fetch('/api/teams').then((r) => r.json()).catch(() => ({ error: 'fetch failed' })),
      fetch('/api/aigw/models').then((r) => r.json()).catch(() => ({ error: 'fetch failed' })),
      fetch('/api/claude/init-snapshot').then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/codex/config').then((r) => r.ok ? r.json() : null).catch(() => null),
    ])
    renderTeamModelContent(pane, teamsRes, modelsRes, snapshotRes, codexRes)
  } catch (err) {
    renderError(pane, err)
  }
}

function buildSkeleton() {
  const div = document.createElement('div')
  div.className = 'rp-loading'
  div.textContent = '...'
  return div
}

function renderError(pane, err) {
  pane.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'rp-section rp-error'
  div.textContent = String(err.message || err)
  pane.appendChild(div)
}

function renderTeamModelContent(pane, teamsRes, modelsRes, snapshotRes, codexRes) {
  pane.innerHTML = ''
  pane.appendChild(renderTeamSection(pane, teamsRes))
  pane.appendChild(renderModelSection(modelsRes, snapshotRes, codexRes))
}

function renderTeamSection(pane, teamsRes) {
  const section = document.createElement('div')
  section.className = 'rp-section'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('plugins.team.title')
  section.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'rp-section-desc'
  desc.textContent = t('plugins.team.desc')
  section.appendChild(desc)

  const teams = teamsRes?.teams || []
  const activePath = teamsRes?.activePath || ''
  if (!teams.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = t('plugins.team.none')
    section.appendChild(empty)
    return section
  }

  for (const team of teams) {
    const row = document.createElement('label')
    row.className = 'rp-option'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'rp-team'
    radio.value = team.path
    radio.checked = team.path === activePath
    radio.addEventListener('change', () => onTeamChange(pane, team.path))
    const label = document.createElement('span')
    label.className = 'rp-option-label'
    const name = document.createElement('span')
    name.className = 'rp-option-name'
    name.textContent = team.name || team.id
    const path = document.createElement('span')
    path.className = 'rp-option-path'
    path.textContent = team.path
    label.appendChild(name)
    label.appendChild(path)
    row.appendChild(radio)
    row.appendChild(label)
    section.appendChild(row)
  }
  return section
}

async function onTeamChange(pane, path) {
  try {
    await updateSetting(TEAM_KEY, path)
    settings[TEAM_KEY] = path
    flashStatus(pane, t('plugins.team.applied'))
  } catch (err) {
    flashStatus(pane, String(err.message || err), true)
  }
}

function renderModelSection(modelsRes, snapshotRes, codexRes) {
  const section = document.createElement('div')
  section.className = 'rp-section'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('plugins.model.title')
  section.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'rp-section-desc'
  desc.textContent = t('plugins.model.desc')
  section.appendChild(desc)

  const currentAigw = settings[AIGW_KEY] || ''
  const currentClaude = settings[CLAUDE_MODEL_KEY] || ''
  const currentCodex = settings[CODEX_MODEL_KEY] || ''
  const currentEffort = settings[CLAUDE_EFFORT_KEY] || ''

  // ── AIGW model (opencode / fable5 sessions via MESHY_AIGW_MODEL) ──
  const aigwLabel = document.createElement('div')
  aigwLabel.className = 'rp-subtitle'
  aigwLabel.textContent = t('plugins.model.aigwTitle')
  section.appendChild(aigwLabel)

  if (modelsRes?.error || !modelsRes?.models?.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = modelsRes?.error
      ? modelsRes.error
      : t('plugins.model.none')
    section.appendChild(empty)
  } else {
    const select = document.createElement('select')
    select.className = 'rp-select'
    select.id = 'rp-aigw-model'
    const noneOpt = document.createElement('option')
    noneOpt.value = ''
    noneOpt.textContent = t('plugins.model.default')
    select.appendChild(noneOpt)
    for (const m of modelsRes.models) {
      const id = typeof m === 'string' ? m : m.id
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = id
      if (id === currentAigw) opt.selected = true
      select.appendChild(opt)
    }
    select.addEventListener('change', () => onAigwModelChange(select.value))
    section.appendChild(select)
  }
  const aigwHint = document.createElement('div')
  aigwHint.className = 'rp-hint'
  aigwHint.textContent = t('plugins.model.hint')
  section.appendChild(aigwHint)

  // ── Claude model (--model flag) — migrated from Settings (MES-13740 R2) ──
  const claudeLabel = document.createElement('div')
  claudeLabel.className = 'rp-subtitle'
  claudeLabel.textContent = t('plugins.model.claudeTitle')
  section.appendChild(claudeLabel)

  const claudeInput = document.createElement('input')
  claudeInput.type = 'text'
  claudeInput.className = 'rp-input'
  claudeInput.id = 'rp-claude-model'
  // If the user has no saved model, pre-fill with the CLI-reported model from
  // init-snapshot so they can see what's active without looking elsewhere.
  // Don't overwrite a saved value. (Ported from Settings app.js.)
  const snapshotModel = snapshotRes?.model || ''
  claudeInput.value = currentClaude || snapshotModel
  claudeInput.placeholder = t('plugins.model.claudePlaceholder')
  const claudeSaveBtn = document.createElement('button')
  claudeSaveBtn.className = 'rp-btn rp-btn-sm'
  claudeSaveBtn.textContent = t('plugins.model.save')
  claudeSaveBtn.addEventListener('click', () => onClaudeModelChange(claudeInput.value))
  const claudeRow = document.createElement('div')
  claudeRow.className = 'rp-btn-row'
  claudeRow.appendChild(claudeInput)
  claudeRow.appendChild(claudeSaveBtn)
  section.appendChild(claudeRow)
  // Show the current active CLI model as a hint (when no override is saved).
  if (snapshotModel) {
    const snapHint = document.createElement('div')
    snapHint.className = 'rp-hint'
    snapHint.textContent = `${t('plugins.model.cliCurrent')}: ${snapshotModel}`
    section.appendChild(snapHint)
  }

  // ── Codex model — migrated from Settings (MES-13740 R2) ──
  const codexLabel = document.createElement('div')
  codexLabel.className = 'rp-subtitle'
  codexLabel.textContent = t('plugins.model.codexTitle')
  section.appendChild(codexLabel)

  const codexSelect = document.createElement('select')
  codexSelect.className = 'rp-select'
  codexSelect.id = 'rp-codex-model'
  const codexConfigModel = codexRes?.model || null
  const codexDefaultOpt = document.createElement('option')
  codexDefaultOpt.value = ''
  codexDefaultOpt.textContent = codexConfigModel
    ? `${t('plugins.model.codexDefault')} (config: ${codexConfigModel})`
    : t('plugins.model.codexDefault')
  codexSelect.appendChild(codexDefaultOpt)
  if (codexConfigModel) {
    const opt = document.createElement('option')
    opt.value = codexConfigModel
    opt.textContent = codexConfigModel
    if (codexConfigModel === currentCodex) opt.selected = true
    codexSelect.appendChild(opt)
  }
  if (currentCodex) {
    codexSelect.value = currentCodex
    if (codexSelect.value !== currentCodex) codexSelect.value = ''
  }
  codexSelect.addEventListener('change', () => onCodexModelChange(codexSelect.value))
  section.appendChild(codexSelect)
  const codexHint = document.createElement('div')
  codexHint.className = 'rp-hint'
  codexHint.textContent = t('plugins.model.codexHint')
  section.appendChild(codexHint)

  // ── Effort level — migrated from Settings (MES-13740 R2) ──
  const effortLabel = document.createElement('div')
  effortLabel.className = 'rp-subtitle'
  effortLabel.textContent = t('plugins.model.effortTitle')
  section.appendChild(effortLabel)

  const effortSelect = document.createElement('select')
  effortSelect.className = 'rp-select'
  effortSelect.id = 'rp-claude-effort'
  const effortOpts = [
    ['', t('plugins.model.effortDefault')],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
  ]
  for (const [val, label] of effortOpts) {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = label
    if (val === currentEffort) opt.selected = true
    effortSelect.appendChild(opt)
  }
  effortSelect.addEventListener('change', () => onEffortChange(effortSelect.value))
  section.appendChild(effortSelect)
  const effortHint = document.createElement('div')
  effortHint.className = 'rp-hint'
  effortHint.textContent = t('plugins.model.effortHint')
  section.appendChild(effortHint)

  return section
}

async function onClaudeModelChange(model) {
  try {
    const val = (model || '').trim()
    await updateSetting(CLAUDE_MODEL_KEY, val)
    settings[CLAUDE_MODEL_KEY] = val
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), t('plugins.model.applied'))
  } catch (err) {
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), String(err.message || err), true)
  }
}

async function onAigwModelChange(model) {
  try {
    await updateSetting(AIGW_KEY, model)
    settings[AIGW_KEY] = model
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), t('plugins.model.applied'))
  } catch (err) {
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), String(err.message || err), true)
  }
}

async function onCodexModelChange(model) {
  try {
    await updateSetting(CODEX_MODEL_KEY, model)
    settings[CODEX_MODEL_KEY] = model
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), t('plugins.model.applied'))
  } catch (err) {
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), String(err.message || err), true)
  }
}

async function onEffortChange(effort) {
  try {
    await updateSetting(CLAUDE_EFFORT_KEY, effort)
    settings[CLAUDE_EFFORT_KEY] = effort
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), t('plugins.model.applied'))
  } catch (err) {
    flashStatus(document.querySelector('.right-panel-pane[data-rp-pane="team-model"]'), String(err.message || err), true)
  }
}

// ── Usage pane (Ops domain) ────────────────────────────────────────────────────

export async function renderUsagePane(pane) {
  if (!pane) return
  pane.innerHTML = ''
  usageLoaded = true

  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'rp-refresh-btn'
  refreshBtn.textContent = t('usage.refresh')
  refreshBtn.addEventListener('click', () => renderUsagePane(pane))
  pane.appendChild(refreshBtn)

  // Per-section slots rendered INDEPENDENTLY: a slow source must never block a
  // fast one. /api/usage/summary hits AIGW (~10s); /api/usage/claude reads jsonl
  // (~0.4s). The old code awaited Promise.all([all four]) then painted once, so
  // Claude Token usage sat behind the 10s summary and looked "missing". Now each
  // fetch fills its own slot as it resolves — fastest paints first.
  const slot = () => {
    const d = document.createElement('div')
    const stub = document.createElement('div')
    stub.className = 'rp-empty'
    stub.textContent = t('usage.summary.loading')
    d.appendChild(stub)
    pane.appendChild(d)
    return d
  }
  const budgetSlot = slot()
  const summarySlot = slot()
  const claudeSlot = slot()
  const opencodeSlot = slot()
  const probeSlot = slot()

  try { await ensureSettings() } catch {}

  const fill = (s, el) => { s.innerHTML = ''; s.appendChild(el) }
  const j = (url) => fetch(url).then((r) => r.json()).catch(() => ({ error: 'fetch failed' }))

  // Probe section needs no fetch — render immediately.
  fill(probeSlot, renderAigwProbeSection(pane))
  // Fire each source independently; whichever resolves first paints first.
  j('/api/usage/aigw-budget').then((d) => fill(budgetSlot, renderAigwBudgetSection(d)))
  j('/api/usage/claude').then((d) => fill(claudeSlot, renderClaudeUsageSection(d)))
  j('/api/usage/opencode').then((d) => fill(opencodeSlot, renderOpencodeUsageSection(d)))
  j('/api/usage/summary').then((d) => fill(summarySlot, renderUsageSummarySection(d)))
}

// ── AIGW monthly budget card (MES-13788 延续: /user/info 剩余额度 + 自适配档) ──
// Headline card: remaining $ + progress bar (spent/max) + tier badge (colored
// by strategy) + reset date / days-left + advice. Mobile 390×844 + touch ≥44px
// handled by the .rp-budget-* CSS. Falls back to an honest unavailable state.
function renderAigwBudgetSection(budget) {
  const section = document.createElement('div')
  section.className = 'rp-section rp-budget-card'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('usage.budget.title')
  section.appendChild(title)
  const desc = document.createElement('div')
  desc.className = 'rp-hint'
  desc.textContent = t('usage.budget.desc')
  section.appendChild(desc)

  if (!budget || budget.error || !budget.available) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = budget?.error || t('usage.budget.unavailable')
    section.appendChild(empty)
    return section
  }

  const maxBudget = Number(budget.max_budget)
  const spend = Number(budget.spend)
  const remaining = Number(budget.remaining)
  const pctUsed = Number(budget.pct_used)
  const pctRem = Number(budget.pct_remaining)
  const daysLeft = budget.days_left
  const tier = budget.tier || 'BALANCED'

  // Headline row: remaining $ (big) + tier badge (colored)
  const head = document.createElement('div')
  head.className = 'rp-budget-head'
  const rem = document.createElement('div')
  rem.className = 'rp-budget-remaining'
  const remLabel = document.createElement('span')
  remLabel.className = 'rp-budget-remaining-label'
  remLabel.textContent = t('usage.budget.remaining')
  const remVal = document.createElement('span')
  remVal.className = 'rp-budget-remaining-value'
  remVal.textContent = Number.isFinite(remaining) ? `$${remaining.toFixed(2)}` : '—'
  rem.appendChild(remLabel)
  rem.appendChild(remVal)
  head.appendChild(rem)

  const tierBadge = document.createElement('span')
  tierBadge.className = `rp-tier-badge rp-tier-${tier.toLowerCase().replace(/_/g, '-')}`
  tierBadge.textContent = t(`usage.budget.tier.${tier}`) || tier
  tierBadge.title = t(`usage.budget.tierLabel.${tier}`) || ''
  head.appendChild(tierBadge)
  section.appendChild(head)

  // Progress bar: spent fills toward max_budget. Color by severity (used%).
  const bar = document.createElement('div')
  bar.className = 'rp-budget-bar'
  const fill = document.createElement('div')
  fill.className = 'rp-budget-bar-fill'
  if (Number.isFinite(pctUsed)) fill.style.width = `${Math.min(100, Math.max(0, pctUsed))}%`
  if (pctUsed >= 90) fill.classList.add('rp-budget-bar-critical')
  else if (pctUsed >= 75) fill.classList.add('rp-budget-bar-warning')
  bar.appendChild(fill)
  section.appendChild(bar)

  // Meta: spent of total · reset · days-left
  const meta = document.createElement('div')
  meta.className = 'rp-budget-meta'
  const spentCell = document.createElement('span')
  spentCell.className = 'rp-budget-meta-cell'
  const spentLab = document.createElement('span')
  spentLab.className = 'rp-budget-meta-label'
  spentLab.textContent = t('usage.budget.spend')
  const spentVal = document.createElement('span')
  spentVal.className = 'rp-budget-meta-value'
  spentVal.textContent = Number.isFinite(spend) && Number.isFinite(maxBudget)
    ? `$${spend.toFixed(2)} ${t('usage.budget.of')} $${maxBudget.toFixed(0)}${Number.isFinite(pctUsed) ? ` (${Math.round(pctUsed)}%)` : ''}`
    : (Number.isFinite(spend) ? `$${spend.toFixed(2)}` : '—')
  spentCell.appendChild(spentLab)
  spentCell.appendChild(spentVal)
  meta.appendChild(spentCell)

  const resetCell = document.createElement('span')
  resetCell.className = 'rp-budget-meta-cell'
  const resetLab = document.createElement('span')
  resetLab.className = 'rp-budget-meta-label'
  resetLab.textContent = t('usage.budget.reset')
  const resetVal = document.createElement('span')
  resetVal.className = 'rp-budget-meta-value'
  resetVal.textContent = fmtBudgetReset(budget.reset_at, daysLeft)
  resetCell.appendChild(resetLab)
  resetCell.appendChild(resetVal)
  meta.appendChild(resetCell)
  section.appendChild(meta)

  // Advice line (tier strategy hint)
  if (budget.advice) {
    const advice = document.createElement('div')
    advice.className = 'rp-hint rp-budget-advice'
    advice.textContent = budget.advice
    section.appendChild(advice)
  }
  if (budget.user_email) {
    const who = document.createElement('div')
    who.className = 'rp-hint rp-budget-user'
    who.textContent = budget.user_email
    section.appendChild(who)
  }
  return section
}

function fmtBudgetReset(resetAt, daysLeft) {
  if (!resetAt) return t('usage.budget.noReset')
  const ts = Date.parse(resetAt)
  if (!Number.isFinite(ts)) return t('usage.budget.noReset')
  const date = new Date(ts)
  const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
  if (Number.isFinite(Number(daysLeft)) && Number(daysLeft) >= 0) {
    return `${dateStr} (${daysLeft} ${t('usage.budget.daysLeft')})`
  }
  return dateStr
}

// ── MES-13788 three-source usage summary (CodexBar-style) ─────────────────────
// Renders one card per source (Team1 / Team2 / AIGW) with per-window bars,
// reset countdown, burn rate and hit projection. Estimates are labelled.
// Mobile 390×844 + touch ≥44px are handled by the .rp-usage-* CSS.
function renderUsageSummarySection(summary) {
  const section = document.createElement('div')
  section.className = 'rp-section rp-usage-summary'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('usage.summary.title')
  section.appendChild(title)
  const desc = document.createElement('div')
  desc.className = 'rp-hint'
  desc.textContent = t('usage.summary.desc')
  section.appendChild(desc)

  if (!summary || summary.error) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = summary?.error || t('usage.summary.loading')
    section.appendChild(empty)
    return section
  }

  const sources = Array.isArray(summary.sources) ? summary.sources : []
  if (!sources.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = t('usage.summary.loading')
    section.appendChild(empty)
    return section
  }
  for (const src of sources) {
    section.appendChild(renderUsageSourceCard(src))
  }
  return section
}

// Friendly model label: claude-opus-4-8 → "Opus 4.8", claude-sonnet-4-6 →
// "Sonnet 4.6", claude-fable-5 → "Fable 5". Unknown models shown verbatim.
function prettyModelName(model) {
  const s = String(model || '')
  const fam = /opus/i.test(s) ? 'Opus' : /sonnet/i.test(s) ? 'Sonnet'
    : /haiku/i.test(s) ? 'Haiku' : /fable/i.test(s) ? 'Fable' : null
  if (!fam) return s
  const ver = s.match(/(\d+(?:[-.]\d+)?)/)
  return ver ? `${fam} ${ver[1].replace('-', '.')}` : fam
}

function renderUsageSourceCard(src) {
  const card = document.createElement('div')
  card.className = 'rp-usage-source'
  card.dataset.source = src.source || ''

  const head = document.createElement('div')
  head.className = 'rp-usage-source-head'
  const name = document.createElement('span')
  name.className = 'rp-usage-source-name'
  name.textContent = src.label || src.source || ''
  head.appendChild(name)

  // status badge: unavailable / oauth-down / estimated
  const badge = document.createElement('span')
  badge.className = 'rp-usage-badge'
  if (src.source === 'aigw-litellm' && !src.available) {
    badge.classList.add('rp-usage-badge-down')
    badge.textContent = t('usage.summary.unavailable')
    badge.title = src.error || t('usage.summary.aigwDown')
  } else if (src.kind === 'claude-oauth' && src.oauthAvailable === false) {
    badge.classList.add('rp-usage-badge-est')
    badge.textContent = t('usage.summary.estimated')
    badge.title = src.oauthError || t('usage.summary.oauthDown')
  } else {
    badge.classList.add('rp-usage-badge-ok')
    badge.textContent = src.kind === 'claude-oauth' ? 'OAuth' : (src.available ? 'API' : '—')
  }
  head.appendChild(badge)
  card.appendChild(head)

  const windows = Array.isArray(src.windows) ? src.windows : []
  if (!windows.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = src.error || t('usage.summary.unavailable')
    card.appendChild(empty)
    return card
  }
  for (const w of windows) {
    card.appendChild(renderUsageWindowRow(w))
  }
  // Per-model breakdown for this team (Fable / Opus / Sonnet / Haiku …). OAuth
  // exposes no per-model limit, so this is token usage + message rows, from the
  // team's own jsonl — not a limit bar.
  if (Array.isArray(src.byModel) && src.byModel.length) {
    const subTitle = document.createElement('div')
    subTitle.className = 'rp-subtitle'
    subTitle.textContent = t('usage.claude.byModel')
    card.appendChild(subTitle)
    const list = document.createElement('div')
    list.className = 'rp-list'
    for (const m of src.byModel) {
      const r = document.createElement('div')
      r.className = 'rp-list-row'
      const nm = document.createElement('span')
      nm.className = 'rp-list-name'
      nm.textContent = prettyModelName(m.model)
      nm.title = m.model
      const val = document.createElement('span')
      val.className = 'rp-list-val'
      val.textContent = `${fmtTokens(m.tokens)} · ${fmtNum(m.rows)} msgs`
      r.appendChild(nm)
      r.appendChild(val)
      list.appendChild(r)
    }
    card.appendChild(list)
  }
  // provenance note (compact) for the unavailable/estimated case
  if (src.error) {
    const note = document.createElement('div')
    note.className = 'rp-hint rp-usage-note'
    note.textContent = src.error
    card.appendChild(note)
  }
  return card
}

function renderUsageWindowRow(w) {
  const row = document.createElement('div')
  row.className = 'rp-usage-window'
  row.dataset.window = w.windowType || ''
  if (w.severity) row.dataset.severity = w.severity

  const head = document.createElement('div')
  head.className = 'rp-usage-window-head'
  const type = document.createElement('span')
  type.className = 'rp-usage-window-type'
  const typeKey = { '5h': 'usage.summary.window.5h', 'weekly': 'usage.summary.window.weekly', 'monthly': 'usage.summary.window.monthly' }[w.windowType]
  type.textContent = typeKey ? t(typeKey) : (w.windowType || '')
  head.appendChild(type)

  // pct label (right side)
  const pct = document.createElement('span')
  pct.className = 'rp-usage-window-pct'
  const utilPct = computeWindowPct(w)
  if (utilPct != null) {
    pct.textContent = `${Math.round(utilPct)}%`
  } else if (w.used != null && w.limit == null) {
    pct.textContent = fmtTokens(w.used)
  } else {
    pct.textContent = '—'
  }
  head.appendChild(pct)
  row.appendChild(head)

  // bar
  const bar = document.createElement('div')
  bar.className = 'rp-usage-bar'
  const fill = document.createElement('div')
  fill.className = 'rp-usage-bar-fill'
  if (utilPct != null) fill.style.width = `${Math.min(100, Math.max(0, utilPct))}%`
  if (w.severity === 'critical') fill.classList.add('rp-usage-bar-critical')
  else if (w.severity === 'warning') fill.classList.add('rp-usage-bar-warning')
  bar.appendChild(fill)
  row.appendChild(bar)

  // meta line: used/limit · reset · burn · projected
  const meta = document.createElement('div')
  meta.className = 'rp-usage-window-meta'
  meta.appendChild(usageMetaCell(t('usage.summary.used'), fmtUsedLimit(w)))
  meta.appendChild(usageMetaCell(t('usage.summary.reset'), fmtResetCountdown(w.resetAt)))
  if (w.burnRatePerMin != null) {
    meta.appendChild(usageMetaCell(t('usage.summary.burn'), `${fmtTokens(w.burnRatePerMin)} ${t('usage.summary.tokensMin')}`))
  }
  if (w.projectedHitAt) {
    meta.appendChild(usageMetaCell(t('usage.summary.projected'), fmtProjectedHit(w.projectedHitAt)))
  }
  row.appendChild(meta)

  if (w.estimated) {
    const est = document.createElement('span')
    est.className = 'rp-usage-est-tag'
    est.textContent = t('usage.summary.estimated')
    row.appendChild(est)
  }
  return row
}

function usageMetaCell(label, value) {
  const cell = document.createElement('span')
  cell.className = 'rp-usage-meta-cell'
  const lab = document.createElement('span')
  lab.className = 'rp-usage-meta-label'
  lab.textContent = label
  const val = document.createElement('span')
  val.className = 'rp-usage-meta-value'
  val.textContent = value
  cell.appendChild(lab)
  cell.appendChild(val)
  return cell
}

function computeWindowPct(w) {
  if (typeof w.utilization === 'number') return w.utilization
  if (typeof w.used === 'number' && typeof w.limit === 'number' && w.limit > 0) {
    return (w.used / w.limit) * 100
  }
  return null
}

function fmtUsedLimit(w) {
  const u = w.used
  const l = w.limit
  const unit = w.unit || ''
  const fmtByUnit = (n) => {
    if (n == null) return '—'
    if (unit === 'percent') return `${Math.round(n)}%`
    if (unit === 'usd' || unit === 'credits') return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Number(n).toFixed(2)}`
    return fmtTokens(n)
  }
  if (l != null) return `${fmtByUnit(u)} ${t('usage.summary.of')} ${fmtByUnit(l)}`
  if (u != null) return fmtByUnit(u)
  return '—'
}

function fmtResetCountdown(resetAt) {
  if (!resetAt) return t('usage.summary.noReset')
  const ts = Date.parse(resetAt)
  if (!Number.isFinite(ts)) return t('usage.summary.noReset')
  const diff = ts - Date.now()
  if (diff <= 0) return t('usage.summary.noReset')
  return fmtDuration(diff)
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `<1m`
}

function fmtProjectedHit(iso) {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return '—'
  const diff = ts - Date.now()
  if (diff <= 0) return 'now'
  return fmtDuration(diff)
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return `${Math.round(v)}`
}

function renderClaudeUsageSection(usage) {
  const section = document.createElement('div')
  section.className = 'rp-section'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('usage.claude.title')
  section.appendChild(title)

  if (!usage || usage.error) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = usage?.error || t('usage.claude.none')
    section.appendChild(empty)
    return section
  }

  const totals = usage.totals || {}
  const stats = document.createElement('div')
  stats.className = 'rp-stats-grid'
  stats.appendChild(statCell(t('usage.claude.input'), totals.input))
  stats.appendChild(statCell(t('usage.claude.output'), totals.output))
  stats.appendChild(statCell(t('usage.claude.cacheCreate'), totals.cacheCreation))
  stats.appendChild(statCell(t('usage.claude.cacheRead'), totals.cacheRead))
  stats.appendChild(statCell(t('usage.claude.rows'), totals.rows))
  stats.appendChild(statCell(t('usage.claude.files'), usage.files))
  section.appendChild(stats)

  if (usage.byModel?.length) {
    const sub = document.createElement('div')
    sub.className = 'rp-subtitle'
    sub.textContent = t('usage.claude.byModel')
    section.appendChild(sub)
    const list = document.createElement('div')
    list.className = 'rp-list'
    for (const m of usage.byModel.slice(0, 10)) {
      const row = document.createElement('div')
      row.className = 'rp-list-row'
      const name = document.createElement('span')
      name.className = 'rp-list-name'
      name.textContent = m.model
      const val = document.createElement('span')
      val.className = 'rp-list-val'
      val.textContent = fmtNum((m.input || 0) + (m.output || 0) + (m.cacheCreation || 0) + (m.cacheRead || 0))
      row.appendChild(name)
      row.appendChild(val)
      list.appendChild(row)
    }
    section.appendChild(list)
  }
  return section
}

function statCell(label, value) {
  const cell = document.createElement('div')
  cell.className = 'rp-stat'
  const lab = document.createElement('div')
  lab.className = 'rp-stat-label'
  lab.textContent = label
  const val = document.createElement('div')
  val.className = 'rp-stat-value'
  val.textContent = fmtNum(value)
  cell.appendChild(lab)
  cell.appendChild(val)
  return cell
}

// OpenCode/Fable5 token usage — 需求15 item6. Reads the opencode SQLite
// session table (tokens_input/output/reasoning/cache_read/cache_write + cost).
// Honest: AIGW-routed sessions report cost=0; tokens are real.
function renderOpencodeUsageSection(opencode) {
  const section = document.createElement('div')
  section.className = 'rp-section'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('usage.opencode.title')
  section.appendChild(title)

  if (!opencode || opencode.error) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = opencode?.error || t('usage.opencode.none')
    section.appendChild(empty)
    return section
  }

  const totals = opencode.totals || {}
  const stats = document.createElement('div')
  stats.className = 'rp-stats-grid'
  stats.appendChild(statCell(t('usage.opencode.input'), totals.input))
  stats.appendChild(statCell(t('usage.opencode.output'), totals.output))
  stats.appendChild(statCell(t('usage.opencode.reasoning'), totals.reasoning))
  stats.appendChild(statCell(t('usage.opencode.cacheRead'), totals.cacheRead))
  stats.appendChild(statCell(t('usage.opencode.cacheWrite'), totals.cacheWrite))
  stats.appendChild(statCell(t('usage.opencode.sessions'), opencode.sessionCount))
  section.appendChild(stats)

  // Cost: shown honestly. AIGW-routed sessions report cost=0.
  const costRow = document.createElement('div')
  costRow.className = 'rp-hint'
  const costTotal = Number(opencode.costTotal) || 0
  costRow.textContent = `${t('usage.opencode.cost')}: $${costTotal.toFixed(6)}`
  section.appendChild(costRow)
  const costNote = document.createElement('div')
  costNote.className = 'rp-hint'
  costNote.textContent = t('usage.opencode.costNote')
  section.appendChild(costNote)

  if (opencode.byModel?.length) {
    const sub = document.createElement('div')
    sub.className = 'rp-subtitle'
    sub.textContent = t('usage.opencode.byModel')
    section.appendChild(sub)
    const list = document.createElement('div')
    list.className = 'rp-list'
    for (const m of opencode.byModel.slice(0, 10)) {
      const row = document.createElement('div')
      row.className = 'rp-list-row'
      const name = document.createElement('span')
      name.className = 'rp-list-name'
      name.textContent = m.model
      const val = document.createElement('span')
      val.className = 'rp-list-val'
      val.textContent = `${fmtNum((m.input || 0) + (m.output || 0) + (m.reasoning || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0))} (${m.sessions})`
      row.appendChild(name)
      row.appendChild(val)
      list.appendChild(row)
    }
    section.appendChild(list)
  }

  if (opencode.byDirectory?.length) {
    const sub = document.createElement('div')
    sub.className = 'rp-subtitle'
    sub.textContent = t('usage.opencode.byDir')
    section.appendChild(sub)
    const list = document.createElement('div')
    list.className = 'rp-list'
    for (const d of opencode.byDirectory.slice(0, 5)) {
      const row = document.createElement('div')
      row.className = 'rp-list-row'
      const name = document.createElement('span')
      name.className = 'rp-list-name'
      // Show the directory basename for compactness (full path in title).
      const base = String(d.directory || '').split('/').filter(Boolean).pop() || d.directory || '(unknown)'
      name.textContent = base
      name.title = d.directory
      const val = document.createElement('span')
      val.className = 'rp-list-val'
      val.textContent = `${fmtNum((d.input || 0) + (d.output || 0) + (d.reasoning || 0) + (d.cacheRead || 0) + (d.cacheWrite || 0))} (${d.sessions})`
      row.appendChild(name)
      row.appendChild(val)
      list.appendChild(row)
    }
    section.appendChild(list)
  }

  return section
}

function renderAigwProbeSection(pane) {
  const section = document.createElement('div')
  section.className = 'rp-section'
  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('usage.aigw.title')
  section.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'rp-hint'
  desc.textContent = t('usage.aigw.desc')
  section.appendChild(desc)

  const accumulated = Number(settings['aigw_probe_cost_total']) || 0
  const count = Number(settings['aigw_probe_count']) || 0
  if (accumulated > 0 || count > 0) {
    const acc = document.createElement('div')
    acc.className = 'rp-hint'
    acc.textContent = `${t('usage.aigw.accumulated')}: $${accumulated.toFixed(6)} (${count} ${t('usage.aigw.probes')})`
    section.appendChild(acc)
  }

  const btnRow = document.createElement('div')
  btnRow.className = 'rp-btn-row'
  const btn = document.createElement('button')
  btn.className = 'rp-btn'
  btn.textContent = t('usage.aigw.probe')
  btn.addEventListener('click', () => onProbeCost(btn))
  btnRow.appendChild(btn)
  section.appendChild(btnRow)

  const result = document.createElement('div')
  result.className = 'rp-probe-result'
  result.id = 'rp-probe-result'
  section.appendChild(result)
  return section
}

async function onProbeCost(btn) {
  const result = document.getElementById('rp-probe-result')
  if (!result) return
  btn.disabled = true
  result.textContent = '...'
  result.className = 'rp-probe-result loading'
  try {
    const model = settings[AIGW_KEY] || ''
    const body = {}
    if (model) body.model = model
    const res = await fetch('/api/aigw/probe-cost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    settings['aigw_probe_cost_total'] = data.accumulatedCost
    settings['aigw_probe_count'] = data.probeCount
    result.className = 'rp-probe-result'
    if (data.cost == null) {
      result.textContent = t('usage.aigw.noCostHeader')
    } else {
      result.textContent = `${t('usage.aigw.cost')}: $${Number(data.cost).toFixed(6)}`
    }
    const total = document.createElement('div')
    total.className = 'rp-hint'
    total.textContent = `${t('usage.aigw.accumulated')}: $${Number(data.accumulatedCost).toFixed(6)} (${data.probeCount} ${t('usage.aigw.probes')})`
    result.appendChild(total)
  } catch (err) {
    result.className = 'rp-probe-result error'
    result.textContent = String(err.message || err)
  } finally {
    btn.disabled = false
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function resetPluginLoadState() {
  // Used by the registry/tests when a plugin pane is (re)mounted fresh.
  pluginsLoaded = false
  usageLoaded = false
  settings = {}
}

function fmtNum(n) {
  const v = Number(n) || 0
  return v.toLocaleString()
}

function flashStatus(pane, msg, isError = false) {
  if (!pane) return
  let status = pane.querySelector('.rp-flash')
  if (!status) {
    status = document.createElement('div')
    status.className = 'rp-flash'
    pane.appendChild(status)
  }
  status.textContent = msg
  status.classList.toggle('error', isError)
  status.classList.add('show')
  clearTimeout(status._timer)
  status._timer = setTimeout(() => status.classList.remove('show'), 2500)
}
