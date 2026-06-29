/**
 * P4c: input:before interceptor chain tests.
 *
 * The interceptor lets plugins synchronously rewrite or cancel user input
 * before it reaches the terminal pane. Extracted as a pure module so it is
 * unit-testable without a DOM. See public/js/input-interceptor.js.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInputInterceptor } from '../../public/js/input-interceptor.js'

test('no handlers → text passes through unchanged, cancel=false', () => {
  const ic = createInputInterceptor()
  const out = ic.runBeforeInput({ text: 'hello', tabType: 'claude', projectId: 'p1' })
  assert.equal(out.text, 'hello')
  assert.equal(out.cancel, false)
})

test('handler returns a string → rewrites the text', () => {
  const ic = createInputInterceptor()
  ic.beforeInput((ctx) => ctx.text.toUpperCase())
  const out = ic.runBeforeInput({ text: 'hello', tabType: 'bash' })
  assert.equal(out.text, 'HELLO')
  assert.equal(out.cancel, false)
})

test('handler returns false → cancels the send', () => {
  const ic = createInputInterceptor()
  ic.beforeInput(() => false)
  const out = ic.runBeforeInput({ text: 'hello' })
  assert.equal(out.cancel, true)
})

test('handler returning undefined → passes through unchanged', () => {
  const ic = createInputInterceptor()
  ic.beforeInput(() => undefined)
  ic.beforeInput(() => null)
  const out = ic.runBeforeInput({ text: 'hello' })
  assert.equal(out.text, 'hello')
  assert.equal(out.cancel, false)
})

test('multiple handlers run in order; each sees prior rewrites', () => {
  const ic = createInputInterceptor()
  const seen = []
  ic.beforeInput((ctx) => { seen.push(ctx.text); return ctx.text + '!' })
  ic.beforeInput((ctx) => { seen.push(ctx.text); return ctx.text + '?' })
  const out = ic.runBeforeInput({ text: 'hi' })
  assert.deepEqual(seen, ['hi', 'hi!'])
  assert.equal(out.text, 'hi!?')
})

test('a cancelling handler short-circuits; later handlers do not run', () => {
  const ic = createInputInterceptor()
  const ran = []
  ic.beforeInput(() => { ran.push(1); return 'rewritten' })
  ic.beforeInput(() => { ran.push(2); return false })
  ic.beforeInput(() => { ran.push(3); return 'never' })
  const out = ic.runBeforeInput({ text: 'x' })
  assert.deepEqual(ran, [1, 2])
  assert.equal(out.cancel, true)
})

test('empty-string return is treated as no-op (does not blank the input)', () => {
  const ic = createInputInterceptor()
  ic.beforeInput(() => '')
  const out = ic.runBeforeInput({ text: 'hello' })
  assert.equal(out.text, 'hello')
  assert.equal(out.cancel, false)
})

test('a throwing handler is isolated; chain continues', () => {
  const ic = createInputInterceptor()
  ic.beforeInput(() => { throw new Error('boom') })
  ic.beforeInput((ctx) => ctx.text + '-ok')
  const out = ic.runBeforeInput({ text: 'hi' })
  assert.equal(out.text, 'hi-ok')
  assert.equal(out.cancel, false)
})

test('beforeInput returns an unsubscribe function', () => {
  const ic = createInputInterceptor()
  const off = ic.beforeInput(() => false)
  assert.equal(typeof off, 'function')
  let out = ic.runBeforeInput({ text: 'hi' })
  assert.equal(out.cancel, true)
  off()
  out = ic.runBeforeInput({ text: 'hi' })
  assert.equal(out.cancel, false)
})

test('handler receives a copy of ctx; the caller ctx is not mutated', () => {
  const ic = createInputInterceptor()
  const callerCtx = { text: 'orig', tabType: 'claude', projectId: 'p1' }
  ic.beforeInput((ctx) => { ctx.text = 'mutated'; return undefined })
  const out = ic.runBeforeInput(callerCtx)
  // The chain's text only changes via the return value; the caller's ctx is
  // untouched because handlers receive a shallow copy.
  assert.equal(callerCtx.text, 'orig')
  assert.equal(out.text, 'orig')
  assert.equal(out.cancel, false)
})

test('_reset clears all handlers', () => {
  const ic = createInputInterceptor()
  ic.beforeInput(() => false)
  assert.equal(ic.runBeforeInput({ text: 'hi' }).cancel, true)
  ic._reset()
  assert.equal(ic.runBeforeInput({ text: 'hi' }).cancel, false)
})
