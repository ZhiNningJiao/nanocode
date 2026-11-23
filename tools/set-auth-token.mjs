#!/usr/bin/env node
/**
 * Set the nanocode access token (server/token-auth.js) — run on the machine
 * that runs nanocode; the endpoint it calls accepts loopback callers on the
 * main port only.
 *
 *   node tools/set-auth-token.mjs --out <token-file> --port <main-port> [--port <main-port> ...]
 *   node tools/set-auth-token.mjs --out <token-file> --port <main-port> --reuse
 *
 * Generates a 32-byte random token (base64url), writes it to <token-file>
 * (mode 600, temp file + rename), then hands it to every listed running
 * instance via POST http://127.0.0.1:<port>/api/auth/token. It goes through
 * the running process, never the settings file: each process keeps its
 * settings in memory and would overwrite a file edit on its next save.
 * --reuse pushes the token already in <token-file> instead of a new one
 * (e.g. a second instance, or after a partial failure).
 *
 * Prints only the first 4 characters of the token and the file path. Rotating
 * (running it again) logs out every browser: login cookies are HMAC(token).
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOKEN_BYTES = 32

export function parseArgs(argv) {
  const opts = { out: '', ports: [], reuse: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i] || ''
    else if (a === '--port') opts.ports.push(Number(argv[++i]))
    else if (a === '--reuse') opts.reuse = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!opts.out) throw new Error('--out <token-file> is required')
  if (!opts.ports.length) throw new Error('at least one --port is required')
  for (const p of opts.ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`invalid --port: ${p}`)
  }
  return opts
}

async function writeSecretFile(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, content, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

/** → { token, results: [{ port, ok, error? }] }; never logs the token. */
export async function setAuthToken({ out, ports, reuse = false, fetchImpl = fetch }) {
  const file = resolve(out)
  let token
  if (reuse) {
    token = (await readFile(file, 'utf8')).trim()
    if (!token) throw new Error(`--reuse: ${file} is empty`)
  } else {
    token = randomBytes(TOKEN_BYTES).toString('base64url')
    await writeSecretFile(file, `${token}\n`)
  }
  const results = []
  for (const port of ports) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await res.json().catch(() => ({}))
      results.push(res.ok ? { port, ok: true } : { port, ok: false, error: `HTTP ${res.status} ${body.error || ''}`.trim() })
    } catch (err) {
      results.push({ port, ok: false, error: err?.message || String(err) })
    }
  }
  return { file, token, results }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { file, token, results } = await setAuthToken(opts)
  console.log(`token ${token.slice(0, 4)}… → ${file} (mode 600)`)
  for (const r of results) console.log(`  127.0.0.1:${r.port}  ${r.ok ? 'ok' : `FAILED: ${r.error}`}`)
  if (results.some((r) => !r.ok)) {
    console.error('some instances did NOT take the token — fix them, then re-run with --reuse')
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`set-auth-token: ${err?.message || err}`)
    process.exit(1)
  })
}
