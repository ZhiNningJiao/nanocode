#!/usr/bin/env node
/**
 * Reach beacon — runs every minute (systemd timer) on the host that runs
 * nanocode behind a NAT whose LAN address changes (reconnects re-number it).
 *
 *   node tools/reach/beacon.mjs --config <path/to/beacon.json>
 *
 * The host cannot see its own LAN address (NAT), so it asks each relay "which
 * address do you see me coming from?" (`ssh <relay> 'echo "$SSH_CLIENT"'`, first
 * field). Then, only when something is out of date:
 *   - each reachable relay whose where.json does not carry the current address
 *     gets a new one (written atomically on the relay: temp file + mv);
 *   - the notify command is called once per address change with a plain-text
 *     message carrying the new direct URL and the relay entries.
 * Same address, every relay already has it, already notified → nothing at all.
 *
 * A relay that cannot be asked is skipped with one log line; it is never read
 * as "the address changed". No relay answers → nothing is changed, exit 1 (the
 * timer unit shows the failure). A notify that fails is retried next run.
 *
 * Config (host-local file, never in the repo):
 *   {
 *     "directPort": 9475,
 *     "stateFile": "<host-local disk>/state.json",
 *     "ssh": ["ssh", "-o", "BatchMode=yes", ...],          // argv prefix
 *     "notify": ["<send script>"],                          // + <key> <text>
 *     "relays": [{ "name", "target", "entry", "whereDir", "whereUrl" }, ...]
 *   }
 * `target` is the ssh destination, `entry` the relay's public nanocode URL,
 * `whereDir` the relay-local directory where.json lives in, `whereUrl` where
 * that file is served (read by the PWA offline page).
 *
 * State (`stateFile`, host-local disk so it survives restarts but is never on
 * a shared mount): { ip, since, pushed: { <relay name>: ip }, notified: ip }.
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

export const WHERE_SCHEMA = 'nanocode-reach/v1'
const SSH_TIMEOUT_MS = 30_000
const NOTIFY_TIMEOUT_MS = 120_000

/** First field of $SSH_CLIENT ("<ip> <port> <port>"), or '' if it is not an IP. */
export function parseSshClient(text) {
  const first = String(text || '').trim().split(/\s+/)[0] || ''
  return isIP(first) ? first : ''
}

export function directUrl(ip, port) {
  return isIP(ip) === 6 ? `http://[${ip}]:${port}` : `http://${ip}:${port}`
}

export function buildWhere(cfg, state) {
  return {
    schema: WHERE_SCHEMA,
    direct: directUrl(state.ip, cfg.directPort),
    relays: cfg.relays.map((r) => ({ name: r.name, url: r.entry })),
    where: cfg.relays.map((r) => r.whereUrl),
    updated_at: state.since,
  }
}

export function notifyText(cfg, state) {
  const entries = cfg.relays.map((r) => r.entry).join(' 、')
  return `Nanocode 直连地址变了：${directUrl(state.ip, cfg.directPort)} （中转入口照常：${entries}）`
}

/** POSIX single-quote a string for the remote shell. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** Remote command that replaces <dir>/where.json atomically with stdin. */
export function remoteWriteCommand(dir) {
  return `set -e; d=${shq(dir)}; mkdir -p "$d"; t="$d/.where.json.$$"; cat > "$t"; mv -f "$t" "$d/where.json"`
}

/** Default runner: execFile with optional stdin; resolves { ok, stdout, stderr }. */
export function execRunner(argv, { input, timeout }) {
  return new Promise((done) => {
    const child = execFile(argv[0], argv.slice(1), { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      done({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') })
    })
    child.stdin.end(input ?? '')
  })
}

export function validateConfig(cfg) {
  const errs = []
  if (!Number.isInteger(cfg?.directPort) || cfg.directPort < 1 || cfg.directPort > 65535) errs.push('directPort')
  if (typeof cfg?.stateFile !== 'string' || !cfg.stateFile) errs.push('stateFile')
  if (!Array.isArray(cfg?.ssh) || !cfg.ssh.length) errs.push('ssh')
  if (!Array.isArray(cfg?.notify) || !cfg.notify.length) errs.push('notify')
  if (!Array.isArray(cfg?.relays) || !cfg.relays.length) errs.push('relays')
  for (const [i, r] of (cfg?.relays || []).entries()) {
    for (const k of ['name', 'target', 'entry', 'whereDir', 'whereUrl']) {
      if (typeof r?.[k] !== 'string' || !r[k]) errs.push(`relays[${i}].${k}`)
    }
  }
  if (errs.length) throw new Error(`beacon config invalid: ${errs.join(', ')}`)
  return cfg
}

export async function loadState(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'))
    return { ip: s.ip || '', since: s.since || '', pushed: s.pushed || {}, notified: s.notified || '' }
  } catch (err) {
    if (err?.code === 'ENOENT') return { ip: '', since: '', pushed: {}, notified: '' }
    throw err  // a corrupt state file is a failure, not a silent "first run"
  }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n')
  await rename(tmp, file)
}

/**
 * One beacon run. Returns { ip, changed, pushed: [names], notified: bool,
 * skipped: [names], failed: [msgs] }. `run` and `now` are injectable for tests.
 */
export async function runBeacon(cfg, { run = execRunner, now = () => new Date(), log = console.log } = {}) {
  validateConfig(cfg)
  const state = await loadState(cfg.stateFile)
  const result = { ip: '', changed: false, pushed: [], notified: false, skipped: [], failed: [] }

  const reachable = []
  const seen = []
  for (const relay of cfg.relays) {
    const r = await run([...cfg.ssh, relay.target, 'echo "$SSH_CLIENT"'], { timeout: SSH_TIMEOUT_MS })
    const ip = r.ok ? parseSshClient(r.stdout) : ''
    if (!ip) {
      log(`[beacon] relay ${relay.name} unreachable or no SSH_CLIENT, skipped: ${(r.stderr || r.stdout).trim().split('\n').pop()}`)
      result.skipped.push(relay.name)
      continue
    }
    reachable.push(relay)
    seen.push(ip)
  }
  if (!seen.length) {
    log('[beacon] no relay answered — nothing changed')
    result.failed.push('no relay answered')
    return result
  }
  // Config order decides: the first relay that answered is authoritative.
  const ip = seen[0]
  if (new Set(seen).size > 1) log(`[beacon] relays disagree on the source address (${seen.join(', ')}); using ${ip}`)
  result.ip = ip

  if (ip !== state.ip) {
    log(`[beacon] address changed: ${state.ip || '(none)'} -> ${ip}`)
    state.ip = ip
    state.since = now().toISOString()
    result.changed = true
    await saveState(cfg.stateFile, state)
  }

  const body = JSON.stringify(buildWhere(cfg, state), null, 2) + '\n'
  for (const relay of reachable) {
    if (state.pushed[relay.name] === ip) continue
    const w = await run([...cfg.ssh, relay.target, remoteWriteCommand(relay.whereDir)], { input: body, timeout: SSH_TIMEOUT_MS })
    if (!w.ok) {
      log(`[beacon] where.json write to ${relay.name} failed: ${w.stderr.trim()}`)
      result.failed.push(`write ${relay.name}`)
      continue
    }
    state.pushed[relay.name] = ip
    result.pushed.push(relay.name)
    await saveState(cfg.stateFile, state)
  }

  if (state.notified !== ip) {
    const key = `nanoreach-${ip}-${Date.parse(state.since) || 0}`
    const n = await run([...cfg.notify, key, notifyText(cfg, state)], { timeout: NOTIFY_TIMEOUT_MS })
    if (n.ok) {
      state.notified = ip
      result.notified = true
      await saveState(cfg.stateFile, state)
    } else {
      log(`[beacon] notify failed (retried next run): ${n.stderr.trim()}`)
      result.failed.push('notify')
    }
  }
  return result
}

async function main(argv) {
  const i = argv.indexOf('--config')
  if (i < 0 || !argv[i + 1]) {
    console.error('usage: beacon.mjs --config <beacon.json>')
    return 2
  }
  const cfg = JSON.parse(await readFile(resolve(argv[i + 1]), 'utf8'))
  const r = await runBeacon(cfg)
  if (r.changed || r.pushed.length || r.notified) console.log(`[beacon] ${JSON.stringify(r)}`)
  return r.failed.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
    console.error(`[beacon] ${err?.stack || err}`)
    process.exitCode = 1
  })
}
