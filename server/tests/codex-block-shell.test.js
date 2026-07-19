/**
 * Codex block-mode "shell" parity (stop button / queue tray / send-now) —
 * source-pattern tests.
 *
 * Block-mode codex (codexRenderMode === 'block', CodexBlockRenderer) must get
 * the same input-bar "shell" as claude/fable5/opencode block-mode: stop button,
 * busy/interruptible visualisation, queue tray, and "send now" (atomic
 * interrupt + flush). Before the fix `isBlockAgentTab` excluded codex entirely
 * and the codex block renderer never sent `_sendNow`, so block-mode codex had
 * none of these. These tests grep the source so the wiring cannot silently
 * regress.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const tvSrc = readFileSync(join(here, '../../public/js/terminal-view.js'), 'utf8')
const cbrSrc = readFileSync(join(here, '../../public/js/codex-block-renderer.js'), 'utf8')

describe('codex block-mode shell parity (source patterns)', () => {
  it('isBlockAgentTab includes block-mode codex (codexRenderMode === "block")', () => {
    // The isBlockAgentTab assignment must reference codexRenderMode and include
    // the codex + block condition. This is what lights up the stop button, queue
    // tray, model badge, and busy/interruptible UI for block-mode codex.
    assert.match(
      tvSrc,
      /isBlockAgentTab\s*=[\s\S]*?isCodexTab\s*&&\s*codexRenderMode\s*===\s*['"]block['"]/,
      'isBlockAgentTab must include (isCodexTab && codexRenderMode === "block")'
    )
  })

  it('terminal-view.js reads codexRenderMode with the "terminal" default (matches tab-manager.js)', () => {
    // Must mirror tab-manager.js's codexRenderMode default ('terminal') so the
    // shell lights up exactly when CodexBlockRenderer is in use.
    assert.match(
      tvSrc,
      /codexRenderMode\s*=\s*\(\(\)\s*=>\s*\{[\s\S]*?\?\.codexRenderMode\s*\|\|\s*['"]terminal['"]/,
      'terminal-view.js must read codexRenderMode with the "terminal" default'
    )
  })

  it('the thinking handler codex branch is guarded by !isBlockAgentTab (block codex uses updateThinkingState)', () => {
    // Terminal-mode codex keeps the N43-R9 interactive-REPL path (dim-only,
    // send stays enabled). Block-mode codex must fall through to
    // updateThinkingState so it gets the stop button. The guard is the
    // `&& !isBlockAgentTab` on the codex branch.
    assert.match(
      tvSrc,
      /if\s*\(\s*isCodexTab\s*&&\s*!isBlockAgentTab\s*\)\s*\{[\s\S]*?N43-R9/,
      'codex thinking branch must be guarded by && !isBlockAgentTab'
    )
  })

  it('codex-block-renderer sendInputWithEcho forwards _sendNow to the WS', () => {
    // The renderer must pass opts.sendNow through as _sendNow on the input
    // message so the server's attachCodexSession handler can atomically
    // interrupt + flush. Mirrors claude-block-renderer.js sendInputWithEcho.
    assert.match(
      cbrSrc,
      /sendInputWithEcho\s*\(\s*text\s*,\s*opts\s*=\s*\{\s*\}\s*\)/,
      'sendInputWithEcho must accept (text, opts = {})'
    )
    assert.match(
      cbrSrc,
      /this\._send\(\s*\{\s*type:\s*['"]input['"]\s*,\s*data:\s*text\s*\+\s*['"]\\r['"]\s*,\s*_sendNow:\s*opts\.sendNow\s*===\s*true\s*\}\s*\)/,
      'sendInputWithEcho must forward _sendNow: opts.sendNow === true on the input WS message'
    )
  })
})
