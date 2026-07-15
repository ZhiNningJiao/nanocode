/**
 * Tests for the unified personal-config loader + MES-13824 permission-gated
 * plugin injection (terminal/personal-config.js).
 *
 * Covers:
 *   - loadPersonalConfig: remote.machines loading (present / absent / invalid
 *     entries dropped) on top of the existing aigw/linear/claude/ntfy fields.
 *   - maskSecret: first4 + … + last4, short secrets collapse to ••••.
 *   - projectForPlugin: the frontend-safe MASKED projection — only fields the
 *     plugin's manifest permissions allow; secrets replaced by hasKey + masked
 *     form; remote sshPassword stripped.
 *   - resolvePluginSecrets: the SERVER-SIDE real secret values — only fields
 *     the manifest allows; never meant to be serialized to the browser.
 *   - Example plugin end-to-end: a plugin manifest declaring 'personal.linear'
 *     really gets the linear key (masked in the projection, real in secrets),
 *     and a plugin WITHOUT the permission gets nothing.
 *   - Secrets never appear in the frontend projection JSON (plaintext leak
 *     guard for DOM/logs).
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadPersonalConfig,
  resetPersonalConfigCache,
  projectForPlugin,
  resolvePluginSecrets,
  maskSecret,
  PERSONAL_CONFIG_PERMISSIONS,
} from '../../terminal/personal-config.js'

function fakeHome() {
  return mkdtempSync(join(tmpdir(), 'nano-pcfg-'))
}

function writePersonal(home, obj) {
  mkdirSync(join(home, '.config', 'nanocode'), { recursive: true })
  writeFileSync(join(home, '.config', 'nanocode', 'personal.json'), JSON.stringify(obj))
}

describe('personal-config: remote.machines loading', () => {
  let tmp
  beforeEach(() => { tmp = fakeHome(); resetPersonalConfigCache() })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  it('is null when not declared (backward compatible)', () => {
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.remote.machines, null)
  })

  it('loads valid ssh dev machines raw (alias+host+user kept; full sanitization is at merge)', () => {
    writePersonal(tmp, {
      remote: {
        machines: [
          { alias: 'win-212', type: 'ssh', host: '172.30.20.212', user: 'Administrator', port: 22, key: '~/.ssh/id_cluster', note: 'win dev box' },
          { alias: 'dev-box', type: 'ssh', host: '10.18.8.55', user: 'zhining', port: 22, key: '~/.ssh/id_cluster' },
        ],
      },
    })
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.remote.machines.length, 2)
    assert.equal(cfg.remote.machines[0].alias, 'win-212')
    assert.equal(cfg.remote.machines[0].host, '172.30.20.212')
    assert.equal(cfg.remote.machines[0].user, 'Administrator')
    assert.equal(cfg.remote.machines[0].key, '~/.ssh/id_cluster')
    assert.equal(cfg.remote.machines[1].host, '10.18.8.55')
  })

  it('drops entries missing alias/host/user', () => {
    writePersonal(tmp, {
      remote: {
        machines: [
          { alias: 'ok', host: '1.2.3.4', user: 'r' },
          { alias: '', host: '1.2.3.4', user: 'r' },          // empty alias
          { alias: 'x', host: '', user: 'r' },                // empty host
          { alias: 'x', host: '1.2.3.4' },                     // empty user
          'not-an-object',
          null,
        ],
      },
    })
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.remote.machines.length, 1)
    assert.equal(cfg.remote.machines[0].alias, 'ok')
  })

  it('falls back to null when remote.machines is an empty array', () => {
    writePersonal(tmp, { remote: { machines: [] } })
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.remote.machines, null)
  })

  it('survives a non-array remote.machines (treats as null, never throws)', () => {
    writePersonal(tmp, { remote: { machines: 'not-an-array' } })
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.remote.machines, null)
  })

  it('linear.apiKey still falls back to ~/.config/linear-api.key when no personal.json', () => {
    mkdirSync(join(tmp, '.config'), { recursive: true })
    writeFileSync(join(tmp, '.config', 'linear-api.key'), 'lin_scattered\n')
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.linear.apiKey, 'lin_scattered')
  })
})

describe('personal-config: maskSecret', () => {
  it('keeps first4 + … + last4 for long secrets', () => {
    assert.equal(maskSecret('lin_SUPERSECRET_value_7f3a'), 'lin_…7f3a')
  })
  it('collapses short secrets to ••••', () => {
    assert.equal(maskSecret('short'), '••••')
    assert.equal(maskSecret('12345678'), '••••')
  })
  it('returns empty string for empty/non-string', () => {
    assert.equal(maskSecret(''), '')
    assert.equal(maskSecret(null), '')
    assert.equal(maskSecret(undefined), '')
  })
})

describe('personal-config: projectForPlugin (masked, frontend-safe)', () => {
  let tmp, cfg
  beforeEach(() => {
    tmp = fakeHome(); resetPersonalConfigCache()
    writePersonal(tmp, {
      linear: { apiKey: 'lin_SUPERSECRET_value_7f3a' },
      aigw: { base: 'https://aigw.test', key: 'aigw_SUPERSECRET_k3y9', budgetUsd: 500 },
      remote: {
        machines: [
          { alias: 'win-212', type: 'ssh', host: '172.30.20.212', user: 'Administrator', port: 22, key: '~/.ssh/id_cluster', note: 'win' },
          { alias: 'pw-box', type: 'ssh', host: '10.0.0.9', user: 'root', port: 22, sshPassword: 'pw_SUPERSECRET_99' },
        ],
      },
      ntfy: { url: 'http://ntfy.test/topic' },
    })
    cfg = loadPersonalConfig({ home: tmp })
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  it('returns {} for a plugin with no personal.* permissions', () => {
    const proj = projectForPlugin(cfg, { name: 'plain', permissions: ['fs.read'] })
    assert.deepEqual(proj, {})
  })

  it('returns {} for a manifest with no permissions field at all', () => {
    const proj = projectForPlugin(cfg, { name: 'bare' })
    assert.deepEqual(proj, {})
  })

  it('masks the linear key + exposes hasKey (never plaintext) for personal.linear', () => {
    const proj = projectForPlugin(cfg, { name: 'linear-helper', permissions: ['personal.linear'] })
    assert.equal(proj.linear.hasKey, true)
    assert.equal(proj.linear.apiKeyMasked, 'lin_…7f3a')
    const json = JSON.stringify(proj)
    assert.ok(!json.includes('SUPERSECRET'), 'projection must not contain the plaintext secret')
    assert.ok(!json.includes('lin_SUPERSECRET_value_7f3a'), 'projection must not contain the full key')
  })

  it('masks the aigw key + exposes base/budget (non-secret) for personal.aigw', () => {
    const proj = projectForPlugin(cfg, { name: 'usage', permissions: ['fs.read', 'network', 'personal.aigw'] })
    assert.equal(proj.aigw.base, 'https://aigw.test')
    assert.equal(proj.aigw.budgetUsd, 500)
    assert.equal(proj.aigw.hasKey, true)
    assert.equal(proj.aigw.keyMasked, 'aigw…k3y9')
    const json = JSON.stringify(proj)
    assert.ok(!json.includes('aigw_SUPERSECRET_k3y9'))
  })

  it('projects remote machines WITHOUT sshPassword (key path only) for personal.remote', () => {
    const proj = projectForPlugin(cfg, { name: 'remote', permissions: ['network', 'personal.remote'] })
    assert.equal(proj.remote.machines.length, 2)
    const win = proj.remote.machines.find((m) => m.alias === 'win-212')
    assert.equal(win.host, '172.30.20.212')
    assert.equal(win.user, 'Administrator')
    assert.equal(win.keyPath, '~/.ssh/id_cluster')
    assert.equal(win.personal, true)
    assert.equal(win.readOnly, true)
    assert.equal(win.id, 'personal:win-212')
    // sshPassword must NEVER be in the frontend projection
    assert.equal(win.sshPassword, undefined)
    const pw = proj.remote.machines.find((m) => m.alias === 'pw-box')
    assert.equal(pw.sshPassword, undefined, 'sshPassword must be stripped even when declared')
    const json = JSON.stringify(proj)
    assert.ok(!json.includes('pw_SUPERSECRET_99'), 'projection must not contain the ssh password')
  })

  it('exposes claude teams + ntfy url for the matching permissions', () => {
    const cfg2 = (() => {
      writePersonal(tmp, {
        claude: { teams: [{ name: 'Team1', configDir: '/tmp/.claude' }] },
        ntfy: { url: 'http://ntfy.test/t' },
      })
      resetPersonalConfigCache()
      return loadPersonalConfig({ home: tmp })
    })()
    const proj = projectForPlugin(cfg2, { name: 'x', permissions: ['personal.claude', 'personal.ntfy'] })
    assert.equal(proj.claude.teams.length, 1)
    assert.equal(proj.ntfy.url, 'http://ntfy.test/t')
  })
})

describe('personal-config: resolvePluginSecrets (server-side real values)', () => {
  let tmp, cfg
  beforeEach(() => {
    tmp = fakeHome(); resetPersonalConfigCache()
    writePersonal(tmp, {
      linear: { apiKey: 'lin_REAL_key_1234' },
      aigw: { base: 'https://aigw.test', key: 'aigw_REAL_key_9999', budgetUsd: 500 },
      remote: {
        machines: [
          { alias: 'win-212', type: 'ssh', host: '172.30.20.212', user: 'Administrator', key: '~/.ssh/id_cluster' },
          { alias: 'pw-box', type: 'ssh', host: '10.0.0.9', user: 'root', sshPassword: 'pw_REAL_secret' },
        ],
      },
    })
    cfg = loadPersonalConfig({ home: tmp })
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  it('returns the real linear apiKey for a plugin with personal.linear', () => {
    const secrets = resolvePluginSecrets(cfg, { name: 'linear-helper', permissions: ['personal.linear'] })
    assert.equal(secrets.linear.apiKey, 'lin_REAL_key_1234')
  })

  it('returns the real aigw key for personal.aigw', () => {
    const secrets = resolvePluginSecrets(cfg, { name: 'usage', permissions: ['personal.aigw'] })
    assert.equal(secrets.aigw.key, 'aigw_REAL_key_9999')
  })

  it('surfaces remote sshPassword (server-side only) for personal.remote', () => {
    const secrets = resolvePluginSecrets(cfg, { name: 'remote', permissions: ['personal.remote'] })
    assert.ok(secrets.remote, 'remote secrets should be present when a machine has a password')
    assert.equal(secrets.remote.machines.length, 1)
    assert.equal(secrets.remote.machines[0].alias, 'pw-box')
    assert.equal(secrets.remote.machines[0].sshPassword, 'pw_REAL_secret')
    // key-path-only machines are NOT listed (no secret to surface)
    assert.ok(!secrets.remote.machines.some((m) => m.alias === 'win-212'))
  })

  it('returns {} for a plugin with no personal.* permissions', () => {
    const secrets = resolvePluginSecrets(cfg, { name: 'plain', permissions: ['fs.read', 'network'] })
    assert.deepEqual(secrets, {})
  })

  it('returns {} (no remote) when personal machines use key auth only', () => {
    const cfg2 = (() => {
      writePersonal(tmp, {
        remote: { machines: [{ alias: 'win-212', type: 'ssh', host: '172.30.20.212', user: 'Administrator', key: '~/.ssh/id_cluster' }] },
      })
      resetPersonalConfigCache()
      return loadPersonalConfig({ home: tmp })
    })()
    const secrets = resolvePluginSecrets(cfg2, { name: 'remote', permissions: ['personal.remote'] })
    assert.deepEqual(secrets, {})
  })
})

describe('personal-config: example linear plugin end-to-end (MES-13824 验收)', () => {
  let tmp
  beforeEach(() => { tmp = fakeHome(); resetPersonalConfigCache() })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  it('an example plugin declaring personal.linear really gets the linear key (masked for display, real for server-side use)', () => {
    // A personal config holding a realistic-looking linear key.
    writePersonal(tmp, { linear: { apiKey: 'lin_demo_5f3a9c7e2b8d4a1f' } })
    const cfg = loadPersonalConfig({ home: tmp })

    // The example plugin manifest declares the linear permission.
    const examplePlugin = {
      name: 'linear-example',
      version: '1.0.0',
      apiVersion: '1.0',
      group: 'work',
      tab: { id: 'linear-example', labelKey: 'plugin.linear.label' },
      permissions: ['personal.linear'],
    }

    // Frontend-safe projection: masked, no plaintext.
    const proj = projectForPlugin(cfg, examplePlugin)
    assert.equal(proj.linear.hasKey, true)
    assert.equal(proj.linear.apiKeyMasked, 'lin_…4a1f')
    const projJson = JSON.stringify(proj)
    assert.ok(!projJson.includes('lin_demo_5f3a9c7e2b8d4a1f'), 'frontend projection must never carry plaintext')
    assert.ok(projJson.includes('lin_…4a1f'), 'masked form should be present for display')

    // Server-side secrets: the real key, available for the plugin to call Linear.
    const secrets = resolvePluginSecrets(cfg, examplePlugin)
    assert.equal(secrets.linear.apiKey, 'lin_demo_5f3a9c7e2b8d4a1f')
  })

  it('a plugin WITHOUT personal.linear gets nothing — the permission gate', () => {
    writePersonal(tmp, { linear: { apiKey: 'lin_demo_5f3a9c7e2b8d4a1f' } })
    const cfg = loadPersonalConfig({ home: tmp })
    const noPermPlugin = { name: 'other', permissions: ['fs.read', 'network'] }
    assert.deepEqual(projectForPlugin(cfg, noPermPlugin), {})
    assert.deepEqual(resolvePluginSecrets(cfg, noPermPlugin), {})
  })
})

describe('personal-config: PERSONAL_CONFIG_PERMISSIONS mapping', () => {
  it('declares the six personal.* permission tokens', () => {
    const keys = Object.keys(PERSONAL_CONFIG_PERMISSIONS).sort()
    assert.deepEqual(keys, ['personal.aigw', 'personal.akari', 'personal.claude', 'personal.linear', 'personal.ntfy', 'personal.remote'])
  })
})

describe('personal-config: akari server/lens URLs (MES-14049)', () => {
  let tmp
  beforeEach(() => { tmp = fakeHome(); resetPersonalConfigCache() })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); resetPersonalConfigCache() })

  it('defaults to the documented internal akari server + lens URLs when not declared', () => {
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.akari.serverUrl, 'http://10.18.8.55:9481')
    assert.equal(cfg.akari.lensUrl, 'http://10.18.8.55:9482')
  })

  it('loads akari.serverUrl + akari.lensUrl from the personal file', () => {
    writePersonal(tmp, { akari: { serverUrl: 'http://1.2.3.4:9999/', lensUrl: 'http://1.2.3.4:8080' } })
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.akari.serverUrl, 'http://1.2.3.4:9999/')
    assert.equal(cfg.akari.lensUrl, 'http://1.2.3.4:8080')
  })

  it('ignores non-string / empty akari fields and falls back to the default', () => {
    writePersonal(tmp, { akari: { serverUrl: '', lensUrl: 123 } })
    const cfg = loadPersonalConfig({ home: tmp })
    assert.equal(cfg.akari.serverUrl, 'http://10.18.8.55:9481')
    assert.equal(cfg.akari.lensUrl, 'http://10.18.8.55:9482')
  })

  it('projects akari serverUrl + lensUrl IN FULL for personal.akari (not secrets)', () => {
    writePersonal(tmp, { akari: { serverUrl: 'http://akari.test:9481', lensUrl: 'http://akari.test:9482' } })
    const cfg = loadPersonalConfig({ home: tmp })
    const proj = projectForPlugin(cfg, { name: 'akari', permissions: ['network', 'personal.akari'] })
    assert.equal(proj.akari.serverUrl, 'http://akari.test:9481')
    assert.equal(proj.akari.lensUrl, 'http://akari.test:9482')
  })

  it('returns {} (no akari) for a plugin without personal.akari', () => {
    writePersonal(tmp, { akari: { serverUrl: 'http://akari.test:9481', lensUrl: 'http://akari.test:9482' } })
    const cfg = loadPersonalConfig({ home: tmp })
    const proj = projectForPlugin(cfg, { name: 'other', permissions: ['network'] })
    assert.deepEqual(proj, {})
  })

  it('resolvePluginSecrets has no akari secrets (URLs are not secrets)', () => {
    writePersonal(tmp, { akari: { serverUrl: 'http://akari.test:9481', lensUrl: 'http://akari.test:9482' } })
    const cfg = loadPersonalConfig({ home: tmp })
    const secrets = resolvePluginSecrets(cfg, { name: 'akari', permissions: ['personal.akari'] })
    assert.deepEqual(secrets, {})
  })
})
