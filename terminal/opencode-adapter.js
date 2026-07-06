/**
 * opencode → Claude block event adapter (MES-13740 需求11-B)
 *
 * opencode stores sessions in SQLite (event-sourcing) and serves a live SSE
 * stream via `opencode serve`. Its message/part model differs from Claude's
 * streaming-event model. This module normalises opencode parts into the event
 * shape consumed by ClaudeBlockRenderer (public/js/claude-block-renderer.js),
 * so the Fable5 tab can reuse the existing block UI instead of raw TUI.
 *
 * Input  : opencode export/parts JSON (see opencode export <sessionID>)
 * Output : claude block events: {type:'system'|'user'|'assistant'|'result', ...}
 *          matching _handleEvent switch in claude-block-renderer.js
 *
 * Part → event mapping (documented in REPORT 需求11-A):
 *   message(role=user)  text      → user event
 *   message(role=asst)  text      → assistant event (text part)
 *   message(role=asst)  reasoning → assistant event (thinking part)
 *   message(role=asst)  tool      → assistant event (tool_use) + user event (tool_result)
 *   step-start          → (turn boundary marker, optional)
 *   step-finish         → result event (end of turn)
 *
 * The adapter is PURE: no I/O, no side effects — easy to unit test and to drive
 * from both history-replay and live-SSE paths in 11-C.
 */

import { buildUserReplayId } from './claude-history.js'

const NO_INPUT_TOOLS = new Set(['Task', 'TaskCreate'])

// 块B修复: replay_id 让 ClaudeBlockRenderer 的 ReplayCache 能在回放时去重
// (export 回放 vs cs.history 回放)。与 claude-history.js 同算法，避免重复实现。
function assistantReplayId(msg, firstPartType) {
  const id = msg && msg.id
  if (!id) return null
  return `oc:asst:${id}:${firstPartType || 'unknown'}`
}

function isObj(x) {
  return x && typeof x === 'object' && !Array.isArray(x)
}

function asText(s) {
  return s == null ? '' : String(s)
}

function toolInput(state) {
  if (!isObj(state)) return null
  const input = state.input
  if (input == null) return null
  if (typeof input === 'object') return input
  try {
    return JSON.parse(input)
  } catch {
    return { value: String(input) }
  }
}

function toolOutputContent(state) {
  if (!isObj(state)) return ''
  const out = state.output
  if (out == null) return ''
  if (typeof out === 'string') return out
  if (typeof out === 'object') {
    if (typeof out.text === 'string') return out.text
    if (typeof out.content === 'string') return out.content
    try {
      return JSON.stringify(out, null, 2)
    } catch {
      return String(out)
    }
  }
  return String(out)
}

function isToolError(state) {
  if (!isObj(state)) return false
  const meta = state.metadata
  if (isObj(meta)) {
    if (meta.error) return true
    if (meta.success === false) return true
  }
  if (state.status && /error|fail/i.test(String(state.status))) return true
  const out = toolOutputContent(state)
  return /error:/i.test(out.slice(0, 200))
}

function makeId(part) {
  if (!isObj(part)) return `oc-${Math.random().toString(36).slice(2, 10)}`
  return asText(part.callID) || asText(part.id) || `oc-${Math.random().toString(36).slice(2, 10)}`
}

function makeUsage(stepFinish) {
  const sf = stepFinish || {}
  const t = sf.tokens || sf
  const u = {}
  if (isObj(t)) {
    if (t.input != null) u.input_tokens = Number(t.input) || 0
    if (t.output != null) u.output_tokens = Number(t.output) || 0
    if (t.reasoning != null) u.cache_read_input_tokens = Number(t.reasoning) || 0
    if (t.cache_read != null) u.cache_read_input_tokens = Number(t.cache_read) || 0
  }
  return u
}

function emptyContent(arr) {
  return Array.isArray(arr) && arr.length === 0
}

function partToAssistantContent(part) {
  if (!isObj(part) || !part.type) return null
  switch (part.type) {
    case 'text': {
      const text = asText(part.text)
      if (!text.trim()) return null
      return { type: 'text', text }
    }
    case 'reasoning': {
      const text = part.text != null ? asText(part.text) : (part.reasoning ? asText(part.reasoning) : '')
      if (!text.trim()) return null
      return { type: 'thinking', thinking: text }
    }
    case 'tool': {
      const state = part.state || {}
      const name = asText(part.tool) || asText(state.title) || 'tool'
      const input = toolInput(state)
      return {
        type: 'tool_use',
        id: makeId(part),
        name,
        input: input == null && NO_INPUT_TOOLS.has(name) ? {} : input,
      }
    }
    default:
      return null
  }
}

function toolResultPart(part) {
  if (!isObj(part) || part.type !== 'tool') return null
  const state = part.state || {}
  return {
    type: 'tool_result',
    tool_use_id: makeId(part),
    content: toolOutputContent(state),
    is_error: isToolError(state),
  }
}

function userTextContent(text) {
  const t = asText(text)
  if (!t.trim()) return null
  return { type: 'text', text: t }
}

function buildUserMessageParts(text, toolResultParts) {
  const content = []
  if (text != null) {
    const c = userTextContent(text)
    if (c) content.push(c)
  }
  for (const trp of toolResultParts) {
    if (trp) content.push(trp)
  }
  return content.length ? content : null
}

function makeAssistantEvent(msg, parts) {
  const content = []
  for (const p of parts) {
    const c = partToAssistantContent(p)
    if (c) content.push(c)
  }
  if (!content.length) return null
  const firstPartType = parts[0] && parts[0].type
  return {
    type: 'assistant',
    replay_id: assistantReplayId(msg, firstPartType),
    message: {
      id: (msg && msg.id) || `oc-msg-${Math.random().toString(36).slice(2, 10)}`,
      role: 'assistant',
      content,
      model: msg && msg.model && msg.model.modelID ? msg.model.modelID : undefined,
    },
  }
}

function makeUserEvent(msg, content, replayId) {
  if (!content || (Array.isArray(content) && !content.length)) return null
  const ev = {
    type: 'user',
    message: {
      id: (msg && msg.id) || `oc-msg-${Math.random().toString(36).slice(2, 10)}`,
      role: 'user',
      content,
    },
  }
  // 块B修复: tool_result 类 user 事件用 opencode msg id 做 replay_id；
  // 纯文本 user 事件由调用方用 buildUserReplayId(text, counts) 传入 replayId。
  if (replayId) ev.replay_id = replayId
  return ev
}

function makeResultEvent(stepFinish) {
  const sf = stepFinish || {}
  const reason = asText(sf.reason)
  const isStop = !reason || reason === 'stop'
  return {
    type: 'result',
    subtype: isStop ? 'success' : 'error_max_turns',
    usage: makeUsage(sf),
    cost_usd: typeof sf.cost === 'number' ? sf.cost : undefined,
    is_error: !isStop && /error/i.test(reason),
  }
}

function makeSystemEvent(sessionInfo) {
  if (!isObj(sessionInfo)) return null
  const model = sessionInfo.model && sessionInfo.model.modelID
  const cwd = sessionInfo.directory || sessionInfo.cwd
  const lines = []
  if (model) lines.push(`- model: ${model}`)
  if (cwd) lines.push(`- cwd: ${cwd}`)
  if (sessionInfo.agent) lines.push(`- agent: ${sessionInfo.agent}`)
  if (!lines.length) return null
  return {
    type: 'system',
    subtype: 'init',
    cwd,
    model,
    raw: lines.join('\n'),
  }
}

/**
 * Convert an opencode export message ({info, parts}) into claude block events.
 *
 * One opencode assistant message may carry multiple parts (text + tool_use).
 * Claude's model pairs tool_use (assistant turn) with tool_result (user turn
 * that follows). We emit:
 *   - assistant event with all assistant-content parts (text/thinking/tool_use)
 *   - a synthetic user event holding all tool_result parts for this message
 *     (so the renderer sees the tool_result immediately after its tool_use)
 *
 * A user-role opencode message with text emits a single user event.
 */
export function messageToEvents(opencodeMessage, ctx) {
  if (!isObj(opencodeMessage)) return []
  const info = opencodeMessage.info || {}
  const parts = Array.isArray(opencodeMessage.parts) ? opencodeMessage.parts : []
  const role = info.role || (info.data && info.data.role)
  const events = []
  const userTextCounts = (ctx && ctx.userTextCounts) || null

  if (role === 'user') {
    const textPart = parts.find((p) => p && p.type === 'text')
    const toolParts = parts.filter((p) => p && p.type === 'tool')
    if (toolParts.length) {
      const trps = toolParts.map(toolResultPart).filter(Boolean)
      const content = buildUserMessageParts(textPart && textPart.text, trps)
      // tool_result 类 user 事件: 用 opencode msg id 做 replay_id (稳定)
      const rid = info.id ? `oc:user:${info.id}:toolresult` : null
      const ev = makeUserEvent(info, content, rid)
      if (ev) events.push(ev)
    } else if (textPart) {
      const c = userTextContent(textPart.text)
      // 纯文本 user 事件: 用 buildUserReplayId(text, counts) 与 driver echo 对齐
      const rid = userTextCounts ? buildUserReplayId(textPart.text, userTextCounts) : null
      if (c) events.push(makeUserEvent(info, [c], rid))
    }
    return events
  }

  if (role === 'assistant') {
    const asstParts = parts.filter(
      (p) => p && (p.type === 'text' || p.type === 'reasoning' || p.type === 'tool'),
    )
    const asst = makeAssistantEvent(info, asstParts)
    if (asst) events.push(asst)
    const toolParts = parts.filter((p) => p && p.type === 'tool')
    if (toolParts.length) {
      const trps = toolParts.map(toolResultPart).filter(Boolean)
      if (trps.length) {
        const rid = info.id ? `oc:user:${info.id}:toolresult` : null
        const userEv = makeUserEvent(info, trps, rid)
        if (userEv) events.push(userEv)
      }
    }
    const sf = parts.find((p) => p && p.type === 'step-finish')
    if (sf) events.push(makeResultEvent(sf))
    return events
  }

  return []
}

/**
 * Convert a full opencode export payload ({info, messages}) into a replay event
 * stream suitable for ClaudeBlockRenderer.replay(). A system/init event is
 * prepended (model + cwd), then each message is normalised in order.
 */
export function exportToEvents(exportPayload) {
  const events = []
  if (!isObj(exportPayload)) return events
  const sys = makeSystemEvent(exportPayload.info)
  if (sys) events.push(sys)
  const messages = Array.isArray(exportPayload.messages) ? exportPayload.messages : []
  // 块B修复: 内部 userTextCounts 让连续 user 文本消息拿到与 driver echo 对齐的
  // user:<hash>:<N> replay_id，回放时 ReplayCache 能去重 export vs cs.history。
  const ctx = { userTextCounts: new Map() }
  for (const m of messages) {
    for (const ev of messageToEvents(m, ctx)) events.push(ev)
  }
  return events
}

/**
 * Live SSE delta: map an opencode SSE event into a (set of) claude block event(s).
 *
 * Supported opencode SSE event types (from serve):
 *   message.part.updated  — a part was added/updated on a message
 *   message.part.delta    — incremental text append (field+delta)
 *   message.part.removed  — a part was removed (we just forward as no-op)
 *   message.updated       — message metadata changed (e.g. completion)
 *   session.updated       — session metadata changed
 *
 * For `message.part.updated`, we synthesise the appropriate claude event from
 * the part shape (text/reasoning/tool). The caller is responsible for ordering
 * and dedup; this function is a pure shape transform.
 *
 * @param {object} sseEvent — {type, properties:{messageID, partID, part, field, delta, message, session}}
 * @returns {object[]} zero or more claude block events
 */
export function sseToEvents(sseEvent) {
  if (!isObj(sseEvent) || !sseEvent.type) return []
  const props = sseEvent.properties || sseEvent
  switch (sseEvent.type) {
    case 'message.part.updated':
    case 'message.part.delta': {
      const part = props.part
      if (!isObj(part)) return []
      const role = props.role || (props.message && props.message.role) || 'assistant'
      const fakeMsg = {
        info: { id: props.messageID, role },
        parts: [part],
      }
      return messageToEvents(fakeMsg)
    }
    case 'message.updated': {
      const msg = props.message
      if (!isObj(msg)) return []
      return messageToEvents({ info: msg.info || msg, parts: msg.parts || [] })
    }
    default:
      return []
  }
}

export const __test = {
  partToAssistantContent,
  toolResultPart,
  makeUsage,
  isToolError,
}
