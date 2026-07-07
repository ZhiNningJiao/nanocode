/**
 * Branch Compare panel — toggled from the Explorer header.
 *
 *   createGitCompare(container) → { show(projectId), hide(), switchProject(id) }
 *
 * Repo-scoped flow (works from a top-level ~zhining launch, where the session
 * cwd is not itself a git repo):
 *   1. GET /api/repos              → dropdown of git repos/worktrees under ~/code
 *   2. GET /api/repos/branches    → `git fetch --all --prune` + branches by
 *      ?path=<repo>                  most recent commit (local + remote)
 *   3. GET /api/repos/compare     → diff between two selected refs
 *      ?path=<repo>&base=&head=
 *
 * Renders a file list with status / +/- counts and expandable per-file diffs
 * (highlighted via the globally-loaded hljs UMD).
 *
 * Visibility is driven by the `nanocode:toggle-compare` custom event (dispatched
 * from the explorer header button) and an internal close button.
 */

import { fetchRepos, fetchRepoBranches, fetchRepoCompare, fetchProjects } from './api.js'

const STATUS_BADGE = {
  M: { label: 'M', title: 'Modified', cls: 'st-mod' },
  A: { label: 'A', title: 'Added', cls: 'st-add' },
  D: { label: 'D', title: 'Deleted', cls: 'st-del' },
  R: { label: 'R', title: 'Renamed', cls: 'st-ren' },
  C: { label: 'C', title: 'Copied', cls: 'st-ren' },
  T: { label: 'T', title: 'Type changed', cls: 'st-mod' },
  U: { label: 'U', title: 'Unmerged', cls: 'st-del' },
}

/** Compact relative time, e.g. "3h ago", "2d ago". */
function relTime(ts) {
  if (!ts || !Number.isFinite(ts)) return ''
  const s = Math.max(0, Math.floor((Date.now() / 1000) - ts))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

export function createGitCompare(container) {
  let projectId = null
  let repos = []
  let repoPath = ''
  let branches = []
  let current = null
  let defaultBranch = null
  let lastBase = ''
  let lastHead = ''
  let loading = false
  let loadingBranches = false
  // Monotonic token so a stale branch fetch (from a previous repo selection)
  // does not overwrite the selectors after the user switched repos. Each
  // loadBranches() call increments this and only commits results if it is
  // still the latest.
  let loadBranchesToken = 0

  container.innerHTML = ''
  container.classList.add('compare')

  // --- DOM skeleton ---
  const header = document.createElement('div')
  header.className = 'compare-header'

  const title = document.createElement('div')
  title.className = 'compare-title'
  title.textContent = 'Compare'
  header.appendChild(title)

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'explorer-icon-btn'
  closeBtn.title = 'Close compare (back to explorer)'
  closeBtn.innerHTML = closeIcon()
  closeBtn.addEventListener('click', () => hide())
  header.appendChild(closeBtn)

  // --- Repo selector row (new) ---
  const repoRow = document.createElement('div')
  repoRow.className = 'compare-repo-row'

  const repoSel = document.createElement('select')
  repoSel.className = 'compare-select compare-repo-select'
  repoSel.title = 'Repository (under ~/code)'
  repoSel.appendChild(emptyOption('Loading repos…', ''))

  const refreshBtn = document.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.className = 'explorer-icon-btn'
  refreshBtn.title = 'Refresh repos + branches'
  refreshBtn.innerHTML = refreshIcon()
  refreshBtn.addEventListener('click', () => {
    if (repoPath) loadBranches(true)
    else loadRepos(true)
  })

  repoRow.append(repoSel, refreshBtn)
  header.appendChild(repoRow)

  // --- Branch selector toolbar (existing) ---
  const toolbar = document.createElement('div')
  toolbar.className = 'compare-toolbar'

  const baseSel = document.createElement('select')
  baseSel.className = 'compare-select'
  baseSel.title = 'Base branch'
  baseSel.disabled = true
  baseSel.appendChild(emptyOption('— base —', ''))
  const baseLabel = document.createElement('span')
  baseLabel.className = 'compare-arrow'
  baseLabel.textContent = '←'

  const headSel = document.createElement('select')
  headSel.className = 'compare-select'
  headSel.title = 'Head branch'
  headSel.disabled = true
  headSel.appendChild(emptyOption('— head —', ''))

  const swapBtn = document.createElement('button')
  swapBtn.type = 'button'
  swapBtn.className = 'explorer-icon-btn'
  swapBtn.title = 'Swap base/head'
  swapBtn.innerHTML = swapIcon()
  swapBtn.addEventListener('click', () => {
    const b = baseSel.value
    baseSel.value = headSel.value
    headSel.value = b
    runCompare()
  })

  const loadBtn = document.createElement('button')
  loadBtn.type = 'button'
  loadBtn.className = 'btn btn-secondary compare-load-btn'
  loadBtn.textContent = 'Diff'
  loadBtn.addEventListener('click', () => runCompare())

  toolbar.append(baseSel, baseLabel, headSel, swapBtn, loadBtn)
  header.appendChild(toolbar)

  const summary = document.createElement('div')
  summary.className = 'compare-summary'
  summary.hidden = true
  header.appendChild(summary)

  const status = document.createElement('div')
  status.className = 'compare-status'

  const body = document.createElement('div')
  body.className = 'compare-body'

  container.append(header, status, body)

  repoSel.addEventListener('change', () => {
    repoPath = repoSel.value || ''
    // reset branch selectors
    baseSel.innerHTML = ''
    headSel.innerHTML = ''
    baseSel.appendChild(emptyOption('— base —', ''))
    headSel.appendChild(emptyOption('— head —', ''))
    baseSel.disabled = true
    headSel.disabled = true
    summary.hidden = true
    body.innerHTML = ''
    if (repoPath) loadBranches()
    else setStatus('Pick a repository to list its branches.')
  })
  baseSel.addEventListener('change', () => { lastBase = baseSel.value; runCompare() })
  headSel.addEventListener('change', () => { lastHead = headSel.value; runCompare() })

  // --- Logic ---

  function emptyOption(text, value) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    return o
  }

  function setStatus(msg, isError) {
    status.textContent = msg || ''
    status.classList.toggle('error', !!isError && !!msg)
  }

  function populateRepos(list, preferPath) {
    repos = list || []
    repoSel.innerHTML = ''
    if (!repos.length) {
      repoSel.appendChild(emptyOption('No repos found under ~/code', ''))
      repoSel.disabled = true
      setStatus('No git repos found under ~/code.')
      return
    }
    repoSel.disabled = false
    for (const r of repos) {
      const o = document.createElement('option')
      o.value = r.path
      const tag = r.isWorktree ? ' [wt]' : ''
      o.textContent = `${r.name}${tag} · ${r.branch || '(detached)'}`
      o.title = r.path
      repoSel.appendChild(o)
    }
    let chosen = ''
    if (preferPath && repos.some((r) => r.path === preferPath)) {
      chosen = preferPath
    } else {
      chosen = repos[0].path
    }
    repoSel.value = chosen
    repoPath = chosen
  }

  async function loadRepos(forceRefresh = false) {
    setStatus('Scanning ~/code for repos…')
    try {
      // Pre-select the repo matching the current project's cwd, if any.
      let preferPath = ''
      if (projectId) {
        try {
          const projects = await fetchProjects()
          const p = projects.find((x) => x.id === projectId)
          if (p && p.cwd) preferPath = p.cwd
        } catch { /* ignore — fallback to first repo */ }
      }
      const data = await fetchRepos()
      populateRepos(data.repos, preferPath)
      if (repos.length) {
        setStatus('')
        await loadBranches(forceRefresh)
      }
    } catch (e) {
      setStatus('Failed to scan repos: ' + (e.message || e), true)
    }
  }

  function populateBranches(data) {
    branches = data.branches || []
    current = data.current
    defaultBranch = data.defaultBranch
    baseSel.innerHTML = ''
    headSel.innerHTML = ''
    if (!branches.length) {
      baseSel.disabled = true
      headSel.disabled = true
      baseSel.appendChild(emptyOption('— no branches —', ''))
      headSel.appendChild(emptyOption('— no branches —', ''))
      return
    }
    for (const b of branches) {
      const txt = formatBranchOption(b)
      baseSel.appendChild(makeOption(b.name, txt))
      headSel.appendChild(makeOption(b.name, txt))
    }
    baseSel.disabled = false
    headSel.disabled = false
    // Defaults: base = default branch, head = current (or first non-default)
    let baseV = defaultBranch || (branches[0] && branches[0].name) || ''
    let headV = current || baseV
    if (headV === baseV) {
      const other = branches.find((b) => b.name !== baseV)
      if (other) headV = other.name
    }
    lastBase = baseV
    lastHead = headV
    baseSel.value = baseV
    headSel.value = headV
  }

  function makeOption(value, text) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    return o
  }

  function formatBranchOption(b) {
    const when = relTime(b.lastCommitTs)
    const subj = b.subject ? ` · ${truncate(b.subject, 40)}` : ''
    const whenStr = when ? `  (${when})` : ''
    const remote = b.isRemote ? '⤴ ' : ''
    return `${remote}${b.name}${whenStr}${subj}`
  }

  function truncate(s, n) {
    if (!s) return ''
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  async function loadBranches(forceRefresh = false) {
    if (!repoPath) return
    // Don't drop the call if a previous load is in flight — that would
    // silently ignore a repo switch. Instead, stamp this call with a token
    // and let stale fetches no-op on return.
    const token = ++loadBranchesToken
    loadingBranches = true
    baseSel.disabled = true
    headSel.disabled = true
    setStatus(forceRefresh ? 'Fetching + listing branches…' : 'Listing branches…')
    body.innerHTML = ''
    summary.hidden = true
    try {
      const data = await fetchRepoBranches(repoPath)
      if (token !== loadBranchesToken) return // stale — a newer load superseded us
      populateBranches(data)
      setStatus('')
      if (baseSel.value && headSel.value && baseSel.value !== headSel.value) {
        await runCompare()
      } else if (branches.length < 2) {
        setStatus(branches.length ? 'Only one branch — nothing to compare.' : 'No branches found.')
      }
    } catch (e) {
      if (token !== loadBranchesToken) return // stale
      setStatus('Failed to load branches: ' + (e.message || e), true)
    } finally {
      if (token === loadBranchesToken) loadingBranches = false
    }
  }

  async function runCompare() {
    if (!repoPath) return
    const base = baseSel.value
    const head = headSel.value
    if (!base || !head) return
    if (base === head) {
      summary.hidden = true
      body.innerHTML = ''
      setStatus('Base and head are the same branch.')
      return
    }
    lastBase = base
    lastHead = head
    if (loading) return
    loading = true
    loadBtn.disabled = true
    setStatus('Computing diff…')
    body.innerHTML = ''
    summary.hidden = true
    try {
      const data = await fetchRepoCompare(repoPath, base, head)
      renderSummary(data)
      renderFiles(data.files || [])
      setStatus(data.files.length ? '' : 'No differences between these branches.')
    } catch (e) {
      setStatus('Diff failed: ' + (e.message || e), true)
    } finally {
      loading = false
      loadBtn.disabled = false
    }
  }

  function renderSummary(data) {
    summary.hidden = false
    summary.innerHTML = ''
    const span = (txt, cls) => {
      const s = document.createElement('span')
      s.className = 'compare-badge ' + cls
      s.textContent = txt
      return s
    }
    summary.append(
      span(`${data.base} → ${data.head}`, 'cb-range'),
      span(`${data.ahead} ahead`, data.ahead > 0 ? 'cb-ahead-active' : ''),
      span(`${data.behind} behind`, data.behind > 0 ? 'cb-behind-active' : ''),
    )
  }

  function renderFiles(files) {
    body.innerHTML = ''
    if (!files.length) {
      const empty = document.createElement('div')
      empty.className = 'compare-empty'
      empty.textContent = 'No file changes.'
      body.appendChild(empty)
      return
    }
    const list = document.createElement('div')
    list.className = 'compare-filelist'
    for (const f of files) {
      list.appendChild(renderFileRow(f))
    }
    body.appendChild(list)
  }

  function renderFileRow(f) {
    const row = document.createElement('div')
    row.className = 'compare-file-row'

    const head = document.createElement('div')
    head.className = 'compare-file-head'
    head.tabIndex = 0
    head.setAttribute('role', 'button')
    head.setAttribute('aria-expanded', 'false')

    const badge = STATUS_BADGE[f.status] || STATUS_BADGE.M
    const stEl = document.createElement('span')
    stEl.className = 'compare-st ' + badge.cls
    stEl.textContent = badge.label
    stEl.title = badge.title
    head.appendChild(stEl)

    const pathEl = document.createElement('span')
    pathEl.className = 'compare-file-path'
    pathEl.textContent = f.path
    pathEl.title = f.path
    head.appendChild(pathEl)

    const statEl = document.createElement('span')
    statEl.className = 'compare-file-stat'
    if (f.binary) {
      statEl.textContent = 'binary'
    } else {
      const add = f.additions || 0
      const del = f.deletions || 0
      if (add) {
        const a = document.createElement('span')
        a.className = 'stat-add'
        a.textContent = `+${add}`
        statEl.appendChild(a)
      }
      if (del) {
        const d = document.createElement('span')
        d.className = 'stat-del'
        d.textContent = `−${del}`
        statEl.appendChild(d)
      }
    }
    head.appendChild(statEl)

    const chev = document.createElement('span')
    chev.className = 'compare-chev'
    chev.innerHTML = chevIcon()
    head.appendChild(chev)

    const patchWrap = document.createElement('div')
    patchWrap.className = 'compare-patch'
    patchWrap.hidden = true

    const toggle = () => {
      const open = !patchWrap.hidden
      patchWrap.hidden = open
      head.setAttribute('aria-expanded', String(!open))
      chev.classList.toggle('open', !open)
      if (!open && !patchWrap.dataset.rendered) {
        renderPatch(patchWrap, f)
        patchWrap.dataset.rendered = '1'
      }
    }
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
    })

    row.append(head, patchWrap)
    return row
  }

  function renderPatch(wrap, f) {
    if (f.binary) {
      const note = document.createElement('div')
      note.className = 'compare-binary-note'
      note.textContent = 'Binary file — no text diff.'
      wrap.appendChild(note)
      return
    }
    const pre = document.createElement('pre')
    pre.className = 'compare-patch-pre'
    const code = document.createElement('code')
    code.className = 'language-diff'
    let patch = f.patch || ''
    if (f.truncated) {
      const trunc = document.createElement('div')
      trunc.className = 'compare-truncated-note'
      trunc.textContent = '⚠ patch truncated (>200 KB)'
      wrap.appendChild(trunc)
    }
    // Highlight with hljs if available, else plain text (escaped).
    if (window.hljs) {
      try {
        code.innerHTML = window.hljs.highlight(patch, { language: 'diff', ignoreIllegals: true }).value
      } catch {
        code.textContent = patch
      }
    } else {
      code.textContent = patch
    }
    pre.appendChild(code)
    wrap.appendChild(pre)
  }

  // --- Public API ---

  function show(id) {
    projectId = id
    container.hidden = false
    // Hide the explorer sibling so the compare panel fills the right pane.
    const explorerRoot = document.getElementById('explorer-root')
    if (explorerRoot) explorerRoot.hidden = true
    if (repos.length && repoPath) {
      // already loaded — just refresh branches for the current repo
      loadBranches(true)
    } else {
      loadRepos()
    }
  }

  function hide() {
    container.hidden = true
    const explorerRoot = document.getElementById('explorer-root')
    if (explorerRoot) explorerRoot.hidden = false
  }

  function switchProject(id) {
    projectId = id
    body.innerHTML = ''
    summary.hidden = true
    setStatus('')
    if (!container.hidden) {
      // Re-scan so the new project's cwd is pre-selected if it is a repo.
      loadRepos()
    }
  }

  return { show, hide, switchProject }
}

// --- icons ---

function closeIcon() {
  const s = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
  return `<svg width="14" height="14" viewBox="0 0 24 24" ${s}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
}

function swapIcon() {
  const s = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  return `<svg width="14" height="14" viewBox="0 0 24 24" ${s}><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`
}

function chevIcon() {
  const s = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  return `<svg width="10" height="10" viewBox="0 0 24 24" ${s}><polyline points="9 18 15 12 9 6"/></svg>`
}

function refreshIcon() {
  const s = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  return `<svg width="14" height="14" viewBox="0 0 24 24" ${s}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`
}
