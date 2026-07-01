/**
 * Branch Compare panel — toggled from the Explorer header.
 *
 *   createGitCompare(container) → { show(projectId), hide(), switchProject(id) }
 *
 * Fetches /api/projects/:id/git/branches and /api/projects/:id/git/compare,
 * renders a file list with status / +/- counts and expandable per-file diffs
 * (highlighted via the globally-loaded hljs UMD).
 *
 * Visibility is driven by the `nanocode:toggle-compare` custom event (dispatched
 * from the explorer header button) and an internal close button.
 */

import { fetchGitBranches, fetchGitCompare } from './api.js'

const STATUS_BADGE = {
  M: { label: 'M', title: 'Modified', cls: 'st-mod' },
  A: { label: 'A', title: 'Added', cls: 'st-add' },
  D: { label: 'D', title: 'Deleted', cls: 'st-del' },
  R: { label: 'R', title: 'Renamed', cls: 'st-ren' },
  C: { label: 'C', title: 'Copied', cls: 'st-ren' },
  T: { label: 'T', title: 'Type changed', cls: 'st-mod' },
  U: { label: 'U', title: 'Unmerged', cls: 'st-del' },
}

export function createGitCompare(container) {
  let projectId = null
  let branches = []
  let current = null
  let defaultBranch = null
  let lastBase = ''
  let lastHead = ''
  let expandedPaths = new Set()
  let loading = false

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

  const toolbar = document.createElement('div')
  toolbar.className = 'compare-toolbar'

  const baseSel = document.createElement('select')
  baseSel.className = 'compare-select'
  baseSel.title = 'Base branch'
  const baseLabel = document.createElement('span')
  baseLabel.className = 'compare-arrow'
  baseLabel.textContent = '←'

  const headSel = document.createElement('select')
  headSel.className = 'compare-select'
  headSel.title = 'Head branch'

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

  baseSel.addEventListener('change', () => { lastBase = baseSel.value; runCompare() })
  headSel.addEventListener('change', () => { lastHead = headSel.value; runCompare() })

  // --- Logic ---

  function setStatus(msg, isError) {
    status.textContent = msg || ''
    status.classList.toggle('error', !!isError && !!msg)
  }

  function populateBranches(data) {
    branches = data.branches || []
    current = data.current
    defaultBranch = data.defaultBranch
    const opts = branches.map((b) => {
      const o = document.createElement('option')
      o.value = b.name
      o.textContent = b.name + (b.isCurrent ? ' (HEAD)' : '')
      return o
    })
    baseSel.innerHTML = ''
    headSel.innerHTML = ''
    opts.forEach((o) => {
      baseSel.appendChild(o.cloneNode(true))
      headSel.appendChild(o.cloneNode(true))
    })
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

  async function loadBranches() {
    if (!projectId) return
    setStatus('Loading branches…')
    body.innerHTML = ''
    summary.hidden = true
    try {
      const data = await fetchGitBranches(projectId)
      populateBranches(data)
      setStatus('')
      if (baseSel.value && headSel.value && baseSel.value !== headSel.value) {
        await runCompare()
      } else if (branches.length < 2) {
        setStatus(branches.length ? 'Only one branch — nothing to compare.' : 'No branches found.')
      }
    } catch (e) {
      setStatus('Failed to load branches: ' + (e.message || e), true)
    }
  }

  async function runCompare() {
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
      const data = await fetchGitCompare(projectId, base, head)
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
    loadBranches()
  }

  function hide() {
    container.hidden = true
    const explorerRoot = document.getElementById('explorer-root')
    if (explorerRoot) explorerRoot.hidden = false
  }

  function switchProject(id) {
    projectId = id
    expandedPaths = new Set()
    body.innerHTML = ''
    summary.hidden = true
    setStatus('')
    if (!container.hidden) loadBranches()
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
