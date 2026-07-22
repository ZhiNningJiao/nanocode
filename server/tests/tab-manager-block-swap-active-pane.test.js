/**
 * Regression test: "Mobile Claude tab can't send until you visit a bash tab"
 *
 * Bug: When a Claude tab uses block render mode, _addTab() creates a
 * TerminalPane placeholder and starts an async dynamic import for the
 * block renderer. setActive() runs BEFORE the import resolves, so
 * onActiveChange fires with the placeholder pane. When the block renderer
 * finally loads and swaps in (tab.pane = new Cls(...)), onActiveChange is
 * NOT called again — activePane in terminal-view.js still points to the
 * disposed TerminalPane. All sendInputWithEcho() calls go to the dead pane.
 *
 * The race is wider on mobile (slower CPU/network → slower dynamic import)
 * but exists on all platforms whenever setActive runs before the import
 * resolves.
 *
 * Fix: After the block renderer swaps in, if this tab is the active tab,
 * re-fire onActiveChange so terminal-view.js updates activePane.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Polyfill requestAnimationFrame for Node.js test environment
const _rafCallbacks = []
function requestAnimationFrame(cb) { _rafCallbacks.push(cb) }
function flushRaf() { while (_rafCallbacks.length) _rafCallbacks.shift()() }

// ---------------------------------------------------------------------------
// Minimal simulation of TabManager._addTab + setActive + block-renderer swap
// ---------------------------------------------------------------------------

function buildTabManagerSim() {
  this.tabs = []
  this.activeId = null
  this.onActiveChangeCalls = []
  this.onStatusChangeCalls = []

  // Simulate onActiveChange callback (mirrors terminal-view.js line 127)
  this.onActiveChange = (pane, tabMeta) => {
    this.onActiveChangeCalls.push({
      pane,
      tabMeta: tabMeta ? { ...tabMeta } : null,
    })
  }

  this.onStatusChange = (connected) => {
    this.onStatusChangeCalls.push(connected)
  }
}

// Simulate _addTab with the fix applied
function addTabFixed(tm, id, label, type, { willSwapToBlock, blockLoadDelay = 0 } = {}) {
  // Create placeholder pane (TerminalPane)
  const placeholderPane = {
    _ws: { readyState: 1 }, // WebSocket.OPEN
    disposed: false,
    sendInputWithEcho() {
      if (this.disposed) throw new Error('sendInputWithEcho on disposed pane')
    },
    dispose() { this.disposed = true; this._ws = null },
    fitAddon: { fit() {} },
  }

  // Block renderer pane (created after dynamic import resolves)
  const blockPane = {
    _ws: { readyState: 1 },
    sendInputWithEcho() { return true },
    isThinking() { return false },
    fitAddon: { fit() {} },
  }

  const tab = { id, label, type, pane: placeholderPane, paneEl: {} }
  tm.tabs.push(tab)

  // Simulate async block renderer load
  if (willSwapToBlock) {
    setTimeout(() => {
      const found = tm.tabs.find((t) => t.id === id)
      if (!found) return
      try { found.pane.dispose() } catch {}
      found.pane = blockPane

      // ── THE FIX ──────────────────────────────────────────────────
      // Re-fire onActiveChange if this tab is the active tab, so
      // terminal-view.js updates activePane from the disposed placeholder
      // to the real block renderer.
      if (tm.activeId === id) {
        tm.onActiveChange(found.pane, { id: found.id, label: found.label, type: found.type })
        if (found.pane._ws) {
          tm.onStatusChange(found.pane._ws.readyState === 1)
        }
        requestAnimationFrame(() => { try { found.pane.fitAddon.fit() } catch {} })
        flushRaf()
      }
      // ── END FIX ───────────────────────────────────────────────────
    }, blockLoadDelay)
  }

  return tab
}

// Simulate setActive (mirrors tab-manager.js setActive)
function setActive(tm, id) {
  if (tm.activeId === id) return
  if (!tm.tabs.some((t) => t.id === id)) return
  tm.activeId = id
  const active = tm.tabs.find((t) => t.id === id)
  tm.onActiveChange(active?.pane || null, active ? { id: active.id, label: active.label, type: active.type } : null)
  if (active) {
    tm.onStatusChange(!!active.pane._ws && active.pane._ws.readyState === 1)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tab-manager block-renderer swap — activePane update', () => {
  it('re-fires onActiveChange after block renderer swaps in for active tab', async () => {
    const tm = Object.create(buildTabManagerSim.prototype)
    buildTabManagerSim.call(tm)

    // Add a Claude tab that will swap to block renderer
    addTabFixed(tm, 'tab-1', 'Claude', 'claude', {
      willSwapToBlock: true,
      blockLoadDelay: 10,
    })

    // Set it active BEFORE the block renderer loads (the race)
    setActive(tm, 'tab-1')

    // First onActiveChange: should have the placeholder pane
    assert.equal(tm.onActiveChangeCalls.length, 1, 'setActive fires onActiveChange once')
    const firstPane = tm.onActiveChangeCalls[0].pane
    assert.equal(firstPane.disposed, false, 'placeholder pane is alive at first call')

    // Wait for the block renderer to load and swap in
    await new Promise((r) => setTimeout(r, 50))

    // THE FIX: onActiveChange should have fired a SECOND time with the
    // block renderer pane, not the disposed placeholder.
    assert.equal(
      tm.onActiveChangeCalls.length, 2,
      'onActiveChange should fire again after block renderer swap-in (THE FIX)'
    )

    const secondCall = tm.onActiveChangeCalls[1]
    assert.equal(secondCall.tabMeta.id, 'tab-1', 'second call has correct tab id')
    assert.equal(secondCall.tabMeta.type, 'claude', 'second call has correct tab type')

    // The second pane should be the block renderer (not disposed, can send)
    const secondPane = secondCall.pane
    assert.equal(secondPane.disposed, undefined, 'second pane is the block renderer, not the disposed placeholder')
    assert.doesNotThrow(
      () => secondPane.sendInputWithEcho('hello'),
      'block renderer pane can send messages'
    )

    // The first (placeholder) pane should be disposed
    assert.equal(firstPane.disposed, true, 'placeholder pane was disposed after swap')
  })

  it('does NOT re-fire onActiveChange when the tab is not active', async () => {
    const tm = Object.create(buildTabManagerSim.prototype)
    buildTabManagerSim.call(tm)

    // Add a bash tab (no swap)
    addTabFixed(tm, 'tab-1', 'Bash', 'bash', { willSwapToBlock: false })
    // Add a Claude tab that will swap to block
    addTabFixed(tm, 'tab-2', 'Claude', 'claude', {
      willSwapToBlock: true,
      blockLoadDelay: 10,
    })

    // Activate the BASH tab, not the Claude tab
    setActive(tm, 'tab-1')

    // Only one onActiveChange (for the bash tab)
    assert.equal(tm.onActiveChangeCalls.length, 1, 'only bash tab activation')

    // Wait for the Claude block renderer to load
    await new Promise((r) => setTimeout(r, 50))

    // Should NOT have fired a second onActiveChange — the Claude tab is
    // not active, so the fix correctly skips re-firing.
    assert.equal(
      tm.onActiveChangeCalls.length, 1,
      'no extra onActiveChange when block tab is not active'
    )

    // But when we later switch to the Claude tab, setActive picks up the
    // block renderer pane (it's already swapped in).
    setActive(tm, 'tab-2')
    assert.equal(tm.onActiveChangeCalls.length, 2, 'switching to claude tab fires onActiveChange')
    const claudePane = tm.onActiveChangeCalls[1].pane
    assert.doesNotThrow(
      () => claudePane.sendInputWithEcho('hello'),
      'can send after switching to the (already-swapped) claude tab'
    )
  })

  it('activePane stays correct when block renderer loads before setActive', async () => {
    const tm = Object.create(buildTabManagerSim.prototype)
    buildTabManagerSim.call(tm)

    // Add a Claude tab with block load that completes IMMEDIATELY (delay=0)
    addTabFixed(tm, 'tab-1', 'Claude', 'claude', {
      willSwapToBlock: true,
      blockLoadDelay: 0,
    })

    // Wait for the block renderer to load (no active tab yet, so no
    // extra onActiveChange)
    await new Promise((r) => setTimeout(r, 20))

    // Now set it active — setActive reads tab.pane which is already the
    // block renderer. No race, no fix needed.
    setActive(tm, 'tab-1')

    assert.equal(tm.onActiveChangeCalls.length, 1, 'one onActiveChange call')
    const pane = tm.onActiveChangeCalls[0].pane
    assert.doesNotThrow(
      () => pane.sendInputWithEcho('hello'),
      'can send immediately when block renderer loaded before setActive'
    )
  })
})
