/**
 * Tests for the dual-team management routes (server/team-manager.js).
 *
 * Covers: team status snapshot, switching the active team, invalid input
 * rejection, and the login-WS path parser. Credentials are asserted to never
 * appear in any payload (only `configured: boolean` is exposed).
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createStore } from '../store.js'
import {
  registerTeamRoutes,
  getTeamStatus,
  isTeamConfigured,
  parseTeamLoginPath,
  isTeamLoginRequest,
} from '../team-manager.js'

function makeApp(store) {
  const app = express()
  app.use(express.json())
  const notify = []
  registerTeamRoutes(app, store, (msg) => notify.push(msg))
  return { app, notify }
}

async function req(app, method, path, body) {
  const server = app.listen(0)
  try {
    const { port } = server.address()
    const opts = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) opts.body = JSON.stringify(body)
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, body: json, text }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

describe('team-manager', () => {
  let store

  beforeEach(() => {
    store = createStore(':memory:')
  })

  describe('GET /api/teams', () => {
    it('returns both teams with configured boolean and a default activeTeam', async () => {
      const { app } = makeApp(store)
      const { status, body } = await req(app, 'GET', '/api/teams')
      assert.equal(status, 200)
      assert.equal(body.activeTeam, 'team1')
      assert.ok(Array.isArray(body.teams))
      assert.equal(body.teams.length, 2)
      assert.ok(body.teams.some((t) => t.key === 'team1'))
      assert.ok(body.teams.some((t) => t.key === 'team2'))
      for (const t of body.teams) {
        assert.equal(typeof t.configured, 'boolean')
        assert.equal(typeof t.active, 'boolean')
        assert.ok(typeof t.configDir === 'string' && t.configDir.length > 0)
      }
      // team1 is active by default
      const t1 = body.teams.find((t) => t.key === 'team1')
      assert.equal(t1.active, true)
    })

    it('never exposes credentials — only configured + path', async () => {
      const { app } = makeApp(store)
      const { body } = await req(app, 'GET', '/api/teams')
      const json = JSON.stringify(body)
      assert.ok(!/credentials|token|secret|password|apiKey/i.test(json),
        'no credential-like field should appear in the team payload')
    })
  })

  describe('POST /api/teams/switch', () => {
    it('sets the active team to team2 and persists it', async () => {
      const { app, notify } = makeApp(store)
      const { status, body } = await req(app, 'POST', '/api/teams/switch', { team: 'team2' })
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.activeTeam, 'team2')
      assert.equal(store.getSetting('nanocode_active_team'), 'team2')
      // team2 now active, team1 not
      assert.equal(body.teams.find((t) => t.key === 'team2').active, true)
      assert.equal(body.teams.find((t) => t.key === 'team1').active, false)
      // a notify broadcast was emitted
      assert.ok(notify.some((m) => m.type === 'plugin:team:update'))
    })

    it('switches back to team1', async () => {
      const { app } = makeApp(store)
      await req(app, 'POST', '/api/teams/switch', { team: 'team2' })
      const { status, body } = await req(app, 'POST', '/api/teams/switch', { team: 'team1' })
      assert.equal(status, 200)
      assert.equal(body.activeTeam, 'team1')
      assert.equal(store.getSetting('nanocode_active_team'), 'team1')
    })

    it('rejects an unknown team key with 400', async () => {
      const { app } = makeApp(store)
      const { status, body } = await req(app, 'POST', '/api/teams/switch', { team: 'team9' })
      assert.equal(status, 400)
      assert.ok(body.error)
      assert.equal(store.getSetting('nanocode_active_team'), null)
    })

    it('rejects a path-injection attempt', async () => {
      const { app } = makeApp(store)
      const { status } = await req(app, 'POST', '/api/teams/switch', { team: '../etc' })
      assert.equal(status, 400)
    })

    it('rejects a missing team', async () => {
      const { app } = makeApp(store)
      const { status } = await req(app, 'POST', '/api/teams/switch', {})
      assert.equal(status, 400)
    })
  })

  describe('getTeamStatus', () => {
    it('reflects the persisted active team', () => {
      store.setSetting('nanocode_active_team', 'team2')
      const status = getTeamStatus(store)
      assert.equal(status.activeTeam, 'team2')
      assert.equal(status.teams.find((t) => t.key === 'team2').active, true)
      assert.equal(status.teams.find((t) => t.key === 'team1').active, false)
    })
  })

  describe('isTeamConfigured', () => {
    it('returns false for a non-existent dir', () => {
      assert.equal(isTeamConfigured('/this/does/not/exist/at-all'), false)
    })

    it('returns false for empty/falsy input', () => {
      assert.equal(isTeamConfigured(''), false)
      assert.equal(isTeamConfigured(null), false)
    })
  })

  describe('parseTeamLoginPath', () => {
    it('parses a valid team1 path', () => {
      assert.equal(parseTeamLoginPath('/ws/team-login/team1'), 'team1')
    })

    it('parses a valid team2 path with trailing slash', () => {
      assert.equal(parseTeamLoginPath('/ws/team-login/team2/'), 'team2')
    })

    it('rejects an unknown team', () => {
      assert.equal(parseTeamLoginPath('/ws/team-login/team9'), null)
    })

    it('rejects path traversal', () => {
      assert.equal(parseTeamLoginPath('/ws/team-login/../etc'), null)
      assert.equal(parseTeamLoginPath('/ws/team-login/'), null)
      assert.equal(parseTeamLoginPath('/ws/other/team1'), null)
    })
  })

  describe('isTeamLoginRequest', () => {
    it('matches the team-login prefix', () => {
      assert.equal(isTeamLoginRequest('/ws/team-login/team1'), true)
      assert.equal(isTeamLoginRequest('/ws/team-login/team2'), true)
    })

    it('does not match other ws paths', () => {
      assert.equal(isTeamLoginRequest('/ws/terminal'), false)
      assert.equal(isTeamLoginRequest('/ws/fleet-term/x'), false)
      assert.equal(isTeamLoginRequest('/api/teams'), false)
    })
  })
})
