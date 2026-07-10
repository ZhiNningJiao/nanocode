/**
 * Terminal view — multi-tab bash on the left, chat input bar at the bottom.
 *
 * Tab key in the composer cycles tabs (forward; Shift+Tab cycles backward).
 * Ctrl+T creates a new tab; Ctrl+W closes the active one; Ctrl+1..9 jumps.
 */

import { initSplitPane } from './terminal-pane.js'
import { TabManager, TYPE_ICON_SVG } from './tab-manager.js'
import { createExplorer } from './explorer.js'
import { initRightPanel, showRightPanelTab } from './right-panel.js'
import { t } from './i18n.js'

const mobileQuery = window.matchMedia('(max-width: 768px)')
const isMobile = () => mobileQuery.matches

let initialized = false
let tabManager = null
let activePane = null
let explorer = null
let currentProjectId = null

const statusBash = document.getElementById('status-bash')

// Label prefix per tab type for the connection badge in the header.
const TAB_TYPE_LABEL = {
  bash: 'Bash',
  claude: 'Claude',
  codex: 'Codex',
  agent: 'Agent',
  opencode: 'OpenCode',
}

let _activeTabType = 'bash'

function setStatus(connected) {
  if (!statusBash) return
  const label = TAB_TYPE_LABEL[_activeTabType] || 'Bash'
  statusBash.textContent = `${label}: ${connected ? 'connected' : 'disconnected'}`
  statusBash.classList.toggle('connected', connected)
}

/**
 * Initialize the terminal view for a given project.
 * @param {string} projectId
 */
export async function initTerminalView(projectId) {
  if (!projectId) return
  currentProjectId = projectId

  if (!initialized) {
    initialized = true
    setupSplitPane()
    setupTabs(projectId)
    setupExplorer(projectId)
    setupChatInput()
    setupKeyboardShortcuts()
    setupMobile()
  } else {
    if (tabManager) tabManager.switchProject(projectId)
    if (explorer) explorer.switchProject(projectId)
  }
}

/**
 * Switch the terminal view to a new project.
 * @param {string} projectId
 */
export function switchTerminalProject(projectId) {
  if (!projectId || !initialized) return
  if (projectId === currentProjectId) return
  currentProjectId = projectId
  if (tabManager) tabManager.switchProject(projectId)
  if (explorer) explorer.switchProject(projectId)
}

export function fitTerminals() {
  if (tabManager) tabManager.fit()
}

export function isInitialized() {
  return initialized
}

// --- Internal ---

function setupSplitPane() {
  initSplitPane(
    document.getElementById('split-container'),
    document.getElementById('split-divider')
  )
}

function setupExplorer(projectId) {
  const root = document.getElementById('explorer-root')
  if (!root) return
  explorer = createExplorer(root, projectId)
  initRightPanel()

  // Feature 2: listen for path-click events from chat bubble renderer
  // The event bubbles up from wherever in the DOM the clicked span lives.
  document.addEventListener('nanocode:open-in-explorer', (e) => {
    const path = e.detail?.path
    if (!path || !explorer) return
    showRightPanelTab('files')
    explorer.openPath(path).catch(() => {})
  })

  // Cross-project switch requested by openPath (method C, step 1)
  document.addEventListener('nanocode:switch-project', (e) => {
    const { projectId } = e.detail || {}
    if (!projectId) return
    switchTerminalProject(projectId)
  })
}

function setupTabs(projectId) {
  const stripEl = document.getElementById('terminal-tab-strip')
  const stackEl = document.getElementById('terminal-stack')
  if (!stripEl || !stackEl) return

  tabManager = new TabManager({
    stripEl,
    stackEl,
    projectId,
    onActiveChange: (pane, tabMeta) => {
      activePane = pane
      if (tabMeta && tabMeta.type) _activeTabType = tabMeta.type
      updateActiveTabChip()
      // Re-render badge with correct label and current connection state
      if (pane && pane._ws) {
        setStatus(pane._ws.readyState === WebSocket.OPEN)
      } else {
        setStatus(false)
      }
      // Expose the active claude tab so the Team & Model pane can offer a
      // per-session "switch this conversation to another team" button + the
      // failover opt-in toggle. Null for non-claude tabs.
      window.__nanocodeActiveClaudeTab = (tabMeta && tabMeta.type === 'claude')
        ? { projectId: currentProjectId, tabId: tabMeta.id, claudeConfigDir: tabMeta.claudeConfigDir || null, allowTeamFailover: !!tabMeta.allowTeamFailover }
        : null
      document.dispatchEvent(new CustomEvent('nanocode:active-claude-tab', { detail: window.__nanocodeActiveClaudeTab }))
      // Notify chat input bar about tab type change
      document.dispatchEvent(new CustomEvent('nanocode:tab-active', {
        detail: { type: tabMeta?.type || 'bash', tabId: tabMeta?.id },
      }))
    },
    onStatusChange: setStatus,
  })
  tabManager.restore()
  // Re-render carousel when window resizes (recompute translateX so
  // the active slot stays centered).
  window.addEventListener('resize', () => updateActiveTabChip({ noAnim: true }))
}

// ── Session resume from agent-list ──────────────────────────────────────────
//
// When the user clicks a recent-agent entry, agents.js dispatches
// 'nanocode:resume-session' with { projectId, sessionId }.
// We ensure we're in the right workspace, then find or create the claude tab
// that owns that sessionId and activate it. The tab-manager's history fetch
// already handles the jsonl replay via ClaudeBlockRenderer.

document.addEventListener('nanocode:resume-session', async (e) => {
  const { projectId, sessionId, configDir, cwd } = e.detail || {}
  if (!projectId || !sessionId) return

  // Make sure we are in the right workspace
  if (currentProjectId !== projectId) {
    // switchTerminalProject will be called by the hash-change handler; wait briefly
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  if (!tabManager) return

  // Find a claude tab with this sessionId
  try {
    const tabs = await fetch(`/api/projects/${projectId}/tabs`).then(r => r.json())
    const match = tabs.find(t => t.type === 'claude' && t.claudeSessionId === sessionId)
    if (match) {
      // Tab exists — just activate it
      if (tabManager.projectId === projectId) {
        tabManager.setActive(match.id)
      } else {
        tabManager._pendingActiveId = match.id
      }
    } else {
      // Create a new claude tab pre-loaded with this sessionId.
      // Pass claudeSessionId in the POST body so the tab is created with the
      // correct session ID immediately — before the WS broadcast causes the
      // ClaudeBlockRenderer to connect and fetch history. This avoids the
      // create+patch two-step race where CBR fetches history with the wrong
      // (freshly-generated) UUID before the PATCH arrives.
      // 需求5: forward configDir + cwd so a cross-team / cross-cwd resume (from
      // the resume-trigger event or future cross-team agent list) spawns claude
      // under the session's owning team + original project slug.
      const body = { type: 'claude', label: 'resume', claudeSessionId: sessionId }
      if (configDir) body.claudeConfigDir = configDir
      if (cwd) body.claudeSessionCwd = cwd
      const newTab = await fetch(`/api/projects/${projectId}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json())

      if (newTab?.id) {
        // Always set _pendingActiveId so setActive fires when the WS broadcast
        // arrives (if it hasn't yet). Also call setActive immediately if the tab
        // is already in the local list (WS beat the HTTP response). Both paths
        // must be covered because HTTP response and WS message ordering is not
        // guaranteed.
        tabManager._pendingActiveId = newTab.id
        if (tabManager.projectId === projectId && tabManager.tabs.some(t => t.id === newTab.id)) {
          tabManager._pendingActiveId = null
          tabManager.setActive(newTab.id)
        }
      }
    }
  } catch (err) {
    console.warn('[resume-session] error', err)
  }
})

// ── Fork session from sessions plugin (MES-14031) ────────────────────────────
//
// The sessions-panel dispatches 'nanocode:fork-session' with
// { source, id, cwd, cmd }. For Claude sessions we create a new claude tab
// that resumes the same conversation (a "fork" — the original tab keeps its
// own session; both share the append-only jsonl). For Codex sessions we do
// NOT call preventDefault — the panel falls back to showing `codex resume <id>`
// because the codex SDK driver has no tab-creation path to pre-set a thread id.

document.addEventListener('nanocode:fork-session', async (e) => {
  const { source, id, cwd } = e.detail || {}
  if (!id || source !== 'claude') return // only Claude is wired for in-tab fork
  e.preventDefault() // signal handled → panel skips the command fallback

  // Find or create the project for this session's cwd
  let projectId = currentProjectId
  let project = null
  try {
    if (cwd) {
      const projects = await fetch('/api/projects').then(r => r.json())
      project = projects.find(p => p.cwd === cwd)
      if (!project && currentProjectId) {
        // cwd not in store but we're in a workspace — try the current project
        const cur = projects.find(p => p.id === currentProjectId)
        if (cur && cur.cwd === cwd) project = cur
      }
      if (project) {
        projectId = project.id
      } else {
        const name = cwd.split('/').filter(Boolean).pop() || 'fork'
        project = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, cwd }),
        }).then(r => r.json())
        projectId = project?.id || currentProjectId
      }
    }
  } catch (err) {
    console.warn('[fork-session] project lookup failed', err)
  }
  if (!projectId || !tabManager) return

  // Navigate to the project workspace if needed. Reuse the `project` object
  // resolved above (it already carries ssh_host + name) instead of re-fetching
  // by id — there is no GET /api/projects/:id route, so that call 404'd and
  // silently skipped navigation (MES-14031 fix).
  if (currentProjectId !== projectId && project) {
    const host = project.ssh_host
      ? project.ssh_host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      : 'local'
    const base = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
    location.hash = `#/${host}/${base}`
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  // Create a new claude tab pre-loaded with this sessionId (a fork/resume)
  try {
    const body = { type: 'claude', label: 'fork', claudeSessionId: id }
    if (cwd) body.claudeSessionCwd = cwd
    const newTab = await fetch(`/api/projects/${projectId}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())

    if (newTab?.id) {
      tabManager._pendingActiveId = newTab.id
      if (tabManager.projectId === projectId && tabManager.tabs.some(t => t.id === newTab.id)) {
        tabManager._pendingActiveId = null
        tabManager.setActive(newTab.id)
      }
    }
  } catch (err) {
    console.warn('[fork-session] tab creation failed', err)
  }
})

// ── Connect to a tmux session ──────────────────────────────────────────────
// Dispatched by the agent drawer's tmux browser. Creates a new 'tmux' tab
// that attaches to the named tmux session via `tmux attach-session`.

document.addEventListener('nanocode:connect-tmux', async (e) => {
  const { tmuxTarget, label } = e.detail || {}
  if (!tmuxTarget || !tabManager) return

  // Check if a tmux tab for this target already exists
  const existing = tabManager.tabs.find(t =>
    t.type === 'tmux' && t.label === (label || tmuxTarget)
  )
  if (existing) {
    tabManager.setActive(existing.id)
    return
  }

  // Create a new tmux tab
  try {
    const newTab = await fetch(`/api/projects/${tabManager.projectId}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tmux', label: label || tmuxTarget, tmuxTarget }),
    }).then(r => r.json())

    if (newTab?.id) {
      tabManager._pendingActiveId = newTab.id
      if (tabManager.tabs.some(t => t.id === newTab.id)) {
        tabManager._pendingActiveId = null
        tabManager.setActive(newTab.id)
      }
    }
  } catch (err) {
    console.warn('[connect-tmux] error', err)
  }
})

const SLOT_WIDTH_PX = 110
const SLOT_GAP_PX = 4

/**
 * Render the carousel of all tabs and translate the track so the active
 * tab is horizontally centered in the viewport. The animation comes
 * from the CSS transition on .tab-slot-track's transform.
 */
function updateActiveTabChip(opts = {}) {
  const chip = document.getElementById('active-tab-chip')
  const track = document.getElementById('tab-slot-track')
  if (!chip || !track || !tabManager) return

  const tabs = tabManager.tabs
  const activeId = tabManager.activeId
  if (!tabs.length || !activeId) {
    chip.hidden = true
    return
  }
  chip.hidden = false

  // Rebuild slot DOM only when the tab set changes (id list); otherwise
  // update labels + classes in place so the existing slot elements
  // keep their transform animation continuity.
  const wantIds = tabs.map((t) => t.id).join(',')
  if (track.dataset.tabIds !== wantIds) {
    track.innerHTML = ''
    for (const t of tabs) {
      const slot = document.createElement('button')
      slot.type = 'button'
      slot.className = 'tab-slot type-' + (t.type || 'bash')
      slot.dataset.tabId = t.id
      slot.innerHTML =
        `<span class="tab-slot-icon">${TYPE_ICON_SVG[t.type || 'bash'] || TYPE_ICON_SVG.bash}</span>` +
        `<span class="tab-slot-label"></span>`
      slot.querySelector('.tab-slot-label').textContent = t.label
      slot.addEventListener('click', () => {
        if (tabManager && t.id !== tabManager.activeId) tabManager.setActive(t.id)
      })
      track.appendChild(slot)
    }
    track.dataset.tabIds = wantIds
  } else {
    // Label/type updates: refresh in place
    const slotEls = track.children
    tabs.forEach((t, i) => {
      const slot = slotEls[i]
      if (!slot) return
      slot.className = 'tab-slot type-' + (t.type || 'bash')
      const labelEl = slot.querySelector('.tab-slot-label')
      if (labelEl && labelEl.textContent !== t.label) labelEl.textContent = t.label
    })
  }

  // Active class
  for (const slot of track.children) {
    slot.classList.toggle('active', slot.dataset.tabId === activeId)
  }

  // Center the active slot via translateX
  const activeIdx = tabs.findIndex((t) => t.id === activeId)
  if (activeIdx < 0) return
  const containerW = chip.getBoundingClientRect().width
  const slotPitch = SLOT_WIDTH_PX + SLOT_GAP_PX
  const activeSlotCenter = activeIdx * slotPitch + SLOT_WIDTH_PX / 2
  const containerCenter = containerW / 2
  const translateX = Math.round(containerCenter - activeSlotCenter)

  if (opts.noAnim) {
    track.classList.add('no-anim')
    track.style.transform = `translateX(${translateX}px)`
    // Force layout, then drop the no-anim flag so subsequent updates animate.
    void track.offsetWidth
    track.classList.remove('no-anim')
  } else {
    track.style.transform = `translateX(${translateX}px)`
  }
}

// Claude slash commands for the dropdown.
// Populated dynamically from GET /api/claude/slash-commands (which reads the installed
// claude CLI's init event so it's always up-to-date and includes user/plugin commands).
// The fallback list below is used during initial load or when the API is unavailable.
const _SLASH_FALLBACK = [
  { cmd: '/clear',    hint: 'Clear conversation history' },
  { cmd: '/compact',  hint: 'Compact context to reduce token usage' },
  { cmd: '/help',     hint: 'Show help and available commands' },
  { cmd: '/exit',     hint: 'Exit Claude Code' },
  { cmd: '/status',   hint: 'Show session status and info' },
  { cmd: '/plan',        hint: 'Enter plan mode (review before executing)' },
  { cmd: '/rewind',      hint: 'Rewind conversation to an earlier checkpoint' },
  { cmd: '/resume',   hint: 'Resume previous session' },
  { cmd: '/permissions', hint: 'Manage tool permissions' },
  { cmd: '/model',    hint: 'Switch Claude model' },
]

// Hints for well-known commands (used to annotate the dynamic list)
const _SLASH_HINTS = {
  '/clear':         'Clear conversation history',
  '/compact':       'Compact context to reduce token usage',
  '/help':          'Show help and available commands',
  '/exit':          'Exit Claude Code',
  '/status':        'Show session status and info',
  '/restart':       'Restart session',
  '/resume':        'Resume previous session',
  '/add-dir':       'Add working directory to session',
  '/agents':        'List and manage sub-agents',
  '/bug':           'Report a bug to Anthropic',
  '/config':        'Open Claude Code configuration',
  '/context':       'Show current context window usage',
  '/cost':          'Show token cost for this session',
  '/doctor':        'Check Claude Code installation health',
  '/hooks':         'Manage Claude Code hooks',
  '/ide':           'Connect to IDE integration',
  '/init':          'Initialize project with CLAUDE.md',
  '/login':         'Log in to Claude / Anthropic',
  '/logout':        'Log out from Claude',
  '/mcp':           'Manage MCP server connections',
  '/memory':        'Edit Claude memory files',
  '/model':         'Switch Claude model',
  '/permissions':   'Manage tool permissions',
  '/plan':          'Enter plan mode (review before executing)',
  '/pr-comments':   'Review and reply to PR comments',
  '/release-notes': 'Show recent release notes',
  '/review':        'Review code changes',
  '/rewind':        'Rewind conversation to an earlier checkpoint',
  '/settings':      'Edit Claude Code settings',
  '/todos':         'Show and manage TODO items',
  '/vim':           'Toggle vim keybindings mode',
}

let CLAUDE_SLASH_COMMANDS = [..._SLASH_FALLBACK]

// Fetch live slash commands from the server (non-blocking)
fetch('/api/claude/slash-commands')
  .then((r) => r.ok ? r.json() : null)
  .then((data) => {
    if (data && Array.isArray(data.commands) && data.commands.length > 0) {
      CLAUDE_SLASH_COMMANDS = data.commands.map(({ cmd }) => ({
        cmd,
        hint: _SLASH_HINTS[cmd] || '',
      }))
      console.log(`[slash-commands] loaded ${CLAUDE_SLASH_COMMANDS.length} commands from server`)
    }
  })
  .catch(() => { /* keep fallback */ })

function setupChatInput() {
  const chatInput = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send-btn')
  const suggestionsDropdown = document.getElementById('suggestions-dropdown')

  if (!chatInput || !sendBtn) return

  // ── Claude tab stop button ────────────────────────────────────────────────
  // Inject a Stop button into the input-row (next to send-btn) at init time.
  const inputRow = chatInput.closest('.input-row')
  const stopBtn = document.createElement('button')
  stopBtn.type = 'button'
  stopBtn.id = 'claude-stop-btn'
  stopBtn.className = 'claude-stop-btn'
  stopBtn.setAttribute('aria-label', 'Stop Claude')
  stopBtn.title = 'Stop Claude (interrupt)'
  stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`
  stopBtn.hidden = true
  // Insert before send-btn
  sendBtn.parentNode.insertBefore(stopBtn, sendBtn)

  // ── Claude tab "Run in Background" button ─────────────────────────────────
  // Visible only while Claude is thinking. Releases the UI without interrupting
  // the server-side turn; the existing turn-complete notification fires when done.
  const bgBtn = document.createElement('button')
  bgBtn.type = 'button'
  bgBtn.id = 'claude-bg-btn'
  bgBtn.className = 'claude-bg-btn'
  bgBtn.setAttribute('aria-label', 'Run in background')
  bgBtn.title = 'Run in background (keep turn running, free the UI)'
  // Layers icon — two stacked rectangles, suggesting "push to back"
  bgBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="14" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/></svg>`
  bgBtn.hidden = true
  // Insert before stop-btn (so order is: [bg] [stop] [send])
  stopBtn.parentNode.insertBefore(bgBtn, stopBtn)

  // ── Background turn tracking ──────────────────────────────────────────────
  // Set of tabIds whose turns are running in the background (UI released).
  const _bgTabIds = new Set()

  function _getBgTabId() {
    if (!tabManager) return null
    return tabManager.activeId || null
  }

  /** Push active tab to background: release UI without interrupting server. */
  function doBackground() {
    const tabId = _getBgTabId()
    if (!tabId) return
    _bgTabIds.add(tabId)
    // Release the UI as if thinking ended, but without a real WS result.
    // skipFlush=true: queue must NOT flush — turn is still running server-side.
    chatInput.classList.remove('claude-thinking')
    stopBtn.hidden = true
    bgBtn.hidden = true
    sendBtn.hidden = false
    isClaudeThinking = false
    // Update the tab slot badge so user can see which tab has a bg turn.
    _updateBgBadges()
  }

  /** Clear bg state for a tab (called when its turn completes). */
  function _clearBgTab(tabId) {
    if (!tabId) return
    _bgTabIds.delete(tabId)
    _updateBgBadges()
  }

  /** Refresh the small '·' badge on tab slots that have a background turn. */
  function _updateBgBadges() {
    const track = document.getElementById('tab-slot-track')
    if (!track) return
    for (const slot of track.children) {
      const tid = slot.dataset.tabId
      slot.classList.toggle('has-bg-turn', !!(_bgTabIds.has(tid)))
    }
  }


  // ── Client-side pending queue ─────────────────────────────────────────────
  // Messages typed while Claude is busy are held here (not sent to server yet).
  // When Claude becomes idle, all pending items are combined into one turn.
  // This matches CLI behaviour: silent auto-queue + ↑ to edit last item.
  let _pendingQueue = []
  // Track which (projectId, tabId) the current _pendingQueue belongs to.
  let _queueProjectId = null
  let _queueTabId = null

  // ── Queue persistence helpers ─────────────────────────────────────────────
  // 需求9: persist IMMEDIATELY (no debounce) with keepalive so the message
  // lands on the server before a mobile tab suspend/kill can lose it. The old
  // 200ms debounce was the loss window — a page closed inside it lost the queue.
  function _persistQueueNow() {
    if (!_queueProjectId || !_queueTabId) return
    const pid = _queueProjectId
    const tid = _queueTabId
    const snapshot = [..._pendingQueue]
    fetch(`/api/projects/${pid}/tabs/${tid}/queue`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: snapshot }),
      keepalive: true,
    }).catch(() => { /* non-fatal */ })
  }

  async function _hydrateQueue(projectId, tabId) {
    try {
      const r = await fetch(`/api/projects/${projectId}/tabs/${tabId}/queue`)
      if (!r.ok) return
      const data = await r.json()
      if (Array.isArray(data.queue) && data.queue.length > 0) {
        // Only overwrite when the local queue is still empty.  If the user
        // typed a new message while the fetch was in flight we must not clobber
        // it (problem-4 hydrate race).
        if (_pendingQueue.length === 0) {
          _pendingQueue = data.queue
          updateQueueTray()
        }
      }
    } catch { /* non-fatal */ }
  }

  // Inject the queue tray (above .input-row) at init time.
  const queueTray = document.createElement('div')
  queueTray.id = 'claude-queue-tray'
  queueTray.className = 'claude-queue-tray'
  queueTray.hidden = true
  inputRow.parentNode.insertBefore(queueTray, inputRow)

  function updateQueueTray() {
    const visible = _pendingQueue.length > 0 && isBlockAgentTab
    queueTray.hidden = !visible
    if (!visible) { queueTray.innerHTML = ''; return }
    queueTray.innerHTML =
      `<div class="cq-header">` +
        `<span class="cq-header-label">排队中 (${_pendingQueue.length})</span>` +
        `<span class="cq-header-actions">` +
          `<button class="cq-send-now" title="强制中止当前回合并立即发送所有排队消息（只停主回合，不杀后台 sub-agent）">立刻发送</button>` +
          `<button class="cq-clear" title="清空所有排队消息（不发送）">清空</button>` +
        `</span>` +
      `</div>` +
      _pendingQueue.map((text, i) => {
        const truncated = text.length > 72 ? text.slice(0, 72) + '…' : text
        return `<div class="cq-item">` +
          `<span class="cq-pos">${i + 1}</span>` +
          `<span class="cq-text">${escapeHtml(truncated)}</span>` +
          `<button class="cq-send-one" data-idx="${i}" aria-label="Send this message now" title="打断当前回合并立即发送此条（只停主回合，不杀后台 sub-agent）">发送</button>` +
          `<button class="cq-remove" data-idx="${i}" aria-label="Remove queued message" title="Remove from queue">×</button>` +
          `</div>`
      }).join('') +
      `<div class="cq-hint">↑ 取回编辑 · 立刻发送=打断当前回合马上发 · 单条发送=只发该条 · 空闲时自动发送 · Esc 可清空</div>`
    queueTray.querySelectorAll('.cq-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        _pendingQueue.splice(+btn.dataset.idx, 1)
        _persistQueueNow()
        updateQueueTray()
      })
    })
    // Per-message "send now" button: interrupt the current turn and send ONLY
    // this one queued message immediately, leaving the rest in the queue.
    // Same atomic backend path as the global sendNowFlush (sendNow: true).
    queueTray.querySelectorAll('.cq-send-one').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const idx = +btn.dataset.idx
        if (idx < 0 || idx >= _pendingQueue.length) return
        const text = _pendingQueue.splice(idx, 1)[0]
        _persistQueueNow()
        updateQueueTray()
        if (activePane) activePane.sendInputWithEcho(text, { sendNow: true })
        pushHistory(text)
        resetHistoryNav()
        chatInput.focus()
      })
    })
    // "立即发送" button: force-interrupt the current turn AND submit the queued
    // messages right now. The backend owns ordering atomically — the message
    // rides the server queue and the andFlush interrupt guarantees it runs as
    // the next turn regardless of timing or the auto-flush setting. No fragile
    // wait-for-idle / 3s-fallback dance (which used to re-queue into a busy
    // backend = the "立刻发送却还排队" bug).
    const sendNowBtn = queueTray.querySelector('.cq-send-now')
    if (sendNowBtn) {
      sendNowBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        sendNowFlush()
      })
    }
    // "清空" button: cancel/clear all queued messages without sending.
    const clearBtn = queueTray.querySelector('.cq-clear')
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (_pendingQueue.length === 0) return
        _pendingQueue.splice(0)
        _persistQueueNow()
        updateQueueTray()
        chatInput.focus()
      })
    }
  }

  // Send all pending (and any text currently in the composer) right now,
  // force-interrupting the running turn. Shared by the tray button and Ctrl+Enter.
  function sendNowFlush() {
    // Fold any half-typed composer text into the flush so nothing is lost.
    const composer = chatInput.value.trim()
    if (composer) {
      _pendingQueue.push(chatInput.value)
      chatInput.value = ''
      autoResize()
      hideSuggestions()
      hideSlashCommands()
    }
    if (_pendingQueue.length === 0) return
    const all = _pendingQueue.splice(0)
    _persistQueueNow()
    updateQueueTray()
    const combined = all.join('\n\n')
    // 1) Echo + push the combined message to the backend. The backend WS
    //    handler now applies the atomic "send now" — busy → enqueue + interrupt
    //    + _forceFlushQueue (the queued message fires as the next turn); idle →
    //    the message runs immediately. No separate HTTP /interrupt is sent,
    //    which removes the WS-vs-HTTP race that could kill the just-started idle
    //    turn and silently drop the user's message. sendNow=true also suppresses
    //    the transient "queued" banner while a turn is winding down.
    if (activePane) activePane.sendInputWithEcho(combined, { sendNow: true })
    pushHistory(combined)
    resetHistoryNav()
    chatInput.focus()
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let isClaudeTab = false      // is the active tab a claude tab?
  let isCodexTab = false       // is the active tab a codex tab? (N43: slash passthrough)
  // 需求15 keystone: block-mode fable5/opencode tabs reuse ClaudeBlockRenderer
  // and dispatch the same claude-thinking/claude-model events, so they deserve
  // the same "shell" (stop button, model badge, busy/thinking UI). isBlockAgentTab
  // = claude OR block-mode fable5/opencode. Kept claude-only: /model + slash menu
  // (claude REPL specifics) — opencode model switching is via the store setting.
  let isBlockAgentTab = false
  let isClaudeThinking = false // is claude currently thinking?
  let isCodexThinking = false  // is codex currently thinking? (P2: visual feedback)
  let claudeSlashOpen = false  // is the slash commands dropdown open?

  function updateInputBarForTabType({ skipFlush = false } = {}) {
    const tabType = _activeTabType
    isClaudeTab = tabType === 'claude'
    isCodexTab = tabType === 'codex'
    // 需求15 keystone: block-mode fable5/opencode reuse ClaudeBlockRenderer and
    // share the claude shell (stop/badge/thinking). Mirror tab-manager.js's
    // useClaudeRenderer condition so renderMode toggles stay in sync.
    const fable5RenderMode = (() => { try { return window.__nanocodeState?.fable5RenderMode || 'block' } catch { return 'block' } })()
    const opencodeRenderMode = (() => { try { return window.__nanocodeState?.opencodeRenderMode || 'block' } catch { return 'block' } })()
    isBlockAgentTab = isClaudeTab ||
      (tabType === 'fable5' && fable5RenderMode !== 'terminal') ||
      (tabType === 'opencode' && opencodeRenderMode !== 'terminal')
    if (isClaudeTab) {
      chatInput.placeholder = 'Message Claude… (/ for commands)'
    } else if (tabType === 'fable5' && fable5RenderMode !== 'terminal') {
      chatInput.placeholder = 'Message Fable 5… (/ for commands)'
    } else if (tabType === 'opencode' && opencodeRenderMode !== 'terminal') {
      chatInput.placeholder = 'Message OpenCode… (/ for commands)'
    } else if (isCodexTab) {
      // N43: codex tab — "/" should pass through to codex, not trigger nanocode slash menu
      chatInput.placeholder = 'Send to Codex… (/ for codex commands)'
    } else {
      chatInput.placeholder = 'Type a command...'
    }
    // Stop btn only visible when a block agent (claude/fable5/opencode-block) is thinking
    updateThinkingState(isClaudeThinking && isBlockAgentTab, { skipFlush })
  }

  function updateThinkingState(thinking, { skipFlush = false } = {}) {
    isClaudeThinking = thinking
    const activeTabId = tabManager ? tabManager.activeId : null
    const isActiveBg = activeTabId && _bgTabIds.has(activeTabId)
    if (isBlockAgentTab && thinking && !isActiveBg) {
      chatInput.classList.add('claude-thinking')
      // Restore stop button to default icon/state
      stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`
      stopBtn.title = 'Stop (interrupt)'
      stopBtn.disabled = false
      stopBtn.hidden = false
      bgBtn.hidden = false
      sendBtn.hidden = true
    } else {
      chatInput.classList.remove('claude-thinking')
      // Result arrived — restore normal send UI.
      stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`
      stopBtn.title = 'Stop Claude (interrupt)'
      stopBtn.disabled = false
      stopBtn.hidden = true
      bgBtn.hidden = true
      sendBtn.hidden = false
      // 需求9: queue delivery is now server-owned. When Claude becomes idle the
      // server drains tab.pendingQueue itself (terminal/claude-*-driver.js
      // finally block), so the message is delivered even if this page was
      // suspended/closed before idle. The client NO LONGER flushes here — doing
      // so would race the server drain and double-deliver. The local
      // _pendingQueue mirror is cleared by the 'nanocode:claude-queue-drained'
      // event the server broadcasts when it drains the queue.
    }
  }

  // Listen for tab switches
  const origOnActiveChange = tabManager ? null : null  // will hook via event
  document.addEventListener('nanocode:tab-active', (e) => {
    _activeTabType = e.detail?.type || 'bash'

    // Hydrate the pending queue from the backend when switching to a claude tab.
    // Must happen BEFORE isClaudeThinking reset + updateInputBarForTabType() to
    // prevent a stale _pendingQueue from being flushed while Claude is still busy
    // on the target tab (P0 queue-flush race, problem-3).
    const newTabId = e.detail?.tabId || null
    const newProjectId = currentProjectId
    const switchedTab = newTabId !== _queueTabId || newProjectId !== _queueProjectId
    if (switchedTab) {
      // Clear in-memory queue FIRST so updateThinkingState() (called below via
      // updateInputBarForTabType) cannot see a stale queue and flush it prematurely.
      _pendingQueue = []
      _queueProjectId = newProjectId
      _queueTabId = newTabId
    }

    isClaudeThinking = false  // reset on tab switch
    isCodexThinking = false
    // Reset codex-thinking CSS state on tab switch
    chatInput.classList.remove('codex-thinking')
    sendBtn.classList.remove('codex-thinking-btn')
    sendBtn.disabled = false
    // skipFlush=true: do NOT flush _pendingQueue on tab-switch — flush must only
    // happen when the WS 'result' event arrives confirming Claude is truly idle.
    updateInputBarForTabType({ skipFlush: true })

    // If switching to a block-agent tab, check the renderer's ground-truth
    // thinking state to correct any stale isClaudeThinking in terminal-view.
    // Previously this only checked bg tabs, but the thinking state can also
    // become stale after a WS reconnect (the renderer resets _thinking=false
    // directly, without dispatching the event to terminal-view). Checking ALL
    // block-agent tabs on switch ensures the input bar always reflects reality.
    if (newTabId && isBlockAgentTab) {
      const tabEntry = tabManager ? tabManager.tabs.find((t) => t.id === newTabId) : null
      const pane = tabEntry?.pane
      const stillRunning = pane && typeof pane.isThinking === 'function' && pane.isThinking()
      if (stillRunning) {
        // Re-enter foreground thinking UI without clearing bg flag yet.
        // The bg flag will be cleared when the WS result event (thinking=false) arrives.
        chatInput.classList.add('claude-thinking')
        stopBtn.hidden = false
        bgBtn.hidden = false
        sendBtn.hidden = true
        isClaudeThinking = true
      } else if (_bgTabIds.has(newTabId)) {
        // Turn already completed while in bg — clean up the stale bg flag.
        _clearBgTab(newTabId)
      }
    }

    // Start async hydrate AFTER the sync flush-guard above.  _hydrateQueue will
    // only overwrite _pendingQueue when it is still empty (problem-4 hydrate race).
    // 需求15 item2: hydrate the persisted queue for any block-agent tab
    // (claude OR block-mode fable5/opencode) — isBlockAgentTab is already updated
    // to the new tab by updateInputBarForTabType() above.
    if (switchedTab && isBlockAgentTab && newProjectId && newTabId) {
      _hydrateQueue(newProjectId, newTabId)
    }

    updateQueueTray()           // then update tray with fresh isBlockAgentTab
    _updateBgBadges()         // refresh background-turn badges on tab slots
  })

  // Listen for claude/codex thinking state changes
  document.addEventListener('nanocode:claude-thinking', (e) => {
    const detail = e.detail || {}
    const thinkingTabId = detail.tabId
    // When a bg turn finishes (thinking=false on any tab), clear its bg state.
    if (!detail.thinking && thinkingTabId) {
      _clearBgTab(thinkingTabId)
    }
    // Only update UI if this is the active tab
    const activeId = tabManager ? tabManager.activeId : null
    if (!activeId || thinkingTabId !== activeId) return
    if (isCodexTab) {
      // N43-R9: codex is an interactive REPL — dim animation only, do NOT
      // disable the send button or the user can't navigate interactive menus
      // (/model, /compact, etc.) or send /clear while codex is busy.
      isCodexThinking = !!detail.thinking
      chatInput.classList.toggle('codex-thinking', isCodexThinking)
      sendBtn.classList.toggle('codex-thinking-btn', isCodexThinking)
      // sendBtn.disabled intentionally NOT set for codex tabs — keep enabled
      sendBtn.title = isCodexThinking ? 'Codex is working… (send to interact)' : 'Send'
    } else {
      updateThinkingState(!!detail.thinking)
    }
  })

  // 需求9: the server is now the sole queue delivery path. When it drains
  // tab.pendingQueue (agent went idle) it broadcasts 'queue-drained'; clear the
  // local _pendingQueue mirror so the tray doesn't show stale items that the
  // server already delivered. Only clear for the active claude tab.
  document.addEventListener('nanocode:claude-queue-drained', (e) => {
    const detail = e.detail || {}
    const activeId = tabManager ? tabManager.activeId : null
    if (!activeId || detail.tabId !== activeId) return
    if (!isBlockAgentTab) return
    if (_pendingQueue.length > 0) {
      _pendingQueue.splice(0)
      _persistQueueNow()
      updateQueueTray()
    }
  })

  // ── Model badge / in-tab model picker (CC parity #4) ─────────────────────
  // Shows which Claude model is actually replying on the active tab, updated in
  // real time from nanocode:claude-model (dispatched by the block renderer on
  // every assistant message_start — so mid-session /model switches show up on
  // the very next turn). One model remembered per tab; tab switches re-render.
  // The badge doubles as a touch-friendly model picker trigger: tapping it opens
  // the same two-step model/effort picker as `/model`, so switching models never
  // requires typing a slash command (mobile-first). On claude tabs it stays
  // visible even before the first reply so the affordance is always reachable.
  const modelBadgeEl = document.getElementById('model-badge')
  const _modelByTab = new Map()

  function _updateModelBadge() {
    if (!modelBadgeEl) return
    const activeId = tabManager ? tabManager.activeId : null
    if (!isBlockAgentTab || !activeId) {
      // Non-claude tabs: hide the badge (no model concept / no picker).
      modelBadgeEl.hidden = true
      modelBadgeEl.classList.remove('model-badge--pickable')
      return
    }
    const model = _modelByTab.get(activeId)
    if (model) {
      // "claude-fable-5" → "fable-5": keep the pill short (mobile-friendly).
      modelBadgeEl.textContent = model.replace(/^claude-/, '')
      modelBadgeEl.title = t('composer.model.tooltip')
    } else {
      // No reply yet — still show a tappable "model" affordance on claude tabs.
      modelBadgeEl.textContent = 'model'
      modelBadgeEl.title = t('composer.model.tooltip')
    }
    modelBadgeEl.hidden = false
    modelBadgeEl.classList.add('model-badge--pickable')
  }

  if (modelBadgeEl) {
    modelBadgeEl.setAttribute('role', 'button')
    modelBadgeEl.setAttribute('tabindex', '0')
    modelBadgeEl.setAttribute('aria-label', t('composer.model.tooltip'))
    const openPicker = (e) => {
      if (modelBadgeEl.hidden || !isBlockAgentTab) return
      e.preventDefault()
      showModelPicker()
    }
    modelBadgeEl.addEventListener('click', openPicker)
    modelBadgeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') openPicker(e)
    })
  }

  document.addEventListener('nanocode:claude-model', (e) => {
    const { tabId, model } = e.detail || {}
    if (!tabId || !model) return
    _modelByTab.set(tabId, model)
    _updateModelBadge()
  })

  document.addEventListener('nanocode:tab-active', () => _updateModelBadge())
  // Reflect model concept when the active tab type changes at init.
  _updateModelBadge()

  // Listen for subagent-phase transitions.
  // When the main Claude turn has handed off to a subagent (Task tool) and is now
  // idle-waiting, active=true. The outer turn is still in progress (isClaudeThinking
  // stays true so new messages go to the pending queue), but the main model is NOT
  // generating — so we show Send instead of Stop, letting the user queue/chat freely.
  // When active=false the main agent is generating again → Stop/Bg buttons return.
  document.addEventListener('nanocode:claude-subagent-phase', (e) => {
    const detail = e.detail || {}
    const phaseTabId = detail.tabId
    const activeId = tabManager ? tabManager.activeId : null
    if (!activeId || phaseTabId !== activeId) return
    if (!isClaudeTab) return
    const isActiveBg = activeId && _bgTabIds.has(activeId)
    if (isActiveBg) return  // bg turns: no UI change needed
    if (detail.active) {
      // Subagent phase: main agent idle, subagent running.
      // Show Send so user can type/queue; keep isClaudeThinking=true so messages queue.
      chatInput.classList.remove('claude-thinking')
      stopBtn.hidden = true
      bgBtn.hidden = true
      sendBtn.hidden = false
    } else {
      // Main agent resumed generating → restore thinking UI
      if (isClaudeThinking) {
        chatInput.classList.add('claude-thinking')
        stopBtn.hidden = false
        bgBtn.hidden = false
        sendBtn.hidden = true
      }
    }
  })

  // ── Interrupt helper (shared by Stop btn, Esc, Ctrl+C) ─────────────────────
  // Single Esc / Stop interrupts the current turn (soft, SIGINT → q.interrupt()).
  // A second Esc / Stop while still thinking — or any call with {force:true} —
  // escalates to a force interrupt that is guaranteed to unlock the UI even if
  // the soft interrupt was unresponsive. Force stops ONLY the main turn; the
  // backend keeps the claude process and its background sub-agents alive.
  // Posts /interrupt to the backend. Does NOT call updateThinkingState(false)
  // — that only happens when the WS 'result' event arrives, preserving the
  // _pendingQueue protection (b67a2b6).
  let _interruptArmedUntil = 0   // timestamp: until when a 2nd press escalates to force
  const _INTERRUPT_ESCALATE_MS = 2500

  async function doInterrupt(opts = {}) {
    if (!tabManager) return
    const activeTab = tabManager.tabs?.find((t) => t.id === tabManager.activeId)
    if (!activeTab) return
    const projectId = tabManager.projectId
    const tabId = activeTab.id

    // Decide soft vs force: explicit opt, or a quick second press after a soft one.
    const now = Date.now()
    const force = opts.force === true || (_interruptArmedUntil > 0 && now < _interruptArmedUntil)
    // After a soft interrupt, arm an escalation window so the next press forces.
    _interruptArmedUntil = force ? 0 : now + _INTERRUPT_ESCALATE_MS

    const body = JSON.stringify({ force, andFlush: opts.andFlush === true })
    try {
      await fetch(`/api/projects/${projectId}/tabs/${tabId}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    } catch {}

    // Do NOT call showInterruptBlock() here — CLI will emit result/error_during_execution
    // via stdout which nanocode transparently forwards. Let the WS event drive UI state.

    // Visual: keep stopBtn visible until the real WS result event triggers
    // updateThinkingState(false). Do NOT hide stopBtn or show sendBtn yet —
    // this prevents premature flush of _pendingQueue.
    chatInput.classList.remove('claude-thinking')
    stopBtn.disabled = false
    stopBtn.hidden = false
    bgBtn.hidden = true   // bg button not needed once user chose to interrupt
    sendBtn.hidden = true
    // Hint that a second press will force-stop (until the escalation window ends).
    if (!force) {
      stopBtn.classList.add('claude-stop-armed')
      stopBtn.title = '再次点击 / 再按 Esc = 强制中止（只停主回合，不杀后台 sub-agent）'
      setTimeout(() => {
        if (Date.now() >= _interruptArmedUntil) stopBtn.classList.remove('claude-stop-armed')
      }, _INTERRUPT_ESCALATE_MS + 50)
    } else {
      stopBtn.classList.remove('claude-stop-armed')
    }
  }

  // Stop button click: POST interrupt to backend (2nd click escalates to force)
  stopBtn.addEventListener('click', () => {
    doInterrupt()
  })

  // Background button click: release UI without interrupting server turn
  bgBtn.addEventListener('click', () => {
    doBackground()
  })

  // Expose doInterrupt so Esc/Ctrl+C handlers below can call it.
  // (All three handlers are in the same setupChatInput() closure scope.)

  // ── Slash-command dropdown for Claude tabs ────────────────────────────────

  /**
   * Fuzzy match score: returns a number (lower = better) or -1 for no match.
   * Uses a contiguous-subsequence matching strategy similar to VS Code Cmd+P:
   * all query chars must appear in order in the target, but don't need to be adjacent.
   * Bonus for: consecutive matches, prefix match, word-boundary match.
   */
  function _slashFuzzyScore(target, query) {
    if (!query) return 0  // empty query matches everything, score 0
    const t = target.toLowerCase()
    const q = query.toLowerCase()

    // Fast path: prefix match scores best
    if (t.startsWith(q)) return 0 - q.length

    let ti = 0, qi = 0
    let score = 0
    let consecutive = 0
    while (ti < t.length && qi < q.length) {
      if (t[ti] === q[qi]) {
        score += consecutive > 0 ? -2 : 1   // bonus for consecutive
        consecutive++
        qi++
      } else {
        consecutive = 0
        score += 2  // penalty for gap
      }
      ti++
    }
    if (qi < q.length) return -1  // not all chars matched
    return score
  }

  /**
   * Build grouped slash command list: { builtin: [...], plugins: { name: [...] } }
   * Plugin commands have format "plugin:command", builtins have no colon.
   */
  function _groupSlashCommands(cmds) {
    const builtin = []
    const plugins = {}
    for (const cmd of cmds) {
      const name = cmd.cmd.slice(1)  // strip leading /
      const colonIdx = name.indexOf(':')
      if (colonIdx < 0) {
        builtin.push(cmd)
      } else {
        const pluginName = name.slice(0, colonIdx)
        if (!plugins[pluginName]) plugins[pluginName] = []
        plugins[pluginName].push(cmd)
      }
    }
    return { builtin, plugins }
  }

  function showSlashCommands(query) {
    if (!isClaudeTab) return
    // query is the text after '/', e.g. '' or 'cl' or 'help'
    const q = query.toLowerCase()

    let matches
    if (!q) {
      // No query: show all commands, grouped
      matches = CLAUDE_SLASH_COMMANDS.map((c) => ({ cmd: c, score: 0, matchRanges: [] }))
    } else {
      // Fuzzy filter: match against command name (without leading /)
      const scored = []
      for (const cmd of CLAUDE_SLASH_COMMANDS) {
        const target = cmd.cmd.slice(1)  // command name without /
        const score = _slashFuzzyScore(target, q)
        if (score >= 0) scored.push({ cmd, score })
      }
      if (!scored.length) {
        hideSlashCommands()
        return
      }
      // Sort: lower score = better match
      scored.sort((a, b) => a.score - b.score)
      matches = scored.map(({ cmd, score }) => ({ cmd, score, matchRanges: [] }))
    }

    claudeSlashOpen = true
    suggestionsDropdown.innerHTML = ''

    // Determine highlight ranges for query in cmd text
    function highlightCmd(cmdText, q) {
      if (!q) return escapeHtml(cmdText)
      // Find character positions matching query (greedy left-to-right)
      const t = cmdText.toLowerCase()
      const ql = q.toLowerCase()
      const positions = new Set()
      let qi = 0
      for (let ti = 0; ti < t.length && qi < ql.length; ti++) {
        if (t[ti] === ql[qi]) { positions.add(ti); qi++ }
      }
      let html = ''
      for (let i = 0; i < cmdText.length; i++) {
        const ch = escapeHtml(cmdText[i])
        html += positions.has(i) ? `<mark class="slash-match">${ch}</mark>` : ch
      }
      return html
    }

    function appendItem(opt) {
      const item = document.createElement('div')
      item.className = 'suggestion-item claude-slash-item'
      const cmdDisplay = opt.cmd.cmd
      const hintDisplay = opt.cmd.hint || ''
      const cmdHtml = q ? highlightCmd(cmdDisplay, q) : escapeHtml(cmdDisplay)
      item.innerHTML =
        `<span class="claude-slash-cmd">${cmdHtml}</span>` +
        (hintDisplay ? `<span class="claude-slash-hint">${escapeHtml(hintDisplay)}</span>` : '')
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        chatInput.value = cmdDisplay + ' '
        autoResize()
        hideSlashCommands()
        chatInput.focus()
      })
      suggestionsDropdown.appendChild(item)
    }

    function appendGroupHeader(label) {
      const header = document.createElement('div')
      header.className = 'claude-slash-group-header'
      header.textContent = label
      suggestionsDropdown.appendChild(header)
    }

    if (q) {
      // Filtered mode: flat sorted list (no group headers — query breaks grouping intent)
      for (const m of matches) appendItem(m)
    } else {
      // Unfiltered mode: show grouped
      const { builtin, plugins } = _groupSlashCommands(CLAUDE_SLASH_COMMANDS)

      if (builtin.length) {
        appendGroupHeader('Built-in')
        for (const cmd of builtin) appendItem({ cmd, score: 0 })
      }

      for (const [pluginName, cmds] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) {
        appendGroupHeader(pluginName + ':')
        for (const cmd of cmds) appendItem({ cmd, score: 0 })
      }
    }

    suggestionsDropdown.hidden = false
  }

  function hideSlashCommands() {
    claudeSlashOpen = false
    if (suggestionsDropdown) {
      suggestionsDropdown.hidden = true
      suggestionsDropdown.innerHTML = ''
    }
  }

  const HISTORY_KEY = 'cmdHistory'
  const MAX_HISTORY = 200

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed
        if (Array.isArray(parsed.bash)) return parsed.bash
      }
    } catch {}
    return []
  }

  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)) } catch {}
  }

  const history = loadHistory()
  let historyIdx = -1
  let historyDraft = ''
  let selectedSuggestion = -1

  function pushHistory(text) {
    if (history.length && history[history.length - 1] === text) return
    history.push(text)
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY)
    saveHistory()
  }

  function resetHistoryNav() {
    historyIdx = -1
    historyDraft = ''
  }

  function showSuggestions(query) {
    if (!suggestionsDropdown || !query.trim()) {
      hideSuggestions()
      return
    }
    const q = query.toLowerCase()
    const seen = new Set()
    const matches = []
    for (let i = history.length - 1; i >= 0 && matches.length < 12; i--) {
      const cmd = history[i]
      if (seen.has(cmd)) continue
      if (cmd.toLowerCase().includes(q)) {
        seen.add(cmd)
        matches.push(cmd)
      }
    }
    if (!matches.length) {
      hideSuggestions()
      return
    }
    selectedSuggestion = -1
    suggestionsDropdown.innerHTML = ''
    for (let i = 0; i < matches.length; i++) {
      const cmd = matches[i]
      const item = document.createElement('div')
      item.className = 'suggestion-item'
      item.dataset.index = i
      const textEl = document.createElement('span')
      textEl.className = 'suggestion-text'
      const matchIdx = cmd.toLowerCase().indexOf(q)
      if (matchIdx >= 0) {
        textEl.innerHTML =
          escapeHtml(cmd.slice(0, matchIdx)) +
          '<mark>' +
          escapeHtml(cmd.slice(matchIdx, matchIdx + q.length)) +
          '</mark>' +
          escapeHtml(cmd.slice(matchIdx + q.length))
      } else {
        textEl.textContent = cmd
      }
      item.appendChild(textEl)
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        chatInput.value = cmd
        autoResize()
        hideSuggestions()
        chatInput.focus()
      })
      suggestionsDropdown.appendChild(item)
    }
    const hint = document.createElement('div')
    hint.className = 'suggestions-hint'
    hint.textContent = '↑↓ navigate · Enter accept · Esc dismiss'
    suggestionsDropdown.appendChild(hint)
    suggestionsDropdown.hidden = false
  }

  function hideSuggestions() {
    if (suggestionsDropdown) {
      suggestionsDropdown.hidden = true
      suggestionsDropdown.innerHTML = ''
    }
    selectedSuggestion = -1
  }

  function selectSuggestion(direction) {
    const items = suggestionsDropdown.querySelectorAll('.suggestion-item')
    if (!items.length) return false
    if (selectedSuggestion >= 0 && selectedSuggestion < items.length) {
      items[selectedSuggestion].classList.remove('selected')
    }
    selectedSuggestion += direction
    if (selectedSuggestion < 0) selectedSuggestion = items.length - 1
    if (selectedSuggestion >= items.length) selectedSuggestion = 0
    items[selectedSuggestion].classList.add('selected')
    items[selectedSuggestion].scrollIntoView({ block: 'nearest' })
    return true
  }

  function getSelectedSuggestionText() {
    if (selectedSuggestion < 0) return null
    const items = suggestionsDropdown.querySelectorAll('.suggestion-item')
    if (selectedSuggestion >= items.length) return null
    const textEl = items[selectedSuggestion].querySelector('.suggestion-text')
    return textEl ? textEl.textContent : null
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function autoResize() {
    // For empty input, clear the inline height so the CSS rule
    // (height: 38px) takes over cleanly — guarantees pixel-exact
    // alignment with the send button on the empty/single-line state.
    if (!chatInput.value) {
      chatInput.style.height = ''
      chatInput.style.overflowY = 'hidden'
      return
    }
    chatInput.style.height = 'auto'
    // Floor at 38 so even rounding-down scrollHeight values can't
    // make the textarea shorter than its siblings.
    const next = Math.max(38, Math.min(chatInput.scrollHeight, 120))
    chatInput.style.height = next + 'px'
    chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden'
  }

  // ── Feature 1: Queue-choice dialog ───────────────────────────────────────
  // When claude is busy, instead of silently enqueuing, we show an inline
  // banner with two actions: "排队" (enqueue) or "打断并发送" (interrupt+send).
  // The banner is appended to .cbr-scroll of the active pane and removes
  // itself once the user picks an action.

  let _queueChoiceBanner = null

  function dismissQueueBanner() {
    if (_queueChoiceBanner) {
      _queueChoiceBanner.remove()
      _queueChoiceBanner = null
    }
  }

  function showQueueChoiceBanner(text) {
    dismissQueueBanner()

    // Find the scroll container of the active CBR pane
    const container = activePane?.container || activePane?._scroll?.parentElement
    const scroll = container?.querySelector('.cbr-scroll') || activePane?._scroll
    if (!scroll) {
      // Fallback: just enqueue silently
      if (activePane) activePane.sendInputWithEcho(text)
      return
    }

    const banner = document.createElement('div')
    banner.className = 'cbr-queue-banner'
    banner.innerHTML =
      `<span class="cbr-queue-banner-msg">Claude 正忙：</span>` +
      `<button class="cbr-queue-btn cbr-queue-enqueue" title="等当前回合完成再发送">排队</button>` +
      `<button class="cbr-queue-btn cbr-queue-interrupt" title="立即中断当前回合并发送">打断并发送</button>` +
      `<button class="cbr-queue-btn cbr-queue-cancel" title="取消">取消</button>`
    scroll.appendChild(banner)
    scroll.scrollTop = scroll.scrollHeight
    _queueChoiceBanner = banner

    banner.querySelector('.cbr-queue-enqueue').addEventListener('click', () => {
      dismissQueueBanner()
      // Send normally — server will enqueue since it's busy
      if (activePane) activePane.sendInputWithEcho(text)
      pushHistory(text)
      resetHistoryNav()
      chatInput.focus()
    })

    banner.querySelector('.cbr-queue-interrupt').addEventListener('click', async () => {
      dismissQueueBanner()
      // Interrupt the current turn, then send
      const activeTab = tabManager?.tabs?.find((t) => t.id === tabManager.activeId)
      const projectId = tabManager?.projectId
      if (activeTab && projectId) {
        try {
          await fetch(`/api/projects/${projectId}/tabs/${activeTab.id}/interrupt`, { method: 'POST' })
        } catch {}
        // Optimistically update thinking state
        updateThinkingState(false)
      }
      // Small delay so the interrupt lands before we send the next turn
      setTimeout(() => {
        if (activePane) activePane.sendInputWithEcho(text)
        pushHistory(text)
        resetHistoryNav()
        chatInput.focus()
      }, 150)
    })

    banner.querySelector('.cbr-queue-cancel').addEventListener('click', () => {
      dismissQueueBanner()
      chatInput.focus()
    })
  }

  // ── Feature 2: /model interactive picker ─────────────────────────────────
  // When the user types /model (with no args, or bare /model), intercept client-
  // side and show a two-step inline picker: Step 1 = model, Step 2 = effort.
  // Applies only to claude tabs. If the user typed /model <name> directly, we
  // still pass it through to the backend interception for backward compat.

  // Available Claude models for the picker (canonical list; kept short and real).
  const _MODEL_PICKER_LIST = [
    { id: 'claude-fable-5',          label: 'Claude Fable 5',          hint: 'Latest · recommended' },
    { id: 'claude-opus-4-8',         label: 'Claude Opus 4.8',         hint: 'Powerful · complex tasks' },
    { id: 'claude-sonnet-4-6',       label: 'Claude Sonnet 4.6',       hint: 'Balanced' },
    { id: 'claude-haiku-4-5',        label: 'Claude Haiku 4.5',        hint: 'Fast · lightweight' },
    { id: '',                        label: '(CLI default)',            hint: 'Use whatever claude CLI defaults to' },
  ]

  const _EFFORT_PICKER_LIST = [
    { id: 'xhigh', label: 'xhigh', hint: 'Max thinking budget · slowest · most thorough' },
    { id: 'high',  label: 'high',  hint: 'Extended reasoning · thorough' },
    { id: 'medium',label: 'medium',hint: 'Balanced speed vs depth' },
    { id: 'low',   label: 'low',   hint: 'Fast · minimal thinking' },
    { id: '',      label: '(none / CLI default)', hint: 'No --effort flag passed to claude' },
  ]

  let _modelPickerEl = null

  function dismissModelPicker() {
    if (_modelPickerEl) {
      _modelPickerEl.remove()
      _modelPickerEl = null
    }
  }

  function _getPickerScroll() {
    const container = activePane?.container || activePane?._scroll?.parentElement
    return container?.querySelector('.cbr-scroll') || activePane?._scroll || null
  }

  function _appendToScroll(el) {
    const scroll = _getPickerScroll()
    if (!scroll) return false
    scroll.appendChild(el)
    scroll.scrollTop = scroll.scrollHeight
    return true
  }

  async function showModelPicker() {
    dismissModelPicker()

    // Fetch current settings from server to pre-highlight active model/effort.
    // Gracefully degrade to empty string if the fetch fails (no pre-highlight).
    let curModel = ''
    let curEffort = ''
    try {
      const res = await fetch('/api/settings')
      if (res.ok) {
        const s = await res.json()
        curModel = s.claude_model || ''
        curEffort = s.claude_effort || ''
      }
    } catch (_) { /* ignore — picker still works, just no pre-highlight */ }

    const picker = document.createElement('div')
    picker.className = 'cbr-model-picker'
    _modelPickerEl = picker

    // Build step 1: model selection
    function buildModelStep() {
      picker.innerHTML = ''
      const header = document.createElement('div')
      header.className = 'cbr-model-picker-header'
      header.textContent = 'Select model (step 1 of 2)'
      picker.appendChild(header)

      const grid = document.createElement('div')
      grid.className = 'cbr-model-picker-grid'

      for (const m of _MODEL_PICKER_LIST) {
        const btn = document.createElement('button')
        btn.className = 'cbr-model-picker-btn' + (m.id === curModel ? ' cbr-model-picker-active' : '')
        btn.innerHTML = `<span class="cbr-model-picker-name">${escapeHtml(m.label)}</span>` +
                        `<span class="cbr-model-picker-hint">${escapeHtml(m.hint)}</span>`
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          buildEffortStep(m)
        })
        grid.appendChild(btn)
      }

      picker.appendChild(grid)

      const cancelRow = document.createElement('div')
      cancelRow.className = 'cbr-model-picker-cancel-row'
      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'cbr-queue-btn cbr-queue-cancel'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); dismissModelPicker(); chatInput.focus() })
      cancelRow.appendChild(cancelBtn)
      picker.appendChild(cancelRow)

      const scroll = _getPickerScroll()
      if (scroll) scroll.scrollTop = scroll.scrollHeight
    }

    function buildEffortStep(chosenModel) {
      picker.innerHTML = ''
      const header = document.createElement('div')
      header.className = 'cbr-model-picker-header'
      header.innerHTML = `Select reasoning effort for <strong>${escapeHtml(chosenModel.label)}</strong> (step 2 of 2)`
      picker.appendChild(header)

      const grid = document.createElement('div')
      grid.className = 'cbr-model-picker-grid'

      for (const ef of _EFFORT_PICKER_LIST) {
        const btn = document.createElement('button')
        btn.className = 'cbr-model-picker-btn' + (ef.id === curEffort ? ' cbr-model-picker-active' : '')
        btn.innerHTML = `<span class="cbr-model-picker-name">${escapeHtml(ef.label)}</span>` +
                        `<span class="cbr-model-picker-hint">${escapeHtml(ef.hint)}</span>`
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          applyModelAndEffort(chosenModel, ef)
        })
        grid.appendChild(btn)
      }

      picker.appendChild(grid)

      const cancelRow = document.createElement('div')
      cancelRow.className = 'cbr-model-picker-cancel-row'
      const backBtn = document.createElement('button')
      backBtn.className = 'cbr-queue-btn'
      backBtn.textContent = '← Back'
      backBtn.addEventListener('mousedown', (e) => { e.preventDefault(); buildModelStep() })
      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'cbr-queue-btn cbr-queue-cancel'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); dismissModelPicker(); chatInput.focus() })
      cancelRow.appendChild(backBtn)
      cancelRow.appendChild(cancelBtn)
      picker.appendChild(cancelRow)

      const scroll = _getPickerScroll()
      if (scroll) scroll.scrollTop = scroll.scrollHeight
    }

    async function applyModelAndEffort(chosenModel, chosenEffort) {
      dismissModelPicker()
      try {
        // Update both settings via REST API (same path app.js uses for the settings panel)
        await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'claude_model', value: chosenModel.id }),
        })
        await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'claude_effort', value: chosenEffort.id }),
        })
        // Update local serverSettings cache so the picker reflects new values immediately
        if (typeof serverSettings !== 'undefined') {
          serverSettings.claude_model = chosenModel.id
          serverSettings.claude_effort = chosenEffort.id
        }
        // Show confirmation as a system info message rendered inline
        const confirmEl = document.createElement('div')
        confirmEl.className = 'cbr-model-picker-confirm'
        const modelLabel = chosenModel.label || '(CLI default)'
        const effortLabel = chosenEffort.id ? ` · effort: ${chosenEffort.label}` : ''
        confirmEl.textContent = `Model set to ${modelLabel}${effortLabel}. Takes effect on next message.`
        _appendToScroll(confirmEl)
        setTimeout(() => confirmEl.remove(), 5000)
      } catch (err) {
        console.error('[model-picker] failed to save settings:', err)
        const errEl = document.createElement('div')
        errEl.className = 'cbr-model-picker-confirm cbr-model-picker-error'
        errEl.textContent = `Failed to save model: ${err.message}`
        _appendToScroll(errEl)
        setTimeout(() => errEl.remove(), 5000)
      }
      chatInput.focus()
    }

    buildModelStep()

    if (!_appendToScroll(picker)) {
      // No CBR scroll available (plain terminal tab) — fall back to clearing input
      _modelPickerEl = null
    }
  }

  function sendInput() {
    const text = chatInput.value
    if (!text) return

    // /model with no args (or bare /model) on a claude tab → show inline picker
    if (isClaudeTab && text.trim().match(/^\/model\s*$/)) {
      chatInput.value = ''
      autoResize()
      hideSuggestions()
      hideSlashCommands()
      chatInput.focus()
      showModelPicker()
      return
    }

    // When Claude is busy: silently add to client-side pending queue.
    // No per-message banner — matches CLI behaviour of auto-queuing with a
    // compact tray showing position. User can ↑ to take back the last item,
    // or click × on any item to remove it. All items flush automatically when
    // Claude finishes. To interrupt instead, use the Stop button.
    if (isBlockAgentTab && isClaudeThinking) {
      _pendingQueue.push(text)
      _persistQueueNow()
      chatInput.value = ''
      autoResize()
      hideSuggestions()
      hideSlashCommands()
      updateQueueTray()
      chatInput.focus()
      return
    }

    // N43-R9: Codex is an interactive REPL — do NOT block sends while thinking.
    // The user must be able to send follow-up input (e.g. navigate /model menu,
    // send /clear to interrupt, enter numbers to select options). Removing this
    // guard is the core fix for N43: mobile users were permanently locked out
    // when isCodexThinking=true blocked both the send button AND pointer events.

    // Not busy (or not a claude tab): send immediately as before
    if (activePane) activePane.sendInputWithEcho(text)
    pushHistory(text)
    resetHistoryNav()
    hideSuggestions()
    hideSlashCommands()
    chatInput.value = ''
    autoResize()
    chatInput.focus()
  }

  sendBtn.addEventListener('click', sendInput)

  // ── Compact context button ────────────────────────────────────────────────
  // Sends /compact to the active pane (works for both claude and codex tabs).
  const compactCtxBtn = document.getElementById('compact-ctx-btn')
  if (compactCtxBtn) {
    compactCtxBtn.addEventListener('click', () => {
      if (activePane) activePane.sendInputWithEcho('/compact')
    })
  }

  // ── IME composition guard ─────────────────────────────────────────────────
  // Track whether the user is mid-composition (e.g. Chinese/Japanese IME).
  // Some browsers (Chrome on Windows/Mac) set e.isComposing=true during
  // compositionstart..compositionend, but others (older iOS Safari, some
  // Android WebView) only set keyCode 229.  We use a flag + both signals.
  let _isComposing = false
  chatInput.addEventListener('compositionstart', () => { _isComposing = true })
  chatInput.addEventListener('compositionend', () => { _isComposing = false })

  chatInput.addEventListener('input', () => {
    autoResize()
    resetHistoryNav()
    const val = chatInput.value
    // Slash command mode for claude tabs
    if (isClaudeTab && val.startsWith('/')) {
      hideSuggestions()
      showSlashCommands(val.slice(1))
      return
    }
    hideSlashCommands()
    // N43: codex tab — suppress history suggestion dropdown so "/" passes
    // through cleanly to codex without nanocode dropdown intercepting Enter.
    if (isCodexTab) {
      hideSuggestions()
      return
    }
    showSuggestions(val)
  })

  chatInput.addEventListener('keydown', (e) => {
    const suggestionsOpen = suggestionsDropdown && !suggestionsDropdown.hidden

    // Ctrl/Cmd+Enter on a claude tab = "send now": force-interrupt the running
    // turn and submit immediately (composer text + any queued messages).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isBlockAgentTab) {
      if (e.isComposing || _isComposing || e.keyCode === 229) return
      e.preventDefault()
      hideSuggestions()
      hideSlashCommands()
      if (isClaudeThinking || _pendingQueue.length > 0 || chatInput.value.trim()) {
        sendNowFlush()
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // Block Enter while IME is composing (handles Chinese/Japanese/Korean input).
      // e.isComposing is standard; keyCode===229 is the legacy fallback used by
      // some older browsers / Android WebViews during composition.
      if (e.isComposing || _isComposing || e.keyCode === 229) return
      e.preventDefault()
      // If slash dropdown is open, pick the first item or close
      if (claudeSlashOpen) {
        const firstItem = suggestionsDropdown?.querySelector('.claude-slash-item')
        if (firstItem) {
          const cmdEl = firstItem.querySelector('.claude-slash-cmd')
          if (cmdEl) {
            chatInput.value = cmdEl.textContent + ' '
            autoResize()
          }
        }
        hideSlashCommands()
        return
      }
      if (suggestionsOpen && selectedSuggestion >= 0) {
        const text = getSelectedSuggestionText()
        if (text) {
          chatInput.value = text
          autoResize()
        }
        hideSuggestions()
        return
      }
      sendInput()
      return
    }

    if (e.key === 'Tab') {
      // Tab cycles bash tabs (Shift+Tab cycles backward). Always intercepted
      // regardless of composer content — explicit user intent per design.
      e.preventDefault()
      hideSuggestions()
      if (tabManager) tabManager.cycle(e.shiftKey ? -1 : 1)
      return
    }

    if (e.key === 'Escape') {
      if (claudeSlashOpen) {
        // Priority 1: close slash dropdown
        hideSlashCommands()
      } else if (suggestionsOpen) {
        // Priority 2: close suggestions
        hideSuggestions()
      } else if (isBlockAgentTab && isClaudeThinking) {
        // Priority 3 (block-agent tab): interrupt running turn.
        // First Esc = soft interrupt; a quick 2nd Esc escalates to force-stop
        // (only the main turn — background sub-agents are never killed).
        doInterrupt()
      } else if (isBlockAgentTab && !chatInput.value && _pendingQueue.length > 0) {
        // Priority 4 (block-agent tab, idle): clear the pending queue so the user is
        // never stuck with un-cancelable queued messages.
        _pendingQueue.splice(0)
        _persistQueueNow()
        updateQueueTray()
      } else if (chatInput.value) {
        // Priority 5: clear input
        chatInput.value = ''
        autoResize()
      } else if (activePane) {
        // Fall-through: send raw ESC to the PTY (claude/codex/bash all
        // benefit — claude's /login prompt cancels on ESC, codex menus
        // close, vim leaves insert mode). Previously gated by
        // `!isClaudeTab`, which left Esc dead on an idle terminal-mode
        // claude tab. (upstream 59a7eb2 改造)
        activePane.sendRaw('\x1b')
      }
      e.preventDefault()
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (suggestionsOpen) {
        selectSuggestion(-1)
        return
      }
      // ↑ on empty input with pending queue → pop last item back into input for editing.
      // Mirrors CLI "press up to edit queued messages" behaviour.
      if (isBlockAgentTab && _pendingQueue.length > 0 && chatInput.value === '') {
        chatInput.value = _pendingQueue.pop()
        _persistQueueNow()
        updateQueueTray()
        autoResize()
        chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length)
        return
      }
      if (!history.length) return
      if (historyIdx === -1) {
        historyDraft = chatInput.value
        historyIdx = history.length - 1
      } else if (historyIdx > 0) {
        historyIdx--
      }
      chatInput.value = history[historyIdx]
      autoResize()
      hideSuggestions()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestionsOpen) {
        selectSuggestion(1)
        return
      }
      if (historyIdx === -1) return
      if (historyIdx < history.length - 1) {
        historyIdx++
        chatInput.value = history[historyIdx]
      } else {
        historyIdx = -1
        chatInput.value = historyDraft
      }
      autoResize()
      hideSuggestions()
      return
    }

    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      if (chatInput.value) {
        // Input has text: CLI behaviour = clear the line (not copy/kill)
        chatInput.value = ''
        autoResize()
      } else if (isBlockAgentTab && isClaudeThinking) {
        // Empty + busy on block-agent tab: interrupt
        doInterrupt()
      } else if (activePane) {
        // Empty + idle, or non-claude tab: forward raw Ctrl+C to PTY
        activePane.sendRaw('\x03')
      }
      return
    }

    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      if (activePane) activePane.sendRaw('\x0c')
      return
    }
  })

  chatInput.addEventListener('blur', () => {
    setTimeout(() => {
      hideSuggestions()
      hideSlashCommands()
    }, 150)
  })

  // ── URL utilities for the toolbar Open URL / Copy URL buttons ──
  // We can't rely on xterm's WebLinksAddon click (touch hit-area is
  // unreliable on mobile) or on claude's OSC 52 (clipboard API may be
  // gated by user-gesture timing across the WS roundtrip). Instead we
  // scrape the active terminal's buffer for a URL synchronously inside
  // the user's click event, and act on it from inside that same gesture.
  const URL_RE = /\bhttps?:\/\/[^\s"'<>(){}|\\^`]+[^\s"'<>(){}|\\^`,.;!?]/g

  function findUrlInTerminal(pane) {
    // 1. xterm terminal: walk the buffer (visible + scrollback) backwards
    //    so the URL the user just saw is preferred over older ones.
    try {
      const term = pane?.term
      const buf = term?.buffer?.active
      if (buf && typeof buf.getLine === 'function') {
        const lines = []
        const end = buf.length
        const start = Math.max(0, end - 200)   // last 200 lines is plenty
        for (let y = start; y < end; y++) {
          const line = buf.getLine(y)
          if (!line) continue
          lines.push(line.translateToString(true))
        }
        // Concatenate AFTER stripping per-line wrap so a URL spanning
        // multiple visual lines matches as one string.
        const joined = lines.join('')
        const matches = joined.match(URL_RE)
        if (matches && matches.length) return matches[matches.length - 1]
      }
    } catch {}
    // 2. Block-renderer pane: look inside the scroll container's text.
    try {
      const scroll = pane?._scroll || pane?.container?.querySelector?.('.cbr-scroll')
      if (scroll) {
        const text = scroll.innerText || scroll.textContent || ''
        const matches = text.match(URL_RE)
        if (matches && matches.length) return matches[matches.length - 1]
      }
    } catch {}
    return null
  }

  function flashToolbarBtn(btn, label) {
    const original = btn.textContent
    btn.textContent = label
    btn.disabled = true
    setTimeout(() => {
      btn.textContent = original
      btn.disabled = false
    }, 900)
  }

  function copyViaTextarea(text, onSuccess) {
    // Fallback for browsers that block navigator.clipboard.writeText off
    // a user gesture, or when run over plain HTTP (clipboard API requires
    // secure context). Synchronous execCommand still works in most
    // browsers and runs inside our click handler.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand && document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok && onSuccess) onSuccess()
    } catch {}
  }

  // Touch toolbar
  const touchToolbar = document.getElementById('touch-toolbar')
  if (touchToolbar) {
    touchToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.touch-btn')
      if (!btn) return
      const action = btn.dataset.action
      if (!activePane) return
      switch (action) {
        case 'ctrl-c':
          // Same logic as keyboard Ctrl+C: clear input if has text, else interrupt/sendRaw
          if (chatInput.value) {
            chatInput.value = ''; autoResize()
          } else if (isBlockAgentTab && isClaudeThinking) {
            doInterrupt()
          } else {
            activePane.sendRaw('\x03')
          }
          break
        case 'ctrl-l':
          activePane.sendRaw('\x0c'); break
        case 'arrow-up': {
          // Same as keyboard ↑: pop pending queue first if applicable
          if (isBlockAgentTab && _pendingQueue.length > 0 && chatInput.value === '') {
            chatInput.value = _pendingQueue.pop()
            _persistQueueNow()
            updateQueueTray()
            autoResize()
            break
          }
          if (!history.length) break
          if (historyIdx === -1) {
            historyDraft = chatInput.value
            historyIdx = history.length - 1
          } else if (historyIdx > 0) historyIdx--
          chatInput.value = history[historyIdx]
          autoResize(); hideSuggestions(); break
        }
        case 'arrow-down': {
          if (historyIdx === -1) break
          if (historyIdx < history.length - 1) {
            historyIdx++; chatInput.value = history[historyIdx]
          } else {
            historyIdx = -1; chatInput.value = historyDraft
          }
          autoResize(); hideSuggestions(); break
        }
        case 'tab':
          activePane.sendRaw('\t'); break
        case 'escape':
          // Same priority logic as keyboard Esc. The final branch is
          // UNCONDITIONAL: when no UI-level branch matches, ESC must
          // always reach the PTY (vim, claude's own interactive prompts,
          // codex menus, etc.). The earlier guard `!isClaudeTab` swallowed
          // ESC on a claude tab with empty input + not-thinking, leaving
          // the mobile Esc button dead in that state.
          if (claudeSlashOpen) {
            hideSlashCommands()
          } else if (suggestionsOpen) {
            hideSuggestions()
          } else if (isBlockAgentTab && isClaudeThinking) {
            doInterrupt()
          } else if (chatInput.value) {
            chatInput.value = ''; autoResize()
          } else {
            activePane.sendRaw('\x1b')
          }
          break
        case 'open-url':
        case 'copy-url': {
          // Bypass everything async / xterm / OSC-related: scrape the
          // visible screen + scrollback for a URL and act on it now,
          // inside this synchronous click handler. That keeps us inside
          // the user-gesture stack so navigator.clipboard.writeText and
          // window.open are both allowed (Safari and Chrome are strict
          // about both off-gesture).
          const url = findUrlInTerminal(activePane)
          if (!url) {
            flashToolbarBtn(btn, 'No URL')
            break
          }
          if (action === 'open-url') {
            try { window.open(url, '_blank', 'noopener,noreferrer') } catch {}
            flashToolbarBtn(btn, 'Opened')
          } else {
            try {
              navigator.clipboard.writeText(url).then(
                () => flashToolbarBtn(btn, 'Copied'),
                () => copyViaTextarea(url, () => flashToolbarBtn(btn, 'Copied')),
              )
            } catch {
              copyViaTextarea(url, () => flashToolbarBtn(btn, 'Copied'))
            }
          }
          break
        }
      }
      if (document.activeElement === chatInput) chatInput.focus()
    })
  }

  mobileQuery.addEventListener('change', () => fitTerminals())
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+T: new tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault()
      if (tabManager) tabManager.newTab()
      return
    }
    // Ctrl+W: close active tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault()
      if (tabManager && tabManager.activeId) tabManager.closeTab(tabManager.activeId)
      return
    }
    // Ctrl+1..9: jump to tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      if (tabManager) tabManager.jumpTo(parseInt(e.key, 10))
      return
    }
    // Tab when focus is not in an input: cycle
    if (
      e.key === 'Tab' &&
      document.activeElement?.tagName !== 'INPUT' &&
      document.activeElement?.tagName !== 'TEXTAREA'
    ) {
      e.preventDefault()
      if (tabManager) tabManager.cycle(e.shiftKey ? -1 : 1)
      const chatInput = document.getElementById('chat-input')
      if (chatInput) chatInput.focus()
    }
  })
}

function setupMobile() {
  // Mobile pane switcher — buttons toggle between left (terminal) and right (explorer).
  const switchEl = document.getElementById('mobile-pane-switch')
  if (switchEl) {
    function setMobilePane(pane) {
      document.body.classList.toggle('mobile-pane-left', pane === 'left')
      document.body.classList.toggle('mobile-pane-right', pane === 'right')
      switchEl.querySelectorAll('.mobile-pane-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.pane === pane)
      })
      if (pane === 'left') fitTerminals()
    }
    switchEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.mobile-pane-btn')
      if (!btn) return
      setMobilePane(btn.dataset.pane)
    })
    // Default to terminal on mobile load
    if (isMobile()) setMobilePane('left')
    mobileQuery.addEventListener('change', () => {
      if (isMobile()) setMobilePane('left')
      else {
        document.body.classList.remove('mobile-pane-left', 'mobile-pane-right')
      }
    })
  }

  if (!isMobile()) return

  // Mobile keyboard handling, lifted verbatim from codebuilder.
  // The mobile media query freezes html/body and lets .app-layout
  // consume `calc(var(--vvh, 100dvh) - 48px)`. We keep --vvh synced
  // to visualViewport.height so the layout shrinks when the soft
  // keyboard opens. killScroll() defangs iOS Safari's habit of
  // scrolling the page upward as the keyboard slides in.
  const chatInput = document.getElementById('chat-input')
  const killScroll = () => {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }
  window.addEventListener('scroll', killScroll)
  document.addEventListener('scroll', killScroll)
  if (chatInput) {
    chatInput.addEventListener('focus', () => {
      setTimeout(killScroll, 50)
      setTimeout(killScroll, 150)
      setTimeout(killScroll, 300)
    })
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      document.documentElement.style.setProperty(
        '--vvh',
        `${window.visualViewport.height}px`
      )
      killScroll()
    })
    window.visualViewport.addEventListener('scroll', killScroll)
  }

  // --- Swipe to switch between terminal tabs ----------------------
  // Heuristics: single finger, total elapsed < 400 ms, horizontal
  // delta > 60 px AND > 1.8× the vertical delta. That window is wide
  // enough that an intentional flick triggers a switch and narrow
  // enough that long-press + drag (used by mobile browsers for text
  // selection inside xterm) doesn't accidentally cycle tabs.
  const SWIPE_MIN_DX = 60
  const SWIPE_MAX_DT = 400
  const SWIPE_MAX_DY_RATIO = 0.55 // |dy| / |dx| must be below this
  const terminalStack = document.getElementById('terminal-stack')
  if (terminalStack) {
    let startX = 0, startY = 0, startT = 0, touchCount = 0
    terminalStack.addEventListener('touchstart', (e) => {
      touchCount = e.touches.length
      if (touchCount !== 1) return
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      startT = performance.now()
    }, { passive: true })
    terminalStack.addEventListener('touchend', (e) => {
      if (touchCount !== 1) return
      const t = e.changedTouches[0]
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      const dt = performance.now() - startT
      if (dt > SWIPE_MAX_DT) return
      if (Math.abs(dx) < SWIPE_MIN_DX) return
      if (Math.abs(dy) / Math.abs(dx) > SWIPE_MAX_DY_RATIO) return
      if (!tabManager || tabManager.tabs.length < 2) return
      // Left swipe (dx<0) advances to next tab; right swipe goes back.
      tabManager.cycle(dx < 0 ? 1 : -1)
    }, { passive: true })
  }
}
