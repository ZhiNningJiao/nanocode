// Ties a helper process a test starts to the test process's lifetime. Private
// tmux servers daemonize and spawned servers outlive a SIGKILLed parent, so
// whatever the test process does not get to clean up (killed by an outer
// timeout, an after() hook that never ran) must notice by itself that the
// test process is gone and exit.
//
// Two ways in: import exitWithOwner(pid) (tmux-stub-bridge.mjs), or preload
// this file into a spawned node — `node --import <this file> …` with the test
// process's pid in NANOCODE_TEST_OWNER_PID — without touching the program run.
//
// A killed test process also never removes its temp dir. A preloaded process
// given that dir in NANOCODE_TEST_OWNER_CLEANUP (ownerEnvRemoving) removes it
// on the way out, when it exits because the owner is gone.
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative } from 'node:path'

export const OWNER_WATCH = import.meta.url

/** Spawn a node program that exits with this process:
 * `spawn(process.execPath, [...OWNED_NODE_ARGS, script], { env: { ...env, ...OWNER_ENV } })`. */
export const OWNED_NODE_ARGS = ['--import', OWNER_WATCH]
export const OWNER_ENV = { NANOCODE_TEST_OWNER_PID: String(process.pid) }
/** OWNER_ENV, plus the test's temp dir (under os.tmpdir()) for the spawned process to remove if the test process dies first. */
export const ownerEnvRemoving = (dir) => ({ ...OWNER_ENV, NANOCODE_TEST_OWNER_CLEANUP: dir })

/** `pid` is a live process (a zombie awaiting its reaper counts as gone). */
export function pidAlive(pid) {
  try { process.kill(pid, 0) } catch (err) { return err.code === 'EPERM' }
  try { return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

/** Exit this process once `ownerPid` is gone (checked every 250 ms), first
 * removing `cleanupDir` — only ever a dir inside os.tmpdir(). */
export function exitWithOwner(ownerPid, cleanupDir) {
  const rel = cleanupDir && relative(tmpdir(), cleanupDir)
  if (cleanupDir && (!rel || rel.startsWith('..') || isAbsolute(rel))) throw new Error(`owner-watch: refusing to remove ${cleanupDir} (not inside ${tmpdir()})`)
  setInterval(() => {
    if (pidAlive(ownerPid)) return
    if (cleanupDir) try { rmSync(cleanupDir, { recursive: true, force: true }) } catch {}
    process.exit(0)
  }, 250).unref()
}

if (process.env.NANOCODE_TEST_OWNER_PID) exitWithOwner(Number(process.env.NANOCODE_TEST_OWNER_PID), process.env.NANOCODE_TEST_OWNER_CLEANUP)
