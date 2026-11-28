// Ties a helper process a test starts to the test process's lifetime. Private
// tmux servers daemonize and spawned servers outlive a SIGKILLed parent, so
// whatever the test process does not get to clean up (killed by an outer
// timeout, an after() hook that never ran) must notice by itself that the
// test process is gone and exit.
//
// Two ways in: import exitWithOwner(pid) (tmux-stub-bridge.mjs), or preload
// this file into a spawned node — `node --import <this file> …` with the test
// process's pid in NANOCODE_TEST_OWNER_PID — without touching the program run.
import { readFileSync } from 'node:fs'

export const OWNER_WATCH = import.meta.url

/** `pid` is a live process (a zombie awaiting its reaper counts as gone). */
export function pidAlive(pid) {
  try { process.kill(pid, 0) } catch (err) { return err.code === 'EPERM' }
  try { return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

/** Exit this process once `ownerPid` is gone (checked every 250 ms). */
export function exitWithOwner(ownerPid) {
  setInterval(() => { if (!pidAlive(ownerPid)) process.exit(0) }, 250).unref()
}

if (process.env.NANOCODE_TEST_OWNER_PID) exitWithOwner(Number(process.env.NANOCODE_TEST_OWNER_PID))
