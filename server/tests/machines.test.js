import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import {
  parseCollectorOutput,
  loadMachinesConfig,
  isSelf,
  collectMachine,
  collectAllMachines,
  recommendHeavyWorkloadTarget,
  THRESHOLDS,
  COLLECTOR_SCRIPT,
  SUBCOMMAND_TIMEOUT_SEC,
  PARALLEL_JOIN_SLEEP_SEC,
} from '../machines.js'

// Fixture files live in a gitignored dir inside this worktree — never host
// /tmp, never the shared nanocode checkout.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, '.fixtures-tmp')

const FULL_OUTPUT = [
  'NPROC=8',
  'LOADAVG=1.50 0.90 0.40 2/300 12345',
  'UPTIME_SEC=123456',
  'MEMINFO_BEGIN',
  'MemTotal:       16000000 kB',
  'MemAvailable:    4000000 kB',
  'SwapTotal:       2000000 kB',
  'SwapFree:        1500000 kB',
  'MEMINFO_END',
  'DISK_BEGIN',
  '/|100000000|50000000|50000000|50%',
  '/jfs|200000000|190000000|10000000|95%',
  'DISK_END',
  'GPU_BEGIN',
  'NVIDIA A100, 42, 1000, 8000',
  'GPU_END',
  'DSTATE_BEGIN',
  '600|rsync',
  '120|dd',
  'DSTATE_END',
  'USERS=2',
  'SYSTEMD_USER_RUNNING=3',
  'TMUX_AKARI=4',
  'CONTAINERS_BEGIN',
  'abc123',
  'def456',
  'CONTAINERS_END',
].join('\n')

describe('parseCollectorOutput', () => {
  it('parses a full healthy snapshot', () => {
    const s = parseCollectorOutput(FULL_OUTPUT)
    assert.equal(s.cores, 8)
    assert.equal(s.load1, 1.5)
    assert.equal(s.load5, 0.9)
    assert.equal(s.load15, 0.4)
    assert.equal(s.uptimeSec, 123456)
    assert.equal(s.usersCount, 2)
    assert.equal(s.mem.totalMB, Math.round(16000000 / 1024))
    assert.equal(s.mem.availableMB, Math.round(4000000 / 1024))
    assert.ok(s.mem.availablePct > 24 && s.mem.availablePct < 26)
    assert.equal(s.swap.usedMB, Math.round((2000000 - 1500000) / 1024))
    assert.equal(s.disks.length, 2)
    assert.equal(s.disks[0].mount, '/')
    assert.equal(s.disks[0].usedPct, 50)
    assert.equal(s.disks[1].usedPct, 95)
    assert.equal(s.gpus.length, 1)
    assert.equal(s.gpus[0].name, 'NVIDIA A100')
    assert.equal(s.gpus[0].utilPct, 42)
    assert.equal(s.gpus[0].memUsedMB, 1000)
    assert.equal(s.dstate.count, 2)
    assert.equal(s.dstate.oldestSec, 600)
    assert.equal(s.ours.systemdUserRunning, 3)
    assert.equal(s.ours.tmuxAkariCount, 4)
    assert.equal(s.ours.containerCount, 2)
  })

  it('degrades cleanly when nvidia-smi is missing (empty GPU section)', () => {
    const out = FULL_OUTPUT.replace('NVIDIA A100, 42, 1000, 8000\n', '')
    const s = parseCollectorOutput(out)
    assert.deepEqual(s.gpus, [])
  })

  it('skips a missing mountpoint instead of erroring', () => {
    const out = FULL_OUTPUT.replace('/jfs|200000000|190000000|10000000|95%\n', '')
    const s = parseCollectorOutput(out)
    assert.equal(s.disks.length, 1)
    assert.equal(s.disks[0].mount, '/')
  })

  it('returns a safe empty-ish shape for empty/garbage input', () => {
    const s = parseCollectorOutput('')
    assert.equal(s.cores, null)
    assert.equal(s.load1, null)
    assert.deepEqual(s.disks, [])
    assert.deepEqual(s.gpus, [])
    assert.equal(s.dstate.count, 0)
  })

  it('reports zero D-state processes when none are stuck', () => {
    const out = FULL_OUTPUT.replace(/DSTATE_BEGIN\n600\|rsync\n120\|dd\nDSTATE_END/, 'DSTATE_BEGIN\nDSTATE_END')
    const s = parseCollectorOutput(out)
    assert.equal(s.dstate.count, 0)
    assert.equal(s.dstate.oldestSec, 0)
    assert.equal(s.dstate.stuckCount, 0)
    assert.equal(s.dstate.transientCount, 0)
  })

  it('classifies a D-state process alive under 60s as transient, not stuck', () => {
    const out = FULL_OUTPUT.replace(
      'DSTATE_BEGIN\n600|rsync\n120|dd\nDSTATE_END',
      'DSTATE_BEGIN\n16|rsync\nDSTATE_END'
    )
    const s = parseCollectorOutput(out)
    assert.equal(s.dstate.count, 1)
    assert.equal(s.dstate.stuckCount, 0)
    assert.equal(s.dstate.transientCount, 1)
    assert.equal(s.dstate.transientOldestSec, 16)
  })

  it('classifies a D-state process alive >= 60s as stuck', () => {
    const out = FULL_OUTPUT.replace(
      'DSTATE_BEGIN\n600|rsync\n120|dd\nDSTATE_END',
      'DSTATE_BEGIN\n60|rsync\nDSTATE_END'
    )
    const s = parseCollectorOutput(out)
    assert.equal(s.dstate.stuckCount, 1)
    assert.equal(s.dstate.stuckOldestSec, 60)
    assert.equal(s.dstate.transientCount, 0)
  })

  it('splits a mix of stuck and transient D-state processes correctly', () => {
    const out = FULL_OUTPUT.replace(
      'DSTATE_BEGIN\n600|rsync\n120|dd\nDSTATE_END',
      'DSTATE_BEGIN\n600|rsync\n16|dd\nDSTATE_END'
    )
    const s = parseCollectorOutput(out)
    assert.equal(s.dstate.count, 2)
    assert.equal(s.dstate.stuckCount, 1)
    assert.equal(s.dstate.stuckOldestSec, 600)
    assert.equal(s.dstate.transientCount, 1)
    assert.equal(s.dstate.transientOldestSec, 16)
  })

  it('marks tmux as skipped (null, not 0) when the script skipped it because D-state processes were present', () => {
    const out = FULL_OUTPUT.replace('TMUX_AKARI=4', 'TMUX_AKARI_SKIPPED=1')
    const s = parseCollectorOutput(out)
    assert.equal(s.ours.tmuxSkipped, true)
    assert.equal(s.ours.tmuxAkariCount, null)
  })

  it('reports tmux count normally (not skipped) when no D-state processes are present', () => {
    const s = parseCollectorOutput(FULL_OUTPUT)
    assert.equal(s.ours.tmuxSkipped, false)
    assert.equal(s.ours.tmuxAkariCount, 4)
  })
})

describe('loadMachinesConfig', () => {
  it('returns [] when the config file is missing', () => {
    assert.deepEqual(loadMachinesConfig(path.join(FIXTURE_DIR, 'does-not-exist.json')), [])
  })

  it('returns [] when the config file is corrupt JSON', async () => {
    await mkdir(FIXTURE_DIR, { recursive: true })
    const p = path.join(FIXTURE_DIR, 'corrupt.json')
    await writeFile(p, '{ not valid json', 'utf8')
    assert.deepEqual(loadMachinesConfig(p), [])
    await rm(p)
  })

  it('parses a valid machines list and drops entries without a host', async () => {
    await mkdir(FIXTURE_DIR, { recursive: true })
    const p = path.join(FIXTURE_DIR, 'valid.json')
    await writeFile(p, JSON.stringify({
      machines: [
        { id: 'a', label: 'Machine A', host: '10.0.0.1' },
        { label: 'no id, uses host as id', host: '10.0.0.2' },
        { id: 'bad', label: 'missing host' },
      ],
    }), 'utf8')
    const machines = loadMachinesConfig(p)
    assert.equal(machines.length, 2)
    assert.equal(machines[0].id, 'a')
    assert.equal(machines[1].id, '10.0.0.2')
    await rm(p)
  })
})

describe('isSelf', () => {
  it('treats localhost/127.0.0.1 as self', () => {
    assert.equal(isSelf('localhost'), true)
    assert.equal(isSelf('127.0.0.1'), true)
  })
  it('treats an unrelated IP as not self', () => {
    assert.equal(isSelf('203.0.113.99'), false)
  })
})

describe('collectMachine / collectAllMachines (injected exec)', () => {
  it('collectMachine marks a timed-out ssh call as unreachable, not throwing', async () => {
    const fakeExecFile = (cmd, args, opts, cb) => {
      cb(new Error('ssh: connect to host 203.0.113.9 port 22: Connection timed out'))
    }
    const result = await collectMachine({ id: 'm1', label: 'M1', host: '203.0.113.9' }, fakeExecFile)
    assert.equal(result.reachable, false)
    assert.ok(result.error.includes('timed out'))
  })

  it('collectMachine parses a successful run into stats', async () => {
    const fakeExecFile = (cmd, args, opts, cb) => { cb(null, FULL_OUTPUT) }
    const result = await collectMachine({ id: 'm1', label: 'M1', host: '203.0.113.9' }, fakeExecFile)
    assert.equal(result.reachable, true)
    assert.equal(result.stats.cores, 8)
    assert.ok(result.derived.freeCores >= 0)
  })

  it('collectAllMachines isolates one unreachable machine from the rest', async () => {
    const fakeExecFile = (cmd, args, opts, cb) => {
      const host = args.includes('203.0.113.9') ? '203.0.113.9' : args[args.length - 1]
      if (host === '203.0.113.9') return cb(new Error('unreachable'))
      cb(null, FULL_OUTPUT)
    }
    const machines = [
      { id: 'down', label: 'Down', host: '203.0.113.9' },
      { id: 'up', label: 'Up', host: '203.0.113.10' },
    ]
    const results = await collectAllMachines(machines, fakeExecFile)
    assert.equal(results.length, 2)
    assert.equal(results.find((r) => r.id === 'down').reachable, false)
    assert.equal(results.find((r) => r.id === 'up').reachable, true)
  })
})

// Exercises the actual COLLECTOR_SCRIPT under real bash, with `ps`/`tmux`
// stubbed out via a prepended PATH dir — this is the only way to verify the
// tmux-skip *decision* itself, which lives in shell, not in the JS parser.
// Stub executables live under FIXTURE_DIR (never the host /tmp).
describe('COLLECTOR_SCRIPT tmux gating (real bash, stubbed ps/tmux)', () => {
  let binDir
  const binDirFor = (name) => path.join(FIXTURE_DIR, `bin-${name}`)

  async function writeStub(dir, name, content) {
    const p = path.join(dir, name)
    await writeFile(p, content, 'utf8')
    await chmod(p, 0o755)
  }

  async function runCollectorScript(dir) {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        'bash',
        ['-c', COLLECTOR_SCRIPT],
        { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 20_000, maxBuffer: 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(String(out || '')))
      )
    })
    return parseCollectorOutput(stdout)
  }

  it('skips the tmux probe when the tmux server itself is D-state', async () => {
    binDir = binDirFor('server-stuck')
    await mkdir(binDir, { recursive: true })
    await writeStub(binDir, 'ps', '#!/bin/bash\nprintf "STAT ETIMES COMMAND\\nD 120 tmux\\nSs 50 bash\\n"\n')
    // If invoked despite the D-state server, this would print a session so a
    // bug (probe not actually skipped) would show up as TMUX_AKARI=1 instead
    // of TMUX_AKARI_SKIPPED=1.
    await writeStub(binDir, 'tmux', '#!/bin/bash\n[ "$1" = "list-sessions" ] && echo "akari_wf_should_not_run"\n')
    const s = await runCollectorScript(binDir)
    assert.equal(s.ours.tmuxSkipped, true)
    assert.equal(s.ours.tmuxAkariCount, null)
    await rm(binDir, { recursive: true, force: true })
  })

  it('still runs the tmux probe when D-state is present but unrelated to tmux', async () => {
    binDir = binDirFor('unrelated-dstate')
    await mkdir(binDir, { recursive: true })
    await writeStub(binDir, 'ps', '#!/bin/bash\nprintf "STAT ETIMES COMMAND\\nD 120 rsync\\nSs 50 bash\\n"\n')
    await writeStub(binDir, 'tmux', '#!/bin/bash\n[ "$1" = "list-sessions" ] && printf "akari_wf_a\\nakari_wf_b\\nother\\n"\n')
    const s = await runCollectorScript(binDir)
    assert.equal(s.ours.tmuxSkipped, false)
    assert.equal(s.ours.tmuxAkariCount, 2)
    await rm(binDir, { recursive: true, force: true })
  })

  it('skips (degrades) when the tmux probe does not return within the join window', async () => {
    binDir = binDirFor('ls-times-out')
    await mkdir(binDir, { recursive: true })
    await writeStub(binDir, 'ps', '#!/bin/bash\nprintf "STAT ETIMES COMMAND\\nSs 50 bash\\n"\n')
    // No D-state at all, but the probe itself hangs past SUBCOMMAND_TIMEOUT_SEC;
    // `exec sleep` so `timeout` can kill it cleanly (no orphan left behind).
    await writeStub(binDir, 'tmux', `#!/bin/bash\n[ "$1" = "list-sessions" ] && exec sleep $((${SUBCOMMAND_TIMEOUT_SEC} + 5))\n`)
    const s = await runCollectorScript(binDir)
    assert.equal(s.ours.tmuxSkipped, true)
    assert.equal(s.ours.tmuxAkariCount, null)
    await rm(binDir, { recursive: true, force: true })
  }, { timeout: Math.ceil((SUBCOMMAND_TIMEOUT_SEC + PARALLEL_JOIN_SLEEP_SEC) * 1000) + 15_000 })
})

describe('recommendHeavyWorkloadTarget', () => {
  const ok = (id, overrides = {}) => ({
    id, label: id, host: id, reachable: true, checkedAt: 'x',
    stats: {
      cores: 8, load1: 1, mem: { availablePct: 50 }, dstate: { stuckCount: 0 },
      ...overrides.stats,
    },
    derived: { freeCores: 7, ...overrides.derived },
  })

  it('returns null when every machine is excluded', () => {
    const r = recommendHeavyWorkloadTarget([
      { id: 'a', reachable: false },
      ok('b', { stats: { cores: 8, load1: 1, mem: { availablePct: 50 }, dstate: { stuckCount: 3 } } }),
    ])
    assert.equal(r, null)
  })

  it('excludes a machine below the memory threshold', () => {
    const low = ok('low-mem', { stats: { cores: 8, load1: 1, mem: { availablePct: THRESHOLDS.memAvailableLowPct - 1 }, dstate: { stuckCount: 0 } } })
    const fine = ok('fine', { derived: { freeCores: 2 } })
    const r = recommendHeavyWorkloadTarget([low, fine])
    assert.equal(r, 'fine')
  })

  it('excludes a machine with stuck D-state processes', () => {
    const stuck = ok('stuck', { stats: { cores: 8, load1: 1, mem: { availablePct: 80 }, dstate: { stuckCount: 69 } }, derived: { freeCores: 7.5 } })
    const fine = ok('fine', { derived: { freeCores: 2 } })
    const r = recommendHeavyWorkloadTarget([stuck, fine])
    assert.equal(r, 'fine')
  })

  it('does not exclude a machine whose D-state processes are only transient', () => {
    const transientOnly = ok('transient', { stats: { cores: 8, load1: 1, mem: { availablePct: 80 }, dstate: { stuckCount: 0 } }, derived: { freeCores: 7.5 } })
    const r = recommendHeavyWorkloadTarget([transientOnly])
    assert.equal(r, 'transient')
  })

  it('ranks remaining candidates by free cores, then memory %', () => {
    const a = ok('a', { derived: { freeCores: 2 } })
    const b = ok('b', { derived: { freeCores: 5 } })
    const r = recommendHeavyWorkloadTarget([a, b])
    assert.equal(r, 'b')
  })
})
