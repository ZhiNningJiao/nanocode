/**
 * Header entry registry.
 *
 * Plugins register buttons that appear in the top-right header's "plugin entry
 * slot area" (#plugin-header-slots). Each entry is
 * `{ id, icon, label, onClick, panel, order }`:
 *   - id      unique key (duplicate id replaces the prior entry)
 *   - icon    HTML string (SVG markup) rendered inside the button
 *   - label   accessible name (button title + aria-label)
 *   - onClick (btn, event) => void   — click handler; OR
 *   - panel   string id of a registered panel to activate on click
 *   - order   number; lower comes first (default 0); ties keep insertion order
 *
 * Extracted as a pure module so the registry semantics are unit-testable
 * without a DOM. The browser plugin-host (public/js/plugin-host.js) wraps
 * registration so entries are removed when a plugin is unloaded.
 *
 * Blueprint reference: NANOCODE_ARCH.md §3.2 — ui.registerHeaderEntry (Tier-1).
 */

const _entries = new Map() // id → { id, icon, label, onClick, panel, order, _seq }

let _seq = 0

export const headerEntryRegistry = {
  /**
   * Register a header entry. Replaces any prior entry with the same id.
   * Either onClick (function) or panel (string) is required.
   * @param {{id:string, icon?:string, label?:string, onClick?:Function, panel?:string, order?:number}} def
   * @returns {string} the entry id (for unregister)
   */
  register(def) {
    if (!def || typeof def.id !== 'string' || !def.id) {
      throw new Error('header entry requires a non-empty id')
    }
    const hasClick = typeof def.onClick === 'function'
    const hasPanel = typeof def.panel === 'string' && def.panel
    if (!hasClick && !hasPanel) {
      throw new Error(`header entry "${def.id}" requires onClick or panel`)
    }
    // Preserve insertion order on re-register: keep the original seq if present
    // so replacing an entry does not shove it to the end.
    const prior = _entries.get(def.id)
    const seq = prior ? prior._seq : _seq++
    _entries.set(def.id, {
      id: def.id,
      icon: typeof def.icon === 'string' ? def.icon : '',
      label: typeof def.label === 'string' ? def.label : def.id,
      onClick: hasClick ? def.onClick : null,
      panel: hasPanel ? def.panel : null,
      order: typeof def.order === 'number' ? def.order : 0,
      _seq: seq,
    })
    return def.id
  },

  /**
   * Remove a registered entry by id.
   * @param {string} id
   */
  unregister(id) {
    _entries.delete(id)
  },

  /**
   * Return a snapshot of all registered entries, sorted by `order` ascending
   * (ties broken by insertion order). The returned array is a shallow copy;
   * mutating it does not affect the registry.
   * @returns {Array<{id:string,icon:string,label:string,onClick:Function|null,panel:string|null,order:number}>}
   */
  list() {
    return [..._entries.values()]
      .sort((a, b) => (a.order - b.order) || (a._seq - b._seq))
      .map(({ _seq, ...rest }) => rest)
  },

  /** @internal clear all entries (for tests) */
  _reset() {
    _entries.clear()
    _seq = 0
  },
}
