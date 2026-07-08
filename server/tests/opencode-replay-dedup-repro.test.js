import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildUserReplayId } from '../../terminal/claude-history.js'

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

let ClaudeBlockRenderer
before(async () => {
  const mod = await import('../../public/js/claude-block-renderer.js')
  ClaudeBlockRenderer = mod.ClaudeBlockRenderer
})

function makeRenderer() {
  const container = makeElement('div')
  return new ClaudeBlockRenderer(container, {})
}

// Simulate the opencode export event shape (NO replay_id, NO uuid — the bug)
function ocUserEvent(text, msgId) {
  return {
    type: 'user',
    message: { id: msgId, role: 'user', content: [{ type: 'text', text }] },
  }
}
function ocAssistantEvent(text, msgId) {
  return {
    type: 'assistant',
    message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] },
  }
}

describe('opencode/fable5 tab history replay duplication (repro)', () => {
  it('renders the SAME user message TWICE: export replay + cs.history replay (no dedup)', () => {
    const renderer = makeRenderer()
    // 1) _fetchAndReplayHistory path: export events have NO replay_id / NO uuid
    const exportEvents = [ocUserEvent('hello world', 'oc-msg-1')]
    renderer._replayCache.rememberFetchedEvents(exportEvents)
    // render initial slice (fromReplay: true → skips dedup check)
    for (const ev of exportEvents) renderer._handleEvent(ev, { fromReplay: true })

    const afterExport = renderer._scroll.children.length
    assert.equal(afterExport, 1, 'export replay renders 1 user block')

    // 2) server replays cs.history on attach (same events, NO replay_id/uuid, NO fromReplay)
    //    This is attachOpencodeBlockSession line 1210 loop → _handleEvent(msg.event)
    for (const ev of exportEvents) renderer._handleEvent(ev)

    const afterCsHistory = renderer._scroll.children.length
    // BUG: dedup fails (getEventReplayKey returns null) → rendered TWICE
    assert.equal(
      afterCsHistory, 2,
      `EXPECTED BUG: opencode events have no replay_id → not deduped → ${afterCsHistory} copies (should be 1)`,
    )
  })

  it('renders the SAME assistant message TWICE without dedup', () => {
    const renderer = makeRenderer()
    const exportEvents = [ocAssistantEvent('hi there', 'oc-msg-2')]
    renderer._replayCache.rememberFetchedEvents(exportEvents)
    for (const ev of exportEvents) renderer._handleEvent(ev, { fromReplay: true })
    assert.equal(renderer._scroll.children.length, 1)

    for (const ev of exportEvents) renderer._handleEvent(ev)
    assert.equal(
      renderer._scroll.children.length, 2,
      'BUG: assistant event without replay_id rendered twice',
    )
  })

  it('a full turn (user+assistant+result) renders 2x for opencode tabs', () => {
    const renderer = makeRenderer()
    const exportEvents = [
      ocUserEvent('do something', 'oc-msg-1'),
      ocAssistantEvent('okay', 'oc-msg-2'),
    ]
    renderer._replayCache.rememberFetchedEvents(exportEvents)
    for (const ev of exportEvents) renderer._handleEvent(ev, { fromReplay: true })
    assert.equal(renderer._scroll.children.length, 2, 'export renders user+assistant')

    // cs.history replay (attach)
    for (const ev of exportEvents) renderer._handleEvent(ev)
    assert.equal(
      renderer._scroll.children.length, 4,
      'BUG: full turn doubled (4 blocks instead of 2)',
    )
  })

  it('THE 3x BUG: double-echo puts 2 user copies in cs.history, export adds a 3rd', () => {
    // Root cause of "1 条消息渲染成 3 条":
    //   1. controller onMsg (line 1224) claudeBroadcast(userEvent)  -> cs.history copy #1
    //   2. runOpencodeTurn (driver line 130) broadcast(userEvent)    -> cs.history copy #2
    //   3. opencode export has 1 stored user message                 -> export copy
    // None have replay_id/uuid → no dedup → all 3 render.
    const renderer = makeRenderer()
    const text = 'hello world'

    // export replay (GET /history → opencode export → exportToEvents)
    const exportEvents = [ocUserEvent(text, 'oc-msg-1')]
    renderer._replayCache.rememberFetchedEvents(exportEvents)
    for (const ev of exportEvents) renderer._handleEvent(ev, { fromReplay: true })
    assert.equal(renderer._scroll.children.length, 1, 'export renders 1')

    // cs.history replay on attach: 2 copies (double-echo, no replay_id → no dedup)
    const csHistory = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }, // controller echo
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }, // driver echo
    ]
    for (const ev of csHistory) renderer._handleEvent(ev)
    assert.equal(
      renderer._scroll.children.length, 3,
      `THE BUG: 1 message rendered ${renderer._scroll.children.length} times (expected 3)`,
    )
  })

  // ── FIX VERIFICATION ──────────────────────────────────────────────────────
  // After the fix: opencode events carry replay_id (export + driver echo share
  // user:<hash>:<N>), and the controller double-echo is removed. So export replay
  // + cs.history replay dedup to a SINGLE copy.

  it('FIX: export + driver-echo share replay_id → cs.history replay is deduped (1 copy)', () => {
    const renderer = makeRenderer()
    const text = 'hello world'
    const counts = new Map()

    // export replay (with replay_id via buildUserReplayId, registered in transportKeys)
    const exportReplayId = buildUserReplayId(text, counts)
    const exportEvents = [{
      type: 'user',
      replay_id: exportReplayId,
      message: { id: 'oc-msg-1', role: 'user', content: [{ type: 'text', text }] },
    }]
    renderer._replayCache.rememberFetchedEvents(exportEvents)
    for (const ev of exportEvents) renderer._handleEvent(ev, { fromReplay: true })
    assert.equal(renderer._scroll.children.length, 1, 'export renders 1')

    // cs.history replay: driver echo with the SAME replay_id (cs seeded from export
    // → counter aligned → same replay_id) → hasTransportReplay matches → deduped
    renderer._handleEvent({
      type: 'user',
      replay_id: exportReplayId,
      _nonce: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
    assert.equal(
      renderer._scroll.children.length, 1,
      `FIX: driver echo deduped → ${renderer._scroll.children.length} copy (expected 1)`,
    )
  })

  it('FIX: live driver echo with nonce is deduped against local echo (nonce path)', () => {
    // sendInputWithEcho: local _appendUserBlock + _send(claude-input, _nonce)
    // driver echo carries _nonce → _handleUserEvent nonce-dedup skips it
    const renderer = makeRenderer()
    const text = 'hi'
    const nonce = 'n-1'

    // local echo (client side)
    renderer._appendUserBlock(text)
    renderer._pendingNonces = new Set([nonce])
    assert.equal(renderer._scroll.children.length, 1, 'local echo renders 1')

    // server driver echo WITH nonce → nonce dedup skips
    renderer._handleEvent({
      type: 'user',
      _nonce: nonce,
      replay_id: 'user:deadbeef:1',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
    assert.equal(
      renderer._scroll.children.length, 1,
      `FIX: nonce dedup → ${renderer._scroll.children.length} copy (expected 1)`,
    )
  })
})
