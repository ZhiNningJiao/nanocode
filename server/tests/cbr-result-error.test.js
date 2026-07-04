/**
 * 需求15 item7 — Block 渲染 live 查漏：result error block 渲染。
 *
 * Root cause being guarded against: _handleResult() read only `event.error?.message`
 * (object form). The opencode block driver sends `error` as a PLAIN STRING (stderr
 * text, opencode-block-driver.js:197/223), so `event.error?.message` was undefined
 * → the error block rendered '[Error: unknown error]', silently dropping the
 * actual stderr crash info. claude SDK sends an Error-like object (.message);
 * claude tmux/controller send no `error` field at all.
 *
 * Fix (claude-block-renderer.js _handleResult): errText = error?.message || error
 * || 'unknown error' — handles all three forms. These tests pin the three paths.
 */

import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

function makeElement(tag) {
  const children = []
  const listeners = {}
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    innerHTML: '',
    hidden: false,
    title: '',
    style: {},
    dataset: {},
    children,
    get scrollHeight() { return 0 },
    get scrollTop() { return 0 },
    set scrollTop(_v) {},
    get clientHeight() { return 0 },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      contains(c) { return this._set.has(c) },
      toggle(c, force) {
        if (force === true) this._set.add(c)
        else if (force === false) this._set.delete(c)
        else if (this._set.has(c)) this._set.delete(c)
        else this._set.add(c)
      },
    },
    setAttribute(_k, _v) {},
    getAttribute(_k) { return null },
    appendChild(child) { children.push(child); return child },
    insertBefore(node, ref) {
      const idx = children.indexOf(ref)
      if (idx === -1) children.push(node)
      else children.splice(idx, 0, node)
      return node
    },
    removeChild(child) {
      const idx = children.indexOf(child)
      if (idx !== -1) children.splice(idx, 1)
    },
    querySelector(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) return null
      for (const c of children) {
        if (typeof c.className === 'string' && c.className.split(' ').includes(cls)) return c
      }
      return null
    },
    querySelectorAll(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) return []
      return children.filter((c) => typeof c.className === 'string' && c.className.split(' ').includes(cls))
    },
    addEventListener(ev, fn) {
      listeners[ev] = listeners[ev] || []
      listeners[ev].push(fn)
    },
    dispatchEvent(ev) {
      for (const fn of listeners[ev.type] || []) fn(ev)
    },
    scrollTo() {},
  }
  return el
}

global.document = {
  createElement: (tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  createTextNode: (text) => ({ nodeValue: text, parentElement: null }),
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: () => {},
  dispatchEvent: () => {},
  querySelectorAll: () => [],
}
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
global.requestAnimationFrame = (fn) => { fn(); return 0 }
global.location = { protocol: 'http:', host: 'localhost:3001' }
global.WebSocket = class {
  constructor() {}
  set onopen(_v) {}
  set onmessage(_v) {}
  set onerror(_v) {}
  set onclose(_v) {}
  close() {}
}
global.fetch = async () => ({ ok: true, json: async () => ({}) })
global.IntersectionObserver = class {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null },
  setItem(k, v) { this._store[k] = String(v) },
  removeItem(k) { delete this._store[k] },
}

let ClaudeBlockRenderer
before(async () => {
  const mod = await import('../../public/js/claude-block-renderer.js')
  ClaudeBlockRenderer = mod.ClaudeBlockRenderer
})

function makeRenderer() {
  const container = makeElement('div')
  return new ClaudeBlockRenderer(container, {})
}

function findText(el, text) {
  if (typeof el.innerHTML === 'string' && el.innerHTML.includes(text)) return true
  for (const child of el.children || []) {
    if (findText(child, text)) return true
  }
  return false
}

describe('ClaudeBlockRenderer _handleResult error block (需求15 item7)', () => {
  it('renders string-form error (opencode stderr) — not dropped as unknown', () => {
    const renderer = makeRenderer()
    // Mirrors opencode-block-driver.js non-zero-exit path: error is a STRING.
    renderer._handleEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: 'Error: model not found',
    })
    assert.ok(
      findText(renderer._scroll, 'Error: model not found'),
      'stderr string must appear in the error block (regression: was dropped to "unknown error")'
    )
    assert.ok(
      !findText(renderer._scroll, 'unknown error'),
      'must not fall back to "unknown error" when a real stderr string is present'
    )
  })

  it('renders object-form error.message (claude SDK Error-like)', () => {
    const renderer = makeRenderer()
    renderer._handleEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: { message: 'SDK stream aborted' },
    })
    assert.ok(
      findText(renderer._scroll, 'SDK stream aborted'),
      'object-form error.message must render'
    )
  })

  it('falls back to unknown error when no error field (claude tmux/controller)', () => {
    const renderer = makeRenderer()
    renderer._handleEvent({ type: 'result', subtype: 'error' })
    assert.ok(
      findText(renderer._scroll, 'unknown error'),
      'absent error field must render the fallback'
    )
  })

  it('error block ends the thinking state (turn completes on error)', () => {
    const renderer = makeRenderer()
    // Start a turn: a system/init sets thinking? Use sendInputWithEcho path is
    // complex; instead drive an assistant event then an error result and assert
    // thinking flag is false afterwards (result always clears thinking).
    renderer._thinking = true
    renderer._turnStartTime = Date.now()
    renderer._handleEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: 'boom',
    })
    assert.equal(renderer._thinking, false, 'error result must clear thinking state')
  })
})
