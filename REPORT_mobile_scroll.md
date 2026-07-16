# Mobile Scroll Fix — Root Cause & Solution

## Summary

Mobile touch scrolling on the integrated branch (9476) was broken for claude tabs
in block render mode. The root cause was a **silent exception in `TerminalPane.dispose()`**
that prevented touch event listeners from being removed before the block renderer
took over the same DOM element.

## Root Cause

### The TerminalPane-first creation flow

On the integrated branch, `tab-manager.js` always creates a `TerminalPane` first
(line 436), then asynchronously loads the block renderer and swaps it in (lines 439-454):

```javascript
let pane = new TerminalPane(paneEl, paneOpts)       // ← touch listeners attached HERE
// ...
if (useClaudeRenderer || useCodexRenderer) {
  loader.then((Cls) => {
    try { tab.pane.dispose() } catch {}              // ← dispose called HERE
    paneEl.innerHTML = ''                            // ← children cleared, but NOT pane-level listeners
    tab.pane = new Cls(paneEl, blockOpts)            // ← block renderer on same element
  })
}
```

`TerminalPane._initTouchScroll()` attaches a **non-passive `touchmove` listener**
with `preventDefault()` to the pane element (`paneEl`). This is by design for
terminal mode — it intercepts vertical swipes to scroll xterm and prevents iOS
page scroll.

### The bug: `_keyDisposable.dispose()` throws

`TerminalPane.dispose()` (commit 8ba610c) had this order:

```javascript
dispose() {
  this._stopPing()
  // ...
  this._dataDisposable.dispose()     // ← OK: term.onData() returns IDisposable
  this._keyDisposable.dispose()     // ← THROWS: attachCustomKeyEventHandler returns void!
  // ... touch handler cleanup BELOW this line — NEVER REACHED
  if (this._touchContainer) {
    this._touchContainer.removeEventListener('touchmove', this._touchMoveHandler)
    // ...
  }
}
```

`this._keyDisposable = this.term.attachCustomKeyEventHandler(...)` — but xterm's
`attachCustomKeyEventHandler()` returns **`void`**, not an `IDisposable`. So
`this._keyDisposable` is `undefined`, and `undefined.dispose()` throws a TypeError.

The `try { tab.pane.dispose() } catch {}` in tab-manager.js **silently swallows**
this error. The touch handler cleanup code below the throwing line **never executes**.
The non-passive `touchmove` listener with `preventDefault()` stays attached to
the pane element.

When `paneEl.innerHTML = ''` runs, it removes child elements but **does NOT remove
event listeners attached to the pane element itself**. The block renderer then
mounts on the same pane element, and the lingering `touchmove` → `preventDefault()`
blocks all native touch scrolling on `.cbr-scroll`.

### Why the stable branch doesn't have this bug

The stable branch (`wt-nano-scattermerge`) has the same `_keyDisposable.dispose()`
bug, but it doesn't matter because the stable branch creates block renderers
**directly** (no TerminalPane-first creation flow). `TerminalPane.dispose()` is only
called when a tab is **closed** — in that case, the entire pane element is removed
from the DOM, so lingering listeners are garbage-collected with the element.

## Reproduction (CDP)

Using Playwright CDP `Input.dispatchTouchEvent` with a mobile viewport (390×844,
hasTouch, isMobile):

**Before fix (stale server serving old code):**
```
TEST 1: Original pane (with lingering listeners)
Scroll after touch: 0 NOT SCROLLED ✗

TEST 2: Cloned pane (listeners stripped by cloneNode)
Scroll after touch: 229 SCROLLED ✓
```

The clone test proved the issue was **lingering event listeners** — cloning the
element (which strips all listeners) immediately fixed scrolling.

**After fix:**
```
Touch scroll test on original pane (no cloning)
Scroll after touch: 229 SCROLLED ✓
```

## The Fix

Two changes to `public/js/terminal-pane.js` in `dispose()`:

1. **Moved touch handler cleanup to the TOP of `dispose()`** — before any
   potentially-throwing call. Even if something else throws later, the touch
   listeners are guaranteed to be removed.

2. **`this._keyDisposable.dispose()` → `this._keyDisposable?.dispose()`** —
   optional chaining prevents the TypeError since `attachCustomKeyEventHandler()`
   returns `void`, not `IDisposable`.

```javascript
dispose() {
  // Remove touch scroll handlers FIRST so they can't leak onto the
  // container when a block renderer replaces this pane.
  if (this._touchContainer) {
    this._touchContainer.removeEventListener('touchstart', this._touchStartHandler)
    this._touchContainer.removeEventListener('touchmove', this._touchMoveHandler)
    this._touchContainer.removeEventListener('touchend', this._touchEndHandler)
    this._touchContainer = null
  }
  this._stopPing()
  clearTimeout(this._reconnectTimer)
  clearTimeout(this._resizeTimer)
  this._resizeObserver.disconnect()
  this._dataDisposable.dispose()
  this._keyDisposable?.dispose()   // ← optional chaining, was: this._keyDisposable.dispose()
  // ...
}
```

## Verification

- Block mode (claude tab): CDP touch scroll → 229 SCROLLED ✓
- Terminal mode (bash tab): xterm present, touch handler active ✓
- No console errors during block renderer swap

## Files Changed

- `public/js/terminal-pane.js` — `dispose()` method: touch cleanup moved to top,
  `_keyDisposable?.dispose()` optional chaining
