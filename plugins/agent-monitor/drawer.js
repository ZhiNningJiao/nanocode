/**
 * Agent manager right-side drawer.
 * Loads from /api/agents, persists via PUT /api/agents.
 * Also shows recent Claude sessions from /api/recent-agents for quick resume.
 *
 * Extracted from public/js/agents.js into the agent-monitor plugin (P5c).
 * initAgentDrawer() now returns { open, close } so the plugin's header entry
 * can toggle the drawer without depending on a hardcoded #agent-drawer-toggle
 * button in the header.
 */

let _agents = []

/** Dispatch a state event so the plugin's header entry can sync its active class. */
function _emitDrawerState(open) {
  document.dispatchEvent(new CustomEvent('agent-drawer:state', { detail: { open } }))
}

export function initAgentDrawer() {
  const drawer = document.getElementById('agent-drawer')
  if (!drawer) return null

  const backdrop = document.getElementById('agent-drawer-backdrop')
  const closeBtn = document.getElementById('agent-drawer-close')
  const discoverBtn = document.getElementById('agent-discover-btn')
  const addForm = document.getElementById('agent-add-form')

  function open() {
    drawer.classList.add('open')
    backdrop?.classList.add('open')
    _emitDrawerState(true)
    _loadAgents()
    _loadRecentAgents()
    _loadSubagents()
  }
  function close() {
    drawer.classList.remove('open')
    backdrop?.classList.remove('open')
    _emitDrawerState(false)
  }

  closeBtn?.addEventListener('click', close)
  backdrop?.addEventListener('click', close)
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

  return { open, close }
}

async function _loadAgents() {
  try {
    _agents = await fetch('/api/agents').then(r => r.json())
    _render()
  } catch {}
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
  title.textContent = `运行中 Sub-agents (${subagents.length})`
  section.appendChild(title)

  if (!subagents.length) {
    const empty = document.createElement('div')
    empty.className = 'subagent-empty'
    empty.textContent = '当前没有运行中的 sub-agent'
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
    stopBtn.textContent = '停止'
    stopBtn.title = 'SIGTERM'
    stopBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(`停止 sub-agent PID ${sub.pid}?`)) return
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
          alert(data.error || '停止失败')
          stopBtn.disabled = false
          stopBtn.textContent = '停止'
        }
      } catch (err) {
        alert('停止失败: ' + err.message)
        stopBtn.disabled = false
        stopBtn.textContent = '停止'
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
  title.textContent = '最近会话'
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
    summary.textContent = entry.summary || '(无摘要)'
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
  _emitDrawerState(false)

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
    empty.textContent = 'No agents configured. Add one below or click ⟳ to discover from tmux.'
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
      _emitDrawerState(false)
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
