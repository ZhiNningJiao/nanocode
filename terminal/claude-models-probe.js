// Claude model-list probe — the authoritative source for the claude model
// picker. Mirrors the codex side's `~/.codex/models_cache.json` pattern but
// for the Claude Agent SDK, whose live list comes from `Query.supportedModels()`
// (sdk.d.ts:2279). The SDK's hardcoded list ships stale (0.3.165 knew Opus 4.8
// but not Opus 5); `supportedModels()` returns whatever the *current* SDK +
// account actually offer, so the picker always reflects the real version.
//
// This module owns the probe ONLY. Filtering / coercion / caching live in
// routes.js so unit tests can inject a fake probe and exercise the whitelist
// without ever spawning the SDK.

import { query as defaultQuery } from '@anthropic-ai/claude-agent-sdk'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const _require = createRequire(import.meta.url)

const PROBE_TIMEOUT_MS = 15000
const CLEANUP_TIMEOUT_MS = 5000

// Resolved once at module load — the installed SDK version is the cache key
// for the model list (the list only changes when the SDK is upgraded or the
// account's entitlements change; the latter is handled by the TTL refresh).
// The SDK package's `exports` map does not expose `./package.json`, so we
// resolve the main entry and walk up to the package root.
export function claudeSdkVersion() {
  try {
    const mainPath = _require.resolve('@anthropic-ai/claude-agent-sdk')
    const sep = '/'
    const parts = mainPath.split(sep)
    const idx = parts.lastIndexOf('node_modules')
    // Scoped package: node_modules/@anthropic-ai/claude-agent-sdk/ — slice
    // through 3 elements (node_modules, scope, pkg-name) to reach the root.
    const pkgRoot = idx >= 0
      ? parts.slice(0, idx + 3).join(sep) + sep
      : null
    if (!pkgRoot) return null
    const pkg = JSON.parse(readFileSync(pkgRoot + 'package.json', 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch { return null }
}

// A streaming-input prompt that never yields a turn. The SDK only honours
// control requests (supportedModels / setModel / interrupt) in streaming-
// input mode (sdk.d.ts:2198 "only supported when streaming input/output is
// used"), so the probe MUST run in that mode. The stream stays pending (the
// claude process stays alive) while we call supportedModels(), then close()
// resolves the iterator → the generator exhausts → the process exits. No
// SDKUserMessage is ever pushed, so ZERO model tokens are consumed.
function createPendingPromptStream() {
  let resolveClose
  const closed = new Promise((r) => { resolveClose = r })
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await closed
          return { value: undefined, done: true }
        },
      }
    },
  }
  return { stream, close: () => resolveClose() }
}

/**
 * Create a probe function that returns the SDK's live ModelInfo[] for the
 * current account. The probe is a short-lived zero-turn streaming-input
 * query: it spawns claude, asks for the model list, and tears down.
 *
 * @param {object} opts
 * @param {Function} [opts.queryImpl]  - SDK query fn (overridable for tests).
 * @param {string}  [opts.home]        - used as cwd fallback.
 * @param {string}  [opts.cwd]        - cwd for the spawned claude process.
 * @param {number}  [opts.timeoutMs]  - probe timeout (default 15s).
 * @returns {() => Promise<object[]>} async fn → raw ModelInfo[]
 */
export function createClaudeModelProbe({
  queryImpl = defaultQuery,
  home,
  cwd,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  return async function probeClaudeModels() {
    const workCwd = cwd || home || process.cwd()
    const { stream, close } = createPendingPromptStream()
    const q = queryImpl({
      prompt: stream,
      options: {
        cwd: workCwd,
        // The probe never sends a turn, so model/effort/permission settings
        // are irrelevant to the result. bypassPermissions keeps the spawned
        // claude from blocking on an interactive permission prompt.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })
    let result = null
    try {
      result = await Promise.race([
        q.supportedModels(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('claude model probe timed out')), timeoutMs)
        ),
      ])
    } finally {
      // Tear down the probe so no claude process lingers. Bounded on every
      // step so a hung SDK can't keep the HTTP request open indefinitely.
      try { await q.interrupt?.() } catch {}
      close()
      try {
        await Promise.race([
          (async () => { for await (const _ of q) { break } })(),
          new Promise((r) => setTimeout(r, CLEANUP_TIMEOUT_MS)),
        ])
      } catch {}
    }
    return Array.isArray(result) ? result : []
  }
}
