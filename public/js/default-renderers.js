/**
 * Default renderer registrations — thin shim.
 *
 * The actual registration logic now lives in the `core-renderers` plugin
 * (plugins/core-renderers/client.js). This file remains imported for its side
 * effect by tab-manager.js so that the three default renderers (claude-block,
 * codex-block, terminal) are registered synchronously at module-load time —
 * before the async plugin loader (loadClientPlugins) runs.
 *
 * When the core-renderers plugin is later loaded by the plugin host it calls
 * register() again; rendererRegistry.register replaces same-named entries, so
 * the double registration is idempotent.
 *
 * Blueprint reference: NANOCODE_ARCH.md §6 / Phase 4b.
 */
import { register } from '../../plugins/core-renderers/client.js'

register()

export const RENDERER_DEFAULTS_REGISTERED = true
