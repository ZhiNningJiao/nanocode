/**
 * Remote machines address book — MES-13740 需求10 (minimal integration).
 *
 * Research conclusion (full version in REPORT): RustDesk is a Flutter/GUI remote
 * desktop app. On a headless nanocode server the *controller* GUI can't render, so
 * the realistic minimal integration is an **address book** that launches the
 * user's *local* native RustDesk client via the `rustdesk://` URI scheme. The
 * server only stores the book (in the core settings store) — it bundles no
 * RustDesk code, so AGPL obligations are not triggered for internal use.
 *
 * URI scheme (derived from rustdesk/src/core_main.rs `core_main_invoke_new_connection`):
 *   rustdesk://connect/<peerId>?password=<pw>&relay=true
 * where `--connect`/`--password`/`--relay` are the CLI flags the uni-link encodes.
 *
 * The heavier approach (iframe the RustDesk *web client* served from a self-hosted
 * hbbs/hbbr relay, ports 21118/21119) is documented in REPORT and deferred for the
 * master's decision — it needs standing up a relay, which is out of scope for the
 * "最小可用先落" round.
 */

import { randomUUID } from 'node:crypto'

const SETTING_KEY = 'remote_machines'

// RustDesk peer IDs are alphanumeric (the client lower-cases / strips for display),
// but direct-IP access lets you enter an IPv4 / host[:port] in the ID field, so allow
// '.' and ':' too. Keep it permissive but bounded; reject anything that could break a URI.
const PEER_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const ALIAS_RE = /^[^\n\r]{1,64}$/u
const NOTE_RE = /^[^\n\r]{0,256}$/u

const MAX_MACHINES = 200

function readMachines(store) {
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

/**
 * Validate + normalise a machine record from user input.
 * Returns `{ ok, machine, errors }`. `machine` is the sanitised partial record
 * (without the internal `id`); the caller assigns the id on create.
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

  const peerId = trimString(input.peerId, 64)
  if (!peerId) errors.push('peerId must be a non-empty string')
  else if (!PEER_ID_RE.test(peerId)) errors.push('peerId must match /^[A-Za-z0-9_-]{1,64}$/')
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

  return { ok: errors.length === 0, errors, machine: m }
}

export function listMachines(store) {
  return readMachines(store).map((m) => ({ ...m }))
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
 * Mirrors the uni-link construction in rustdesk core_main.rs:
 *   authority=connect, params=password=<pw>&relay=true
 * The browser hands the custom scheme to the OS, which opens the native
 * RustDesk client on the user's *local* device (desktop or the RustDesk mobile
 * app). Nothing is opened on the headless nanocode server.
 */
export function buildConnectUri(machine) {
  if (!machine || typeof machine !== 'object') return ''
  const peerId = String(machine.peerId || '')
  if (!peerId || !PEER_ID_RE.test(peerId)) return ''
  let uri = `rustdesk://connect/${encodeURIComponent(peerId)}`
  const params = []
  if (machine.password) params.push(`password=${encodeURIComponent(machine.password)}`)
  if (machine.relay) params.push('relay=true')
  if (params.length) uri += `?${params.join('&')}`
  return uri
}
