/**
 * Agent manager right-side drawer.
 * Loads from /api/agents, persists via PUT /api/agents.
 * Also shows recent Claude sessions from /api/recent-agents for quick resume.
 */

import { t } from './i18n.js'

let _agents = []
let _drawerOpen = false
let _refreshTimer = null

export function initAgentDrawer() {
  const drawer = document.getElementById('agent-drawer')
  if (!drawer) return

  const backdrop = document.getElementById('agent-drawer-backdrop')
  const toggleBtn = document.getElementById('agent-drawer-toggle')
  const closeBtn = document.getElementById('agent-drawer-close')
  const discoverBtn = document.getElementById('agent-discover-btn')
  const addForm = document.getElementById('agent-add-form')

  function open() {
    drawer.classList.add('open')
    backdrop?.classList.add('open')
    toggleBtn?.classList.add('active')
    _drawerOpen = true
    _loadTmuxSessions()
    _loadAgents()
    _loadRecentAgents()
    _loadSubagents()
    _startAutoRefresh()
  }
  function close() {
    drawer.classList.remove('open')
    backdrop?.classList.remove('open')
    toggleBtn?.classList.remove('active')
    _drawerOpen = false
    _stopAutoRefresh()
  }

  toggleBtn?.addEventListener('click', () => drawer.classList.contains('open') ? close() : open())
  closeBtn?.addEventListener('click', close)
  backdrop?.addEventListener('click', close)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) {
      close()
    }
  })
  // 【保留·暂隐藏】按钮在 index.html 已注释掉，discoverBtn 为 null，?. 保证此绑定安全跳过，功能代码(_discover)完整保留
  discoverBtn?.addEventListener('click', _discover)

  // 【保留·暂隐藏】手动创建 agent 表单。主人改用 tab 栏加号开会话，面板入口隐藏以保持清爽；提交逻辑保留，以后需要时放回入口即可。
  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = document.getElementById('agent-add-name')?.value.trim()
    const type = document.getElementById('agent-add-type')?.value || 'other'
    const tmuxWindow = document.getElementById('agent-add-tmux')?.value.trim() || ''
    if (!name) return
    _agents = [..._agents, { id: crypto.randomUUID(), name, type, tmuxWindow }]
    await _save()
    if (document.getElementById('agent-add-name')) document.getElementById('agent-add-name').value = ''
    if (document.getElementById('agent-add-tmux')) document.getElementById('agent-add-tmux').value = ''
  })

  // Initial badge update on load + periodic refresh
  _updateToggleBadge()
  setInterval(_updateToggleBadge, 30000)
}

function _startAutoRefresh() {
  _stopAutoRefresh()
  _refreshTimer = setInterval(() => {
    if (_drawerOpen) {
      _loadTmuxSessions(_currentFilter)
      _loadSubagents()
    }
  }, 15000)
}

function _stopAutoRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer)
    _refreshTimer = null
  }
}

let _currentFilter = ''
let _currentTypeFilter = 'all'

function _getSessionType(sess) {
  const cmd = (sess.paneCommand || '').toLowerCase()
  if (cmd.includes('claude')) return 'claude'
  if (cmd.includes('codex')) return 'codex'
  if (cmd === 'bash' || cmd === 'sh') return 'bash'
  if (cmd === 'node') return 'node'
  return 'other'
}

async function _updateToggleBadge() {
  try {
    const sessions = await fetch('/api/tmux/list').then(r => r.json())
    const count = (sessions || []).filter(s => {
      const cmd = (s.paneCommand || '').toLowerCase()
      return cmd.includes('claude') || cmd.includes('codex') || cmd.includes('node')
    }).length
    const toggleBtn = document.getElementById('agent-drawer-toggle')
    if (!toggleBtn) return
    let badge = toggleBtn.querySelector('.agent-toggle-badge')
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'agent-toggle-badge'
        toggleBtn.appendChild(badge)
      }
      badge.textContent = count
    } else {
      badge?.remove()
    }
  } catch {}
}

async function _loadAgents() {
  try {
    _agents = await fetch('/api/agents').then(r => r.json())
    _render()
  } catch {}
}

// ── Tmux session browser ────────────────────────────────────────────────────

async function _loadTmuxSessions(filterText) {
  const list = document.getElementById('agent-list')
  if (!list) return

  _currentFilter = filterText || ''
  list.querySelector('.tmux-session-section')?.remove()

  let sessions = []
  try {
    sessions = await fetch('/api/tmux/list').then(r => r.json())
  } catch {
    return
  }
  if (!sessions || !sessions.length) return

  _updateToggleBadge()

  // Sort: AI sessions (claude/codex/node) first, then others; within each group, newest first
  const isAi = (s) => {
    const cmd = (s.paneCommand || '').toLowerCase()
    return cmd.includes('claude') || cmd.includes('codex') || cmd.includes('node')
  }
  const byCreated = (a, b) => (b.created || '').localeCompare(a.created || '')
  sessions = [...sessions].sort((a, b) => {
    const aiA = isAi(a), aiB = isAi(b)
    if (aiA && !aiB) return -1
    if (!aiA && aiB) return 1
    return byCreated(a, b)
  })

  // Apply type filter
  if (_currentTypeFilter !== 'all') {
    if (_currentTypeFilter === 'ai') {
      sessions = sessions.filter(isAi)
    } else {
      sessions = sessions.filter(s => _getSessionType(s) === _currentTypeFilter)
    }
  }

  // Apply text filter if provided
  if (filterText) {
    const ft = filterText.toLowerCase()
    sessions = sessions.filter(s =>
      s.name.toLowerCase().includes(ft) ||
      (s.paneCommand || '').toLowerCase().includes(ft)
    )
  }

  const section = document.createElement('div')
  section.className = 'tmux-session-section'

  const header = document.createElement('div')
  header.className = 'tmux-session-header'

  const title = document.createElement('span')
  title.className = 'tmux-session-title'
  title.textContent = `${t('agents.tmux_sessions')} (${sessions.length})`
  header.appendChild(title)

  const refreshBtn = document.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.className = 'tmux-session-refresh'
  refreshBtn.title = t('agents.tmux_refresh')
  refreshBtn.textContent = '⟳'
  refreshBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const searchInput = section.querySelector('.tmux-search-input')
    _loadTmuxSessions(searchInput?.value || '')
  })
  header.appendChild(refreshBtn)

  section.appendChild(header)

  // Type filter chips
  const filterWrap = document.createElement('div')
  filterWrap.className = 'tmux-filter-chips'
  const filterOptions = [
    { key: 'all', label: t('agents.tmux_filter_all') },
    { key: 'ai', label: t('agents.tmux_filter_ai') },
    { key: 'claude', label: 'Claude' },
    { key: 'codex', label: 'Codex' },
    { key: 'node', label: 'Node' },
    { key: 'bash', label: 'Bash' },
  ]
  for (const opt of filterOptions) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'tmux-filter-chip' + (_currentTypeFilter === opt.key ? ' active' : '')
    chip.textContent = opt.label
    chip.addEventListener('click', (e) => {
      e.stopPropagation()
      _currentTypeFilter = opt.key
      _loadTmuxSessions(_currentFilter)
    })
    filterWrap.appendChild(chip)
  }
  section.appendChild(filterWrap)

  // Search filter (only if there are many sessions)
  if (sessions.length > 5 || filterText) {
    const searchWrap = document.createElement('div')
    searchWrap.className = 'tmux-search-wrap'
    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.className = 'tmux-search-input settings-input'
    searchInput.placeholder = t('agents.tmux_search_placeholder')
    searchInput.value = filterText || ''
    let debounceTimer
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        _loadTmuxSessions(searchInput.value)
      }, 200)
    })
    searchWrap.appendChild(searchInput)
    section.appendChild(searchWrap)
  }

  // Show up to 30 sessions (after filtering)
  const visible = sessions.slice(0, 30)
  for (const sess of visible) {
    const item = document.createElement('div')
    item.className = 'tmux-session-item'
    item.title = `Click to attach: ${sess.name}`

    const info = document.createElement('div')
    info.className = 'tmux-session-info'

    const nameRow = document.createElement('div')
    nameRow.className = 'tmux-session-name-row'

    const nameEl = document.createElement('span')
    nameEl.className = 'tmux-session-name'
    nameEl.textContent = sess.name
    nameRow.appendChild(nameEl)

    // Badge showing the current pane command
    if (sess.paneCommand) {
      const cmd = sess.paneCommand.toLowerCase()
      let badgeType = 'other'
      if (cmd.includes('claude')) badgeType = 'claude'
      else if (cmd.includes('codex')) badgeType = 'codex'
      else if (cmd === 'bash' || cmd === 'sh') badgeType = 'bash'
      else if (cmd === 'node') badgeType = 'node'

      const badge = document.createElement('span')
      badge.className = `tmux-session-badge tmux-badge-${badgeType}`
      badge.textContent = sess.paneCommand
      nameRow.appendChild(badge)
    }

    info.appendChild(nameRow)

    if (sess.preview) {
      const preview = document.createElement('pre')
      preview.className = 'tmux-session-preview'
      preview.textContent = sess.preview
      info.appendChild(preview)
    }

    item.appendChild(info)

    const btnRow = document.createElement('div')
    btnRow.className = 'tmux-session-btns'

    const killBtn = document.createElement('button')
    killBtn.type = 'button'
    killBtn.className = 'tmux-session-kill'
    killBtn.textContent = '×'
    killBtn.title = t('agents.tmux_kill_title')
    killBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(t('agents.tmux_kill_confirm', sess.name))) return
      killBtn.disabled = true
      try {
        const res = await fetch('/api/tmux/kill', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: sess.name }),
        })
        const data = await res.json()
        if (data.ok) {
          item.remove()
        } else {
          alert(data.error || t('agents.tmux_kill_failed'))
          killBtn.disabled = false
        }
      } catch (err) {
        alert(t('agents.tmux_kill_failed') + ': ' + err.message)
        killBtn.disabled = false
      }
    })
    btnRow.appendChild(killBtn)

    const connectBtn = document.createElement('button')
    connectBtn.type = 'button'
    connectBtn.className = 'tmux-session-connect'
    connectBtn.textContent = t('agents.tmux_connect')
    connectBtn.title = `Attach to ${sess.name}`
    connectBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      _connectTmuxSession(sess.name)
    })
    btnRow.appendChild(connectBtn)

    item.appendChild(btnRow)

    // Also allow clicking the whole item
    item.addEventListener('click', () => _connectTmuxSession(sess.name))

    section.appendChild(item)
  }

  if (sessions.length > 30) {
    const more = document.createElement('div')
    more.className = 'tmux-session-more'
    more.textContent = t('agents.tmux_more', sessions.length - 30)
    section.appendChild(more)
  }

  list.prepend(section)
}

async function _connectTmuxSession(sessionName) {
  // Close the drawer
  document.getElementById('agent-drawer')?.classList.remove('open')
  document.getElementById('agent-drawer-backdrop')?.classList.remove('open')
  document.getElementById('agent-drawer-toggle')?.classList.remove('active')

  // Dispatch event for terminal-view to handle
  document.dispatchEvent(new CustomEvent('nanocode:connect-tmux', {
    detail: { tmuxTarget: sessionName, label: sessionName },
  }))
}

// ── Running sub-agents ───────────────────────────────────────────────────────

async function _loadSubagents() {
  const list = document.getElementById('agent-list')
  if (!list) return

  list.querySelector('.subagent-section')?.remove()

  let subagents = []
  try {
    const data = await fetch('/api/agents/subagents').then(r => r.json())
    subagents = (data.subagents || []).filter(s => s.pid)
  } catch {
    return
  }

  const section = document.createElement('div')
  section.className = 'subagent-section'

  const title = document.createElement('div')
  title.className = 'subagent-section-title'
  title.textContent = t('agents.subagents_title', subagents.length)
  section.appendChild(title)

  if (!subagents.length) {
    const empty = document.createElement('div')
    empty.className = 'subagent-empty'
    empty.textContent = t('agents.subagents_empty')
    section.appendChild(empty)
    list.prepend(section)
    return
  }

  for (const sub of subagents) {
    const item = document.createElement('div')
    item.className = 'subagent-item'
    item.dataset.pid = sub.pid

    const info = document.createElement('div')
    info.className = 'subagent-info'

    const cmd = document.createElement('div')
    cmd.className = 'subagent-cmd'
    cmd.title = sub.cmd || ''
    cmd.textContent = (sub.name || sub.cmd || `PID ${sub.pid}`).slice(0, 80)
    info.appendChild(cmd)

    const meta = document.createElement('div')
    meta.className = 'subagent-meta'
    meta.textContent = `pid ${sub.pid}` + (sub.session_key ? ` · ${_esc(sub.session_key)}` : '')
    info.appendChild(meta)

    item.appendChild(info)

    const stopBtn = document.createElement('button')
    stopBtn.type = 'button'
    stopBtn.className = 'subagent-stop-btn'
    stopBtn.textContent = t('agents.subagent_stop')
    stopBtn.title = 'SIGTERM'
    stopBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(t('agents.subagent_stop_confirm', sub.pid))) return
      stopBtn.disabled = true
      stopBtn.textContent = '...'
      try {
        const res = await fetch('/api/agents/subagents/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey: sub.session_key, pid: sub.pid }),
        })
        const data = await res.json()
        if (data.ok) {
          item.remove()
        } else {
          alert(data.error || t('agents.subagent_stop_failed'))
          stopBtn.disabled = false
    stopBtn.textContent = t('agents.subagent_stop')
        }
      } catch (err) {
        alert(t('agents.subagent_stop_failed') + ': ' + err.message)
        stopBtn.disabled = false
        stopBtn.textContent = t('agents.subagent_stop')
      }
    })
    item.appendChild(stopBtn)

    section.appendChild(item)
  }

  list.prepend(section)
}

// ── Recent agents from /api/recent-agents ──────────────────────────────────

async function _loadRecentAgents() {
  const list = document.getElementById('agent-list')
  if (!list) return

  // Remove any existing recent section
  list.querySelector('.recent-agent-section')?.remove()

  let entries = []
  try {
    entries = await fetch('/api/recent-agents').then(r => r.json())
  } catch {
    return
  }
  if (!entries || !entries.length) return

  const section = document.createElement('div')
  section.className = 'recent-agent-section'

  const title = document.createElement('div')
  title.className = 'recent-agent-title'
  title.textContent = t('agents.recent_title')
  section.appendChild(title)

  for (const entry of entries) {
    const item = document.createElement('div')
    item.className = 'recent-agent-item'
    item.title = `${entry.projectName} · ${entry.sessionId}`

    const dot = document.createElement('span')
    dot.className = 'recent-agent-active-dot' + (entry.active ? ' active' : '')
    item.appendChild(dot)

    const info = document.createElement('div')
    info.className = 'recent-agent-info'

    const proj = document.createElement('div')
    proj.className = 'recent-agent-proj'
    proj.textContent = entry.projectName
    info.appendChild(proj)

    const summary = document.createElement('div')
    summary.className = 'recent-agent-summary'
    summary.textContent = entry.summary || t('agents.no_summary')
    info.appendChild(summary)

    item.appendChild(info)

    const time = document.createElement('div')
    time.className = 'recent-agent-time'
    time.textContent = entry.relTime
    item.appendChild(time)

    item.addEventListener('click', () => _resumeSession(entry))
    section.appendChild(item)
  }

  // Prepend above the existing agent items
  list.prepend(section)
}

/**
 * Navigate to a project and resume the given session.
 * 1. Ensure the project exists in the store (POST if not found).
 * 2. Navigate to the project workspace via hash routing.
 * 3. Dispatch a custom event so terminal-view can open/focus the correct session tab.
 */
async function _resumeSession(entry) {
  // Use the real cwd returned by /api/recent-agents (read from jsonl).
  // Fallback to heuristic dir-name decoding only for old entries that pre-date the cwd field.
  // The heuristic is ambiguous for paths with '-' in directory names (e.g. meshy-dcc-pipeline),
  // so we always prefer entry.cwd when present.
  const cwd = entry.cwd || entry.projectDir.replace(/^-/, '/').replace(/-/g, '/')

  // Find project in current state or create it
  let project = null
  try {
    const projects = await fetch('/api/projects').then(r => r.json())
    project = projects.find(p => p.cwd === cwd)
    if (!project) {
      project = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: entry.projectName, cwd }),
      }).then(r => r.json())
    }
  } catch (err) {
    console.error('[recent-agents] failed to ensure project', err)
    return
  }

  // Close the drawer
  document.getElementById('agent-drawer')?.classList.remove('open')
  document.getElementById('agent-drawer-backdrop')?.classList.remove('open')
  document.getElementById('agent-drawer-toggle')?.classList.remove('active')

  // Signal terminal-view to resume this session after navigation
  // The sessionId is stored so the tab-manager can pick it up
  window.__pendingResumeSession = { projectId: project.id, sessionId: entry.sessionId }

  // Navigate to the project workspace
  const allProjects = await fetch('/api/projects').then(r => r.json()).catch(() => [project])
  const host = project.ssh_host
    ? project.ssh_host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : 'local'
  const base = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
  location.hash = `#/${host}/${base}`

  // After a tick, dispatch the resume event so terminal-view can handle it
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('nanocode:resume-session', {
      detail: { projectId: project.id, sessionId: entry.sessionId },
    }))
  }, 600)
}

function _render() {
  const list = document.getElementById('agent-list')
  if (!list) return

  // Preserve recent-agent and discover sections if present
  const recentSection = list.querySelector('.recent-agent-section')
  const discoverSection = list.querySelector('.agent-discover-section')
  list.innerHTML = ''
  if (recentSection) list.appendChild(recentSection)
  if (discoverSection) list.appendChild(discoverSection)

  if (!_agents.length) {
    const empty = document.createElement('div')
    empty.className = 'agent-list-empty'
    empty.textContent = t('agents.no_agents')
    list.appendChild(empty)
    return
  }

  for (const agent of _agents) {
    const item = document.createElement('div')
    item.className = 'agent-item'
    item.dataset.id = agent.id
    item.innerHTML = `
      <span class="agent-status-dot ${agent.status || 'unknown'}"></span>
      <div class="agent-info">
        <span class="agent-name">${_esc(agent.name)}</span>
        <div class="agent-meta">
          <span class="agent-type-badge ${agent.type}">${_esc(agent.type)}</span>
          ${agent.tmuxWindow ? `<span class="agent-tmux-label">${_esc(agent.tmuxWindow)}</span>` : ''}
        </div>
      </div>
      <div class="agent-actions">
        <button type="button" class="svc-btn agent-edit-btn" title="Rename">&#9998;</button>
        <button type="button" class="svc-btn agent-del-btn" title="Delete">&#10005;</button>
      </div>`

    // Click agent-info → close drawer (terminal is the default view in upstream)
    item.querySelector('.agent-info').addEventListener('click', () => {
      document.getElementById('agent-drawer')?.classList.remove('open')
      document.getElementById('agent-drawer-backdrop')?.classList.remove('open')
      document.getElementById('agent-drawer-toggle')?.classList.remove('active')
    })

    item.querySelector('.agent-del-btn').addEventListener('click', async (e) => {
      e.stopPropagation()
      _agents = _agents.filter(a => a.id !== agent.id)
      await _save()
    })

    item.querySelector('.agent-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      const nameEl = item.querySelector('.agent-name')
      const old = nameEl.textContent
      nameEl.innerHTML = `<input type="text" class="settings-input" value="${_esc(old)}" style="width:100%;font-size:12px;padding:2px 6px" />`
      const input = nameEl.querySelector('input')
      input.focus(); input.select()
      async function commit() {
        const newName = input.value.trim() || old
        const a = _agents.find(a => a.id === agent.id)
        if (a && a.name !== newName) { a.name = newName; await _save(); } else { _render() }
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit() }
        if (ev.key === 'Escape') _render()
      })
    })

    list.appendChild(item)
  }
}

// 【保留·暂隐藏】Discovered = 扫描 tmux 窗口发现外部 agent。当前工作流已全在 nanocode 内，面板入口隐藏以保持清爽；功能代码保留，以后做"监控 subagent"(自动发现并监控 tmux agent)会用到。
async function _discover() {
  const list = document.getElementById('agent-list')
  if (!list) return
  // Remove existing discover section
  list.querySelector('.agent-discover-section')?.remove()
  try {
    const windows = await fetch('/api/agents/discover').then(r => r.json())
    if (!windows.length) return
    const existingTargets = new Set(_agents.map(a => a.tmuxWindow).filter(Boolean))
    const fresh = windows.filter(w => !existingTargets.has(w.tmuxWindow))
    if (!fresh.length) return

    const section = document.createElement('div')
    section.className = 'agent-discover-section'
    section.innerHTML = `<div class="agent-discover-title">Discovered — click + to add</div>` +
      fresh.map(w => `
        <div class="agent-discover-item">
          <span class="agent-type-badge ${w.type}">${_esc(w.type)}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(w.name)}</span>
          <button type="button" class="btn btn-secondary" data-tmux="${_esc(w.tmuxWindow)}" data-name="${_esc(w.name)}" data-type="${w.type}">+</button>
        </div>`).join('')

    section.querySelectorAll('button[data-tmux]').forEach(btn => {
      btn.addEventListener('click', async () => {
        _agents = [..._agents, {
          id: crypto.randomUUID(),
          name: btn.dataset.name,
          type: btn.dataset.type,
          tmuxWindow: btn.dataset.tmux,
        }]
        await _save()
        section.remove()
      })
    })

    list.prepend(section)
  } catch {}
}

async function _save() {
  try {
    await fetch('/api/agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_agents.map(({ status, ...a }) => a)),
    })
    await _loadAgents()
  } catch {}
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
