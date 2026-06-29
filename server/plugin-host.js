/**
 * Server-side plugin host for NanoCode.
 *
 * Core exposes this host to every enabled plugin via `register(host)`.  It is the
 * ONLY surface plugins should touch; Core internals (routes, store direct use,
 * WebSocket broadcast loops) remain private.
 *
 * Extension points (tiered stability, see NANOCODE_ARCH.md §3):
 *
 *   Tier 1 — Stable Core API (frozen, semver-guaranteed; pre-1.0 not yet frozen):
 *     - Event bus:  host.on(event, cb) / host.emit(event, payload)
 *     - Settings:   host.getSetting(key) / host.setSetting(key, value)
 *     - Lifecycle:  host.registerLifecycle({ onStop })  — cleanup on shutdown/unload
 *     - Status:     host.reportStatus(level, message, { detail, plugin })
 *
 *   Tier 2 — Flexible Extension API (may evolve, versioned):
 *     - Settings def: host.registerSetting(def)
 *     - Routes:       host.registerRoute(method, path, handler)
 *     - Notify:       host.broadcastNotify(payload)
 *     - WebSocket:    host.registerWebSocket(path, handler)  — own a WS upgrade path
 *
 *   Tier 3 — Internal API (not for plugin use):
 *     - host._loaded / host._lifecycle / host._status / host._wsHandlers
 *     - host.getAllSettingDefs / host.getWebSocketHandler / host.getStatus
 *
 * Plugins declare their client-side needs in plugin.json; Core's browser host
 * exposes matching ui.* extension points (see public/js/plugin-host.js).
 *
 * Shutdown: Core calls host.shutdownPlugins() on SIGINT/SIGTERM (and future
 * hot-unload). onStop handlers run in reverse load order; each is awaited and
 * errors are collected without aborting the rest. Mirrors VS Code's
 * Disposable/subscriptions contract and Fastify's onClose hook.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGINS_DIR = join(__dirname, '..', 'plugins')

/**
 * Host API version this build implements. Pre-1.0 means "not yet frozen" — the
 * contract is advisory: incompatible plugins are warned, not refused (see
 * isApiCompatible below). Bump per semver: major=breaking, minor=new points
 * (pre-1.0: minor is the breaking boundary), patch=bugfix. Kept in sync with
 * public/js/plugin-host.js HOST_API_VERSION.
 */
export const HOST_API_VERSION = '0.9'

/**
 * Server-side extension points this host actually exposes (the `host.*`
 * namespace). Used to validate `plugin.json#extensionPoints` declarations so a
 * plugin that claims a non-existent method is warned at load time instead of
 * failing silently. `ui.*` points belong to the browser host and are validated
 * client-side (see public/js/plugin-host.js CLIENT_HOST_POINTS).
 */
const SERVER_HOST_POINTS = new Set([
  'host.on',
  'host.emit',
  'host.registerSetting',
  'host.getSetting',
  'host.setSetting',
  'host.registerRoute',
  'host.registerWebSocket',
  'host.registerLifecycle',
  'host.reportStatus',
  'host.broadcastNotify',
])

/**
 * Parse a loose semver string ("0.9", "0.9.1", "1.0") into parts. Returns null
 * for unversioned/legacy (missing or non-numeric) values.
 */
export function parseSemver(v) {
  if (!v || typeof v !== 'string') return null
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0 }
}

/**
 * Decide whether a plugin's declared apiVersion is compatible with the host's
 * HOST_API_VERSION, per the semver rules in NANOCODE_ARCH.md §5.3:
 *   - major mismatch  => incompatible (breaking change)
 *   - pre-1.0 (0.x)   => minor mismatch is incompatible (0.minor is breaking)
 *   - 1.x+            => minor/patch differences are compatible (additive)
 *   - missing/invalid => incompatible (unversioned/legacy)
 *
 * Returns { compatible: boolean, reason: string }.
 */
export function isApiCompatible(pluginVersion, hostVersion) {
  const p = parseSemver(pluginVersion)
  const h = parseSemver(hostVersion)
  if (!p) return { compatible: false, reason: 'unversioned/legacy manifest (no apiVersion)' }
  if (!h) return { compatible: true, reason: '' }
  if (p.major !== h.major) {
    return { compatible: false, reason: `major mismatch (plugin ${pluginVersion} vs host ${hostVersion})` }
  }
  if (h.major === 0 && p.minor !== h.minor) {
    return { compatible: false, reason: `pre-1.0 minor mismatch (plugin ${pluginVersion} vs host ${hostVersion})` }
  }
  return { compatible: true, reason: '' }
}

/**
 * Validate a plugin manifest against this host: apiVersion compatibility and
 * extensionPoints declarations vs the host's actual exposed methods. This
 * version is advisory only (pre-1.0, internal) — mismatches produce a
 * console.warn, never a load refusal. Returns void.
 */
export function validatePluginManifest(name, manifest) {
  const apiVersion = manifest && manifest.apiVersion
  const { compatible, reason } = isApiCompatible(apiVersion, HOST_API_VERSION)
  if (!compatible) {
    console.warn(
      `[plugin-host] ${name}: API version incompatibility — ${reason}. ` +
        `Host is ${HOST_API_VERSION}. Loading anyway (pre-1.0 advisory).`,
    )
  }

  const points = Array.isArray(manifest && manifest.extensionPoints) ? manifest.extensionPoints : []
  for (const point of points) {
    if (typeof point !== 'string') continue
    // Only validate the host.* namespace (server-side). ui.* points belong to
    // the browser host and are validated client-side.
    if (point.startsWith('host.')) {
      if (!SERVER_HOST_POINTS.has(point)) {
        console.warn(
          `[plugin-host] ${name}: declares unknown extension point "${point}" ` +
            `(not exposed by server host). Known: ${[...SERVER_HOST_POINTS].join(', ')}`,
        )
      }
    }
  }
}

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

  /** @type {Map<string, function>} WebSocket handlers registered by plugins. */
  const wsHandlers = new Map()

  /**
   * Lifecycle cleanup handlers, in registration order. Each entry is
   * { plugin, onStop }. shutdownPlugins() runs them in REVERSE order so the
   * last-loaded plugin tears down first (mirrors stack/RAII unwinding and
   * Fastify onClose registration order).
   */
  const lifecycle = []

  /**
   * Latest reported status per plugin: { level, message, detail, time }.
   * level is one of 'ok' | 'warn' | 'error' | 'info'.
   */
  const status = new Map()

  let currentPlugin = null

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

  /**
   * Register a WebSocket upgrade handler for a plugin-owned path.
   * Core checks these paths in the HTTP upgrade handler before its own WS endpoints.
   *
   * @param {string} path  exact path or prefix (e.g. '/ws/fleet-term')
   * @param {function} handler  (ws, req) => void
   */
  function registerWebSocket(path, handler) {
    if (!path || typeof handler !== 'function') {
      throw new Error('registerWebSocket: path and handler required')
    }
    wsHandlers.set(path, handler)
  }

  function getWebSocketHandler(pathname) {
    for (const [prefix, handler] of wsHandlers) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        return { prefix, handler }
      }
    }
    return null
  }

  /**
   * Register a lifecycle hook for the plugin currently being loaded (or, if
   * called outside load, the most recently loaded plugin). Currently only
   * onStop is supported: an async or sync function called with no args during
   * shutdownPlugins(). Returning a rejected promise / throwing is caught and
   * logged but does not abort the shutdown of remaining plugins.
   *
   * This is the server-side Disposable equivalent: plugins should clear
   * timers, close PTYs/sockets, and release file handles here.
   */
  function registerLifecycle({ onStop } = {}) {
    const plugin = currentPlugin || host._currentPlugin || '<anonymous>'
    if (typeof onStop !== 'function') {
      console.warn(`[plugin-host] ${plugin}: registerLifecycle called without onStop`)
      return
    }
    lifecycle.push({ plugin, onStop })
  }

  /**
   * Report plugin health. Core surfaces this to the UI so operators can see
   * whether a loaded plugin is healthy, degraded, or failing without grepping
   * server logs. The latest report per plugin wins.
   *
   * @param {'ok'|'warn'|'error'|'info'} level
   * @param {string} message
   * @param {object} [extra]  { detail, plugin }  plugin defaults to currentPlugin
   */
  function reportStatus(level, message, extra = {}) {
    const valid = ['ok', 'warn', 'error', 'info']
    const lvl = valid.includes(level) ? level : 'info'
    const plugin = extra.plugin || currentPlugin || host._currentPlugin || '<anonymous>'
    status.set(plugin, {
      level: lvl,
      message: String(message),
      detail: extra.detail != null ? extra.detail : null,
      time: Date.now(),
    })
    // Emit so live UIs (health panel) can refresh without polling.
    emitter.emit('plugin:status', { plugin, level: lvl, message, detail: extra.detail })
  }

  function getStatus() {
    return Array.from(status.entries()).map(([plugin, s]) => ({ plugin, ...s }))
  }

  const host = {
    on,
    emit,
    registerSetting,
    registerRoute,
    registerWebSocket,
    registerLifecycle,
    reportStatus,
    getSetting,
    setSetting,
    broadcastNotify,
    getAllSettingDefs: () => Array.from(settingDefs.values()),
    getWebSocketHandler,
    getStatus,
    _loaded: loaded,
    _wsHandlers: wsHandlers,
    _lifecycle: lifecycle,
    _status: status,
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

  // First pass: read manifests + resolve enabled state, so dependency
  // ordering can be validated before any plugin is imported.
  const candidates = []
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
    let enabled = host.getSetting(enabledKey)
    // First time a plugin with enabledByDefault:true is seen, opt it in and
    // persist the choice so it behaves consistently on subsequent restarts.
    if (enabled == null && manifest.enabledByDefault) {
      host.setSetting(enabledKey, true)
      enabled = true
    }
    if (!enabled) {
      console.log(`[plugin-host] plugin ${name} (${manifest.version || '?'}) disabled`)
      continue
    }
    // Advisory manifest validation (pre-1.0): warn on apiVersion mismatch and
    // phantom extensionPoint declarations. Does not refuse the load.
    validatePluginManifest(name, manifest)
    candidates.push({ name, manifest, serverPath })
  }

  // Dependency validation: a plugin may declare `dependencies` (array of
  // plugin names) in its manifest. If a dependency is not in the enabled
  // candidate set (disabled or missing), the dependent plugin is skipped with
  // a warning rather than crashing at import time. Matches Fastify/VS Code
  // soft-fail behavior for missing deps.
  const enabledNames = new Set(candidates.map((c) => c.name))
  const skipDeps = new Set()
  for (const { name, manifest } of candidates) {
    const deps = manifest.dependencies
    if (!Array.isArray(deps) || deps.length === 0) continue
    const missing = deps.filter((d) => !enabledNames.has(d))
    if (missing.length > 0) {
      console.warn(
        `[plugin-host] ${name} skipped: missing dependency ${missing.join(', ')}`,
      )
      skipDeps.add(name)
    }
  }
  const loadList = candidates.filter((c) => !skipDeps.has(c.name))

  for (const { name, manifest, serverPath } of loadList) {
    try {
      host._currentPlugin = name
      const mod = await import(serverPath)
      if (typeof mod.register === 'function') {
        await mod.register(host)
        host._loaded.add(name)
        console.log(`[plugin-host] loaded plugin ${name} v${manifest.version || '?'} api${manifest.apiVersion || '?'} (points: ${(manifest.extensionPoints || []).join(', ') || 'none'})`)
      } else {
        console.warn(`[plugin-host] ${name}/server.js has no register() export`)
      }
    } catch (err) {
      console.warn(`[plugin-host] failed to load ${name}:`, err?.message)
      host.reportStatus?.('error', `failed to load: ${err?.message || err}`, { plugin: name })
    } finally {
      host._currentPlugin = null
    }
  }

  return Array.from(host._loaded)
}

/**
 * Run every registered onStop lifecycle hook, in REVERSE registration order
 * (last-loaded plugin tears down first). Each hook is awaited individually;
 * if one rejects, the error is logged but shutdown continues so a single
 * misbehaving plugin cannot block process exit or leak the others' resources.
 *
 * Also emits a 'shutdown' event on the host bus before tearing down, so legacy
 * plugins that listen for it (rather than registerLifecycle) still get a
 * chance to clean up. Returns the list of plugins that errored.
 *
 * @param {object} host
 * @returns {Promise<string[]>} names of plugins whose onStop threw
 */
export async function shutdownPlugins(host) {
  const errored = []
  host.emit('shutdown')

  const hooks = (host._lifecycle || []).slice().reverse()
  for (const { plugin, onStop } of hooks) {
    try {
      await onStop()
    } catch (err) {
      errored.push(plugin)
      console.warn(`[plugin-host] ${plugin} onStop error:`, err?.message || err)
    }
  }
  host._lifecycle.length = 0
  return errored
}

/**
 * Discover all plugins under `plugins/<name>/plugin.json` without loading them.
 *
 * Returns metadata plus the current enabled state from settings (or the
 * manifest's enabledByDefault when the setting has never been persisted), the
 * declared apiVersion + extensionPoints (for the management UI), and the latest
 * health status (from reportStatus) when the host exposes getStatus().
 *
 * @param {object} host
 * @param {object} opts
 * @param {string} [opts.pluginsDir]
 * @returns {Promise<Array<{name:string, version:string, apiVersion:string, description:string, enabledByDefault:boolean, enabled:boolean, extensionPoints:string[], status:object|null}>>}
 */
export async function discoverPlugins(host, { pluginsDir = PLUGINS_DIR } = {}) {
  const result = []
  if (!existsSync(pluginsDir)) return result

  // Latest reported health per plugin name, for the management UI.
  let statusByName = new Map()
  try {
    if (typeof host.getStatus === 'function') {
      for (const s of host.getStatus()) statusByName.set(s.plugin, s)
    }
  } catch { /* getStatus is optional */ }

  const names = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const name of names) {
    const manifestPath = join(pluginsDir, name, 'plugin.json')
    if (!existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      console.warn(`[plugin-host] invalid manifest for ${name}:`, err?.message)
      continue
    }

    const enabledKey = `plugin_${name}_enabled`
    let enabled = host.getSetting(enabledKey)
    if (enabled == null && manifest.enabledByDefault) {
      enabled = true
    }

    result.push({
      name,
      version: manifest.version || '?',
      apiVersion: manifest.apiVersion || '',
      description: manifest.description || '',
      enabledByDefault: !!manifest.enabledByDefault,
      enabled: !!enabled,
      extensionPoints: Array.isArray(manifest.extensionPoints) ? manifest.extensionPoints : [],
      status: statusByName.get(name) || null,
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}
