/**
 * Tests for terminal/opencode-adapter.js (MES-13740 需求11-B)
 *
 * Verifies the opencode part → claude block event normalisation:
 *   - user text → user event
 *   - assistant text → assistant event with text part
 *   - reasoning → assistant event with thinking part
 *   - tool → assistant tool_use + user tool_result pair
 *   - step-finish → result event (success / error_max_turns)
 *   - exportToEvents prepends system/init and preserves order
 *   - sseToEvents maps live delta shapes
 *   - edge cases: empty parts, missing role, non-object input, error outputs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  messageToEvents,
  exportToEvents,
  sseToEvents,
  __test,
} from '../../terminal/opencode-adapter.js'

const { partToAssistantContent, toolResultPart, makeUsage, isToolError } = __test

describe('partToAssistantContent', () => {
  it('text part → {type:text, text}', () => {
    assert.deepEqual(
      partToAssistantContent({ type: 'text', text: 'hello' }),
      { type: 'text', text: 'hello' },
    )
  })
  it('empty text → null', () => {
    assert.equal(partToAssistantContent({ type: 'text', text: '   ' }), null)
  })
  it('reasoning → thinking part', () => {
    assert.deepEqual(
      partToAssistantContent({ type: 'reasoning', text: 'why' }),
      { type: 'thinking', thinking: 'why' },
    )
  })
  it('reasoning with .reasoning field → thinking part', () => {
    assert.deepEqual(
      partToAssistantContent({ type: 'reasoning', reasoning: 'because' }),
      { type: 'thinking', thinking: 'because' },
    )
  })
  it('tool → tool_use with name/id/input', () => {
    const p = {
      type: 'tool',
      tool: 'bash',
      callID: 'c1',
      state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb' },
    }
    const c = partToAssistantContent(p)
    assert.equal(c.type, 'tool_use')
    assert.equal(c.id, 'c1')
    assert.equal(c.name, 'bash')
    assert.deepEqual(c.input, { command: 'ls' })
  })
  it('tool with no input + Task tool → empty {} input (not null)', () => {
    const c = partToAssistantContent({ type: 'tool', tool: 'Task', callID: 't1', state: {} })
    assert.equal(c.type, 'tool_use')
    assert.equal(c.name, 'Task')
    assert.deepEqual(c.input, {})
  })
  it('tool with string input → parsed object {value}', () => {
    const c = partToAssistantContent({
      type: 'tool',
      tool: 'write',
      callID: 'w1',
      state: { input: 'not-json' },
    })
    assert.equal(c.type, 'tool_use')
    assert.deepEqual(c.input, { value: 'not-json' })
  })
  it('unknown part type → null', () => {
    assert.equal(partToAssistantContent({ type: 'step-start' }), null)
  })
  it('non-object → null', () => {
    assert.equal(partToAssistantContent(null), null)
    assert.equal(partToAssistantContent('x'), null)
  })
})

describe('toolResultPart', () => {
  it('extracts content + tool_use_id', () => {
    const p = {
      type: 'tool',
      callID: 'c1',
      state: { status: 'completed', output: 'done' },
    }
    assert.deepEqual(toolResultPart(p), {
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'done',
      is_error: false,
    })
  })
  it('object output with .text → string', () => {
    const p = {
      type: 'tool',
      callID: 'c2',
      state: { output: { text: 'hi' } },
    }
    const r = toolResultPart(p)
    assert.equal(r.content, 'hi')
  })
  it('object output without .text → JSON string', () => {
    const p = {
      type: 'tool',
      callID: 'c3',
      state: { output: { foo: 1 } },
    }
    assert.equal(r_content(p), '{\n  "foo": 1\n}')
    function r_content(pp) {
      return toolResultPart(pp).content
    }
  })
  it('error output → is_error true', () => {
    const p = {
      type: 'tool',
      callID: 'c4',
      state: { status: 'error', output: 'Error: boom' },
    }
    assert.equal(toolResultPart(p).is_error, true)
  })
  it('metadata.success=false → is_error true', () => {
    const p = {
      type: 'tool',
      callID: 'c5',
      state: { metadata: { success: false }, output: 'x' },
    }
    assert.equal(toolResultPart(p).is_error, true)
  })
  it('non-tool part → null', () => {
    assert.equal(toolResultPart({ type: 'text' }), null)
  })
})

describe('messageToEvents', () => {
  it('user text → single user event', () => {
    const evs = messageToEvents({
      info: { role: 'user', id: 'u1' },
      parts: [{ type: 'text', text: 'hi there' }],
    })
    assert.equal(evs.length, 1)
    assert.equal(evs[0].type, 'user')
    assert.equal(evs[0].message.role, 'user')
    assert.deepEqual(evs[0].message.content, [{ type: 'text', text: 'hi there' }])
  })
  it('assistant text only → assistant event', () => {
    const evs = messageToEvents({
      info: { role: 'assistant', id: 'a1', model: { modelID: 'kimi' } },
      parts: [{ type: 'text', text: 'sure' }],
    })
    assert.equal(evs.length, 1)
    assert.equal(evs[0].type, 'assistant')
    assert.equal(evs[0].message.model, 'kimi')
    assert.deepEqual(evs[0].message.content, [{ type: 'text', text: 'sure' }])
  })
  it('assistant with reasoning + text → thinking then text', () => {
    const evs = messageToEvents({
      info: { role: 'assistant', id: 'a2' },
      parts: [
        { type: 'reasoning', text: 'thinking...' },
        { type: 'text', text: 'answer' },
      ],
    })
    assert.equal(evs.length, 1)
    assert.deepEqual(evs[0].message.content, [
      { type: 'thinking', thinking: 'thinking...' },
      { type: 'text', text: 'answer' },
    ])
  })
  it('assistant tool → assistant(tool_use) + user(tool_result)', () => {
    const evs = messageToEvents({
      info: { role: 'assistant', id: 'a3' },
      parts: [
        { type: 'text', text: 'running ls' },
        {
          type: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt' },
        },
      ],
    })
    assert.equal(evs.length, 2)
    assert.equal(evs[0].type, 'assistant')
    assert.equal(evs[0].message.content[1].type, 'tool_use')
    assert.equal(evs[0].message.content[1].id, 'c1')
    assert.equal(evs[1].type, 'user')
    assert.equal(evs[1].message.content[0].type, 'tool_result')
    assert.equal(evs[1].message.content[0].tool_use_id, 'c1')
    assert.equal(evs[1].message.content[0].content, 'file.txt')
  })
  it('assistant tool with step-finish → result event appended', () => {
    const evs = messageToEvents({
      info: { role: 'assistant', id: 'a4' },
      parts: [
        { type: 'text', text: 'done' },
        { type: 'step-finish', reason: 'stop', tokens: { input: 10, output: 5 } },
      ],
    })
    assert.equal(evs.length, 2)
    assert.equal(evs[1].type, 'result')
    assert.equal(evs[1].subtype, 'success')
    assert.equal(evs[1].usage.input_tokens, 10)
    assert.equal(evs[1].usage.output_tokens, 5)
  })
  it('step-finish reason=tool-calls → subtype error_max_turns', () => {
    const evs = messageToEvents({
      info: { role: 'assistant', id: 'a5' },
      parts: [{ type: 'step-finish', reason: 'tool-calls' }],
    })
    assert.equal(evs.length, 1)
    assert.equal(evs[0].type, 'result')
    assert.equal(evs[0].subtype, 'error_max_turns')
  })
  it('user message with tool results only (tool_result relay) → user event with tool_results', () => {
    const evs = messageToEvents({
      info: { role: 'user', id: 'u2' },
      parts: [
        {
          type: 'tool',
          callID: 'c1',
          state: { status: 'completed', output: 'result-data' },
        },
      ],
    })
    assert.equal(evs.length, 1)
    assert.equal(evs[0].type, 'user')
    assert.equal(evs[0].message.content[0].type, 'tool_result')
  })
  it('empty parts → no events', () => {
    assert.deepEqual(messageToEvents({ info: { role: 'assistant' }, parts: [] }), [])
  })
  it('missing role → no events', () => {
    assert.deepEqual(messageToEvents({ info: {}, parts: [{ type: 'text', text: 'x' }] }), [])
  })
  it('non-object input → []', () => {
    assert.deepEqual(messageToEvents(null), [])
    assert.deepEqual(messageToEvents('x'), [])
  })
})

describe('exportToEvents', () => {
  it('prepends system/init with model + cwd, preserves order', () => {
    const payload = {
      info: { directory: '/repo', model: { modelID: 'kimi-k2' }, agent: 'fable5' },
      messages: [
        { info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'q' }] },
        { info: { role: 'assistant', id: 'a1' }, parts: [{ type: 'text', text: 'a' }] },
      ],
    }
    const evs = exportToEvents(payload)
    assert.equal(evs.length, 3)
    assert.equal(evs[0].type, 'system')
    assert.equal(evs[0].subtype, 'init')
    assert.equal(evs[0].model, 'kimi-k2')
    assert.equal(evs[0].cwd, '/repo')
    assert.match(evs[0].raw, /model: kimi-k2/)
    assert.match(evs[0].raw, /cwd: \/repo/)
    assert.match(evs[0].raw, /agent: fable5/)
    assert.equal(evs[1].type, 'user')
    assert.equal(evs[2].type, 'assistant')
  })
  it('no info → no system event, still emits messages', () => {
    const evs = exportToEvents({ messages: [{ info: { role: 'user', id: 'u' }, parts: [{ type: 'text', text: 'hi' }] }] })
    assert.equal(evs.length, 1)
    assert.equal(evs[0].type, 'user')
  })
  it('non-object payload → []', () => {
    assert.deepEqual(exportToEvents(null), [])
  })
})

describe('sseToEvents', () => {
  it('message.part.updated with text part → assistant event', () => {
    const evs = sseToEvents({
      type: 'message.part.updated',
      properties: {
        messageID: 'm1',
        partID: 'p1',
        role: 'assistant',
        part: { type: 'text', text: 'streaming' },
      },
    })
    assert.equal(evs.length, 1)
    assert.equal(evs[0].type, 'assistant')
    assert.deepEqual(evs[0].message.content, [{ type: 'text', text: 'streaming' }])
  })
  it('message.part.delta with tool part → tool_use + tool_result', () => {
    const evs = sseToEvents({
      type: 'message.part.delta',
      properties: {
        messageID: 'm2',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'completed', input: { command: 'pwd' }, output: '/home' },
        },
      },
    })
    assert.equal(evs.length, 2)
    assert.equal(evs[0].message.content[0].type, 'tool_use')
    assert.equal(evs[1].message.content[0].type, 'tool_result')
  })
  it('message.updated with full message → normalised events', () => {
    const evs = sseToEvents({
      type: 'message.updated',
      properties: {
        message: {
          info: { role: 'assistant', id: 'a1' },
          parts: [{ type: 'text', text: 'final' }],
        },
      },
    })
    assert.equal(evs.length, 1)
    assert.equal(evs[0].type, 'assistant')
  })
  it('unknown event type → []', () => {
    assert.deepEqual(sseToEvents({ type: 'session.updated', properties: {} }), [])
  })
  it('no part in properties → []', () => {
    assert.deepEqual(sseToEvents({ type: 'message.part.updated', properties: {} }), [])
  })
  it('non-object → []', () => {
    assert.deepEqual(sseToEvents(null), [])
    assert.deepEqual(sseToEvents('x'), [])
  })
})

describe('makeUsage', () => {
  it('maps input/output/reasoning tokens', () => {
    const u = makeUsage({ tokens: { input: 100, output: 50, reasoning: 20 } })
    assert.equal(u.input_tokens, 100)
    assert.equal(u.output_tokens, 50)
    assert.equal(u.cache_read_input_tokens, 20)
  })
  it('cache_read overrides reasoning', () => {
    const u = makeUsage({ tokens: { input: 1, output: 2, cache_read: 3, reasoning: 4 } })
    assert.equal(u.cache_read_input_tokens, 3)
  })
  it('missing tokens → empty object', () => {
    assert.deepEqual(makeUsage({}), {})
    assert.deepEqual(makeUsage(null), {})
  })
})

describe('isToolError', () => {
  it('status error → true', () => {
    assert.equal(isToolError({ status: 'error' }), true)
  })
  it('status completed → false', () => {
    assert.equal(isToolError({ status: 'completed', output: 'ok' }), false)
  })
  it('output starts with Error: → true', () => {
    assert.equal(isToolError({ output: 'Error: something broke' }), true)
  })
  it('null → false', () => {
    assert.equal(isToolError(null), false)
  })
})
