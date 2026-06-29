/**
 * input:before interceptor chain.
 *
 * A synchronous tap chain (unlike the fire-and-forget CustomEvent emit/on bus):
 * handlers run in registration order and each may return
 *   - a non-empty string → rewrites the input (subsequent handlers see the new text)
 *   - `false`            → cancels the send entirely
 *   - anything else       → passes through unchanged
 *
 * Extracted as a pure module so the interception semantics are unit-testable
 * without a DOM. The browser plugin-host (public/js/plugin-host.js) composes
 * one instance and exposes `beforeInput`/`runBeforeInput` to plugins.
 *
 * Blueprint reference: NANOCODE_ARCH.md §6 / Phase 4c — input:before.
 */

export function createInputInterceptor() {
  const handlers = []

  function beforeInput(handler) {
    handlers.push(handler)
    return () => {
      const i = handlers.indexOf(handler)
      if (i !== -1) handlers.splice(i, 1)
    }
  }

  function runBeforeInput(ctx) {
    let text = ctx.text
    // iterate a snapshot so a handler removing itself mid-run doesn't skew indices
    for (const h of [...handlers]) {
      try {
        const ret = h({ ...ctx, text })
        if (ret === false) return { text, cancel: true }
        if (typeof ret === 'string' && ret) text = ret
      } catch (err) {
        console.warn('[input-interceptor] beforeInput handler error:', err)
      }
    }
    return { text, cancel: false }
  }

  function _reset() { handlers.length = 0 }

  return { beforeInput, runBeforeInput, _reset }
}
