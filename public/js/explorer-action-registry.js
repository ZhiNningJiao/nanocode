/**
 * Explorer context-menu action registry.
 *
 * Plugins register actions that appear in the file explorer's right-click
 * context menu. Each action is `{ id, label, run(ctx) }` where `ctx` is
 * `{ path, type, projectId }` (type is 'file' | 'dir'). Registering with an
 * existing `id` replaces the prior entry.
 *
 * Extracted as a pure module so the registry semantics are unit-testable
 * without a DOM. The browser plugin-host (public/js/plugin-host.js) wraps
 * registration so actions are removed when a plugin is unloaded.
 *
 * Blueprint reference: NANOCODE_ARCH.md §6 / Phase 4d — explorer context menu.
 */

const _actions = new Map() // id → { id, label, run }

export const explorerActionRegistry = {
  /**
   * Register an explorer action. Replaces any prior entry with the same id.
   * @param {{id:string, label:string, run:(ctx:{path:string,type:string,projectId:string})=>void}} def
   * @returns {string} the action id (for unregister)
   */
  register(def) {
    if (!def || typeof def.id !== 'string' || !def.id) {
      throw new Error('explorer action requires a non-empty id')
    }
    if (typeof def.label !== 'string') {
      throw new Error(`explorer action "${def.id}" requires a label`)
    }
    if (typeof def.run !== 'function') {
      throw new Error(`explorer action "${def.id}" requires a run() function`)
    }
    _actions.set(def.id, { id: def.id, label: def.label, run: def.run })
    return def.id
  },

  /**
   * Remove a registered action by id.
   * @param {string} id
   */
  unregister(id) {
    _actions.delete(id)
  },

  /**
   * Return a snapshot of all registered actions, in insertion order.
   * @returns {Array<{id:string,label:string,run:Function}>}
   */
  list() {
    return [..._actions.values()]
  },

  /** @internal clear all actions (for tests) */
  _reset() {
    _actions.clear()
  },
}
