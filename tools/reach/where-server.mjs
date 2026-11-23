#!/usr/bin/env node
/**
 * where.json server — runs on each relay host, independent of the nanocode
 * host, so the address book stays readable while that host is down.
 *
 *   node tools/reach/where-server.mjs --listen 0.0.0.0:9495 --www <dir>
 *
 * <dir> holds where.json (rewritten by beacon.mjs) plus a copy of the PWA's
 * offline page (public/offline.html + public/js/reach-finder.js), so
 * http://<relay>:<port>/ is also a bookmarkable "find nanocode" page that
 * needs no service worker. Only those files are served, read fresh on every
 * request, never cached; CORS is open because the offline page on another
 * relay's origin reads where.json cross-origin.
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHostPort } from './relay-forward.mjs'

const FILES = {
  '/': ['offline.html', 'text/html; charset=utf-8'],
  '/offline.html': ['offline.html', 'text/html; charset=utf-8'],
  '/js/reach-finder.js': ['js/reach-finder.js', 'text/javascript; charset=utf-8'],
  '/where.json': ['where.json', 'application/json; charset=utf-8'],
}

export function createWhereServer({ www }) {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD')
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const entry = FILES[new URL(req.url, 'http://x').pathname]
    if (!entry) {
      res.writeHead(404).end()
      return
    }
    try {
      const body = await readFile(join(www, entry[0]))
      res.writeHead(200, { 'Content-Type': entry[1] })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (err) {
      res.writeHead(err?.code === 'ENOENT' ? 404 : 500).end()
    }
  })
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const listen = parseHostPort(arg(argv, '--listen'))
  const www = arg(argv, '--www')
  if (!www) {
    console.error('usage: where-server.mjs --listen <host:port> --www <dir>')
    process.exit(2)
  }
  const server = createWhereServer({ www: resolve(www) })
  server.on('error', (err) => {
    console.error(`[where-server] listen ${listen.host}:${listen.port} failed: ${err.message}`)
    process.exit(1)
  })
  server.listen(listen.port, listen.host, () => console.log(`[where-server] ${listen.host}:${listen.port} serving ${www}`))
}
