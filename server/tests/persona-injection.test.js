/**
 * 需求8 persona injection — SDK driver anti-fake-pass proof.
 *
 * The SDK streaming driver is the default claude path. The DIRECT query() path
 * does NOT honor a top-level `appendSystemPrompt` option (that field only exists
 * on the bridge SDKControlInitializeRequest — a different code path). The
 * documented way to append to the default claude_code system prompt is
 * `systemPrompt: { type: 'preset', preset: 'claude_code', append }` (sdk.d.ts).
 * We verified this empirically: top-level appendSystemPrompt is a silent no-op;
 * preset.append takes effect. We mock `queryImpl` (the SDK query entry point) to
 * capture the options object, then assert:
 *   - a tab with persona='catgirl' → options.systemPrompt is the preset with
 *     .append === the catgirl instruction text (resolved from the bundled file),
 *     and the no-op top-level appendSystemPrompt is NOT set
 *   - a tab with no persona → options.systemPrompt === undefined (no override,
 *     keeps the exact default behavior)
 *
 * The CLI --append-system-prompt path (a real CLI flag, confirmed via
 * `claude --help`) and the tmux bridge arg are wired identically through this
 * same runSdkTurn; the SDK path is the production default, so we lock it here.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'
import { resolvePersonaPrompt } from '../../terminal/personas.js'

function makeQueryCapture(calls) {
  return ({ prompt, options }) => {
    calls.push({ prompt, options })
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'cap-session', tools: [] }
      yield { type: 'assistant', session_id: 'cap-session', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
      yield { type: 'result', subtype: 'success', session_id: 'cap-session', result: 'ok' }
    }
    const it = run()
    it.interrupt = async () => {}
    it.close = async () => {}
    return it
  }
}

function baseStore() {
  return {
    getSetting() { return null },
    updateTabMetadata() {},
  }
}

function baseCs(overrides = {}) {
  return {
    claudeSessionId: 'sess-init',
    busy: false,
    turnCount: 0,
    queue: [],
    history: [],
    clients: new Set(),
    ...overrides,
  }
}

describe('persona injection (需求8) — SDK systemPrompt preset.append', () => {
  it('passes the resolved catgirl instruction as systemPrompt preset.append', async () => {
    const calls = []
    const driver = createClaudeSdkDriver({
      store: baseStore(),
      claudeBroadcast: () => {},
      rerunTurn: () => { throw new Error('rerunTurn should not be called') },
      queryImpl: makeQueryCapture(calls),
    })
    // Simulate the attach-time resolution: tab.persona='catgirl' → cs.personaPrompt.
    const personaPrompt = resolvePersonaPrompt(undefined, 'catgirl')
    assert.ok(personaPrompt.length > 0, 'catgirl persona must resolve to non-empty instruction')
    const cs = baseCs({ personaPrompt })
    await driver.runSdkTurn(cs, 'hello', 'p1:claude:t1', process.cwd())

    assert.equal(calls.length, 1)
    // The documented direct-query() form: systemPrompt preset + append.
    const sp = calls[0].options.systemPrompt
    assert.ok(sp, 'systemPrompt must be set when a persona is active')
    assert.equal(sp.type, 'preset', 'systemPrompt must be the preset form')
    assert.equal(sp.preset, 'claude_code', 'preset must be claude_code (keep defaults)')
    assert.equal(sp.append, personaPrompt, 'append must equal the catgirl instruction text')
    assert.ok(/猫娘|主人/.test(sp.append), 'append must carry the catgirl instruction')
    // Anti-fake-pass: the no-op top-level form must NOT be present.
    assert.equal(calls[0].options.appendSystemPrompt, undefined,
      'must not use the no-op top-level appendSystemPrompt on the direct query path')
  })

  it('omits systemPrompt (undefined) when no persona is set', async () => {
    const calls = []
    const driver = createClaudeSdkDriver({
      store: baseStore(),
      claudeBroadcast: () => {},
      rerunTurn: () => { throw new Error('rerunTurn should not be called') },
      queryImpl: makeQueryCapture(calls),
    })
    const cs = baseCs({ personaPrompt: '' })
    await driver.runSdkTurn(cs, 'hello', 'p1:claude:t2', process.cwd())

    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.systemPrompt, undefined,
      'no-persona tab must NOT override systemPrompt (keeps the exact default)')
    assert.equal(calls[0].options.appendSystemPrompt, undefined,
      'no-persona tab must NOT set the no-op appendSystemPrompt either')
  })

  it('a missing persona id resolves to empty → no systemPrompt override', async () => {
    const calls = []
    const driver = createClaudeSdkDriver({
      store: baseStore(),
      claudeBroadcast: () => {},
      rerunTurn: () => { throw new Error('rerunTurn should not be called') },
      queryImpl: makeQueryCapture(calls),
    })
    // tab.persona='does-not-exist' → resolvePersonaPrompt returns '' → no injection.
    const cs = baseCs({ personaPrompt: resolvePersonaPrompt(undefined, 'does-not-exist') })
    await driver.runSdkTurn(cs, 'hello', 'p1:claude:t3', process.cwd())

    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.systemPrompt, undefined)
    assert.equal(calls[0].options.appendSystemPrompt, undefined)
  })
})
