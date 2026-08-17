/**
 * Safe mount for the model picker and its success/error toasts.
 *
 * Block-mode agent panes (claude + codex block renderer) own a conversation
 * scroll (.cbr-scroll / .cbx-scroll) where the element flows inline at the
 * bottom. Terminal-mode codex tabs have NO such scroll — the pane is an xterm
 * — so appending to a scroll that does not exist would silently drop the
 * element and the user gets zero feedback (the exact bug this helper fixes:
 * the old toast path only called _appendToScroll, which returns false in a
 * terminal pane, so the "Codex model set to …" / error toast never mounted).
 *
 * Strategy: append to the scroll when one exists; otherwise fall back to the
 * pane container and tag the element with a `floatingClass` so CSS anchors it
 * as a bottom overlay (mirrors the picker's own _mountPicker fallback). Returns
 * true when the element was mounted anywhere, false only when neither a scroll
 * nor a container is available.
 *
 * Pure by design: the scroll and container are passed in by the caller (which
 * reads them from the active pane closure), so this can be unit-tested with a
 * tiny fake DOM — the "equivalent DOM evidence" that terminal-mode success AND
 * error toasts really do mount.
 */
export function mountFloatingEl(el, { scroll, container, floatingClass } = {}) {
  if (scroll) {
    scroll.appendChild(el)
    if (typeof scroll.scrollTop !== 'undefined') scroll.scrollTop = scroll.scrollHeight
    return true
  }
  if (container) {
    if (floatingClass) el.classList.add(floatingClass)
    container.appendChild(el)
    return true
  }
  return false
}
