#!/usr/bin/env node
/**
 * Relay forwarder — runs on a relay host. Accepts on <listen> and pipes every
 * connection to <upstream>, which is the loopback end of the reverse ssh
 * tunnel the nanocode host keeps open to this relay (`ssh -R`). sshd binds a
 * reverse forward to loopback only, so this is what makes it reachable on the
 * LAN. Plain TCP: HTTP and WebSocket pass through untouched, and the token
 * check stays nanocode's own (the tunnel lands on its remote-entry port).
 *
 *   node tools/reach/relay-forward.mjs --listen 0.0.0.0:9475 --upstream 127.0.0.1:29475
 *
 * Tunnel down → the upstream connect fails → the client connection is closed
 * at once, so a browser sees a network error (the PWA's offline page takes
 * over) instead of a hang.
 */

import net from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseHostPort(s) {
  const m = /^(.*):(\d{1,5})$/.exec(String(s || ''))
  const port = m ? Number(m[2]) : 0
  if (!m || !m[1] || port < 1 || port > 65535) throw new Error(`expected host:port, got ${JSON.stringify(s)}`)
  return { host: m[1].replace(/^\[|\]$/g, ''), port }
}

export function createForwarder({ upstream, connectTimeoutMs = 5000, log = console.log }) {
  return net.createServer((client) => {
    const up = net.connect(upstream)
    up.setTimeout(connectTimeoutMs, () => up.destroy(new Error('upstream connect timeout')))
    up.once('connect', () => up.setTimeout(0))
    const close = (err) => {
      if (err && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') log(`[relay-forward] ${err.message}`)
      client.destroy()
      up.destroy()
    }
    up.on('error', close)
    client.on('error', close)
    up.on('close', () => client.destroy())
    client.on('close', () => up.destroy())
    client.pipe(up)
    up.pipe(client)
  })
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const listen = parseHostPort(arg(argv, '--listen'))
  const upstream = parseHostPort(arg(argv, '--upstream'))
  const server = createForwarder({ upstream })
  server.on('error', (err) => {
    console.error(`[relay-forward] listen ${listen.host}:${listen.port} failed: ${err.message}`)
    process.exit(1)
  })
  server.listen(listen.port, listen.host, () => {
    console.log(`[relay-forward] ${listen.host}:${listen.port} -> ${upstream.host}:${upstream.port}`)
  })
}
