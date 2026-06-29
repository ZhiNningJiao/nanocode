/**
 * agent-monitor browser plugin (P5c).
 *
 * Owns the agent drawer (list / recent / subagents) and the agent-health
 * banner. Extracted from the former hardcoded Core markup + agents.js +
 * agent-health.js. The drawer DOM is created by this plugin (no longer in
 * index.html) and a header entry is registered via ui.registerHeaderEntry so
 * the header is a plugin contribution area.
 *
 * Agent-health messages arrive via the ui bus: Core's notify-WS handler
 * emits 'agent-health' events (pluginUiHost.emit) which this plugin listens
 * for via ui.on. The initial seed is fetched from GET /api/agents/health.
 */

import { initAgentDrawer } from './drawer.js'
import { updateAgentHealth, seedFromServer } from './health.js'

const AGENT_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="8" r="4"/>
  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
  <circle cx="18" cy="8" r="2.5" fill="currentColor" stroke="none" opacity="0.6"/>
  <circle cx="6" cy="8" r="2.5" fill="currentColor" stroke="none" opacity="0.6"/>
</svg>`

/** Build the drawer DOM (previously hardcoded in index.html). */
function _buildDrawerDom() {
  // Backdrop
  const backdrop = document.createElement('div')
  backdrop.className = 'agent-drawer-backdrop'
  backdrop.id = 'agent-drawer-backdrop'

  // Drawer
  const drawer = document.createElement('div')
  drawer.className = 'agent-drawer'
  drawer.id = 'agent-drawer'
  drawer.innerHTML = `
    <div class="agent-drawer-header">
      <span class="agent-drawer-title">Agents</span>
      <button type="button" class="btn-icon" id="agent-drawer-close" aria-label="Close">&#10005;</button>
    </div>
    <div class="agent-list" id="agent-list"></div>
  `

  // Insert after the settings panel (or at end of the main container).
  const settingsPanel = document.getElementById('settings-panel')
  const anchor = settingsPanel?.parentNode || document.body
  anchor.insertBefore(backdrop, settingsPanel?.nextSibling || null)
  anchor.insertBefore(drawer, backdrop.nextSibling)
}

export function register(ui) {
  _buildDrawerDom()

  const drawerApi = initAgentDrawer()

  // Register the header entry that toggles the drawer.
  ui.registerHeaderEntry({
    id: 'agent-monitor',
    icon: AGENT_ICON,
    label: 'Agent manager',
    order: 0,
    onClick: (btn) => {
      const drawer = document.getElementById('agent-drawer')
      if (!drawer || !drawerApi) return
      if (drawer.classList.contains('open')) {
        drawerApi.close()
        btn.classList.remove('active')
      } else {
        drawerApi.open()
        btn.classList.add('active')
      }
    },
  })

  // Sync the header button's active class when the drawer state changes
  // (close button, backdrop click, resume session, agent-info click).
  const headerBtn = document.querySelector('.header-entry-btn[aria-label="Agent manager"]')
  if (headerBtn) {
    document.addEventListener('agent-drawer:state', (e) => {
      if (e.detail?.open) headerBtn.classList.add('active')
      else headerBtn.classList.remove('active')
    })
  }

  // Subscribe to agent-health events from the ui bus (Core emits these from
  // the notify-WS handler) and seed from the server snapshot.
  ui.on('agent-health', (msg) => updateAgentHealth(msg))
  seedFromServer().catch((e) => console.warn('[agent-monitor] seed failed', e))

  // Cleanup on unload: remove the drawer DOM we created.
  ui.registerLifecycle({
    onStop() {
      document.getElementById('agent-drawer')?.remove()
      document.getElementById('agent-drawer-backdrop')?.remove()
    },
  })
}
