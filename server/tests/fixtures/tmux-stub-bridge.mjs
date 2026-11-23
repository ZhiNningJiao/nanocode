#!/usr/bin/env node
// Stand-in for terminal/claude-tmux-bridge.mjs in tests: same argv and socket
// protocol, no Claude. Each `user` message is appended (with this process's
// pid) to <socket>.log and answered with an init event + turn-done, so a test
// can tell which bridge process served a turn — i.e. whether a session was
// reattached or relaunched (STUB_LOG_DIR, if set, holds the logs instead, as
// <socket basename>.log). Writes the same <socket>.sessionId sidecar.
import { createServer } from 'node:net'
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const socketPath = arg('--socket')
const sessionId = arg('--session-id') || 'stub-session'
const logPath = process.env.STUB_LOG_DIR ? join(process.env.STUB_LOG_DIR, `${basename(socketPath)}.log`) : `${socketPath}.log`
try { writeFileSync(`${socketPath}.sessionId`, sessionId, { mode: 0o600 }) } catch {}

const server = createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'ping') socket.write(JSON.stringify({ type: 'pong', id: msg.id }) + '\n')
      if (msg.type !== 'user') continue
      appendFileSync(logPath, JSON.stringify({ pid: process.pid, text: msg.text }) + '\n')
      socket.write(JSON.stringify({ type: 'event', event: { type: 'system', subtype: 'init', session_id: sessionId } }) + '\n')
      socket.write(JSON.stringify({ type: 'turn-done', event: { type: 'result', subtype: 'success' } }) + '\n')
    }
  })
  socket.on('error', () => {})
})
try { unlinkSync(socketPath) } catch {}
server.listen(socketPath)
