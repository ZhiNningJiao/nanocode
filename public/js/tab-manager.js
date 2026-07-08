/**
 * Multi-tab bash terminal manager.
 *
 * Tabs are server-side metadata (persisted in data/nanocode.json). Every
 * connected client subscribes to /ws/tabs and reflects the canonical list.
 * Opening the workspace on a second device shows the same tabs and
 * re-attaches to the same in-memory PTYs (via /ws/terminal + tabId).
 *
 * activeId is local-per-device (each browser remembers its own focused tab).
 */

import { TerminalPane } from './terminal-pane.js'
import { ClaudeBlockRenderer } from './claude-block-renderer.js'
import { CodexBlockRenderer } from './codex-block-renderer.js'
import { fetchTabs, createTab, deleteTab, patchTab } from './api.js'

const ACTIVE_KEY_PREFIX = 'activeTab:'

function loadActiveId(projectId) {
  try { return localStorage.getItem(ACTIVE_KEY_PREFIX + projectId) || null } catch { return null }
}
function saveActiveId(projectId, id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY_PREFIX + projectId, id)
    else localStorage.removeItem(ACTIVE_KEY_PREFIX + projectId)
  } catch {}
}

export class TabManager {
  /**
   * @param {{
   *   stripEl: HTMLElement,
   *   stackEl: HTMLElement,
   *   projectId: string,
   *   onActiveChange?: (pane: TerminalPane | null) => void,
   *   onStatusChange?: (connected: boolean) => void,
   * }} opts
   */
  constructor(opts) {
    this.stripEl = opts.stripEl
    this.stackEl = opts.stackEl
    this.projectId = opts.projectId
    this.onActiveChange = opts.onActiveChange || (() => {})
    this.onStatusChange = opts.onStatusChange || (() => {})

    // Carousel track — all pane DOM lives here side-by-side. The
    // track's translateX selects which pane is visible, and the CSS
    // transition is the slide animation. Created once per TabManager;
    // re-used across switchProject() calls.
    this.trackEl = document.createElement('div')
    this.trackEl.className = 'terminal-track no-anim'
    this.stackEl.appendChild(this.trackEl)

    /** @type {{ id: string, label: string, pane: TerminalPane, paneEl: HTMLElement }[]} */
    this.tabs = []
    this.activeId = null
    this._pendingActiveId = null  // set after POST so we focus the new tab when it arrives via broadcast
    this._creatingEmpty = false   // guard against duplicate auto-creates when list is empty

    // WS subscription
    this._ws = null
    this._wsBackoff = 500
    this._wsReconnectTimer = null
    this._disposed = false

    // Delegated double-click → rename
    this.stripEl.addEventListener('dblclick', (e) => {
      const chip = e.target.closest('.tab-chip')
      if (!chip) return
      e.preventDefault()
      e.stopPropagation()
      const id = chip.dataset.tabId
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return
      const label = chip.querySelector('.tab-chip-label')
      if (!label) return
      this._beginRename(tab, label, chip)
    })

    this._renderStrip()
  }

  /**
   * Initialize: subscribe to /ws/tabs. The first broadcast is a snapshot;
   * subsequent broadcasts arrive on every mutation.
   */
  restore() {
    this._connectWs()
  }

  /** Deprecated alias retained for callers. */
  ensureFirstTab() { this.restore() }

  // --- Public mutations ---

  async newTab(type = 'bash', extraOpts = {}) {
    try {
      const tab = await createTab(this.projectId, { type, ...extraOpts })
      this._pendingActiveId = tab.id
      // The WS broadcast that follows will add the tab + setActive.
      // But the server broadcasts BEFORE the POST response returns, so the
      // broadcast may have already arrived and added the tab without activating
      // it (because _pendingActiveId was still null). If the tab is already in
      // this.tabs, activate it now; otherwise the next broadcast will.
      if (this.tabs.some((t) => t.id === tab.id)) {
        this._pendingActiveId = null
        this.setActive(tab.id)
      }
      return tab.id
    } catch (err) {
      console.error('newTab failed', err)
    }
  }

  async closeTab(id) {
    try { await deleteTab(this.projectId, id) }
    catch (err) { console.error('closeTab failed', err) }
  }

  async renameTab(id, label) {
    try { await patchTab(this.projectId, id, label) }
    catch (err) { console.error('rename failed', err) }
  }

  // --- Public local helpers ---

  setActive(id) {
    if (this.activeId === id) return
    if (!this.tabs.some((t) => t.id === id)) return
    // Compute direction so the composer chip animates left (forward) /
    // right (back) appropriately. 'jump' for non-adjacent moves.
    const n = this.tabs.length
    const oldIdx = this.tabs.findIndex((t) => t.id === this.activeId)
    const newIdx = this.tabs.findIndex((t) => t.id === id)
    let direction = 'jump'
    if (oldIdx >= 0 && newIdx >= 0 && n > 1) {
      if ((oldIdx + 1) % n === newIdx) direction = 'forward'
      else if ((newIdx + 1) % n === oldIdx) direction = 'back'
    }
    // Adjacent moves get the slide animation; everything else (jumps,
    // first activation, wrap-around at the ends of the strip) snaps so
    // the track doesn't visibly whizz past every intermediate pane.
    const adjacent = Math.abs(newIdx - oldIdx) === 1 && oldIdx >= 0
    this.activeId = id
    saveActiveId(this.projectId, id)
    for (const tab of this.tabs) {
      tab.paneEl.classList.toggle('active', tab.id === id)
    }
    this._syncTrackPosition({ noAnim: !adjacent })
    this._renderStrip()
    const active = this._getActive()
    this.onActiveChange(active?.pane || null, active ? { id: active.id, label: active.label, type: active.type } : null, direction)
    if (active) {
      this.onStatusChange(!!active.pane._ws && active.pane._ws.readyState === WebSocket.OPEN)
      requestAnimationFrame(() => { try { active.pane.fitAddon.fit() } catch {} })
    }
  }

  cycle(dir = 1) {
    if (this.tabs.length < 2) return
    const idx = this.tabs.findIndex((t) => t.id === this.activeId)
    const next = (idx + dir + this.tabs.length) % this.tabs.length
    this.setActive(this.tabs[next].id)
  }

  jumpTo(n) {
    const tab = this.tabs[n - 1]
    if (tab) this.setActive(tab.id)
  }

  getActivePane() {
    return this._getActive()?.pane || null
  }

  /** Return shallow copies of the prev / current / next tabs for the
   *  composer's 3-segment chip. With 1 tab, prev and next are null;
   *  with 2 tabs, prev and next both point at the same other tab. */
  getNeighbors() {
    const n = this.tabs.length
    if (n === 0 || !this.activeId) return { prev: null, current: null, next: null }
    const idx = this.tabs.findIndex((t) => t.id === this.activeId)
    if (idx < 0) return { prev: null, current: null, next: null }
    const pick = (t) => t ? { id: t.id, label: t.label, type: t.type } : null
    return {
      prev: n > 1 ? pick(this.tabs[(idx - 1 + n) % n]) : null,
      current: pick(this.tabs[idx]),
      next: n > 1 ? pick(this.tabs[(idx + 1) % n]) : null,
    }
  }

  count() {
    return this.tabs.length
  }

  /** Project switch: tear down local panes + WS, re-subscribe to new project. */
  switchProject(projectId) {
    if (projectId === this.projectId) return
    for (const tab of this.tabs) {
      try { tab.pane.dispose() } catch {}
      tab.paneEl.remove()
    }
    this.tabs = []
    this.activeId = null
    this._pendingActiveId = null
    this._creatingEmpty = false
    this.projectId = projectId
    this._teardownWs()
    this._renderStrip()
    this._connectWs()
  }

  fit() {
    const active = this._getActive()
    if (active) requestAnimationFrame(() => { try { active.pane.fitAddon.fit() } catch {} })
  }

  destroy() {
    this._disposed = true
    this._teardownWs()
    for (const tab of this.tabs) {
      try { tab.pane.dispose() } catch {}
      tab.paneEl.remove()
    }
    this.tabs = []
    this.activeId = null
  }

  // --- WS subscription ---

  _connectWs() {
    if (this._disposed) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/tabs`)
    this._ws = ws
    ws.addEventListener('open', () => {
      this._wsBackoff = 500
      ws.send(JSON.stringify({ type: 'subscribe', projectId: this.projectId }))
    })
    ws.addEventListener('message', (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'tabs:update' && msg.projectId === this.projectId) {
        this._applyServerTabs(msg.tabs || [])
      }
    })
    ws.addEventListener('close', () => {
      if (this._disposed) return
      // Reconnect with capped exponential backoff
      const delay = Math.min(this._wsBackoff, 10_000)
      this._wsBackoff = Math.min(this._wsBackoff * 2, 10_000)
      clearTimeout(this._wsReconnectTimer)
      this._wsReconnectTimer = setTimeout(() => this._connectWs(), delay)
    })
    ws.addEventListener('error', () => {/* close fires next */})
  }

  _teardownWs() {
    clearTimeout(this._wsReconnectTimer)
    this._wsReconnectTimer = null
    if (this._ws) {
      try { this._ws.close() } catch {}
      this._ws = null
    }
  }

  _applyServerTabs(serverTabs) {
    const serverById = new Map(serverTabs.map((t) => [t.id, t]))

    // Add tabs that are new on the server
    for (const t of serverTabs) {
      const local = this.tabs.find((x) => x.id === t.id)
      if (!local) {
        this._addTab(t.id, t.label, t.type || 'bash', { persona: t.persona || '' })
      } else {
        if (local.label !== t.label) local.label = t.label
        if (t.type && local.type !== t.type) local.type = t.type
        // 需求8: keep persona in sync so the 🐱 tab chip reflects server state.
        if ((local.persona || '') !== (t.persona || '')) local.persona = t.persona || ''
      }
    }

    // Remove tabs gone from the server
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      const t = this.tabs[i]
      if (!serverById.has(t.id)) {
        try { t.pane.dispose() } catch {}
        t.paneEl.remove()
        this.tabs.splice(i, 1)
      }
    }

    // Reorder to match server order
    this.tabs.sort(
      (a, b) =>
        serverTabs.findIndex((t) => t.id === a.id) -
        serverTabs.findIndex((t) => t.id === b.id)
    )
    // Mirror that order into the carousel track so the translateX math
    // stays in sync with the array. appendChild on an existing child is
    // a move, so iterating in tab-order pushes each pane to its new
    // position without disturbing the others.
    for (const tab of this.tabs) {
      this.trackEl.appendChild(tab.paneEl)
    }
    this._syncTrackPosition({ noAnim: true })

    // Empty-list auto-create — guard against multiple devices racing.
    if (this.tabs.length === 0 && !this._creatingEmpty) {
      this._creatingEmpty = true
      this.newTab().finally(() => { this._creatingEmpty = false })
      this._renderStrip()
      return
    }

    // Active-tab logic
    if (this._pendingActiveId && serverById.has(this._pendingActiveId)) {
      const id = this._pendingActiveId
      this._pendingActiveId = null
      this.setActive(id)
    } else if (this.activeId && !serverById.has(this.activeId)) {
      // The previously-active tab was removed (possibly by another device).
      this.activeId = null
      if (this.tabs.length) this.setActive(this.tabs[0].id)
      else this._renderStrip()
    } else if (!this.activeId && this.tabs.length) {
      // First-time activation: prefer the last-active for this device, or the
      // most-recently-active claude tab (by jsonl mtime) for cross-port resume.
      const remembered = loadActiveId(this.projectId)
      if (remembered && serverById.has(remembered)) {
        // Only honour the remembered tab when it is itself a claude tab — i.e.
        // the user was on a conversation. If the remembered tab is a bash/other
        // tab, opening the project should auto-replay the latest claude
        // conversation in the directory (the "点进目录自动回放该目录最近一次对话"
        // requirement) rather than land on a bare terminal.
        const rememberedTab = serverById.get(remembered)
        if (rememberedTab && rememberedTab.type === 'claude') {
          this.setActive(remembered)
        } else {
          this._autoSelectMostRecentClaudeTab(serverById)
        }
      } else {
        // No remembered tab for this device: auto-select the most recently active
        // claude tab by querying the server (jsonl mtime). Falls back to tabs[0].
        this._autoSelectMostRecentClaudeTab(serverById)
      }
    } else {
      this._renderStrip()
    }
  }

  /**
   * Query /api/projects/:id/most-recent-claude-tab and activate that tab.
   * Falls back to tabs[0] if the API fails or returns null.
   * Only called on first-time activation (no remembered tab for this device).
   */
  async _autoSelectMostRecentClaudeTab(serverById) {
    let tabId = null
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/most-recent-claude-tab`)
      if (resp.ok) {
        const data = await resp.json()
        tabId = data?.tabId || null
      }
    } catch {}

    // Pick the API result if it's valid, else fall back to first tab
    const target = (tabId && serverById.has(tabId)) ? tabId : this.tabs[0]?.id
    if (target) this.setActive(target)
    else this._renderStrip()
  }

  // --- Internals ---

  _addTab(id, label, type = 'bash', opts = {}) {
    const paneEl = document.createElement('div')
    paneEl.className = 'pane-terminal'
    paneEl.dataset.tabId = id
    this.trackEl.appendChild(paneEl)

    const paneOpts = {
      projectId: this.projectId,
      tabId: id,
      onStatusChange: (connected) => {
        if (this.activeId === id) this.onStatusChange(connected)
      },
    }

    // Claude tabs use a DOM block renderer by default (rich text, mobile-friendly).
    // If the global renderMode setting is 'terminal', use raw PTY instead.
    // Codex tabs: separate codexRenderMode setting, defaults to 'terminal' (xterm raw).
    // Set codexRenderMode to 'block' in Settings to opt into CodexBlockRenderer (experimental).
    // 需求11-C: Fable5/opencode tabs use ClaudeBlockRenderer (Block mode, default)
    // via the opencode block driver. fable5RenderMode/opencodeRenderMode='terminal'
    // falls back to raw opencode TUI (PTY/xterm).
    const renderMode = (() => { try { return window.__nanocodeState?.renderMode || 'block' } catch { return 'block' } })()
    const codexRenderMode = (() => { try { return window.__nanocodeState?.codexRenderMode || 'terminal' } catch { return 'terminal' } })()
    const fable5RenderMode = (() => { try { return window.__nanocodeState?.fable5RenderMode || 'block' } catch { return 'block' } })()
    const opencodeRenderMode = (() => { try { return window.__nanocodeState?.opencodeRenderMode || 'block' } catch { return 'block' } })()
    const useClaudeRenderer =
      (type === 'claude' && renderMode !== 'terminal') ||
      (type === 'fable5' && fable5RenderMode !== 'terminal') ||
      (type === 'opencode' && opencodeRenderMode !== 'terminal')
    const useCodexRenderer = type === 'codex' && codexRenderMode === 'block'
    let pane
    if (useClaudeRenderer) {
      pane = new ClaudeBlockRenderer(paneEl, { ...paneOpts, tabType: type })
    } else if (useCodexRenderer) {
      pane = new CodexBlockRenderer(paneEl, paneOpts)
    } else {
      pane = new TerminalPane(paneEl, paneOpts)
    }

    this.tabs.push({ id, label, type, pane, paneEl, persona: opts.persona || '' })
    // Track grew; keep the visible position pinned to the active tab.
    this._syncTrackPosition({ noAnim: true })
  }

  /** Move the carousel track so the active tab is in view. */
  _syncTrackPosition({ noAnim = false } = {}) {
    if (!this.trackEl) return
    const idx = this.tabs.findIndex((t) => t.id === this.activeId)
    if (idx < 0) {
      // No active tab — keep the current transform; the next setActive
      // will re-align.
      return
    }
    if (noAnim) {
      this.trackEl.classList.add('no-anim')
      this.trackEl.style.transform = `translateX(-${idx * 100}%)`
      // Force a layout flush so the transform paints before we lift the
      // no-anim guard, otherwise the next setActive would animate from
      // the OLD position.
      void this.trackEl.offsetWidth
      requestAnimationFrame(() => this.trackEl.classList.remove('no-anim'))
    } else {
      this.trackEl.classList.remove('no-anim')
      this.trackEl.style.transform = `translateX(-${idx * 100}%)`
    }
  }

  _getActive() {
    return this.tabs.find((t) => t.id === this.activeId) || null
  }

  _beginRename(tab, labelEl, btnEl) {
    if (!labelEl.parentNode) return

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'tab-chip-input'
    input.value = tab.label
    input.maxLength = 40
    input.spellcheck = false

    let done = false
    const commit = (save) => {
      if (done) return
      done = true
      if (save) {
        const v = input.value.trim()
        if (v && v !== tab.label) {
          // Server will broadcast back; local label updates then.
          this.renameTab(tab.id, v)
        }
      }
      this._renderStrip()
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); commit(true) }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false) }
      else if (e.key === 'Tab') { e.preventDefault(); commit(true) }
    })
    input.addEventListener('blur', () => commit(true))
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('dblclick', (e) => e.stopPropagation())

    labelEl.replaceWith(input)
    input.focus()
    input.select()
  }

  _renderStrip() {
    this.stripEl.innerHTML = ''
    for (const tab of this.tabs) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'tab-chip tab-chip-' + (tab.type || 'bash') +
        (tab.id === this.activeId ? ' active' : '')
      btn.dataset.tabId = tab.id
      btn.title = 'Double-click to rename'

      const icon = document.createElement('span')
      icon.className = 'tab-chip-icon'
      icon.innerHTML = TYPE_ICON_SVG[tab.type || 'bash'] || TYPE_ICON_SVG.bash
      btn.appendChild(icon)

      const label = document.createElement('span')
      label.className = 'tab-chip-label'
      label.textContent = tab.label
      btn.appendChild(label)

      // 需求8: annotate tabs carrying a persona so the active persona is
      // visible in the tab strip (e.g. "new 🐱"). Only Claude tabs have one.
      if (tab.persona) {
        const chip = document.createElement('span')
        chip.className = 'tab-chip-persona'
        chip.textContent = '🐱'
        chip.title = `persona: ${tab.persona}`
        btn.appendChild(chip)
      }

      const close = document.createElement('span')
      close.className = 'tab-chip-close'
      close.textContent = '×'
      close.title = 'Close tab'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        this.closeTab(tab.id)
      })
      btn.appendChild(close)

      btn.addEventListener('click', () => this.setActive(tab.id))
      this.stripEl.appendChild(btn)
    }

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'tab-chip-add'
    addBtn.textContent = '+'
    addBtn.title = 'New tab — click for menu, Ctrl+T for bash'
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this._showNewTabMenu(addBtn)
    })
    this.stripEl.appendChild(addBtn)
  }

  _showNewTabMenu(anchor) {
    // Dismiss any open menu
    this._closeNewTabMenu()
    const menu = document.createElement('div')
    menu.className = 'tab-new-menu'
    const enabledTypes = getEnabledTabTypes()
    for (const opt of NEW_TAB_OPTIONS) {
      if (!enabledTypes.includes(opt.type)) continue
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'tab-new-menu-item'
      item.innerHTML =
        `<span class="tab-new-menu-icon">${TYPE_ICON_SVG[opt.type] || ''}</span>` +
        `<span class="tab-new-menu-label">${opt.label}</span>` +
        (opt.hint ? `<span class="tab-new-menu-hint">${opt.hint}</span>` : '')
      item.addEventListener('click', () => {
        this._closeNewTabMenu()
        // 需求3: opening a Claude Code tab shows a picker of the 5 most recent
        // "longer" conversations to 继续 (resume) or 开启新对话 (start fresh),
        // instead of silently auto-resuming the newest one.
        if (opt.type === 'claude') {
          this._showClaudeResumePicker()
          return
        }
        // 需求15 item1: Fable5/opencode tabs get the same resume picker, backed
        // by `opencode session list` instead of claude jsonl — 继续 resumes an
        // opencode session (--session <id>), 开启新对话 starts a fresh one.
        if (opt.type === 'fable5' || opt.type === 'opencode') {
          this._showOpencodeResumePicker(opt.type)
          return
        }
        this.newTab(opt.type)
      })
      menu.appendChild(item)
    }
    // "Manage tab types" shortcut — opens settings to the tab types section
    const manageItem = document.createElement('button')
    manageItem.type = 'button'
    manageItem.className = 'tab-new-menu-item tab-new-menu-manage'
    manageItem.innerHTML =
      `<span class="tab-new-menu-icon">${MANAGE_ICON_SVG}</span>` +
      `<span class="tab-new-menu-label">${'Manage tab types'}</span>`
    manageItem.addEventListener('click', () => {
      this._closeNewTabMenu()
      const settingsBtn = document.getElementById('settings-toggle-btn')
      if (settingsBtn) settingsBtn.click()
      // Scroll to tab types section after panel opens
      setTimeout(() => {
        const cb = document.querySelector('.tab-type-checkbox')
        if (cb) cb.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 400)
    })
    menu.appendChild(manageItem)
    document.body.appendChild(menu)
    const rect = anchor.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.top = (rect.bottom + 6) + 'px'
    menu.style.left = rect.left + 'px'
    this._menuEl = menu
    // Click-outside closes
    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target)) {
          this._closeNewTabMenu()
          document.removeEventListener('click', close, true)
        }
      }
      document.addEventListener('click', close, true)
    }, 0)
  }

  _closeNewTabMenu() {
    if (this._menuEl) {
      this._menuEl.remove()
      this._menuEl = null
    }
  }

  // ── 需求3: Claude Code tab picker ──────────────────────────────────────────
  // Lists up to 5 recent "longer" conversations for the current project (by byte
  // size) so the user can 继续 a specific one or 开启新对话 (fresh). "继续" creates
  // a claude tab pre-seeded with that sessionId (resume); "开启新对话" creates a
  // claude tab with fresh=true so the server starts a brand new session instead
  // of auto-resuming the newest jsonl.
  _showClaudeResumePicker() {
    this._closeClaudeResumePicker()
    const overlay = document.createElement('div')
    overlay.className = 'claude-resume-picker'

    const card = document.createElement('div')
    card.className = 'claude-resume-picker-card'
    overlay.appendChild(card)

    const header = document.createElement('div')
    header.className = 'claude-resume-picker-header'
    const title = document.createElement('div')
    title.className = 'claude-resume-picker-title'
    title.textContent = 'Claude Code — resume or start new'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'claude-resume-picker-close'
    closeBtn.textContent = '×'
    closeBtn.title = 'Close'
    header.appendChild(title)
    header.appendChild(closeBtn)
    card.appendChild(header)

    const body = document.createElement('div')
    body.className = 'claude-resume-picker-body'
    const loading = document.createElement('div')
    loading.className = 'claude-resume-picker-loading'
    loading.textContent = 'Loading recent conversations…'
    body.appendChild(loading)
    card.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'claude-resume-picker-footer'

    // 需求8: persona selector — chosen persona is injected via
    // --append-system-prompt on every turn (applies to both 继续 + 开启新对话).
    const personaField = document.createElement('label')
    personaField.className = 'claude-resume-picker-persona'
    const personaLab = document.createElement('span')
    personaLab.className = 'claude-resume-picker-persona-label'
    personaLab.textContent = 'Persona'
    const personaSel = document.createElement('select')
    personaSel.className = 'rp-select claude-resume-picker-persona-select'
    personaSel.id = 'claude-resume-persona'
    const personaNone = document.createElement('option')
    personaNone.value = ''
    personaNone.textContent = '(none)'
    personaSel.appendChild(personaNone)
    personaField.appendChild(personaLab)
    personaField.appendChild(personaSel)
    footer.appendChild(personaField)
    // Populate personas async (non-blocking — picker stays usable if empty).
    fetch('/api/personas').then((r) => r.json()).then((data) => {
      if (!data || !Array.isArray(data.personas)) return
      for (const p of data.personas) {
        const opt = document.createElement('option')
        opt.value = p.id
        opt.textContent = p.name
        personaSel.appendChild(opt)
      }
    }).catch(() => {})

    const newBtn = document.createElement('button')
    newBtn.type = 'button'
    newBtn.className = 'claude-resume-picker-new'
    newBtn.textContent = '＋ 开启新对话'
    newBtn.title = 'Start a brand new Claude conversation'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'claude-resume-picker-secondary'
    cancelBtn.textContent = 'Cancel'
    footer.appendChild(cancelBtn)
    footer.appendChild(newBtn)
    card.appendChild(footer)

    document.body.appendChild(overlay)
    this._pickerEl = overlay

    const dismiss = () => this._closeClaudeResumePicker()
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss() })
    closeBtn.addEventListener('click', dismiss)
    cancelBtn.addEventListener('click', dismiss)
    const onKey = (e) => { if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey, true) } }
    document.addEventListener('keydown', onKey, true)

    newBtn.addEventListener('click', () => {
      const persona = personaSel.value || ''
      dismiss()
      this.newTab('claude', { fresh: true, label: 'new', ...(persona ? { persona } : {}) })
    })

    // Load recent conversations. 需求5.3: remember the last chosen source
    // (project/home/all). Default is 'all' so the first screen surfaces the
    // most-recent (mtime-desc) conversations across project + home — matching
    // the backend default (scanRecentConversationsMulti source='all') and the
    // 需求3 acceptance ("列表首屏必须出现最近 1 小时内活跃的会话"). A project
    // with no recent claude sessions would otherwise show only stale entries.
    // r8 anti-fake-pass: a STALE persisted 'project' choice (e.g. the user
    // clicked "This project" in a prior session) would still hide recent
    // conversations after a hot-update — see _renderPickerBody auto-fallback.
    this._pickerSource = localStorage.getItem('claudeResumeSource') || 'all'
    this._renderPickerBody(body, true)
  }

  async _renderPickerBody(body, isInitial = false) {
    const source = this._pickerSource || 'all'
    body.innerHTML = ''

    // 需求5.3: source switch — This project / Home / All
    const sourceBar = document.createElement('div')
    sourceBar.className = 'claude-resume-picker-sources'
    const sources = [
      { id: 'project', label: 'This project' },
      { id: 'home', label: 'Home' },
      { id: 'all', label: 'All' },
    ]
    for (const s of sources) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'claude-resume-picker-source'
      if (s.id === source) btn.classList.add('active')
      btn.textContent = s.label
      btn.title = `Show conversations from ${s.label.toLowerCase()}`
      btn.addEventListener('click', () => {
        this._pickerSource = s.id
        localStorage.setItem('claudeResumeSource', s.id)
        this._renderPickerBody(body)
      })
      sourceBar.appendChild(btn)
    }
    body.appendChild(sourceBar)

    const loading = document.createElement('div')
    loading.className = 'claude-resume-picker-loading'
    loading.textContent = 'Loading recent conversations…'
    body.appendChild(loading)

    let conversations = []
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/recent-conversations?limit=5&source=${encodeURIComponent(source)}`)
      if (resp.ok) {
        const data = await resp.json()
        conversations = data.conversations || []
      }
    } catch (err) {
      console.warn('[claude-resume-picker] failed to load conversations', err)
    }

    // 需求3 robustness (anti-fake-pass r8): a stale persisted 'project' choice
    // must not hide recent conversations after a hot-update. On the INITIAL
    // picker open, if source='project' and the project has no recently-active
    // session (top entry older than 1h), auto-fallback to 'all' so the master's
    // hard requirement — "首屏出现最近 1h 活跃会话" — holds regardless of the
    // browser's localStorage state. Only 'project' auto-falls back (it is the
    // scope most likely to have no recent sessions; 'home'/'all' naturally
    // surface recent home/secretary sessions). Explicit "This project" clicks
    // pass isInitial=false so a deliberate choice is still respected. The
    // re-render uses source='all' (≠ 'project') + isInitial=false → no recursion.
    if (isInitial && source === 'project' && conversations.length
        && Date.now() - new Date(conversations[0].mtime).getTime() > 60 * 60 * 1000) {
      this._pickerSource = 'all'
      localStorage.setItem('claudeResumeSource', 'all')
      this._renderPickerBody(body)
      return
    }

    loading.remove()
    if (!conversations.length) {
      const empty = document.createElement('div')
      empty.className = 'claude-resume-picker-empty'
      empty.textContent = 'No recent conversations in this source. Start a new one below.'
      body.appendChild(empty)
      return
    }

    for (const c of conversations) {
      const row = document.createElement('div')
      row.className = 'claude-resume-picker-item'

      const info = document.createElement('div')
      info.className = 'claude-resume-picker-item-info'
      const summary = document.createElement('div')
      summary.className = 'claude-resume-picker-item-summary'
      summary.textContent = c.summary || '(no summary)'
      summary.title = c.summary || ''
      const meta = document.createElement('div')
      meta.className = 'claude-resume-picker-item-meta'
      const sizeKb = c.byteSize > 1024 ? (c.byteSize / 1024).toFixed(0) + ' KB' : c.byteSize + ' B'
      // 需求5: annotate the source team + cwd so the user knows a conversation
      // belongs to another team (or to the home/secretary cwd) before resuming.
      const badges = []
      if (c.teamName) badges.push(c.teamName)
      if (c.isHome) badges.push('home')
      else if (c.cwd) badges.push(c.cwd)
      const badgeText = badges.length ? ` · ${badges.join(' / ')}` : ''
      // 需求3 紧急修正: relTime FIRST so the master can verify recency
      // ("11m ago") at a glance — the sort is now mtime-desc, so the top of the
      // list must visibly be the freshest conversation.
      meta.textContent = `${c.relTime} · ${c.messageCount} msgs · ${sizeKb}${badgeText}`
      info.appendChild(summary)
      info.appendChild(meta)
      row.appendChild(info)

      const resume = document.createElement('button')
      resume.type = 'button'
      resume.className = 'claude-resume-picker-resume'
      resume.textContent = '继续'
      resume.title = `Resume session ${c.sessionId}`
      resume.addEventListener('click', () => {
        // 需求8: read the chosen persona BEFORE closing the picker — _closeClaudeResumePicker
        // removes the overlay (and #claude-resume-persona) from the DOM, so reading it
        // after the close would always yield '' and silently drop the persona on resume.
        const personaEl = document.getElementById('claude-resume-persona')
        const personaVal = personaEl ? personaEl.value : ''
        this._closeClaudeResumePicker()
        // 需求5: carry the session's owning team (configDir) + original cwd so
        // the spawned claude resumes under the right CLAUDE_CONFIG_DIR and in
        // the matching project-slug dir (cross-team / cross-cwd resume).
        const opts = { claudeSessionId: c.sessionId }
        // 需求8: apply the persona chosen in the picker to resumed sessions too
        // (re-injected each turn via --append-system-prompt).
        if (personaVal) opts.persona = personaVal
        // 需求5: annotate the tab label with the source team so cross-team tabs
        // are distinguishable in the tab strip (e.g. "resume·team2", "resume·home").
        const tags = []
        if (c.isCrossTeam && c.teamId) tags.push(c.teamId)
        else if (c.isHome) tags.push('home')
        opts.label = tags.length ? `resume·${tags.join('·')}` : 'resume'
        if (c.configDir) opts.claudeConfigDir = c.configDir
        if (c.cwd) opts.claudeSessionCwd = c.cwd
        this.newTab('claude', opts)
      })
      row.appendChild(resume)

      body.appendChild(row)
    }
  }

  _closeClaudeResumePicker() {
    if (this._pickerEl) {
      this._pickerEl.remove()
      this._pickerEl = null
    }
  }

  // ── 需求15 item1: Fable5/opencode tab picker ───────────────────────────────
  // Mirrors _showClaudeResumePicker but the data source is `opencode session
  // list` (via GET /opencode-sessions) instead of claude jsonl. 继续 creates a
  // fable5/opencode tab pre-seeded with opencodeSessionId (the block driver
  // passes --session <id>); 开启新对话 creates a fresh tab (driver allocates a
  // new session on the first turn). Reuses the .claude-resume-picker-* CSS so
  // the picker looks identical to the claude one (no new CSS needed). 需求15
  // item5: a Persona selector is wired into the footer (same as claude); the
  // chosen persona is prepended to the prompt every turn by the block driver
  // (opencode has no --append-system-prompt flag — see buildArgs).
  _showOpencodeResumePicker(type) {
    this._closeClaudeResumePicker()
    const typeLabel = type === 'fable5' ? 'Fable 5' : 'OpenCode'
    const overlay = document.createElement('div')
    overlay.className = 'claude-resume-picker'

    const card = document.createElement('div')
    card.className = 'claude-resume-picker-card'
    overlay.appendChild(card)

    const header = document.createElement('div')
    header.className = 'claude-resume-picker-header'
    const title = document.createElement('div')
    title.className = 'claude-resume-picker-title'
    title.textContent = `${typeLabel} — resume or start new`
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'claude-resume-picker-close'
    closeBtn.textContent = '×'
    closeBtn.title = 'Close'
    header.appendChild(title)
    header.appendChild(closeBtn)
    card.appendChild(header)

    const body = document.createElement('div')
    body.className = 'claude-resume-picker-body'
    const loading = document.createElement('div')
    loading.className = 'claude-resume-picker-loading'
    loading.textContent = 'Loading recent OpenCode sessions…'
    body.appendChild(loading)
    card.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'claude-resume-picker-footer'

    // 需求15 item5: persona selector — mirrors the claude picker. opencode has
    // no --append-system-prompt flag, so the driver prepends the framed persona
    // to the user prompt every turn (see opencode-block-driver buildArgs). The
    // chosen persona applies to BOTH 继续 (resume) and 开启新对话.
    const personaField = document.createElement('label')
    personaField.className = 'claude-resume-picker-persona'
    const personaLab = document.createElement('span')
    personaLab.className = 'claude-resume-picker-persona-label'
    personaLab.textContent = 'Persona'
    const personaSel = document.createElement('select')
    personaSel.className = 'rp-select claude-resume-picker-persona-select'
    personaSel.id = 'opencode-resume-persona'
    const personaNone = document.createElement('option')
    personaNone.value = ''
    personaNone.textContent = '(none)'
    personaSel.appendChild(personaNone)
    personaField.appendChild(personaLab)
    personaField.appendChild(personaSel)
    footer.appendChild(personaField)
    // Populate personas async (non-blocking — picker stays usable if empty).
    fetch('/api/personas').then((r) => r.json()).then((data) => {
      if (!data || !Array.isArray(data.personas)) return
      for (const p of data.personas) {
        const opt = document.createElement('option')
        opt.value = p.id
        opt.textContent = p.name
        personaSel.appendChild(opt)
      }
    }).catch(() => {})

    const newBtn = document.createElement('button')
    newBtn.type = 'button'
    newBtn.className = 'claude-resume-picker-new'
    newBtn.textContent = '＋ 开启新对话'
    newBtn.title = `Start a brand new ${typeLabel} conversation`
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'claude-resume-picker-secondary'
    cancelBtn.textContent = 'Cancel'
    footer.appendChild(cancelBtn)
    footer.appendChild(newBtn)
    card.appendChild(footer)

    document.body.appendChild(overlay)
    this._pickerEl = overlay

    const dismiss = () => this._closeClaudeResumePicker()
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss() })
    closeBtn.addEventListener('click', dismiss)
    cancelBtn.addEventListener('click', dismiss)
    const onKey = (e) => { if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey, true) } }
    document.addEventListener('keydown', onKey, true)

    newBtn.addEventListener('click', () => {
      const persona = personaSel.value || ''
      dismiss()
      this.newTab(type, { label: 'new', ...(persona ? { persona } : {}) })
    })

    this._renderOpencodePickerBody(body, type)
  }

  async _renderOpencodePickerBody(body, type) {
    body.innerHTML = ''
    const loading = document.createElement('div')
    loading.className = 'claude-resume-picker-loading'
    loading.textContent = 'Loading recent OpenCode sessions…'
    body.appendChild(loading)

    let conversations = []
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/opencode-sessions?limit=5`)
      if (resp.ok) {
        const data = await resp.json()
        conversations = data.conversations || []
      }
    } catch (err) {
      console.warn('[opencode-resume-picker] failed to load sessions', err)
    }

    loading.remove()
    if (!conversations.length) {
      const empty = document.createElement('div')
      empty.className = 'claude-resume-picker-empty'
      empty.textContent = 'No recent OpenCode sessions. Start a new one below.'
      body.appendChild(empty)
      return
    }

    for (const c of conversations) {
      const row = document.createElement('div')
      row.className = 'claude-resume-picker-item'

      const info = document.createElement('div')
      info.className = 'claude-resume-picker-item-info'
      const summary = document.createElement('div')
      summary.className = 'claude-resume-picker-item-summary'
      summary.textContent = c.title || '(untitled)'
      summary.title = c.title || ''
      const meta = document.createElement('div')
      meta.className = 'claude-resume-picker-item-meta'
      // opencode sessions are cwd-scoped; show the dir basename so the user can
      // tell apart sessions from sibling project dirs if the CLI returns any.
      const dirName = c.directory ? c.directory.replace(/\/$/, '').split('/').pop() : ''
      meta.textContent = `${c.relTime || ''}${dirName ? ' · ' + dirName : ''}`
      info.appendChild(summary)
      info.appendChild(meta)
      row.appendChild(info)

      const resume = document.createElement('button')
      resume.type = 'button'
      resume.className = 'claude-resume-picker-resume'
      resume.textContent = '继续'
      resume.title = `Resume session ${c.sessionId}`
      resume.addEventListener('click', () => {
        // 需求15 item5: read persona BEFORE close — _closeClaudeResumePicker
        // removes the overlay (and #opencode-resume-persona) from the DOM, so
        // reading it after the close would always yield '' and drop the persona.
        // Applying the persona to a resumed session re-injects it every turn
        // (mirrors claude's resume+persona behaviour).
        const personaEl = document.getElementById('opencode-resume-persona')
        const personaVal = personaEl ? personaEl.value : ''
        this._closeClaudeResumePicker()
        const opts = { opencodeSessionId: c.sessionId, label: 'resume' }
        if (personaVal) opts.persona = personaVal
        this.newTab(type, opts)
      })
      row.appendChild(resume)

      body.appendChild(row)
    }
  }
}

const NEW_TAB_OPTIONS = [
  { type: 'bash', label: 'Terminal', hint: 'bash' },
  { type: 'claude', label: 'Claude Code', hint: 'claude' },
  { type: 'codex', label: 'Codex', hint: 'codex' },
  { type: 'agent', label: 'Cursor Agent', hint: 'agent' },
  { type: 'opencode', label: 'OpenCode', hint: 'opencode' },
  { type: 'meshy-aigw', label: 'Meshy AIGW', hint: 'Kimi K2.7 Code' },
  { type: 'fable5', label: 'Fable 5', hint: 'OpenCode AIGW' },
  { type: 'tmux', label: 'Tmux Session', hint: 'attach' },
]

const DEFAULT_ENABLED_TYPES = ['bash', 'claude', 'codex', 'agent', 'opencode', 'meshy-aigw', 'fable5', 'tmux']
const ENABLED_TYPES_KEY = 'nanocodeEnabledTabTypes'

export function getEnabledTabTypes() {
  try {
    const stored = localStorage.getItem(ENABLED_TYPES_KEY)
    if (!stored) return DEFAULT_ENABLED_TYPES
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_ENABLED_TYPES
    return parsed
  } catch { return DEFAULT_ENABLED_TYPES }
}

export function setEnabledTabTypes(types) {
  try { localStorage.setItem(ENABLED_TYPES_KEY, JSON.stringify(types)) } catch {}
}

const TYPE_ICON_SVG = {
  bash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  claude: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9.5a3 3 0 1 1 0 5"/><path d="M15 9.5a3 3 0 1 0 0 5"/></svg>`,
  codex: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  agent: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`,
  opencode: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9l-3 3 3 3M16 9l3 3-3 3"/></svg>`,
  // Meshy AIGW: lightning bolt icon (fast Kimi model via internal proxy)
  'meshy-aigw': `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  // Fable 5: sparkles icon (Claude Fable 5 via OpenCode AIGW)
  'fable5': `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/></svg>`,
  // Tmux: terminal split icon
  tmux: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>`,
}

const MANAGE_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/></svg>`

export { TYPE_ICON_SVG }
