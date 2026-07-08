/**
 * Remote machines address book — MES-13740 需求10 + MES-13781 SSH dev machine.
 *
 * Two machine types coexist in one address book:
 *   - `rustdesk` (original): the server only stores the book; a Connect click
 *     navigates to `rustdesk://connect/<peerId>` so the user's *local* native
 *     RustDesk client opens (the headless nanocode server renders no desktop).
 *   - `ssh` (MES-13781): a Connect click opens a *web terminal Tab* whose PTY
 *     command is `ssh ... user@host` (or `sshpass -e ssh ...` for password auth).
 *     The nanocode server runs on the dev box and can reach the target, so the
 *     server-side SSH → frontend xterm path reuses the existing PTY/xterm
 *     terminal infrastructure (terminal/sessions.js); see remote-ssh.js.
 *
 * URI scheme for rustdesk (derived from rustdesk/src/core_main.rs
 * `core_main_invoke_new_connection`):
 *   rustdesk://connect/<peerId>?password=<pw>&relay=true
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const SETTING_KEY = 'remote_machines'
const SEED_FLAG_KEY = 'remote_machines_seeded_v1'

// RustDesk peer IDs are alphanumeric (the client lower-cases / strips for
// display), but direct-IP access lets you enter an IPv4 / host[:port] in the
// ID field, so allow '.' and ':' too. Keep it permissive but bounded; reject
// anything that could break a URI.
const PEER_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const ALIAS_RE = /^[^\n\r]{1,64}$/u
const NOTE_RE = /^[^\n\r]{0,256}$/u

// SSH host: IPv4, IPv6 (has ':'), or DNS labels. Bounded so it can't be a flag
// (reject leading '-') or path traversal (no '/'/'..'). Passed as an argv
// element to ssh (not a shell), so no shell-injection surface; the regex
// just keeps the value sane.
const HOST_RE = /^(?!-)[A-Za-z0-9._:-]{1,253}$/
const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/
const KEY_PATH_RE = /^[^\n\r\0]{1,512}$/

const MAX_MACHINES = 200

export function readMachines(store) {
  const raw = store.getSetting(SETTING_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((m) => m && typeof m === 'object') : []
  } catch {
    return []
  }
}

function writeMachines(store, machines) {
  store.setSetting(SETTING_KEY, JSON.stringify(machines))
}

function trimString(v, max) {
  if (typeof v !== 'string') return ''
  return v.slice(0, max)
}

/** Expand a leading `~` to the user's home dir. Returns the input unchanged on failure. */
export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`
  return p
}

/**
 * Validate + normalise a machine record from user input.
 * Returns `{ ok, machine, errors }`. `machine` is the sanitised partial record
 * (without the internal `id`); the caller assigns the id on create.
 *
 * `type` defaults to `rustdesk` (so existing records and callers that omit it
 * keep working). For `ssh` the rustdesk-only fields (peerId/password/relay) are
 * dropped; for `rustdesk` the ssh-only fields are dropped.
 */
export function sanitizeMachine(input) {
  const errors = []
  const m = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['machine must be a plain object'], machine: null }
  }
  const alias = trimString(input.alias, 64)
  if (!alias) errors.push('alias must be a non-empty string')
  else if (!ALIAS_RE.test(alias)) errors.push('alias must be ≤64 chars (no newlines)')
  m.alias = alias

  const type = input.type === 'ssh' ? 'ssh' : 'rustdesk'
  m.type = type

  if (type === 'ssh') {
    sanitizeSshFields(input, m, errors)
  } else {
    sanitizeRustdeskFields(input, m, errors)
  }

  return { ok: errors.length === 0, errors, machine: m }
}

function sanitizeRustdeskFields(input, m, errors) {
  const peerId = trimString(input.peerId, 64)
  if (!peerId) errors.push('peerId must be a non-empty string')
  else if (!PEER_ID_RE.test(peerId)) errors.push('peerId must match /^[A-Za-z0-9_.:-]{1,64}$/')
  m.peerId = peerId

  // Optional permanent password. Stored in the local settings store (server-side,
  // not exposed to third parties). Left blank → native client prompts at connect.
  const password = trimString(input.password, 128)
  if (password && !/^[\S]{1,128}$/.test(password)) errors.push('password must be ≤128 non-space chars')
  m.password = password

  const relay = input.relay === true || input.relay === 'true'
  m.relay = relay

  const note = trimString(input.note, 256)
  if (note && !NOTE_RE.test(note)) errors.push('note must be ≤256 chars (no newlines)')
  m.note = note
}

function sanitizeSshFields(input, m, errors) {
  const host = trimString(input.host, 253).trim()
  if (!host) errors.push('host must be a non-empty string')
  else if (!HOST_RE.test(host)) errors.push('host must be an IP or domain (no leading "-", no "/" or spaces)')
  else if (host.includes('..')) errors.push('host must not contain ".."')
  m.host = host

  const user = trimString(input.user, 64).trim()
  if (!user) errors.push('user must be a non-empty string')
  else if (!USER_RE.test(user)) errors.push('user must be ≤64 chars ([A-Za-z0-9._@-])')
  m.user = user

  let port = 22
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    const n = Number(input.port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.push('port must be an integer 1-65535')
    else port = n
  }
  m.port = port

  // Auth: exactly one of key / password. Both stored server-side in the settings
  // store (same boundary as the rustdesk password). Never echoed to logs/terminal
  // by the SSH spawner (password goes via sshpass -e env var; key is a path).
  const key = trimString(input.key, 512).trim()
  const password = trimString(input.sshPassword || input.password, 128)
  if (key && password) errors.push('provide either key or password, not both')
  else if (!key && !password) errors.push('ssh machine needs either a key path or a password')
  if (key && !KEY_PATH_RE.test(key)) errors.push('key path must be ≤512 chars (no newlines/NUL)')
  if (password && !/^[\S]{1,128}$/.test(password)) errors.push('ssh password must be ≤128 non-space chars')
  m.key = key
  m.sshPassword = password

  const note = trimString(input.note, 256)
  if (note && !NOTE_RE.test(note)) errors.push('note must be ≤256 chars (no newlines)')
  m.note = note
}

export function listMachines(store) {
  // Backfill `type` for records written before the ssh type existed.
  return readMachines(store).map((m) => ({ ...m, type: m.type || 'rustdesk' }))
}

/**
 * Merge read-only personal dev machines (from ~/.config/nanocode/personal.json,
 * MES-13824) ahead of the user's address-book machines. Each personal entry is
 * run through sanitizeMachine (the SAME validator as the address book) so the
 * shape is consistent and key/path/host are bounded; entries that fail
 * validation are dropped. Personal machines get a stable id `personal:<alias>`
 * and are tagged `personal:true, readOnly:true` so the UI can mark them and the
 * update/delete routes can reject them. The user's address book is untouched.
 *
 * @param {Array} storeMachines  - machines from the settings store
 * @param {Array|null} personalMachines - raw machines from the personal config
 * @returns {Array} merged list (personal first, then store machines)
 */
export function mergePersonalMachines(storeMachines, personalMachines) {
  const personal = Array.isArray(personalMachines) ? personalMachines : []
  const merged = []
  for (const raw of personal) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const r = sanitizeMachine({ ...raw, type: raw.type || 'ssh' })
    if (!r.ok) continue
    merged.push({ ...r.machine, id: `personal:${r.machine.alias}`, personal: true, readOnly: true })
  }
  return [...merged, ...storeMachines]
}

export function getMachine(store, recId, personalMachines) {
  if (typeof recId !== 'string' || !recId) return null
  // MES-13824: personal dev machines (id `personal:<alias>`) are read-only seeds
  // declared in ~/.config/nanocode/personal.json. They are not in the settings
  // store; resolve them from the personal list passed in by the caller (the
  // connect route + WS handler pass loadPersonalConfig().remote.machines). When
  // personalMachines is omitted the behaviour is unchanged (store-only lookup).
  if (recId.startsWith('personal:')) {
    const list = Array.isArray(personalMachines) ? personalMachines : []
    for (const raw of list) {
      const r = sanitizeMachine({ ...raw, type: raw.type || 'ssh' })
      if (r.ok && `personal:${r.machine.alias}` === recId) {
        return { ...r.machine, id: recId, personal: true, readOnly: true }
      }
    }
    return null
  }
  const m = readMachines(store).find((x) => x.id === recId)
  if (!m) return null
  return { ...m, type: m.type || 'rustdesk' }
}

export function addMachine(store, input) {
  const { ok, errors, machine } = sanitizeMachine(input)
  if (!ok) return { error: errors.join('; ') }
  const machines = readMachines(store)
  if (machines.length >= MAX_MACHINES) return { error: `address book full (max ${MAX_MACHINES})` }
  const record = { id: randomUUID(), ...machine }
  machines.push(record)
  writeMachines(store, machines)
  return { machine: { ...record } }
}

export function updateMachine(store, recId, input) {
  if (typeof recId !== 'string' || !recId) return { error: 'invalid record id' }
  const { ok, errors, machine } = sanitizeMachine(input)
  if (!ok) return { error: errors.join('; ') }
  const machines = readMachines(store)
  const idx = machines.findIndex((m) => m.id === recId)
  if (idx < 0) return { error: 'machine not found' }
  machines[idx] = { id: machines[idx].id, ...machine }
  writeMachines(store, machines)
  return { machine: { ...machines[idx] } }
}

export function deleteMachine(store, recId) {
  if (typeof recId !== 'string' || !recId) return { error: 'invalid record id' }
  const machines = readMachines(store)
  const next = machines.filter((m) => m.id !== recId)
  if (next.length === machines.length) return { error: 'machine not found' }
  writeMachines(store, next)
  return { ok: true }
}

/**
 * Build the `rustdesk://connect/<peerId>` URI a Connect click navigates to.
 * Returns '' for ssh machines (they open a web terminal instead).
 * Mirrors the uni-link construction in rustdesk core_main.rs:
 *   authority=connect, params=password=<pw>&relay=true
 */
export function buildConnectUri(machine) {
  if (!machine || typeof machine !== 'object') return ''
  if (machine.type === 'ssh') return ''
  const peerId = String(machine.peerId || '')
  if (!peerId || !PEER_ID_RE.test(peerId)) return ''
  let uri = `rustdesk://connect/${encodeURIComponent(peerId)}`
  const params = []
  if (machine.password) params.push(`password=${encodeURIComponent(machine.password)}`)
  if (machine.relay) params.push('relay=true')
  if (params.length) uri += `?${params.join('&')}`
  return uri
}

/**
 * Build the argv for an SSH PTY. Reused by the remote-ssh WS handler.
 *
 * Key auth:    `ssh -tt -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i <key> -p <port> user@host`
 * Password:    `sshpass -e ssh -tt -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p <port> user@host`
 *              (password carried in the SSHPASS env var so it never appears in argv / logs)
 *
 * Returns `{ ok, command, args, env, error }`. `env` is a partial env to merge
 * into the PTY env (e.g. { SSHPASS }). The caller must NOT log `env.SSHPASS`.
 *
 * @param {object} machine - ssh machine record (host/user/port/key/sshPassword)
 * @param {{ sshpassPath?: string|null }} [opts] - resolved sshpass binary path
 *   (null/undefined = not installed). Required for password auth.
 */
export function buildSshCommand(machine, opts = {}) {
  if (!machine || machine.type !== 'ssh') {
    return { ok: false, error: 'not an ssh machine' }
  }
  const host = String(machine.host || '').trim()
  const user = String(machine.user || '').trim()
  const port = Number(machine.port) || 22
  if (!host || !user) return { ok: false, error: 'host and user are required' }

  const keyPath = machine.key ? expandHome(String(machine.key).trim()) : ''
  const password = machine.sshPassword || ''

  const baseArgs = [
    '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-p', String(port),
    `${user}@${host}`,
  ]

  if (keyPath) {
    if (!existsSync(keyPath)) {
      return { ok: false, error: `private key not found: ${keyPath}` }
    }
    return {
      ok: true,
      command: 'ssh',
      args: ['-i', keyPath, ...baseArgs],
      env: {},
      // Safe to log: only the key *path*, never the key *content*.
      logSummary: `ssh -i <key> -p ${port} ${user}@${host}`,
    }
  }

  if (password) {
    const sshpass = opts.sshpassPath
    if (!sshpass) {
      return { ok: false, error: 'sshpass is not installed on the server — install it for password auth, or use a private key' }
    }
    return {
      ok: true,
      command: sshpass,
      args: ['-e', 'ssh', ...baseArgs],
      env: { SSHPASS: password },
      // Don't leak the password; sshpass -e reads it from env.
      logSummary: `sshpass -e ssh -p ${port} ${user}@${host}`,
    }
  }

  return { ok: false, error: 'ssh machine has neither a key nor a password' }
}

/**
 * Seed the default address book with one example ssh machine on a fresh
 * install (so others can copy the shape). Idempotent: a settings flag guards
 * re-seeding after the user deletes the seed. Called once at server start.
 */
export function seedRemoteDefaults(store) {
  if (store.getSetting(SEED_FLAG_KEY) === '1') return
  const existing = readMachines(store)
  if (existing.length === 0) {
    const seed = {
      id: randomUUID(),
      type: 'ssh',
      alias: 'dev-212',
      host: '172.30.20.212',
      user: 'Administrator',
      port: 22,
      key: '~/.ssh/id_cluster',
      sshPassword: '',
      note: '示例 SSH 开发机（照此添加你自己的）',
    }
    writeMachines(store, [seed])
  }
  store.setSetting(SEED_FLAG_KEY, '1')
}
