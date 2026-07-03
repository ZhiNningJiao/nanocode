/**
 * Plugins & Usage panels — MES-13740 需求1.
 *
 * Two right-panel panes are filled here:
 *   - Plugins pane: Team switch (CLAUDE_CONFIG_DIR) + Model switch (AIGW litellm/* list)
 *   - Usage pane:   Claude JSONL token aggregation + AIGW one-shot cost probe
 *
 * Data is fetched lazily when the user first opens the pane (listens for the
 * `nanocode:right-panel-tab` event from right-panel.js) and refreshed on
 * demand via refresh buttons. All sources are labelled honestly: unavailable
 * sources show "该源无用量接口" instead of pretending.
 */

import { fetchSettings, updateSetting } from './api.js'
import { t } from './i18n.js'

const AIGW_KEY = 'aigw_model'
const CLAUDE_MODEL_KEY = 'claude_model'
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

export function initPluginsPanel() {
  document.addEventListener('nanocode:right-panel-tab', (e) => {
    const tab = e.detail?.tab
    if (tab === 'plugins') loadPluginsPane()
    else if (tab === 'usage') loadUsagePane()
  })
}

// ── Plugins pane: Team switch + Model switch ─────────────────────────────────

async function loadPluginsPane() {
  const pane = document.querySelector('.right-panel-pane[data-rp-pane="plugins"]')
  if (!pane) return
  if (!pluginsLoaded) {
    pane.innerHTML = ''
    pane.appendChild(buildPluginsSkeleton())
    pluginsLoaded = true
  }
  try {
    await ensureSettings()
    const [teamsRes, modelsRes] = await Promise.all([
      fetch('/api/teams').then((r) => r.json()),
      fetch('/api/aigw/models').then((r) => r.json()),
    ])
    renderPluginsPane(pane, teamsRes, modelsRes)
  } catch (err) {
    renderPluginsError(pane, err)
  }
}

function buildPluginsSkeleton() {
  const div = document.createElement('div')
  div.className = 'rp-loading'
  div.textContent = '...'
  return div
}

function renderPluginsError(pane, err) {
  pane.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'rp-section rp-error'
  div.textContent = String(err.message || err)
  pane.appendChild(div)
}

function renderPluginsPane(pane, teamsRes, modelsRes) {
  pane.innerHTML = ''
  pane.appendChild(renderTeamSection(teamsRes))
  pane.appendChild(renderModelSection(modelsRes))
}

function renderTeamSection(teamsRes) {
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
    radio.addEventListener('change', () => onTeamChange(team.path))
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

async function onTeamChange(path) {
  try {
    await updateSetting(TEAM_KEY, path)
    settings[TEAM_KEY] = path
    flashStatus('plugins', t('plugins.team.applied'))
  } catch (err) {
    flashStatus('plugins', String(err.message || err), true)
  }
}

function renderModelSection(modelsRes) {
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

  if (modelsRes?.error || !modelsRes?.models?.length) {
    const empty = document.createElement('div')
    empty.className = 'rp-empty'
    empty.textContent = modelsRes?.error
      ? modelsRes.error
      : t('plugins.model.none')
    section.appendChild(empty)
    return section
  }

  const currentAigw = settings[AIGW_KEY] || ''
  const currentClaude = settings[CLAUDE_MODEL_KEY] || ''
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

  const hint = document.createElement('div')
  hint.className = 'rp-hint'
  hint.textContent = t('plugins.model.hint')
  section.appendChild(hint)

  // Claude model (--model flag, already injected by SDK/tmux drivers)
  const claudeLabel = document.createElement('div')
  claudeLabel.className = 'rp-subtitle'
  claudeLabel.textContent = t('plugins.model.claudeTitle')
  section.appendChild(claudeLabel)

  const claudeInput = document.createElement('input')
  claudeInput.type = 'text'
  claudeInput.className = 'rp-input'
  claudeInput.id = 'rp-claude-model'
  claudeInput.value = currentClaude
  claudeInput.placeholder = t('plugins.model.claudePlaceholder')
  const saveBtn = document.createElement('button')
  saveBtn.className = 'rp-btn rp-btn-sm'
  saveBtn.textContent = t('plugins.model.save')
  saveBtn.addEventListener('click', () => onClaudeModelChange(claudeInput.value))
  const claudeRow = document.createElement('div')
  claudeRow.className = 'rp-btn-row'
  claudeRow.appendChild(claudeInput)
  claudeRow.appendChild(saveBtn)
  section.appendChild(claudeRow)
  return section
}

async function onClaudeModelChange(model) {
  try {
    const val = (model || '').trim()
    await updateSetting(CLAUDE_MODEL_KEY, val)
    settings[CLAUDE_MODEL_KEY] = val
    flashStatus('plugins', t('plugins.model.applied'))
  } catch (err) {
    flashStatus('plugins', String(err.message || err), true)
  }
}

async function onAigwModelChange(model) {
  try {
    await updateSetting(AIGW_KEY, model)
    settings[AIGW_KEY] = model
    flashStatus('plugins', t('plugins.model.applied'))
  } catch (err) {
    flashStatus('plugins', String(err.message || err), true)
  }
}

// ── Usage pane: Claude tokens + AIGW cost probe ──────────────────────────────

async function loadUsagePane() {
  const pane = document.querySelector('.right-panel-pane[data-rp-pane="usage"]')
  if (!pane) return
  if (!usageLoaded) {
    pane.innerHTML = ''
    pane.appendChild(buildUsageSkeleton())
    usageLoaded = true
  }
  try {
    await ensureSettings()
    const usage = await fetch('/api/usage/claude').then((r) => r.json())
    renderUsagePane(pane, usage)
  } catch (err) {
    renderUsageError(pane, err)
  }
}

function buildUsageSkeleton() {
  const div = document.createElement('div')
  div.className = 'rp-loading'
  div.textContent = '...'
  return div
}

function renderUsageError(pane, err) {
  pane.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'rp-section rp-error'
  div.textContent = String(err.message || err)
  pane.appendChild(div)
}

function renderUsagePane(pane, usage) {
  pane.innerHTML = ''
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'rp-refresh-btn'
  refreshBtn.textContent = t('usage.refresh')
  refreshBtn.addEventListener('click', () => { usageLoaded = false; loadUsagePane() })
  pane.appendChild(refreshBtn)

  pane.appendChild(renderClaudeUsageSection(usage))
  pane.appendChild(renderAigwProbeSection())
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

function renderAigwProbeSection() {
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

function fmtNum(n) {
  const v = Number(n) || 0
  return v.toLocaleString()
}

function flashStatus(pane, msg, isError = false) {
  let status = document.getElementById(`rp-status-${pane}`)
  if (!status) {
    const p = document.querySelector(`.right-panel-pane[data-rp-pane="${pane}"]`)
    if (!p) return
    status = document.createElement('div')
    status.id = `rp-status-${pane}`
    status.className = 'rp-flash'
    p.appendChild(status)
  }
  status.textContent = msg
  status.classList.toggle('error', isError)
  status.classList.add('show')
  clearTimeout(status._timer)
  status._timer = setTimeout(() => status.classList.remove('show'), 2500)
}
