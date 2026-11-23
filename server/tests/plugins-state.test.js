/**
 * The one plugin switch: kernel defaults live in the registry (`defaultOn`),
 * the enabled list is stored server-side (`plugins_enabled`), and the server
 * reads it to gate optional background work.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_PLUGINS, PLUGINS_SETTING_KEY, defaultEnabledPlugins } from '../../public/js/plugins-registry.js'
import { enabledPlugins, isPluginEnabled } from '../plugins-state.js'

const storeWith = (v) => ({ getSetting: (k) => (k === PLUGINS_SETTING_KEY ? v : null) })

describe('plugin switch', () => {
  it('fresh install = the kernel set only', () => {
    assert.deepEqual(defaultEnabledPlugins().sort(), [
      'cc-chat', 'cc-quota', 'cc-waiting', 'command-center', 'machines', 'sessions', 'team-model', 'usage',
    ])
    // every other builtin is optional and starts off
    const optional = BUILTIN_PLUGINS.filter((p) => !p.defaultOn).map((p) => p.name).sort()
    assert.deepEqual(optional, [
      'akari', 'compare', 'historian', 'linear-mobile-push', 'memory', 'notify', 'persona',
      'remote', 'rewind', 'services', 'tasks', 'tts',
    ])
  })

  it('server reads the stored list (array or JSON string)', () => {
    assert.equal(isPluginEnabled(storeWith(['machines']), 'machines'), true)
    assert.equal(isPluginEnabled(storeWith('["notify"]'), 'notify'), true)
    assert.equal(isPluginEnabled(storeWith(['usage']), 'machines'), false)
  })

  it('unset / garbage setting = no optional background work', () => {
    assert.equal(enabledPlugins(storeWith(null)).size, 0)
    assert.equal(enabledPlugins(storeWith('{not json')).size, 0)
    assert.equal(enabledPlugins(storeWith({ machines: true })).size, 0)
    assert.equal(isPluginEnabled(null, 'machines'), false)
  })
})
