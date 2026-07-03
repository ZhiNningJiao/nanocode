/**
 * Persona library + skills browser render core — MES-13740 需求8.
 *
 * Two read-only sections:
 *   1. Persona library — bundled (<repo>/personas/*.md) + user
 *      (~/.config/nanocode/personas/*.md) personas. Click to preview the
 *      instruction text that gets injected via --append-system-prompt. The
 *      persona is APPLIED at new-session creation (the Claude Code resume
 *      picker has a persona dropdown); this panel is browse + preview only.
 *   2. Skills browser — Claude-native skills across team config dirs
 *      (<team>/skills/<name>/SKILL.md). Read-only: loading a native skill is
 *      Claude's own mechanism, we never inject it.
 *
 * Mobile-readable (≤480px): single column, ≥44px touch targets. This is a
 * render core ("芯"); the 需求6 right-panel.js registry mounts/unmounts it.
 */

import { t } from './i18n.js'

let loaded = false
let activePane = null
let personas = []
let selPersona = ''
let personaDetail = null
let skillsData = { teams: [], activePath: '' }
let openTeams = new Set()

export async function renderPersonaPane(pane) {
  if (!pane) return
  activePane = pane
  if (!loaded) {
    pane.innerHTML = ''
    pane.appendChild(buildSkeleton())
    loaded = true
  }
  try {
    await loadPersonas()
    await loadSkills()
    renderShell(pane)
  } catch (err) {
    renderError(pane, err)
  }
}

export function resetPersonaLoadState() {
  loaded = false
  activePane = null
  personas = []
  selPersona = ''
  personaDetail = null
  skillsData = { teams: [], activePath: '' }
  openTeams = new Set()
}

// ── data loading ────────────────────────────────────────────────────────────

async function loadPersonas() {
  const data = await fetch('/api/personas').then((r) => r.json())
  if (data.error) throw new Error(data.error)
  personas = Array.isArray(data.personas) ? data.personas : []
  if (!selPersona && personas.length) selPersona = personas[0].id
  if (selPersona) await loadPersonaDetail(selPersona)
}

async function loadPersonaDetail(id) {
  selPersona = id
  if (!id) { personaDetail = null; return }
  try {
    const data = await fetch(`/api/personas/${encodeURIComponent(id)}`).then((r) => r.json())
    if (data.error) { personaDetail = null; return }
    personaDetail = data
  } catch {
    personaDetail = null
  }
}

async function loadSkills() {
  try {
    const data = await fetch('/api/skills').then((r) => r.json())
    if (data.error) { skillsData = { teams: [], activePath: '' }; return }
    skillsData = { teams: Array.isArray(data.teams) ? data.teams : [], activePath: data.activePath || '' }
    // Open the active team's skill group by default.
    if (skillsData.activePath && !openTeams.size) openTeams.add(skillsData.activePath)
  } catch {
    skillsData = { teams: [], activePath: '' }
  }
}

// ── rendering ──────────────────────────────────────────────────────────────

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

function renderShell(pane) {
  pane.innerHTML = ''
  pane.appendChild(renderPersonaSection())
  pane.appendChild(renderSkillsSection())
}

// ── persona library section ─────────────────────────────────────────────────

function renderPersonaSection() {
  const section = document.createElement('div')
  section.className = 'rp-section'

  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('persona.library.title')
  section.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'rp-section-desc'
  desc.textContent = t('persona.library.desc')
  section.appendChild(desc)

  // Selector
  const field = document.createElement('label')
  field.className = 'mem-field'
  const lab = document.createElement('span')
  lab.className = 'mem-field-label'
  lab.textContent = t('persona.select')
  const sel = document.createElement('select')
  sel.className = 'rp-select'
  sel.id = 'persona-select'
  const noneOpt = document.createElement('option')
  noneOpt.value = ''
  noneOpt.textContent = t('persona.none')
  sel.appendChild(noneOpt)
  for (const p of personas) {
    const opt = document.createElement('option')
    opt.value = p.id
    const tag = p.source === 'user' ? t('persona.sourceUser') : t('persona.sourceBuiltin')
    opt.textContent = `${p.name} (${tag})`
    if (p.id === selPersona) opt.selected = true
    sel.appendChild(opt)
  }
  if (!personas.length) sel.disabled = true
  sel.addEventListener('change', async () => {
    await loadPersonaDetail(sel.value)
    renderPersonaPreview()
  })
  field.appendChild(lab)
  field.appendChild(sel)
  section.appendChild(field)

  // Preview
  const preview = document.createElement('div')
  preview.className = 'persona-preview'
  preview.id = 'persona-preview'
  section.appendChild(preview)
  renderPersonaPreview()

  // Apply hint
  const hint = document.createElement('div')
  hint.className = 'rp-hint persona-apply-hint'
  hint.textContent = t('persona.applyHint')
  section.appendChild(hint)

  return section
}

function renderPersonaPreview() {
  const el = document.getElementById('persona-preview')
  if (!el) return
  el.innerHTML = ''
  if (!selPersona || !personaDetail) {
    el.appendChild(personaHint(t('persona.selectToPreview')))
    return
  }
  const head = document.createElement('div')
  head.className = 'persona-preview-head'
  head.textContent = personaDetail.name || selPersona
  el.appendChild(head)
  const body = document.createElement('div')
  body.className = 'persona-preview-body'
  // Render markdown if available, else plain preformatted text.
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(personaDetail.instruction || '')
    body.innerHTML = window.DOMPurify.sanitize(html)
  } else {
    const pre = document.createElement('pre')
    pre.className = 'preview-code'
    pre.textContent = personaDetail.instruction || ''
    body.appendChild(pre)
  }
  el.appendChild(body)
}

// ── skills browser section (read-only) ──────────────────────────────────────

function renderSkillsSection() {
  const section = document.createElement('div')
  section.className = 'rp-section'

  const title = document.createElement('div')
  title.className = 'rp-section-title'
  title.textContent = t('persona.skills.title')
  section.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'rp-section-desc'
  desc.textContent = t('persona.skills.desc')
  section.appendChild(desc)

  if (!skillsData.teams.length) {
    section.appendChild(personaHint(t('persona.skills.empty')))
    return section
  }

  for (const team of skillsData.teams) {
    section.appendChild(renderTeamGroup(team))
  }
  return section
}

function renderTeamGroup(team) {
  const wrap = document.createElement('div')
  wrap.className = 'persona-skill-group'
  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'persona-skill-group-head'
  const isOpen = openTeams.has(team.path)
  head.classList.toggle('open', isOpen)
  const chev = document.createElement('span')
  chev.className = 'persona-skill-chev'
  chev.textContent = isOpen ? '▾' : '▸'
  const name = document.createElement('span')
  name.className = 'persona-skill-group-name'
  name.textContent = `${team.name || team.id} (${team.skills.length})`
  if (team.path === skillsData.activePath) {
    const badge = document.createElement('span')
    badge.className = 'persona-skill-badge'
    badge.textContent = t('persona.skills.active')
    name.appendChild(badge)
  }
  head.appendChild(chev)
  head.appendChild(name)
  head.addEventListener('click', () => {
    if (openTeams.has(team.path)) openTeams.delete(team.path)
    else openTeams.add(team.path)
    renderShell(activePane)
  })
  wrap.appendChild(head)
  if (isOpen) {
    const list = document.createElement('div')
    list.className = 'persona-skill-list'
    if (!team.skills.length) {
      list.appendChild(personaHint(t('persona.skills.noSkills')))
    } else {
      for (const s of team.skills) list.appendChild(renderSkillRow(s))
    }
    wrap.appendChild(list)
  }
  return wrap
}

function renderSkillRow(s) {
  const row = document.createElement('div')
  row.className = 'persona-skill-row'
  const name = document.createElement('div')
  name.className = 'persona-skill-name'
  name.textContent = s.label || s.name
  const desc = document.createElement('div')
  desc.className = 'persona-skill-desc'
  desc.textContent = s.description || ''
  row.appendChild(name)
  if (s.description) row.appendChild(desc)
  return row
}

// ── helpers ─────────────────────────────────────────────────────────────────

function personaHint(text) {
  const d = document.createElement('div')
  d.className = 'mem-hint'
  d.textContent = text
  return d
}
