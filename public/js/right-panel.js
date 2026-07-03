/**
 * Right panel — tabbed container for the right pane.
 *
 * Tabs: Files | Compare | Plugins | Usage.
 *
 * This is a shell wrapper only. The Files tab hosts the existing file
 * explorer (created by explorer.js) unchanged — its internal logic is
 * not touched. Compare / Plugins / Usage are placeholder containers to be
 * filled by later feature work (MES-13740 需求1 plugins/usage).
 */

const STORAGE_KEY = 'rightPanel:activeTab'
const TABS = ['files', 'compare', 'plugins', 'usage']
let activeTab = 'files'
let initialized = false

export function initRightPanel() {
  if (initialized) return
  const strip = document.getElementById('right-panel-tabs')
  if (!strip) return
  initialized = true

  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && TABS.includes(saved)) activeTab = saved
  } catch {}

  applyTab(activeTab)

  strip.addEventListener('click', (e) => {
    const btn = e.target.closest('.right-panel-tab')
    if (!btn) return
    setActive(btn.dataset.rpTab)
  })
}

export function showRightPanelTab(tab) {
  if (!TABS.includes(tab)) return
  if (!initialized) {
    activeTab = tab
    return
  }
  setActive(tab)
}

function setActive(tab) {
  activeTab = tab
  applyTab(tab)
  try { localStorage.setItem(STORAGE_KEY, tab) } catch {}
  document.dispatchEvent(new CustomEvent('nanocode:right-panel-tab', { detail: { tab } }))
}

function applyTab(tab) {
  const strip = document.getElementById('right-panel-tabs')
  if (strip) {
    strip.querySelectorAll('.right-panel-tab').forEach((b) => {
      const on = b.dataset.rpTab === tab
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
  }
  const panel = document.getElementById('right-panel')
  if (panel) {
    panel.querySelectorAll('.right-panel-pane').forEach((p) => {
      p.classList.toggle('active', p.dataset.rpPane === tab)
    })
  }
}
