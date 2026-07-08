/** REST API helpers. */

const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(
      data.error?.fieldErrors
        ? JSON.stringify(data.error)
        : data.error || 'Request failed'
    )
  }
  return data
}

export function fetchProjects() {
  return request('/projects')
}

export function createProject(body) {
  return request('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function deleteProject(id) {
  return fetch(`${BASE}/projects/${id}`, { method: 'DELETE' })
}

// --- Tabs (server-side, per-project) ---

export function fetchTabs(projectId) {
  return request(`/projects/${projectId}/tabs`)
}

export function createTab(projectId, opts = {}) {
  const body = {}
  if (opts.label) body.label = opts.label
  if (opts.type) body.type = opts.type
  if (opts.tmuxTarget) body.tmuxTarget = opts.tmuxTarget
  if (opts.claudeSessionId) body.claudeSessionId = opts.claudeSessionId
  if (opts.claudeConfigDir) body.claudeConfigDir = opts.claudeConfigDir
  if (opts.claudeSessionCwd) body.claudeSessionCwd = opts.claudeSessionCwd
  if (opts.fresh) body.fresh = true
  // 需求15 item1: opencode session id chosen in the Fable5/opencode resume
  // picker → forwarded to the server so the block driver resumes that session.
  if (opts.opencodeSessionId) body.opencodeSessionId = opts.opencodeSessionId
  // 需求8: persona id chosen in the new-session picker → forwarded to the
  // server, stored on the tab, re-injected each turn via --append-system-prompt.
  if (opts.persona) body.persona = opts.persona
  return request(`/projects/${projectId}/tabs`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function deleteTab(projectId, tabId) {
  return fetch(`${BASE}/projects/${projectId}/tabs/${tabId}`, { method: 'DELETE' })
}

export function patchTab(projectId, tabId, label) {
  return request(`/projects/${projectId}/tabs/${tabId}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  })
}

export function fetchSshHosts() {
  return request('/ssh-hosts')
}

export function testSsh(projectId) {
  return request(`/projects/${projectId}/test-ssh`, { method: 'POST' })
}

export function fetchDir(path) {
  const url = path ? `/fs?path=${encodeURIComponent(path)}` : '/fs'
  return request(url)
}

// MES-13804: top-level drive list for the cross-platform folder picker.
// Windows → C:\, D:\, …; POSIX/mac → a single '/' root entry.
export function fetchDrives() {
  return request('/fs?drives=1')
}

export function renameFsPath(projectId, from, to) {
  return request(`/projects/${projectId}/files/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  })
}

// ─── Git compare (branch diff) ────────────────────────────────────────────

export function fetchGitBranches(projectId) {
  return request(`/projects/${projectId}/git/branches`)
}

export function fetchGitCompare(projectId, base, head) {
  const q = new URLSearchParams({ base, head })
  return request(`/projects/${projectId}/git/compare?${q}`)
}

// ─── Repo-scoped git compare (top-level launch) ──────────────────────────
// These are independent of the project system: the server scans ~/code for
// git repos/worktrees, so compare works even when the session cwd (~zhining)
// is not itself a git repo.

export function fetchRepos() {
  return request('/repos')
}

export function fetchRepoBranches(repoPath) {
  const q = new URLSearchParams({ path: repoPath })
  return request(`/repos/branches?${q}`)
}

export function fetchRepoCompare(repoPath, base, head) {
  const q = new URLSearchParams({ path: repoPath, base, head })
  return request(`/repos/compare?${q}`)
}

// ─── Settings ─────────────────────────────────────────────────────────────

export function fetchSettings() {
  return request('/settings')
}

export function updateSetting(key, value) {
  return request('/settings', {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  })
}
