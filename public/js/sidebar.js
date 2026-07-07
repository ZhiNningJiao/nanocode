/** Sidebar — project list with add/delete, active project indicator. */

import { state } from './state.js'
import { fetchProjects, createProject, deleteProject, fetchDir, fetchDrives, testSsh } from './api.js'

let _onProjectSwitch = null
let browsePath = ''
// MES-13804: server-reported platform ('win32' | 'posix'), stashed from each
// /api/fs response so the breadcrumb and path-join use the right separator.
let browsePlatform = 'posix'

const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed'

function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed)
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0') } catch {}
}

function loadSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
}

/**
 * Initialize the sidebar.
 */
export function initSidebar(onProjectSwitch) {
  _onProjectSwitch = onProjectSwitch

  const sidebar = document.getElementById('sidebar')
  const toggleBtn = document.getElementById('sidebar-toggle')
  if (toggleBtn && sidebar) {
    let backdrop = document.querySelector('.sidebar-backdrop')
    if (!backdrop) {
      backdrop = document.createElement('div')
      backdrop.className = 'sidebar-backdrop'
      sidebar.parentNode.insertBefore(backdrop, sidebar.nextSibling)
    }

    // Restore desktop collapsed state on load
    applySidebarCollapsed(loadSidebarCollapsed())

    const mql = window.matchMedia('(max-width: 768px)')
    toggleBtn.addEventListener('click', () => {
      if (mql.matches) {
        // Mobile: slide-in overlay
        const open = sidebar.classList.toggle('open')
        backdrop.classList.toggle('open', open)
      } else {
        // Desktop: collapse to zero-width
        applySidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'))
      }
    })
    backdrop.addEventListener('click', () => {
      sidebar.classList.remove('open')
      backdrop.classList.remove('open')
    })
  }

  document.getElementById('project-add').addEventListener('click', openAddDialog)

  const dialog = document.getElementById('add-project-dialog')
  const form = document.getElementById('add-project-form')
  const cancelBtn = document.getElementById('proj-cancel')
  const selectFolderBtn = document.getElementById('folder-select-btn')

  cancelBtn?.addEventListener('click', () => {
    dialog.close()
    // If no active project, return to landing
    if (!state.activeProjectId) {
      location.hash = '#/local'
    }
  })
  selectFolderBtn?.addEventListener('click', selectCurrentFolder)

  // MES-13804: "Up one level" + "Computer" toolbar for cross-platform nav.
  const upBtn = document.getElementById('folder-up-btn')
  const drivesBtn = document.getElementById('folder-drives-btn')
  upBtn?.addEventListener('click', () => {
    if (!upBtn.disabled && upBtn.dataset.parent) loadFolder(upBtn.dataset.parent)
  })
  drivesBtn?.addEventListener('click', loadDrives)

  const remoteToggle = document.getElementById('proj-remote-toggle')
  const localFields = document.getElementById('proj-local-fields')
  const remoteFields = document.getElementById('proj-remote-fields')

  if (remoteToggle) {
    remoteToggle.addEventListener('change', () => {
      const remote = remoteToggle.checked
      if (localFields) localFields.hidden = remote
      if (remoteFields) remoteFields.hidden = !remote
      document.getElementById('proj-cwd').value = ''
    })
  }

  // When the user types a path directly, auto-fill the project name
  // from its last segment — same convenience the SSH form provides.
  const cwdInput = document.getElementById('proj-cwd')
  const nameInput = document.getElementById('proj-name')
  if (cwdInput && nameInput) {
    cwdInput.addEventListener('input', () => {
      if (nameInput.dataset.manual) return
      const segs = cwdInput.value.trim().replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
      const last = segs[segs.length - 1] || ''
      if (last) nameInput.value = last
    })
    nameInput.addEventListener('input', () => { nameInput.dataset.manual = '1' })
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = document.getElementById('proj-name').value.trim()
    const isRemote = remoteToggle?.checked
    const cwd = isRemote
      ? document.getElementById('proj-remote-dir').value.trim()
      : document.getElementById('proj-cwd').value.trim()
    if (!name || !cwd) return

    const body = { name, cwd }
    if (isRemote) {
      body.ssh_host = document.getElementById('proj-ssh-host').value.trim()
      body.ssh_user = document.getElementById('proj-ssh-user').value.trim() || undefined
      const port = parseInt(document.getElementById('proj-ssh-port').value, 10)
      if (port) body.ssh_port = port
      body.ssh_key = document.getElementById('proj-ssh-key').value.trim() || undefined
      if (!body.ssh_host) return
    }

    try {
      const project = await createProject(body)
      state.projects = await fetchProjects()
      renderSidebar()
      switchProject(project.id)
      dialog.close()
    } catch (err) {
      console.error(err)
    }
  })
}

/**
 * Render the list of available projects.
 */
let _searchQuery = ''

export function renderSidebar() {
  const container = document.getElementById('sidebar-projects')
  if (!container) return

  container.textContent = ''

  // Search input (shown when 4+ projects)
  if (state.projects.length >= 4) {
    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.className = 'sidebar-search'
    searchInput.placeholder = 'Search projects…'
    searchInput.value = _searchQuery
    searchInput.addEventListener('input', () => {
      _searchQuery = searchInput.value
      renderSidebar()
    })
    container.appendChild(searchInput)
    if (_searchQuery) searchInput.focus()
  } else {
    _searchQuery = ''
  }

  // Empty state guidance
  if (state.projects.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sidebar-empty'
    empty.textContent = 'No projects yet. Click + to add one.'
    container.appendChild(empty)
    return
  }

  const query = _searchQuery.toLowerCase()
  const filtered = query
    ? state.projects.filter((p) => p.name.toLowerCase().includes(query) || (p.ssh_host || '').toLowerCase().includes(query))
    : state.projects

  for (const project of filtered) {
    const item = document.createElement('button')
    item.className =
      'sidebar-project' + (project.id === state.activeProjectId ? ' active' : '')
    item.type = 'button'

    const name = document.createElement('span')
    name.className = 'sidebar-project-name'
    name.textContent = project.name
    item.appendChild(name)

    if (project.ssh_host) {
      const badge = document.createElement('span')
      badge.className = 'sidebar-project-ssh'
      badge.textContent = 'SSH'
      badge.title = `${project.ssh_user || 'root'}@${project.ssh_host}`
      item.appendChild(badge)
    }

    item.addEventListener('click', () => switchProject(project.id))

    if (state.projects.length > 1) {
      const del = document.createElement('span')
      del.className = 'sidebar-project-del'
      del.textContent = '×'
      del.title = 'Delete project'
      del.addEventListener('click', async (event) => {
        event.stopPropagation()
        if (!confirm('Delete this project? Terminal sessions will end.')) return
        await deleteProject(project.id)
        state.projects = await fetchProjects()
        if (state.activeProjectId === project.id) {
          const next = state.projects[0]?.id || null
          switchProject(next)
        }
        renderSidebar()
      })
      item.appendChild(del)
    }

    container.appendChild(item)
  }
}

function switchProject(projectId) {
  if (projectId === state.activeProjectId) return
  state.activeProjectId = projectId
  try {
    localStorage.setItem('activeProjectId', projectId)
  } catch {}
  renderSidebar()

  const sidebar = document.getElementById('sidebar')
  const backdrop = document.querySelector('.sidebar-backdrop')
  if (sidebar) sidebar.classList.remove('open')
  if (backdrop) backdrop.classList.remove('open')

  if (_onProjectSwitch) _onProjectSwitch(projectId)
}

function openAddDialog() {
  const nameInput = document.getElementById('proj-name')
  nameInput.value = ''
  delete nameInput.dataset.manual
  document.getElementById('proj-cwd').value = ''
  const toggle = document.getElementById('proj-remote-toggle')
  if (toggle) toggle.checked = false
  const local = document.getElementById('proj-local-fields')
  const remote = document.getElementById('proj-remote-fields')
  if (local) local.hidden = false
  if (remote) remote.hidden = true
  for (const id of ['proj-ssh-host', 'proj-ssh-user', 'proj-ssh-port', 'proj-ssh-key', 'proj-remote-dir']) {
    const el = document.getElementById(id)
    if (el) el.value = ''
  }
  browsePath = ''
  loadFolder('')
  document.getElementById('add-project-dialog').showModal()
}

function selectCurrentFolder() {
  if (!browsePath) return
  document.getElementById('proj-cwd').value = browsePath
  const segs = browsePath.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
  const name = segs.length ? segs[segs.length - 1] : ''
  const nameInput = document.getElementById('proj-name')
  if (name && !nameInput.value.trim()) nameInput.value = name
}

// True if a path looks like a Windows drive-prefixed path (C:\ or C:/).
function isWinPath(p) {
  return /^([A-Za-z]:)[\\/]/.test(p || '')
}

// Join a base directory and a child name with the correct separator for the
// path's platform. Handles drive root (C:\) + name → C:\name.
function joinPath(base, name, platform) {
  if (!base) return name
  const win = platform === 'win32' || isWinPath(base)
  const sep = win ? '\\' : '/'
  if (base === '/') return '/' + name
  if (win && /^[A-Za-z]:\\?$/.test(base)) return base + name
  return base + sep + name
}

async function loadDrives() {
  try {
    const data = await fetchDrives()
    if (data.platform) browsePlatform = data.platform
    browsePath = ''
    renderBreadcrumb('')
    renderDriveList(data.drives || [])
    const upBtn = document.getElementById('folder-up-btn')
    if (upBtn) { upBtn.disabled = true; delete upBtn.dataset.parent }
    const cur = document.getElementById('folder-current')
    if (cur) cur.textContent = 'Computer'
  } catch (err) {
    console.error(err)
  }
}

function renderDriveList(drives) {
  const el = document.getElementById('folder-list')
  if (!el) return
  el.textContent = ''
  for (const d of drives) {
    if (!d.isDir) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = d.name
    btn.title = d.name
    btn.addEventListener('click', () => loadFolder(d.name))
    el.appendChild(btn)
  }
}

async function loadFolder(path) {
  try {
    const data = await fetchDir(path || undefined)
    if (data.platform) browsePlatform = data.platform
    browsePath = data.path
    renderBreadcrumb(data.path)
    renderFolderList(data.entries || [], data.path)
    const upBtn = document.getElementById('folder-up-btn')
    if (upBtn) {
      if (data.parent) {
        upBtn.disabled = false
        upBtn.dataset.parent = data.parent
      } else {
        upBtn.disabled = true
        delete upBtn.dataset.parent
      }
    }
    const cur = document.getElementById('folder-current')
    if (cur) cur.textContent = data.path || '(home)'
  } catch (err) {
    console.error(err)
  }
}

function renderBreadcrumb(path) {
  const el = document.getElementById('folder-breadcrumb')
  if (!el) return
  el.textContent = ''

  // "Computer" anchor → drive list (Windows) / root (POSIX, single '/').
  const comp = document.createElement('a')
  comp.href = '#'
  comp.textContent = 'Computer'
  comp.title = 'Drives / filesystem roots'
  comp.addEventListener('click', (event) => {
    event.preventDefault()
    loadDrives()
  })
  el.appendChild(comp)

  // POSIX-only convenience: "/" root + "Home" anchors so users can still jump
  // to /opt, /srv, etc. On Windows these are meaningless (no '/').
  if (browsePlatform !== 'win32' && !isWinPath(path)) {
    el.appendChild(document.createTextNode(' '))
    const rootLink = document.createElement('a')
    rootLink.href = '#'
    rootLink.textContent = '/'
    rootLink.title = 'Filesystem root'
    rootLink.addEventListener('click', (event) => {
      event.preventDefault()
      loadFolder('/')
    })
    el.appendChild(rootLink)

    el.appendChild(document.createTextNode(' '))
    const homeLink = document.createElement('a')
    homeLink.href = '#'
    homeLink.textContent = 'Home'
    homeLink.title = 'Your home directory'
    homeLink.addEventListener('click', (event) => {
      event.preventDefault()
      loadFolder('')
    })
    el.appendChild(homeLink)
  }

  if (!path) return

  if (isWinPath(path)) {
    // Windows: drive root + remaining segments, '\' separated.
    const m = path.match(/^([A-Za-z]:[\\/])/)
    const driveRoot = m ? m[1] : null
    if (driveRoot) {
      el.appendChild(document.createTextNode(' \\ '))
      const dlink = document.createElement('a')
      dlink.href = '#'
      dlink.textContent = driveRoot
      dlink.title = driveRoot
      dlink.addEventListener('click', (event) => {
        event.preventDefault()
        loadFolder(driveRoot)
      })
      el.appendChild(dlink)
    }
    const rest = path.slice(driveRoot ? driveRoot.length : 0).split(/[\\/]+/).filter(Boolean)
    let acc = driveRoot || ''
    for (const seg of rest) {
      acc = joinPath(acc, seg, 'win32')
      el.appendChild(document.createTextNode(' \\ '))
      const link = document.createElement('a')
      link.href = '#'
      link.textContent = seg
      link.addEventListener('click', (event) => {
        event.preventDefault()
        loadFolder(acc)
      })
      el.appendChild(link)
    }
    return
  }

  // POSIX path.
  if (path === '/') return
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const segPath = '/' + parts.slice(0, i + 1).join('/')
    el.appendChild(document.createTextNode(' / '))
    const link = document.createElement('a')
    link.href = '#'
    link.textContent = parts[i]
    link.addEventListener('click', (event) => {
      event.preventDefault()
      loadFolder(segPath)
    })
    el.appendChild(link)
  }
}

function renderFolderList(entries, currentPath) {
  const el = document.getElementById('folder-list')
  if (!el) return
  el.textContent = ''

  for (const entry of entries) {
    if (!entry.isDir) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = entry.name
    const nextPath = joinPath(currentPath, entry.name, browsePlatform)
    btn.addEventListener('click', () => loadFolder(nextPath))
    el.appendChild(btn)
  }
}
