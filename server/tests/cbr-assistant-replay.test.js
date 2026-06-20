/**
 * Regression test for: assistant text missing after page refresh.
 *
 * Root cause: _handleAssistant() found textPart from msg.content, then skipped
 * it in the render loop with `if (part === textPart) continue`.  The skip was
 * only correct when _liveAssistantBlock existed (live-streaming path) and the
 * text had already been rendered into the live block via _finalizeLiveAssistantBlock.
 * During history replay _liveAssistantBlock is always null, so _finalizeLiveAssistantBlock
 * was never called, yet the skip still fired — silently dropping all assistant text.
 *
 * Fix: capture hadLiveBlock = !!this._liveAssistantBlock BEFORE nulling it, and
 * skip textPart only when hadLiveBlock is true.
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

function innerText(el) {
  if (typeof el.innerHTML === 'string') return el.innerHTML
  return ''
}

function findText(el, text) {
  if (innerText(el).includes(text)) return true
  for (const child of el.children || []) {
    if (findText(child, text)) return true
  }
  return false
}

describe('ClaudeBlockRenderer assistant history replay', () => {
  it('renders assistant text during replay (no live block)', () => {
    const renderer = makeRenderer()
    // No _liveAssistantBlock — this is the history replay scenario.
    assert.equal(renderer._liveAssistantBlock, null)

    renderer._handleEvent({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from history replay' }],
      },
    }, { fromReplay: true })

    // Text block must have been appended to _scroll.
    assert.ok(renderer._scroll.children.length > 0, 'expected at least one block in scroll')
    assert.ok(
      findText(renderer._scroll, 'Hello from history replay'),
      'expected assistant text to appear in DOM'
    )
  })

  it('renders assistant text + tool_use during replay', () => {
    const renderer = makeRenderer()

    renderer._handleEvent({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'About to read file' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/foo' } },
        ],
      },
    }, { fromReplay: true })

    assert.ok(renderer._scroll.children.length >= 2, 'expected text block + tool_use block')
    assert.ok(findText(renderer._scroll, 'About to read file'), 'expected text block')
  })

  it('does not double-render text when live block existed (streaming path)', () => {
    const renderer = makeRenderer()

    // Simulate a live streaming block that was appended during partial events.
    const liveBlock = makeElement('article')
    liveBlock.className = 'cbr-block cbr-live'
    // Give it a parentNode so _finalizeLiveAssistantBlock can manipulate it.
    renderer._scroll.appendChild(liveBlock)
    renderer._liveAssistantBlock = liveBlock
    renderer._liveTextBuffer = 'partial text...'

    const childCountBefore = renderer._scroll.children.length

    renderer._handleEvent({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Final complete text' }],
      },
    })

    // The live block should have been finalized in-place (no new block added for text).
    // _scroll.children.length should not increase (the live block was updated, not duplicated).
    assert.equal(
      renderer._scroll.children.length, childCountBefore,
      'expected no extra block added when live block was finalized in-place'
    )
  })
})
