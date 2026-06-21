/**
 * Server-side plugin host for NanoCode.
 *
 * Core exposes this host to every enabled plugin via `register(host)`.  It is the
 * ONLY surface plugins should touch; Core internals (routes, store direct use,
 * WebSocket broadcast loops) remain private.
 *
 * Extension points:
 *   - Event bus: host.on(event, cb) / host.emit(event, payload)
 *   - Settings:  host.registerSetting(def) / host.getSetting(key) / host.setSetting(key, value)
 *   - Routes:    host.registerRoute(method, path, handler)
 *   - Notify:    host.broadcastNotify(payload)
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGINS_DIR = join(__dirname, '..', 'plugins')

/**
 * Create a plugin host backed by the given Express app and settings store.
 *
 * @param {object} opts
 * @param {import('express').Application} opts.app
 * @param {object} opts.store
 * @param {Function} opts.broadcastNotify  (payload) => void
 * @returns {object} host
 */
export function createPluginHost({ app, store, broadcastNotify }) {
  const emitter = new EventEmitter()
  // Prevent warnings when many plugins listen to the same event.
  emitter.setMaxListeners(50)

  /** @type {Map<string, object>} Registered setting definitions keyed by setting key. */
  const settingDefs = new Map()

  /** @type {Set<string>} Names of successfully loaded plugins. */
  const loaded = new Set()

  function getSetting(key) {
    return store.getSetting(key)
  }

  function setSetting(key, value) {
    store.setSetting(key, value)
  }

  /**
   * Register a setting definition. Core persists values; plugins read/write
   * through getSetting/setSetting.
   */
  function registerSetting(def) {
    if (!def || !def.key) throw new Error('registerSetting: key required')
    settingDefs.set(def.key, {
      type: 'string',
      default: null,
      label: def.key,
      ...def,
    })
  }

  /**
   * Mount an Express route under /api.  The method is lower-cased and the path
   * is normalized to start with /api.
   */
  function registerRoute(method, path, handler) {
    const m = String(method).toLowerCase()
    const p = path.startsWith('/') ? path : `/${path}`
    const fullPath = p.startsWith('/api') ? p : `/api${p}`
    if (!app[m]) throw new Error(`registerRoute: invalid method ${method}`)
    app[m](fullPath, handler)
  }

  function on(event, cb) {
    emitter.on(event, cb)
  }

  function emit(event, payload) {
    emitter.emit(event, payload)
  }

  const host = {
    on,
    emit,
    registerSetting,
    registerRoute,
    getSetting,
    setSetting,
    broadcastNotify,
    getAllSettingDefs: () => Array.from(settingDefs.values()),
    _loaded: loaded,
  }

  return host
}

/**
 * Load enabled plugins from `plugins/<name>/` directories.
 *
 * A plugin is loaded when:
 *   1. `plugins/<name>/plugin.json` exists and is valid JSON.
 *   2. The setting `plugin_<name>_enabled` is truthy.
 *
 * The server entry `plugins/<name>/server.js` is imported dynamically and its
 * exported `register(host)` is called.
 *
 * @param {object} host
 * @param {object} opts
 * @param {string} [opts.pluginsDir]
 * @returns {Promise<string[]>} list of loaded plugin names
 */
export async function loadPlugins(host, { pluginsDir = PLUGINS_DIR } = {}) {
  if (!existsSync(pluginsDir)) return []

  const names = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const name of names) {
    const manifestPath = join(pluginsDir, name, 'plugin.json')
    const serverPath = join(pluginsDir, name, 'server.js')
    if (!existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      console.warn(`[plugin-host] invalid manifest for ${name}:`, err?.message)
      continue
    }

    const enabledKey = `plugin_${name}_enabled`
    const enabled = host.getSetting(enabledKey)
    if (!enabled) {
      console.log(`[plugin-host] plugin ${name} (${manifest.version || '?'}) disabled`)
      continue
    }

    try {
      const mod = await import(serverPath)
      if (typeof mod.register === 'function') {
        mod.register(host)
        host._loaded.add(name)
        console.log(`[plugin-host] loaded plugin ${name} v${manifest.version || '?'} (points: ${(manifest.extensionPoints || []).join(', ') || 'none'})`)
      } else {
        console.warn(`[plugin-host] ${name}/server.js has no register() export`)
      }
    } catch (err) {
      console.warn(`[plugin-host] failed to load ${name}:`, err?.message)
    }
  }

  return Array.from(host._loaded)
}
