/**
 * Unit tests for terminal/session-lock.js — cross-process session singleton lock.
 *
 * Verifies:
 *  - Basic acquire / release cycle
 *  - Second acquire fails when held by another live process
 *  - Stale lock recovery (dead pid → steal)
 *  - Release only by the owner
 *  - Re-entrant acquire (same pid + port)
 *  - getLockHolder / isLockHeldByOther semantics
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import {
  acquireSessionLock,
  releaseSessionLock,
  getLockHolder,
  isLockHeldByOther,
  isPidAlive,
} from '../../terminal/session-lock.js'

let tmpHome

function setup() {
  tmpHome = mkdtempSync('/tmp/nanocode-locktest-')
}

function teardown() {
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

describe('session-lock', () => {
  beforeEach(setup)
  afterEach(teardown)

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      assert.equal(isPidAlive(process.pid), true)
    })

    it('returns false for a non-existent pid', () => {
      // Pid 0 is never a valid kill target in this context; use a very high
      // pid that is almost certainly not running.
      assert.equal(isPidAlive(999_999), false)
    })

    it('returns false for null / undefined / invalid', () => {
      assert.equal(isPidAlive(null), false)
      assert.equal(isPidAlive(undefined), false)
      assert.equal(isPidAlive(0), false)
    })
  })

  describe('acquireSessionLock', () => {
    it('acquires a lock for a new session', () => {
      const result = acquireSessionLock('sess-a', { pid: 1000, port: 9477 }, tmpHome)
      assert.equal(result.acquired, true)
      assert.equal(result.holder, undefined)
    })

    it('writes pid + port + timestamp to the lock file', () => {
      acquireSessionLock('sess-b', { pid: 2000, port: 9478 }, tmpHome)
      const dir = `${tmpHome}/.nanocode/session-locks`
      const raw = readFileSync(`${dir}/sess-b.lock`, 'utf8')
      const obj = JSON.parse(raw)
      assert.equal(obj.pid, 2000)
      assert.equal(obj.port, 9478)
      assert.equal(typeof obj.timestamp, 'number')
      assert.ok(obj.timestamp > 0)
    })

    it('is re-entrant for the same pid + port', () => {
      acquireSessionLock('sess-c', { pid: 3000, port: 9477 }, tmpHome)
      const result = acquireSessionLock('sess-c', { pid: 3000, port: 9477 }, tmpHome)
      assert.equal(result.acquired, true)
    })

    it('rejects a second acquire when another live process holds the lock', () => {
      // Server A (pid=our pid, port 9477) acquires.
      acquireSessionLock('sess-e', { pid: process.pid, port: 9477 }, tmpHome)
      // Server B (same pid — alive, port 9478) tries to acquire.
      // Since pid is alive but port differs, it's a different holder → reject.
      const result = acquireSessionLock('sess-e', { pid: process.pid, port: 9478 }, tmpHome)
      assert.equal(result.acquired, false)
      assert.ok(result.holder)
      assert.equal(result.holder.pid, process.pid)
      assert.equal(result.holder.port, 9477)
    })

    it('steals a stale lock when the holder pid is dead', () => {
      // "Dead" process acquires (pid 999999 is not alive).
      acquireSessionLock('sess-f', { pid: 999_999, port: 9477 }, tmpHome)
      // New live process steals.
      const result = acquireSessionLock('sess-f', { pid: process.pid, port: 9478 }, tmpHome)
      assert.equal(result.acquired, true)
      assert.equal(result.holder, undefined)
    })

    it('overwrites a corrupt lock file', () => {
      const dir = `${tmpHome}/.nanocode/session-locks`
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/sess-g.lock`, 'not-json{')
      const result = acquireSessionLock('sess-g', { pid: 1000, port: 9477 }, tmpHome)
      assert.equal(result.acquired, true)
    })
  })

  describe('releaseSessionLock', () => {
    it('releases a lock held by the caller', () => {
      acquireSessionLock('sess-h', { pid: 1000, port: 9477 }, tmpHome)
      const ok = releaseSessionLock('sess-h', { pid: 1000, port: 9477 }, tmpHome)
      assert.equal(ok, true)
      assert.equal(existsSync(`${tmpHome}/.nanocode/session-locks/sess-h.lock`), false)
    })

    it('refuses to release a lock held by another process', () => {
      acquireSessionLock('sess-i', { pid: 1000, port: 9477 }, tmpHome)
      const ok = releaseSessionLock('sess-i', { pid: 2000, port: 9478 }, tmpHome)
      assert.equal(ok, false)
      assert.equal(existsSync(`${tmpHome}/.nanocode/session-locks/sess-i.lock`), true)
    })

    it('returns false when no lock exists', () => {
      const ok = releaseSessionLock('sess-j', { pid: 1000, port: 9477 }, tmpHome)
      assert.equal(ok, false)
    })
  })

  describe('getLockHolder', () => {
    it('returns null when no lock exists', () => {
      assert.equal(getLockHolder('sess-k', tmpHome), null)
    })

    it('returns the holder when a live process holds the lock', () => {
      acquireSessionLock('sess-l', { pid: process.pid, port: 9477 }, tmpHome)
      const holder = getLockHolder('sess-l', tmpHome)
      assert.ok(holder)
      assert.equal(holder.pid, process.pid)
      assert.equal(holder.port, 9477)
    })

    it('returns null and cleans up a stale lock', () => {
      acquireSessionLock('sess-m', { pid: 999_999, port: 9477 }, tmpHome)
      const holder = getLockHolder('sess-m', tmpHome)
      assert.equal(holder, null)
      assert.equal(existsSync(`${tmpHome}/.nanocode/session-locks/sess-m.lock`), false)
    })
  })

  describe('isLockHeldByOther', () => {
    it('returns null when no lock exists', () => {
      const result = isLockHeldByOther('sess-n', { pid: 1000, port: 9477 }, tmpHome)
      assert.equal(result, null)
    })

    it('returns null when we hold the lock', () => {
      acquireSessionLock('sess-o', { pid: 1000, port: 9477 }, tmpHome)
      const result = isLockHeldByOther('sess-o', { pid: 1000, port: 9477 }, tmpHome)
      assert.equal(result, null)
    })

    it('returns the holder when another live process holds the lock', () => {
      acquireSessionLock('sess-p', { pid: process.pid, port: 9477 }, tmpHome)
      const result = isLockHeldByOther('sess-p', { pid: process.pid, port: 9478 }, tmpHome)
      assert.ok(result)
      assert.equal(result.pid, process.pid)
      assert.equal(result.port, 9477)
    })

    it('returns null when the lock is stale', () => {
      acquireSessionLock('sess-q', { pid: 999_999, port: 9477 }, tmpHome)
      const result = isLockHeldByOther('sess-q', { pid: process.pid, port: 9478 }, tmpHome)
      assert.equal(result, null)
    })
  })

  describe('acquire → release → acquire cycle', () => {
    it('allows a new process to acquire after the old one releases', () => {
      acquireSessionLock('sess-r', { pid: 1000, port: 9477 }, tmpHome)
      releaseSessionLock('sess-r', { pid: 1000, port: 9477 }, tmpHome)
      const result = acquireSessionLock('sess-r', { pid: 2000, port: 9478 }, tmpHome)
      assert.equal(result.acquired, true)
    })

    it('supports two servers with different sessions (no conflict)', () => {
      const a = acquireSessionLock('sess-s1', { pid: 1000, port: 9477 }, tmpHome)
      const b = acquireSessionLock('sess-s2', { pid: 2000, port: 9478 }, tmpHome)
      assert.equal(a.acquired, true)
      assert.equal(b.acquired, true)
    })
  })
})
