import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Equivalent-DOM evidence (critic note 2): terminal-mode codex tabs have no
// conversation scroll, so the old toast path only called _appendToScroll which
// returns false there → the "Codex model set to …" / error toast never mounted
// and the user got zero feedback. The picker/toasts now share mountFloatingEl
// (public/js/model-picker-mount.js), which falls back to the pane container
// with a floating class. This test drives that pure helper with a tiny fake
// DOM and asserts BOTH the success and the error toast really mount in the
// terminal-mode shape (no scroll, container only) — the exact path that used
// to return false.

function makeEl() {
  // classList ↔ className stay in sync, just like a real HTMLElement: setting
  // className parses it into the class set, and classList.add surfaces in
  // className. This is what makes the toast-class-preservation assertions
  // faithful (the real code sets className as a string, then the helper adds
  // the floating class via classList.add).
  const classes = new Set()
  const el = {
    tagName: 'DIV',
    children: [],
    parentNode: null,
    classList: {
      add(c) { classes.add(String(c)) },
      contains(c) { return classes.has(String(c)) },
      remove(c) { classes.delete(String(c)) },
    },
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
  }
  Object.defineProperty(el, 'className', {
    configurable: true,
    get() { return [...classes].join(' ') },
    set(v) {
      classes.clear()
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c))
    },
  })
  return el
}

function makeScroll() {
  return Object.assign(makeEl(), { scrollTop: 0, scrollHeight: 999 })
}

const { mountFloatingEl } = await import('../../public/js/model-picker-mount.js')

describe('model-picker mountFloatingEl — safe mount for picker + toasts', () => {
  it('appends to the scroll and sets scrollTop when a scroll exists (block mode)', () => {
    const el = makeEl()
    el.className = 'cbr-model-picker-confirm'
    const scroll = makeScroll()
    const container = makeEl()

    const ok = mountFloatingEl(el, { scroll, container, floatingClass: 'cbr-model-picker-confirm--floating' })

    assert.equal(ok, true)
    assert.equal(scroll.children.length, 1, 'toast appended to the scroll')
    assert.equal(scroll.children[0], el)
    assert.equal(scroll.scrollTop, 999, 'scrollTop pinned to bottom')
    assert.equal(container.children.length, 0, 'container untouched when scroll exists')
    assert.ok(!el.classList.contains('cbr-model-picker-confirm--floating'), 'no floating class in block mode')
  })

  it('falls back to the container with the floating class when there is no scroll (terminal mode) — success toast', () => {
    // Terminal-mode codex pane: no .cbr-scroll, just the .pane-terminal container.
    // This is the path that used to return false and drop the toast.
    const el = makeEl()
    el.className = 'cbr-model-picker-confirm'
    const container = makeEl()

    const ok = mountFloatingEl(el, { scroll: null, container, floatingClass: 'cbr-model-picker-confirm--floating' })

    assert.equal(ok, true, 'toast MUST mount in terminal mode (the fix)')
    assert.equal(container.children.length, 1, 'toast appended to the pane container')
    assert.equal(container.children[0], el)
    assert.ok(el.classList.contains('cbr-model-picker-confirm--floating'), 'toast tagged floating so CSS shows it over xterm')
    assert.ok(el.classList.contains('cbr-model-picker-confirm'), 'base class preserved')
  })

  it('falls back to the container with the floating class when there is no scroll (terminal mode) — error toast', () => {
    // The save-failed toast must mount just like the success toast; otherwise a
    // failed PATCH silently vanishes in terminal mode.
    const el = makeEl()
    el.className = 'cbr-model-picker-confirm cbr-model-picker-error'
    const container = makeEl()

    const ok = mountFloatingEl(el, { scroll: null, container, floatingClass: 'cbr-model-picker-confirm--floating' })

    assert.equal(ok, true, 'error toast MUST mount in terminal mode (the fix)')
    assert.equal(container.children.length, 1)
    assert.equal(container.children[0], el)
    assert.ok(el.classList.contains('cbr-model-picker-confirm--floating'), 'error toast tagged floating')
    assert.ok(el.classList.contains('cbr-model-picker-error'), 'error class preserved')
  })

  it('works without a floatingClass (e.g. a plain inline toast) and still mounts to the container', () => {
    const el = makeEl()
    const container = makeEl()
    const ok = mountFloatingEl(el, { scroll: null, container })
    assert.equal(ok, true)
    assert.equal(container.children[0], el)
    assert.equal(el.className, '', 'no class added when floatingClass omitted')
  })

  it('returns false only when neither a scroll nor a container is available', () => {
    const el = makeEl()
    const ok = mountFloatingEl(el, { scroll: null, container: null, floatingClass: 'x' })
    assert.equal(ok, false, 'nothing to mount to')
    assert.equal(el.parentNode, null)
    assert.ok(!el.classList.contains('x'), 'no class added on failure')
  })

  it('returns false for an empty/undefined options object (defensive)', () => {
    const el = makeEl()
    assert.equal(mountFloatingEl(el), false)
    assert.equal(mountFloatingEl(el, undefined), false)
  })
})
