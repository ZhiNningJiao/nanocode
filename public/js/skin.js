/**
 * Skins (皮肤): colour, texture and motion only — never layout or features.
 * A skin is `html[data-skin="<id>"]` + its block in /skins.css (CSS variables,
 * backdrop blur, transitions). All three are the Meshy brand palette (lime on
 * near-black) and force dark underneath (no second copy of the dark palette —
 * see the shared `[data-skin^="meshy"]` block); the user's own theme comes
 * back once another (future, non-Meshy) skin is chosen.
 *
 * The choice is saved on the server (`ui_skin`) and cached in localStorage so
 * the inline boot script in index.html paints the right skin before any JS
 * module runs; the server copy wins once settings have loaded.
 */
import { t } from './i18n.js'
import { updateSetting } from './api.js'
import { esc, fmtTime } from './command-center-format.js'
import { setTheme, savedTheme } from './theme.js'

// id → the theme it brings along (the Meshy palette is dark-only — all three
// bring 'dark' along). The index.html boot script mirrors this list to paint
// the right skin before modules load.
const SKIN_THEME = { meshy: 'dark', 'meshy-glass': 'dark', 'meshy-motion': 'dark' }
export const SKINS = Object.keys(SKIN_THEME)
export const SKIN_SETTING_KEY = 'ui_skin'
const CACHE_KEY = 'nanocodeSkin'

let current = 'meshy'
let saveState = { at: null, error: null }
let settingsEl = null

export function normalizeSkin(v) { return SKINS.includes(v) ? v : 'meshy' }

function apply(id) {
  const prevForced = SKIN_THEME[current]
  current = normalizeSkin(id)
  document.documentElement.setAttribute('data-skin', current)
  try { localStorage.setItem(CACHE_KEY, current) } catch {}
  const forced = SKIN_THEME[current]
  if (forced) setTheme(forced, { persist: false })
  else if (prevForced) setTheme(savedTheme(), { persist: false })
}

// a skin with its own brightness keeps it (e.g. the OS light/dark listener in theme.js)
document.addEventListener('nanocode:theme', (ev) => {
  const forced = SKIN_THEME[current]
  if (forced && ev.detail?.theme !== forced) setTheme(forced, { persist: false })
})
// cached skin right away (this module loads before first paint; settings may change it later)
apply(document.documentElement.getAttribute('data-skin'))

/** Called by app.js with GET /api/settings. */
export function initSkin(serverSettings) {
  const server = serverSettings?.[SKIN_SETTING_KEY]
  if (server != null) apply(server)
  else apply(document.documentElement.getAttribute('data-skin'))
}

export function currentSkin() { return current }

export async function setSkin(id) {
  apply(id)
  renderSkinSettings(settingsEl)
  try {
    await updateSetting(SKIN_SETTING_KEY, current)
    saveState = { at: new Date().toISOString(), error: null }
  } catch (err) {
    saveState = { at: saveState.at, error: String(err.message || err) }
  }
  renderStatus()
}

/** Settings panel → 指挥舱 → 皮肤 radio group. */
export function renderSkinSettings(el) {
  if (!el) return
  settingsEl = el
  if (!el.dataset.wired) {
    el.dataset.wired = '1'
    el.addEventListener('change', (ev) => {
      const r = ev.target.closest('input[name="ui-skin"]')
      if (r) setSkin(r.value)
    })
  }
  el.innerHTML = `<div class="settings-radio-group">${SKINS.map((id) => `
    <label class="settings-radio-label"><input type="radio" name="ui-skin" value="${id}" ${id === current ? 'checked' : ''} /> <span>${esc(t(`skin.${id}`))}</span> <span class="settings-hint-inline">${esc(t(`skin.${id}.desc`))}</span></label>`).join('')}
  </div><div class="settings-status skin-status"></div>`
  renderStatus()
}

function renderStatus() {
  const s = settingsEl?.querySelector('.skin-status')
  if (!s) return
  s.classList.toggle('ck-set-err', !!saveState.error)
  s.textContent = saveState.error ? t('cockpit.saveFailed', saveState.error) : saveState.at ? t('cockpit.saved', fmtTime(saveState.at)) : ''
}
