// Regression test: subagent visibility toggles (MES-13148)
//
// Goal:
//   1. Prompts sent TO a subagent (Agent/Task tool_use blocks) are fully visible
//      by default — they must NOT be collapsed by the global tool-fold setting.
//   2. The "subagent activity" toggle must control visibility (display:none)
//      instead of causing the event handler to return early and discard DOM.
//      When the toggle is turned on later, blocks that already streamed through
//      must become visible because their DOM was retained.
//
// This test drives the real ClaudeBlockRenderer through _handleEvent with real
// event shapes and inspects the produced DOM.

import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

function makeElement(tag) {
  const children = []
  const listeners = {}
  const attrs = {}
  const dataset = {}
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    innerHTML: '',
    hidden: false,
    title: '',
    style: {},
    dataset,
    children,
    parentNode: null,
    get scrollHeight() { return 0 },
    get scrollTop() { return 0 },
    set scrollTop(_v) {},
    get clientHeight() { return 0 },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); el.className = [...this._set].join(' ') },
      remove(c) { this._set.delete(c); el.className = [...this._set].join(' ') },
      contains(c) { return this._set.has(c) },
      toggle(c, force) {
        if (force === true) this._set.add(c)
        else if (force === false) this._set.delete(c)
        else if (this._set.has(c)) this._set.delete(c)
        else this._set.add(c)
        el.className = [...this._set].join(' ')
      },
    },
    setAttribute(k, v) { attrs[k] = String(v) },
    getAttribute(k) { return attrs[k] ?? null },
    appendChild(child) {
      if (child && child.parentNode && child.parentNode !== el) {
        child.parentNode.removeChild(child)
      }
      children.push(child)
      child.parentNode = el
      return child
    },
    insertBefore(node, ref) {
      if (node.parentNode && node.parentNode !== el) node.parentNode.removeChild(node)
      const idx = children.indexOf(ref)
      if (idx === -1) children.push(node)
      else children.splice(idx, 0, node)
      node.parentNode = el
      return node
    },
    removeChild(child) {
      const i = children.indexOf(child)
      if (i !== -1) {
        children.splice(i, 1)
        child.parentNode = null
      }
    },
    _matchesClass(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : sel
      return typeof el.className === 'string' && el.className.split(/\s+/).includes(cls)
    },
    querySelector(sel) {
      for (const c of children) {
        if (c._matchesClass && c._matchesClass(sel)) return c
        const found = c.querySelector ? c.querySelector(sel) : null
        if (found) return found
      }
      return null
    },
    querySelectorAll(sel) {
      const out = []
      for (const c of children) {
        if (c._matchesClass && c._matchesClass(sel)) out.push(c)
        if (c.querySelectorAll) out.push(...c.querySelectorAll(sel))
      }
      return out
    },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); return true },
    scrollTo() {},
  }
  return el
}

function allDescendants(root) {
  const out = []
  function walk(el) {
    if (!el || !el.children) return
    for (const c of el.children) {
      out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

const dispatched = []
let currentContainer = null

global.document = {
  createElement: (tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  createTextNode: (text) => ({ nodeValue: text, parentElement: null }),
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: () => {},
  dispatchEvent: (ev) => { dispatched.push(ev); return true },
  querySelectorAll: (sel) => {
    if (!currentContainer) return []
    return allDescendants(currentContainer).filter((el) => el._matchesClass && el._matchesClass(sel))
  },
}
global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
global.requestAnimationFrame = (fn) => { fn(); return 0 }
global.location = { protocol: 'http:', host: 'localhost:3001' }
global.WebSocket = class { constructor() {} set onopen(_v) {} set onmessage(_v) {} set onerror(_v) {} set onclose(_v) {} close() {} }
global.fetch = async () => ({ ok: true, json: async () => ({}) })
global.window = global
// Stub localStorage so defaults are exercised: prompt=true, activity=false
const storage = {}
global.localStorage = {
  getItem(k) { return storage[k] ?? null },
  setItem(k, v) { storage[k] = String(v) },
  removeItem(k) { delete storage[k] },
  _reset() { for (const k of Object.keys(storage)) delete storage[k] },
}

let ClaudeBlockRenderer
let getSubagentPromptVisible
let getSubagentActivityVisible
let setSubagentPromptVisible
let setSubagentActivityVisible
let setToolFoldLevel

before(async () => {
  const mod = await import('../../public/js/claude-block-renderer.js')
  ClaudeBlockRenderer = mod.ClaudeBlockRenderer
  getSubagentPromptVisible = mod.getSubagentPromptVisible
  getSubagentActivityVisible = mod.getSubagentActivityVisible
  setSubagentPromptVisible = mod.setSubagentPromptVisible
  setSubagentActivityVisible = mod.setSubagentActivityVisible
  setToolFoldLevel = mod.setToolFoldLevel
})

function makeRenderer() {
  dispatched.length = 0
  global.localStorage._reset()
  const container = makeElement('div')
  currentContainer = container
  const r = new ClaudeBlockRenderer(container, { tabId: 'tab-sv' })
  return r
}

function blocksByClass(renderer, cls) {
  return renderer._scroll.querySelectorAll('.' + cls)
}

function firstBlockByClass(renderer, cls) {
  return renderer._scroll.querySelector('.' + cls)
}

describe('Subagent prompt visibility', () => {
  it('defaults to fully visible (true)', () => {
    assert.equal(getSubagentPromptVisible(), true)
  })

  it('renders Agent tool_use blocks with data-fold="full" even when global fold is line', () => {
    setToolFoldLevel('line')
    const r = makeRenderer()
    r._handleEvent({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'm1',
        content: [{
          type: 'tool_use',
          id: 'toolu_agent1',
          name: 'Agent',
          input: { description: ' investigate', prompt: 'Please check the failing test.' },
        }],
      },
    })
    const block = firstBlockByClass(r, 'cbr-block-subagent-prompt')
    assert.ok(block, 'Agent tool_use should produce a subagent-prompt block')
    assert.notEqual(block.style.display, 'none', 'prompt block should be visible by default')
    assert.equal(block.getAttribute('data-fold'), 'full', 'prompt block must stay fully expanded')
  })

  it('hides Agent tool_use blocks when the prompt toggle is off, then reveals them', () => {
    const r = makeRenderer()
    r._handleEvent({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'm2',
        content: [{
          type: 'tool_use',
          id: 'toolu_agent2',
          name: 'Task',
          input: { prompt: 'Fix the bug.' },
        }],
      },
    })
    const block = firstBlockByClass(r, 'cbr-block-subagent-prompt')
    assert.ok(block)
    assert.notEqual(block.style.display, 'none')

    setSubagentPromptVisible(false)
    assert.equal(block.style.display, 'none', 'toggle off should hide existing prompt blocks')
    assert.equal(block.getAttribute('data-fold'), 'full', 'hidden prompt block still keeps full fold')

    setSubagentPromptVisible(true)
    assert.equal(block.style.display, '', 'toggle on should reveal existing prompt blocks')
    assert.equal(block.getAttribute('data-fold'), 'full', 'revealed prompt block stays fully expanded')
  })
})

describe('Subagent activity visibility', () => {
  it('defaults to hidden (false)', () => {
    assert.equal(getSubagentActivityVisible(), false)
  })

  it('builds DOM for subagent user events and hides them when toggle is off', () => {
    const r = makeRenderer()
    r._handleEvent({
      type: 'user',
      parent_tool_use_id: 'toolu_agent1',
      message: { content: [{ type: 'text', text: 'subagent input text' }] },
    })
    const blocks = blocksByClass(r, 'cbr-block-subagent-activity')
    assert.equal(blocks.length, 1, 'subagent user event must build an activity block')
    assert.equal(blocks[0].style.display, 'none', 'activity block should be hidden when toggle is off')
  })

  it('builds DOM for subagent assistant events and hides them when toggle is off', () => {
    const r = makeRenderer()
    r._handleEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent1',
      message: {
        role: 'assistant',
        id: 'msg_sa1',
        content: [{ type: 'text', text: 'subagent response text' }],
      },
    })
    const blocks = blocksByClass(r, 'cbr-block-subagent-activity')
    assert.equal(blocks.length, 1, 'subagent assistant event must build an activity block')
    assert.equal(blocks[0].style.display, 'none')
  })

  it('builds DOM for subagent partial_message events and hides them when toggle is off', () => {
    const r = makeRenderer()
    r._handleEvent({
      type: 'partial_message',
      parent_tool_use_id: 'toolu_agent1',
      message: {
        role: 'assistant',
        id: 'msg_p1',
        content: [{ type: 'text', text: 'subagent partial chunk' }],
      },
    })
    const blocks = blocksByClass(r, 'cbr-block-subagent-activity')
    assert.equal(blocks.length, 1, 'subagent partial must build an activity block')
    assert.equal(blocks[0].style.display, 'none')
  })

  it('reveals existing subagent activity blocks when the toggle is turned on', () => {
    const r = makeRenderer()
    r._handleEvent({
      type: 'user',
      parent_tool_use_id: 'toolu_agent1',
      message: { content: [{ type: 'text', text: 'first' }] },
    })
    r._handleEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent1',
      message: {
        role: 'assistant',
        id: 'msg_sa2',
        content: [{ type: 'text', text: 'second' }],
      },
    })
    let blocks = blocksByClass(r, 'cbr-block-subagent-activity')
    assert.equal(blocks.length, 2)
    assert.ok(blocks.every((b) => b.style.display === 'none'), 'all activity blocks hidden by default')

    setSubagentActivityVisible(true)
    blocks = blocksByClass(r, 'cbr-block-subagent-activity')
    assert.ok(blocks.every((b) => b.style.display === ''), 'toggle on reveals all existing activity blocks')
  })
})
