/**
 * Tests for the JSON file store.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'

describe('store', () => {
  let store

  beforeEach(() => {
    store = createStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('creates and fetches projects', () => {
    const project = store.createProject('Alpha', '/tmp/alpha')
    assert.ok(project.id)
    assert.equal(project.name, 'Alpha')
    assert.equal(project.cwd, '/tmp/alpha')
    assert.deepEqual(store.getProject(project.id), project)
  })

  it('lists projects in creation order', () => {
    store.createProject('One', '/tmp/one')
    store.createProject('Two', '/tmp/two')
    store.createProject('Three', '/tmp/three')

    const projects = store.listProjects()
    assert.equal(projects.length, 3)
    assert.equal(projects[0].name, 'One')
    assert.equal(projects[1].name, 'Two')
    assert.equal(projects[2].name, 'Three')
  })

  it('upserts settings and returns the full settings map', () => {
    assert.equal(store.getSetting('theme'), null)

    store.setSetting('theme', 'light')
    store.setSetting('font_size', 14)
    store.setSetting('theme', 'dark')

    assert.equal(store.getSetting('theme'), 'dark')
    assert.deepEqual(store.getAllSettings(), {
      theme: 'dark',
      font_size: 14,
    })
  })

  it('removes a project cleanly', () => {
    const project = store.createProject('Alpha', '/tmp/alpha')
    store.removeProject(project.id)
    assert.equal(store.getProject(project.id), undefined)
    assert.deepEqual(store.listProjects(), [])
  })

  it('creates a remote project with SSH fields', () => {
    const project = store.createProject('Remote', '/home/ubuntu/proj', null, {
      host: '10.0.1.5',
      user: 'ubuntu',
      port: 2222,
      key: '~/.ssh/id_ed25519',
    })
    assert.equal(project.ssh_host, '10.0.1.5')
    assert.equal(project.ssh_user, 'ubuntu')
    assert.equal(project.ssh_port, 2222)
    assert.equal(project.ssh_key, '~/.ssh/id_ed25519')
  })

  it('creates a local project with null SSH fields', () => {
    const project = store.createProject('Local', '/tmp/local')
    assert.equal(project.ssh_host, null)
    assert.equal(project.ssh_user, null)
    assert.equal(project.ssh_port, null)
    assert.equal(project.ssh_key, null)
  })

  it('persists codex thread metadata for codex tabs', () => {
    const project = store.createProject('Codex', '/tmp/codex')
    const tab = store.createTab(project.id, { type: 'codex', label: 'codex 1' })

    assert.equal(tab.codexThreadId, null)

    const updated = store.updateTabMetadata(project.id, tab.id, { codexThreadId: 'thread-123' })
    assert.equal(updated.codexThreadId, 'thread-123')

    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.codexThreadId, 'thread-123')
  })

  it('需求15 item5: persists persona on fable5/opencode tabs + opencodeSessionId', () => {
    const project = store.createProject('Fable', '/tmp/fable')
    // New fable5 tab with a chosen persona + a resumed opencode session id.
    const tab = store.createTab(project.id, { type: 'fable5', label: 'fable 1', persona: 'catgirl', opencodeSessionId: 'ses_xyz' })
    assert.equal(tab.persona, 'catgirl')
    assert.equal(tab.opencodeSessionId, 'ses_xyz')

    // A fable5 tab without a persona must NOT set persona (no empty string leak).
    const bare = store.createTab(project.id, { type: 'fable5', label: 'bare', persona: '   ' })
    assert.equal(bare.persona, undefined)
    assert.equal(bare.opencodeSessionId, null)

    // opencode tab type also persists persona (same branch).
    const oc = store.createTab(project.id, { type: 'opencode', label: 'oc', persona: 'stern' })
    assert.equal(oc.persona, 'stern')

    // Survives a reload (getTab reads persisted state).
    const fetched = store.getTab(project.id, tab.id)
    assert.equal(fetched.persona, 'catgirl')
    assert.equal(fetched.opencodeSessionId, 'ses_xyz')
  })
})
