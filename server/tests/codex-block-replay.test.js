import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

// Codex Block render mode — history restoration on refresh.
//
// The replay path (attachCodexSession on WS reattach / browser refresh) must
// send a message stream that is SUFFICIENT for the block renderer to reconstruct
// the full turn history in original order: user messages, agent text (as
// structured blocks, not raw PTY text), commands, file changes — without loss
// or duplication.
//
// This test pins the server-side replay contract that the renderer depends on:
//   1. codex-event messages are replayed BEFORE the history (scrollback) blob,
//      so the renderer enters SDK mode and suppresses the duplicate PTY text.
//   2. user input is persisted as a synthetic `user_message` event in
//      eventHistory (historyOnly — not re-broadcast live), so user blocks
//      replay from structured events, not from the duplicated `›` PTY echo.
//   3. item.completed for agent_message carries the full `item.text`, so the
//      renderer can reconstruct the agent block without the lost stream-text
//      deltas (codex-stream-text is live-only and never persisted).
//   4. codex-stream-text is NEVER replayed (it is live-only).

const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function waitUntil(fn, timeoutMs = 5000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    function check() {
      try {
        const value = fn()
        if (value) return resolve(value)
      } catch (err) {
        return reject(err)
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new Error(`Timed out waiting for ${label}`))
      }
      setTimeout(check, 25)
    }
    check()
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

class MockWs extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
}

function emitJson(ws, payload) {
  ws.emit('message', JSON.stringify(payload))
}

// Fake codex CLI binary: reads a prompt from stdin, emits a rich deterministic
// event sequence (command + file_change + streamed agent_message + turn end).
// The SDK spawns one process per turn, so this is invoked once per turn.
function writeFakeCodexBinary(targetPath) {
  const script = `#!/usr/bin/env node
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const prompt = input.trim()
  const slug = prompt.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'x'
  const reply = 'Agent says: ' + prompt
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread-replay' }))
  console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'cmd-' + slug, command: 'echo ' + prompt, status: 'in_progress', aggregated_output: '' } }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd-' + slug, command: 'echo ' + prompt, status: 'completed', aggregated_output: 'out-' + slug, exit_code: 0 } }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', id: 'chg-' + slug, status: 'completed', changes: [{ kind: 'update', path: 'src/' + slug + '.js' }] } }))
  console.log(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', id: 'msg-' + slug } }))
  const half = reply.slice(0, Math.ceil(reply.length / 2))
  const rest = reply.slice(half.length)
  console.log(JSON.stringify({ type: 'agent_message_content_delta', item_id: 'msg-' + slug, delta: { type: 'text_delta', text: half } }))
  console.log(JSON.stringify({ type: 'agent_message_content_delta', item_id: 'msg-' + slug, delta: { type: 'text_delta', text: rest } }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'msg-' + slug, text: reply } }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }))
})
`
  writeFileSync(targetPath, script, { mode: 0o755 })
  chmodSync(targetPath, 0o755)
}

describe('codex block render mode — history replay contract', () => {
  it('replays structured events (user_message + item.completed with text) before scrollback, with no stream-text', async () => {
    const tempRoot = makeTempDir('nanocode-codex-block-replay-')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(projectCwd, { recursive: true })
    const fakeCodexPath = path.join(tempRoot, 'fake-codex')
    writeFakeCodexBinary(fakeCodexPath)

    const store = createStore(':memory:')
    const project = store.createProject('Codex Block Replay', projectCwd)
    const tab = store.createTab(project.id, { type: 'codex', label: 'codex block', renderMode: 'block' })
    store.setSetting('codex_driver', 'sdk')
    store.setSetting('codex_path_override', fakeCodexPath)

    const { handleTerminalWs } = createTerminalRoutes(store)

    // ── Live session: send two turns ────────────────────────────────────────
    const ws = new MockWs()
    handleTerminalWs(ws)
    emitJson(ws, {
      type: 'attach',
      projectId: project.id,
      sessionType: 'bash',
      tabId: tab.id,
      cols: 120,
      rows: 40,
    })

    const sendTurn = (text) => {
      emitJson(ws, { type: 'input', data: text })
      emitJson(ws, { type: 'input', data: '\r' })
    }

    sendTurn('first turn')
    // Wait for turn 1 to fully complete (turn separator output).
    await waitUntil(
      () => ws.sent.filter((m) => m.type === 'output' && m.data === '────────────\n').length >= 1,
      5000,
      'turn 1 separator'
    )
    sendTurn('second turn')
    await waitUntil(
      () => ws.sent.filter((m) => m.type === 'output' && m.data === '────────────\n').length >= 2,
      5000,
      'turn 2 separator'
    )

    // ── Replay: attach a fresh WS (simulates browser refresh) ──────────────
    const wsReplay = new MockWs()
    handleTerminalWs(wsReplay)
    emitJson(wsReplay, {
      type: 'attach',
      projectId: project.id,
      sessionType: 'bash',
      tabId: tab.id,
      cols: 120,
      rows: 40,
    })

    // Collect replay messages once the history blob and events have arrived.
    await waitUntil(
      () => wsReplay.sent.some((m) => m.type === 'history') &&
        wsReplay.sent.some((m) => m.type === 'codex-event' && m.event?.type === 'turn.completed' && wsReplay.sent.filter((n) => n.type === 'codex-event' && n.event?.type === 'turn.completed').length >= 2),
      5000,
      'replay events + history'
    )

    const sent = wsReplay.sent
    const historyIdx = sent.findIndex((m) => m.type === 'history')
    const firstCodexEventIdx = sent.findIndex((m) => m.type === 'codex-event')
    const codexEvents = sent.filter((m) => m.type === 'codex-event').map((m) => m.event)
    const streamText = sent.filter((m) => m.type === 'codex-stream-text')
    const userMsgEvents = codexEvents.filter((e) => e.type === 'user_message')
    const agentCompleted = codexEvents.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
    const types = codexEvents.map((e) => e.type)

    // (1) Events are replayed BEFORE the scrollback history blob, so the
    //     renderer enters SDK mode and suppresses duplicate PTY text.
    assert.notEqual(firstCodexEventIdx, -1, 'codex-event messages must be replayed')
    assert.notEqual(historyIdx, -1, 'history blob must still be sent for terminal-mode compat')
    assert.ok(firstCodexEventIdx < historyIdx, `codex-event (idx ${firstCodexEventIdx}) must come before history (idx ${historyIdx})`)

    // (2) User input is persisted as synthetic user_message events, in order
    //     before each turn's agent events. Two turns → two user_message events.
    assert.equal(userMsgEvents.length, 2, `expected 2 user_message events, got ${userMsgEvents.length}; types=${JSON.stringify(types)}`)
    assert.equal(userMsgEvents[0].text, 'first turn')
    assert.equal(userMsgEvents[1].text, 'second turn')
    const firstUserIdx = types.indexOf('user_message')
    const secondUserIdx = types.lastIndexOf('user_message')
    const firstAgentCompletedIdx = codexEvents.findIndex((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
    assert.ok(firstUserIdx < firstAgentCompletedIdx, 'first user_message must precede first agent_message completion')
    assert.ok(secondUserIdx > firstAgentCompletedIdx, 'second user_message must follow first turn')

    // (3) item.completed for agent_message carries the full final text, so the
    //     renderer can reconstruct the agent block without stream-text deltas.
    assert.equal(agentCompleted.length, 2)
    assert.equal(agentCompleted[0].item.text, 'Agent says: first turn')
    assert.equal(agentCompleted[1].item.text, 'Agent says: second turn')

    // (4) codex-stream-text is live-only — never replayed.
    assert.equal(streamText.length, 0, 'codex-stream-text must not be replayed')

    ws.close()
    wsReplay.close()
    store.close()
  })
})
