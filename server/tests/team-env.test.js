/**
 * Tests for the dual-team env helpers (terminal/team-env.js).
 *
 * These are pure, side-effect-free functions so they can be tested without an
 * Express app or a real filesystem.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTeamEnv, readActiveTeam, wrapSpawnWithTeamEnv, TEAM_KEYS, TEAM_DIRS } from '../../terminal/team-env.js'

describe('team-env', () => {
  describe('resolveTeamEnv', () => {
    it('returns null for the default team (team1) — no override needed', () => {
      assert.equal(resolveTeamEnv('team1'), null)
    })

    it('returns CLAUDE_CONFIG_DIR pointing at the team2 config dir', () => {
      const env = resolveTeamEnv('team2')
      assert.ok(env)
      assert.ok(env.CLAUDE_CONFIG_DIR.endsWith('.claude-team2'))
    })

    it('returns null when no team is set', () => {
      assert.equal(resolveTeamEnv(null), null)
      assert.equal(resolveTeamEnv(undefined), null)
      assert.equal(resolveTeamEnv(''), null)
    })

    it('returns null for an unknown team key', () => {
      assert.equal(resolveTeamEnv('team3'), null)
      assert.equal(resolveTeamEnv('evil/../etc'), null)
    })

    it('never includes credentials — only the config dir path', () => {
      const env = resolveTeamEnv('team2')
      assert.deepEqual(Object.keys(env), ['CLAUDE_CONFIG_DIR'])
    })
  })

  describe('readActiveTeam', () => {
    it('reads the persisted active team', () => {
      const store = { getSetting: (k) => (k === 'nanocode_active_team' ? 'team2' : null) }
      assert.equal(readActiveTeam(store), 'team2')
    })

    it('falls back to team1 when unset', () => {
      const store = { getSetting: () => null }
      assert.equal(readActiveTeam(store), 'team1')
    })

    it('falls back to team1 for an invalid persisted value', () => {
      const store = { getSetting: () => 'bogus' }
      assert.equal(readActiveTeam(store), 'team1')
    })

    it('handles a store without getSetting', () => {
      assert.equal(readActiveTeam({}), 'team1')
      assert.equal(readActiveTeam(undefined), 'team1')
    })
  })

  describe('constants', () => {
    it('TEAM_KEYS is exactly team1 and team2', () => {
      assert.deepEqual(TEAM_KEYS, ['team1', 'team2'])
    })

    it('TEAM_DIRS maps both keys to distinct dirs', () => {
      assert.ok(TEAM_DIRS.team1.endsWith('.claude'))
      assert.ok(TEAM_DIRS.team2.endsWith('.claude-team2'))
      assert.notEqual(TEAM_DIRS.team1, TEAM_DIRS.team2)
    })
  })

  describe('wrapSpawnWithTeamEnv', () => {
    it('injects CLAUDE_CONFIG_DIR when team2 is active', () => {
      const store = { getSetting: (k) => (k === 'nanocode_active_team' ? 'team2' : null) }
      const calls = []
      const wrapped = wrapSpawnWithTeamEnv(store, (opts) => { calls.push(opts); return { pid: 1 } })
      wrapped({ command: 'claude', args: [], env: { PATH: '/bin' } })
      assert.equal(calls.length, 1)
      assert.ok(calls[0].env.CLAUDE_CONFIG_DIR.endsWith('.claude-team2'))
      // existing env keys preserved
      assert.equal(calls[0].env.PATH, '/bin')
    })

    it('does not mutate env when team1 (default) is active', () => {
      const store = { getSetting: (k) => (k === 'nanocode_active_team' ? 'team1' : null) }
      const calls = []
      const wrapped = wrapSpawnWithTeamEnv(store, (opts) => { calls.push(opts); return {} })
      wrapped({ command: 'claude', args: [], env: { PATH: '/bin' } })
      assert.deepEqual(calls[0].env, { PATH: '/bin' })
    })

    it('does not mutate env when no team is set', () => {
      const store = { getSetting: () => null }
      const calls = []
      const wrapped = wrapSpawnWithTeamEnv(store, (opts) => { calls.push(opts); return {} })
      wrapped({ command: 'claude', args: [], env: { PATH: '/bin' } })
      assert.deepEqual(calls[0].env, { PATH: '/bin' })
    })

    it('falls back to process.env when opts.env is undefined', () => {
      const store = { getSetting: (k) => (k === 'nanocode_active_team' ? 'team2' : null) }
      const calls = []
      const wrapped = wrapSpawnWithTeamEnv(store, (opts) => { calls.push(opts); return {} })
      wrapped({ command: 'claude', args: [] })
      assert.ok(calls[0].env.CLAUDE_CONFIG_DIR.endsWith('.claude-team2'))
    })

    it('delegates to the base spawn and returns its result', () => {
      const store = { getSetting: () => 'team1' }
      const sentinel = { pid: 4242 }
      const wrapped = wrapSpawnWithTeamEnv(store, () => sentinel)
      assert.equal(wrapped({ command: 'claude', args: [] }), sentinel)
    })
  })
})
