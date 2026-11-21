/**
 * Machine Board — "还能放多少" resource dashboard (nanomach_1645).
 *
 * Collects lightweight, read-only resource stats from a fixed list of
 * machines over SSH (one SSH call per machine, same shell script run locally
 * when the machine IS this host) so the operator can see at a glance where to
 * put the next heavy job. No agent/daemon is installed on the watched
 * machines — everything here is a single lightweight remote command.
 *
 * Machine list lives in config/machines.local.json (gitignored — real IPs/
 * names never committed); config/machines.example.json is the committed
 * placeholder shape.
 *
 * Collection is per-machine isolated (Promise.allSettled): one unreachable
 * machine never blocks or blanks out the others (PRD P0-8).
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

export const MACHINES_CONFIG_PATH = join(REPO_ROOT, 'config', 'machines.local.json')
export const MACHINES_EXAMPLE_PATH = join(REPO_ROOT, 'config', 'machines.example.json')

// Thresholds — single source of truth, reused by the "what's free" headline,
// the recommend-a-target rule, and the frontend's color-coding so the three
// never drift apart (DCC 荣耻七条 "范式统一" spirit, applied here too).
export const THRESHOLDS = {
  memAvailableLowPct: 15, // below this: "can't take heavy work" (memory)
  diskHighPct: 90,
  // load1 > cores is flagged as overloaded in the UI; no separate constant
  // needed since it's a direct comparison of two already-collected fields.
}

const SSH_CONNECT_TIMEOUT_SEC = 5
const COMMAND_TIMEOUT_MS = 15_000

/**
 * Load the machine list. Never throws: missing/corrupt config degrades to an
 * empty list (the panel will just show nothing to watch, not crash).
 */
export function loadMachinesConfig(path = MACHINES_CONFIG_PATH) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const machines = Array.isArray(parsed?.machines) ? parsed.machines : []
    return machines
      .filter((m) => m && typeof m.host === 'string' && m.host)
      .map((m) => ({
        id: String(m.id || m.host),
        label: String(m.label || m.host),
        host: m.host,
      }))
  } catch {
    return []
  }
}

/**
 * Is `host` this machine itself? Used to decide "read directly, no ssh"
 * (when the collector happens to run on one of the watched hosts) vs "ssh
 * in". Compares against loopback names and the machine's own non-internal
 * IPv4 addresses — no hardcoded hostname special-casing, so the same code
 * works wherever it's deployed.
 */
export function isSelf(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (host === os.hostname()) return true
  const ips = []
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (!addr.internal && addr.family === 'IPv4') ips.push(addr.address)
    }
  }
  return ips.includes(host)
}

// The one collector script, run either locally (self) or over ssh (remote).
//
// A D-state (uninterruptible-sleep) process cannot be killed by `timeout`,
// SIGTERM, or even SIGKILL — the kernel won't deliver any signal until the
// process returns from its blocking syscall, which on a machine with a half-
// dead JuiceFS mount can be indefinite (observed in production: a tmux CLIENT
// hangs forever because the tmux SERVER it talks to is itself D-state-stuck).
// So this script never calls anything that might block on such a server:
// `ps` is checked FIRST and synchronously (it only reads /proc, confirmed
// safe even while other tools wedge); the tmux probe is skipped entirely
// whenever any D-state process is present, rather than attempted-and-maybe-
// abandoned — an abandoned attempt would itself become one more permanently
// stuck orphan process on an already-struggling machine, accumulating one
// per 60s poll forever. Everything else (df/nvidia-smi/who/systemctl/docker)
// has not been observed to block on this host's JuiceFS issue, but still
// gets a `timeout` guard as cheap insurance; they run backgrounded in
// parallel (own temp files, no stdout interleaving) with a bounded sleep
// instead of a blocking `wait`, so even an unexpected hang there is never
// waited on — whatever finished within the sleep window is read, the rest
// degrades to empty/missing (handled the same as "tool not installed").
const SUBCOMMAND_TIMEOUT_SEC = 3
const PARALLEL_JOIN_SLEEP_SEC = 3.3
const COLLECTOR_SCRIPT = `
TMPD=$(mktemp -d 2>/dev/null) || TMPD="/tmp/.machboard.$$"
mkdir -p "$TMPD" 2>/dev/null
trap 'rm -rf "$TMPD" 2>/dev/null' EXIT
echo "NPROC=$(nproc 2>/dev/null)"
echo "LOADAVG=$(cat /proc/loadavg 2>/dev/null)"
echo "UPTIME_SEC=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
echo "MEMINFO_BEGIN"
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo "MEMINFO_END"
echo "DSTATE_BEGIN"
DSTATE_OUT=$(timeout ${SUBCOMMAND_TIMEOUT_SEC} ps -eo stat,etimes,comm 2>/dev/null | awk '$1 ~ /^D/ {print $2"|"$3}')
[ -n "$DSTATE_OUT" ] && printf '%s\\n' "$DSTATE_OUT"
echo "DSTATE_END"
( for m in / /jfs /dev/shm /var/tmp; do timeout ${SUBCOMMAND_TIMEOUT_SEC} df -kP "$m" 2>/dev/null | awk -v m="$m" 'NR==2{print m"|"$2"|"$3"|"$4"|"$5}'; done > "$TMPD/disk" ) &
( timeout ${SUBCOMMAND_TIMEOUT_SEC} nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits > "$TMPD/gpu" 2>/dev/null ) &
( timeout ${SUBCOMMAND_TIMEOUT_SEC} who 2>/dev/null | wc -l > "$TMPD/users" ) &
( timeout ${SUBCOMMAND_TIMEOUT_SEC} systemctl --user list-units --type=service --state=running --no-legend 2>/dev/null | wc -l > "$TMPD/systemd" ) &
( if command -v docker >/dev/null 2>&1; then timeout ${SUBCOMMAND_TIMEOUT_SEC} docker ps -q 2>/dev/null > "$TMPD/containers"; fi ) &
if [ -z "$DSTATE_OUT" ]; then
  ( timeout ${SUBCOMMAND_TIMEOUT_SEC} tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c '^akari_wf_' > "$TMPD/tmux" ) &
fi
sleep ${PARALLEL_JOIN_SLEEP_SEC}
echo "DISK_BEGIN"; cat "$TMPD/disk" 2>/dev/null; echo "DISK_END"
echo "GPU_BEGIN"; cat "$TMPD/gpu" 2>/dev/null; echo "GPU_END"
echo "USERS=$(cat "$TMPD/users" 2>/dev/null)"
echo "SYSTEMD_USER_RUNNING=$(cat "$TMPD/systemd" 2>/dev/null)"
if [ -n "$DSTATE_OUT" ]; then
  echo "TMUX_AKARI_SKIPPED=1"
else
  echo "TMUX_AKARI=$(cat "$TMPD/tmux" 2>/dev/null)"
fi
echo "CONTAINERS_BEGIN"; cat "$TMPD/containers" 2>/dev/null; echo "CONTAINERS_END"
`.trim()

/**
 * Run the collector script against one machine. Injectable `execFileImpl`
 * (defaults to node's execFile) so tests can simulate timeouts/failures
 * without a real network or real ssh binary — keeps the parsing/derivation
 * logic testable in isolation from real IO.
 */
function runCollector(machine, execFileImpl = execFile) {
  return new Promise((resolve) => {
    const local = isSelf(machine.host)
    const args = local
      ? ['-c', COLLECTOR_SCRIPT]
      : []
    const cmd = local ? 'bash' : 'ssh'
    const fullArgs = local
      ? args
      : [
          '-o', 'BatchMode=yes',
          '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`,
          machine.host,
          COLLECTOR_SCRIPT,
        ]
    execFileImpl(cmd, fullArgs, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message || String(err) })
      resolve({ ok: true, stdout: String(stdout || '') })
    })
  })
}

function parseSection(lines, beginTag, endTag) {
  const begin = lines.indexOf(beginTag)
  const end = lines.indexOf(endTag)
  if (begin === -1 || end === -1 || end < begin) return []
  return lines.slice(begin + 1, end).filter((l) => l.length > 0)
}

function kbToMB(kb) { return Math.round(kb / 1024) }

/**
 * Parse one machine's raw collector stdout into structured stats. Pure
 * function — no IO — so missing-tool / missing-mountpoint / empty-output
 * cases can be unit tested with plain strings.
 */
export function parseCollectorOutput(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trimEnd())
  const get = (key) => {
    const line = lines.find((l) => l.startsWith(key + '='))
    return line === undefined ? null : line.slice(key.length + 1)
  }

  const cores = Number(get('NPROC')) || null
  const loadRaw = get('LOADAVG')
  const loadParts = loadRaw ? loadRaw.split(/\s+/).map(Number) : []
  const load1 = loadParts[0] ?? null
  const load5 = loadParts[1] ?? null
  const load15 = loadParts[2] ?? null
  const uptimeSec = Number(get('UPTIME_SEC')) || null
  const usersCount = Number(get('USERS')) || 0
  const systemdUserRunning = Number(get('SYSTEMD_USER_RUNNING')) || 0
  // The tmux probe is skipped (not attempted) whenever D-state processes are
  // present, to avoid spawning a client against a possibly wedged tmux server
  // (see COLLECTOR_SCRIPT comment) — null + explicit flag, never a fake 0.
  const tmuxSkipped = get('TMUX_AKARI_SKIPPED') === '1'
  const tmuxAkariCount = tmuxSkipped ? null : (Number(get('TMUX_AKARI')) || 0)

  const memLines = parseSection(lines, 'MEMINFO_BEGIN', 'MEMINFO_END')
  const memKV = {}
  for (const l of memLines) {
    const m = l.match(/^(\w+):\s*(\d+)\s*kB$/)
    if (m) memKV[m[1]] = Number(m[2])
  }
  const memTotalMB = memKV.MemTotal ? kbToMB(memKV.MemTotal) : null
  const memAvailableMB = memKV.MemAvailable != null ? kbToMB(memKV.MemAvailable) : null
  const memAvailablePct = memTotalMB && memAvailableMB != null
    ? Math.round((memAvailableMB / memTotalMB) * 1000) / 10
    : null
  const swapTotalMB = memKV.SwapTotal != null ? kbToMB(memKV.SwapTotal) : null
  const swapFreeMB = memKV.SwapFree != null ? kbToMB(memKV.SwapFree) : null
  const swapUsedMB = swapTotalMB != null && swapFreeMB != null ? swapTotalMB - swapFreeMB : null

  const diskLines = parseSection(lines, 'DISK_BEGIN', 'DISK_END')
  const disks = diskLines.map((l) => {
    const [mount, totalKB, usedKB, availKB, pct] = l.split('|')
    return {
      mount,
      totalMB: kbToMB(Number(totalKB)),
      usedMB: kbToMB(Number(usedKB)),
      availMB: kbToMB(Number(availKB)),
      usedPct: Number(String(pct).replace('%', '')),
    }
  }).filter((d) => d.mount && !Number.isNaN(d.usedPct))

  const gpuLines = parseSection(lines, 'GPU_BEGIN', 'GPU_END')
  const gpus = gpuLines.map((l) => {
    const parts = l.split(',').map((p) => p.trim())
    const [name, util, memUsed, memTotal] = parts
    return {
      name: name || 'gpu',
      utilPct: Number(util) || 0,
      memUsedMB: Number(memUsed) || 0,
      memTotalMB: Number(memTotal) || 0,
    }
  }).filter((g) => g.name)

  const dstateLines = parseSection(lines, 'DSTATE_BEGIN', 'DSTATE_END')
  const dstateProcs = dstateLines.map((l) => {
    const [etimes, comm] = l.split('|')
    return { etimesSec: Number(etimes) || 0, comm: comm || '?' }
  })
  const dstateCount = dstateProcs.length
  const dstateOldestSec = dstateProcs.reduce((max, p) => Math.max(max, p.etimesSec), 0)

  const containerLines = parseSection(lines, 'CONTAINERS_BEGIN', 'CONTAINERS_END')
  const containerCount = containerLines.length

  return {
    cores,
    load1, load5, load15,
    uptimeSec,
    usersCount,
    mem: { totalMB: memTotalMB, availableMB: memAvailableMB, availablePct: memAvailablePct },
    swap: { totalMB: swapTotalMB, usedMB: swapUsedMB },
    disks,
    gpus,
    dstate: { count: dstateCount, oldestSec: dstateOldestSec },
    ours: { tmuxAkariCount, tmuxSkipped, systemdUserRunning, containerCount },
  }
}

function freeCores(stats) {
  if (stats?.cores == null || stats?.load1 == null) return null
  return Math.max(0, Math.round((stats.cores - stats.load1) * 10) / 10)
}

function freeGpuMemMB(stats) {
  if (!stats?.gpus?.length) return 0
  return stats.gpus.reduce((sum, g) => sum + Math.max(0, g.memTotalMB - g.memUsedMB), 0)
}

/**
 * Collect one machine's snapshot. Never throws — unreachable/failed machines
 * come back with `reachable: false` and a short error, never a thrown error
 * that could take other machines down with it (caller uses allSettled too,
 * belt-and-braces).
 */
export async function collectMachine(machine, execFileImpl = execFile) {
  const checkedAt = new Date().toISOString()
  const result = await runCollector(machine, execFileImpl)
  if (!result.ok) {
    return { id: machine.id, label: machine.label, host: machine.host, reachable: false, checkedAt, error: result.error }
  }
  const stats = parseCollectorOutput(result.stdout)
  return {
    id: machine.id,
    label: machine.label,
    host: machine.host,
    reachable: true,
    checkedAt,
    stats,
    derived: {
      freeCores: freeCores(stats),
      freeGpuMemMB: freeGpuMemMB(stats),
    },
  }
}

/**
 * Collect all configured machines in parallel, one machine's failure never
 * affecting another's result (PRD P0-8 data-source segmented degradation).
 */
export async function collectAllMachines(machines, execFileImpl = execFile) {
  const settled = await Promise.allSettled(machines.map((m) => collectMachine(m, execFileImpl)))
  return settled.map((s, i) => s.status === 'fulfilled'
    ? s.value
    : { id: machines[i].id, label: machines[i].label, host: machines[i].host, reachable: false, checkedAt: new Date().toISOString(), error: String(s.reason) })
}

/**
 * "重活现在建议放：X" — exclude unreachable / D-state-heavy / low-memory
 * machines, then rank the rest by free cores then free memory %. Pure
 * function over already-collected snapshots so the rule itself is unit
 * testable without touching the network.
 */
export function recommendHeavyWorkloadTarget(snapshots) {
  const candidates = snapshots.filter((m) =>
    m.reachable &&
    m.stats.dstate.count === 0 &&
    (m.stats.mem.availablePct == null || m.stats.mem.availablePct >= THRESHOLDS.memAvailableLowPct)
  )
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const fa = a.derived.freeCores ?? -Infinity
    const fb = b.derived.freeCores ?? -Infinity
    if (fb !== fa) return fb - fa
    const ma = a.stats.mem.availablePct ?? -Infinity
    const mb = b.stats.mem.availablePct ?? -Infinity
    return mb - ma
  })
  return candidates[0].id
}
