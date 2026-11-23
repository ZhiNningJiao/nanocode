/**
 * spawn-in-dir.js — start a child whose working directory may sit on the
 * shared /jfs home without stalling the event loop.
 *
 * child_process.spawn({ cwd }) blocks the parent inside libuv's uv_spawn until
 * the forked child has chdir()ed and exec()ed: on a stalled /jfs that chdir (or
 * the exec of a binary under ~/.local/bin) freezes the whole server for as long
 * as the mount likes (measured in REPORT_nanolock_0730.md: one blocked spawn per
 * stalled op). Here the parent only waits for /bin/sh to exec; the chdir and
 * the exec of `command` happen in the child.
 *
 * Differences from spawn(command, args, { cwd }): a missing cwd or command
 * makes the shell exit non-zero (126/127, message on stderr) instead of an
 * 'error' event — callers already treat a non-zero exit as failure.
 */
import { spawn } from 'node:child_process'

export function spawnInDir(command, args, { cwd, ...opts } = {}) {
  if (!cwd) return spawn(command, args, opts)
  return spawn('/bin/sh', ['-c', 'cd -- "$0" && exec "$@"', cwd, command, ...args], opts)
}
