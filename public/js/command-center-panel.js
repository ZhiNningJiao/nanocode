/**
 * Command Center plugin tab (workspace right panel).
 *
 * The big-event views live on the cockpit main page only (cockpit.js +
 * cockpit-views.js) — one shell, one poll, one state. This tab used to be a
 * second 340-line shell with its own 60s poll of the same endpoint; it is now
 * a door back to the cockpit. The plugin itself stays: its enabled flag is the
 * cockpit `events` module's on/off switch (cockpit-model.js).
 */
import { t } from './i18n.js'

export function renderCommandCenterPane(pane) {
  if (!pane) return
  pane.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'rp-section'
  const hint = document.createElement('div')
  hint.className = 'rp-hint'
  hint.textContent = t('plugin.cc.moved')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'rp-refresh-btn'
  btn.textContent = t('plugin.cc.open')
  btn.addEventListener('click', () => {
    import('./cockpit.js').then((m) => m.showMainView('cockpit')).catch(() => {})
  })
  wrap.append(hint, btn)
  pane.appendChild(wrap)
}

export function resetCommandCenterLoadState() {}
