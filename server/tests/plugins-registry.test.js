import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLUGIN_API_VERSION,
  BUILTIN_PLUGINS,
  builtinPlugin,
  validateManifest,
} from '../../public/js/plugins-registry.js'

describe('plugins-registry (MES-13740 需求6)', () => {
  it('exposes a core apiVersion', () => {
    assert.equal(typeof PLUGIN_API_VERSION, 'string')
    assert.equal(PLUGIN_API_VERSION, '1.0')
  })

  it('validates every built-in manifest', () => {
    for (const p of BUILTIN_PLUGINS) {
      const v = validateManifest(p)
      assert.ok(v.ok, `${p.name}: ${v.errors.join('; ')}`)
      assert.deepEqual(v.errors, [])
    }
  })

  it('builtinPlugin looks up by name', () => {
    assert.equal(builtinPlugin('team-model').group, 'session')
    assert.equal(builtinPlugin('usage').group, 'ops')
    assert.equal(builtinPlugin('memory').group, 'session')
    assert.equal(builtinPlugin('persona').group, 'session')
    assert.equal(builtinPlugin('nope'), null)
  })

  it('memory plugin (需求7) declares session group + fs permissions', () => {
    const m = builtinPlugin('memory')
    assert.ok(m, 'memory plugin must be registered')
    assert.equal(m.group, 'session')
    assert.equal(m.tab.id, 'memory')
    assert.ok(Array.isArray(m.permissions))
    assert.ok(m.permissions.includes('fs.read'))
    assert.ok(m.permissions.includes('fs.write'))
    const v = validateManifest(m)
    assert.ok(v.ok, `memory manifest invalid: ${v.errors.join('; ')}`)
  })

  it('persona plugin (需求8) declares session group + fs.read only', () => {
    const m = builtinPlugin('persona')
    assert.ok(m, 'persona plugin must be registered')
    assert.equal(m.group, 'session')
    assert.equal(m.tab.id, 'persona')
    assert.equal(m.apiVersion, PLUGIN_API_VERSION)
    assert.ok(Array.isArray(m.permissions))
    assert.ok(m.permissions.includes('fs.read'))
    assert.ok(!m.permissions.includes('fs.write'), 'persona is browse-only — no fs.write')
    const v = validateManifest(m)
    assert.ok(v.ok, `persona manifest invalid: ${v.errors.join('; ')}`)
  })

  it('rejects a non-object manifest', () => {
    const v = validateManifest(null)
    assert.equal(v.ok, false)
    assert.ok(v.errors.length > 0)
  })

  it('rejects an incompatible apiVersion explicitly (never silent)', () => {
    const v = validateManifest({
      name: 'future',
      version: '2.0.0',
      apiVersion: '2.0',
      group: 'session',
      tab: { id: 'future', labelKey: 'x' },
      permissions: [],
    })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some((e) => /incompatible/.test(e) && /2\.0/.test(e) && /1\.0/.test(e)),
      `errors should name both versions: ${v.errors.join('; ')}`)
  })

  it('rejects an unknown group', () => {
    const v = validateManifest({
      name: 'bad', version: '1.0.0', apiVersion: '1.0', group: 'inside', tab: { id: 'bad' },
    })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some((e) => /group/.test(e)))
  })

  it('rejects a manifest missing tab.id', () => {
    const v = validateManifest({
      name: 'bad', version: '1.0.0', apiVersion: '1.0', group: 'ops', tab: {},
    })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some((e) => /tab\.id/.test(e)))
  })

  it('rejects non-array permissions', () => {
    const v = validateManifest({
      name: 'bad', version: '1.0.0', apiVersion: '1.0', group: 'ops',
      tab: { id: 'bad' }, permissions: 'fs.read',
    })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some((e) => /permissions/.test(e)))
  })

  it('rejects non-string permission entries', () => {
    const v = validateManifest({
      name: 'bad', version: '1.0.0', apiVersion: '1.0', group: 'ops',
      tab: { id: 'bad' }, permissions: ['fs.read', 42],
    })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some((e) => /42/.test(e)))
  })

  it('accepts a manifest with no permissions (optional field)', () => {
    const v = validateManifest({
      name: 'ok', version: '1.0.0', apiVersion: '1.0', group: 'artifacts', tab: { id: 'ok' },
    })
    assert.equal(v.ok, true)
  })

  it('built-ins declare permissions as arrays of strings', () => {
    for (const p of BUILTIN_PLUGINS) {
      assert.ok(Array.isArray(p.permissions), `${p.name} permissions must be array`)
      for (const perm of p.permissions) assert.equal(typeof perm, 'string')
    }
  })
})
