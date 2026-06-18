/**
 * sub-agent-scanner.js
 *
 * Discovers OS-level sub-agent processes spawned by a parent Claude/Codex
 * process.  Used by the agent health monitor to expose a "running sub-agents"
 * list and to terminate a specific sub-agent without touching the main turn.
 *
 * Linux-only: reads /proc/<pid>/{cmdline,stat,comm,cwd}.  On non-Linux
 * platforms the scanner returns empty arrays gracefully so the UI stays
 * functional.
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { platform } from 'node:os'

const IS_LINUX = platform() === 'linux'

// Match claude/codex/opencode agent executables in cmdline or comm.
const AGENT_CMD_RE = /(?:^|\/)(claude|codex|opencode)(?:\s|$|-)/i

function defaultReadProcText(pid, name) {
  try {
    return readFileSync(`/proc/${pid}/${name}`, 'utf8')
  } catch {
    return ''
  }
}

function defaultReadProcLink(pid, name) {
  try {
    return readlinkSync(`/proc/${pid}/${name}`)
  } catch {
    return ''
  }
}

function basename(p) {
  const m = String(p).match(/([^/\\]+)$/)
  return m ? m[1] : p
}

const INTERPRETERS = new Set(['node', 'node.exe', 'python', 'python3', 'bash', 'sh', 'zsh', 'ruby', 'perl'])

function inferProcessName(cmdline, comm) {
  const tokens = (cmdline || comm || '').split(/\s+/).filter(Boolean)
  if (!tokens.length) return ''
  const first = basename(tokens[0])
  const raw = INTERPRETERS.has(first) && tokens[1] ? basename(tokens[1]) : first
  return raw.replace(/\.(js|ts|py|rb|sh)$/i, '')
}

function defaultListProcEntries() {
  if (!IS_LINUX) return []
  try {
    return readdirSync('/proc')
  } catch {
    return []
  }
}

export function readProcessInfo(pid, reader = {}) {
  const readText = reader.readText || defaultReadProcText
  const readLink = reader.readLink || defaultReadProcLink

  const cmdline = readText(pid, 'cmdline').replace(/\0/g, ' ').trim()
  if (!cmdline) return null

  const stat = readText(pid, 'stat')
  const parts = stat.split(' ')
  // ppid is the 4th field in /proc/<pid>/stat
  const ppid = parts.length >= 4 ? parseInt(parts[3], 10) : 0
  const comm = readText(pid, 'comm').trim()
  const cwd = readLink(pid, 'cwd') || ''

  return {
    pid,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    name: inferProcessName(cmdline, comm),
    comm,
    cmd: cmdline,
    cwd,
  }
}

export function listAllProcesses(reader = {}) {
  const listEntries = reader.listEntries || defaultListProcEntries
  const readText = reader.readText || defaultReadProcText
  const readLink = reader.readLink || defaultReadProcLink
  const procReader = { listEntries, readText, readLink }

  const procs = []
  for (const entry of listEntries()) {
    const pid = parseInt(entry, 10)
    if (!Number.isFinite(pid) || pid <= 0) continue
    const info = readProcessInfo(pid, procReader)
    if (info) procs.push(info)
  }
  return procs
}

export function findDescendants(pid, all) {
  const children = all.filter((p) => p.ppid === pid)
  const result = []
  for (const child of children) {
    result.push(child)
    result.push(...findDescendants(child.pid, all))
  }
  return result
}

function defaultIsAgentProcess(p) {
  return AGENT_CMD_RE.test(p.comm || '') || AGENT_CMD_RE.test(p.cmd || '')
}

/**
 * Find sub-agent processes spawned (directly or transitively) by the given
 * parent PID.  Returns processes that look like agent executables, excluding
 * the parent itself.
 */
export function findSubagents(parentPid, options = {}) {
  const pid = Number(parentPid)
  if (!Number.isFinite(pid) || pid <= 0) return []
  const listProcesses = options.listProcesses || listAllProcesses
  const isAgentProcess = options.isAgentProcess || defaultIsAgentProcess

  const all = listProcesses()
  const descendants = findDescendants(pid, all)
  return descendants.filter((p) => p.pid !== pid && isAgentProcess(p))
}

/**
 * Send a signal to a specific PID.  Returns { ok, error? }.
 */
export function signalProcess(pid, signal = 'SIGTERM', { processKill = process.kill } = {}) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'invalid pid' }
  }
  if (n === process.pid) {
    return { ok: false, error: 'refusing to signal own process' }
  }
  try {
    processKill(n, signal)
    return { ok: true, pid: n, signal }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * Factory that returns a scanner with injectable dependencies (used by tests
 * and by any caller that wants to virtualize /proc access).
 */
export function createSubAgentScanner({ reader, processKill } = {}) {
  function listProcesses() {
    if (!reader) return listAllProcesses()
    const entries = reader.readdir ? reader.readdir() : defaultListProcEntries()
    return entries
      .map((entry) => {
        const pid = parseInt(entry, 10)
        if (!Number.isFinite(pid) || pid <= 0) return null
        const cmdline = (reader.readLink ? reader.readLink(entry) : '') || ''
        const stat = reader.readStat ? reader.readStat(entry) : null
        if (!stat || !Number.isFinite(stat.ppid) || !Number.isFinite(stat.pid)) return null
        return { pid: stat.pid, ppid: stat.ppid, name: inferProcessName(cmdline), comm: '', cmd: cmdline, cwd: '' }
      })
      .filter(Boolean)
  }

  return {
    findSubagents: (parentPid) => findSubagents(parentPid, { listProcesses }),
    signalProcess: (pid, signal) => signalProcess(pid, signal, { processKill: processKill || process.kill }),
  }
}
