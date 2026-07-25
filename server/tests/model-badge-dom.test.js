import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Evidence for the claude (block) #model-badge fix. The old _updateModelBadge
// only read the reported model (_modelByTab), so a tab with a modelOverride but
// no turn yet rendered the bare 'model' affordance — the user could not see
// their selection. claudeBadgeText now resolves reported > override > 'model',
// strips a leading `claude-` but preserves `[1m]` suffixes verbatim. Pure by
// design (no DOM): the three priority cases + the clear-override no-residue
// case are driven with plain inputs.
const { claudeBadgeText } = await import('../../public/js/model-badge.js')

describe('claudeBadgeText — claude block badge resolution (reported > override > model)', () => {
  it('reported reply model wins over modelOverride (strongest fact)', () => {
    // A real assistant message_start reported claude-sonnet-4-6; the tab also
    // has an override. The badge shows what actually replied, stripped.
    assert.equal(
      claudeBadgeText({ reportedModel: 'claude-sonnet-4-6', modelOverride: 'opus[1m]' }),
      'sonnet-4-6'
    )
  })

  it('only a modelOverride (no reply yet) is shown so the user sees their pick', () => {
    // No turn has happened. The user picked opus[1m]; the badge must show it,
    // suffix preserved verbatim (NOT stripped/rewritten).
    assert.equal(claudeBadgeText({ reportedModel: undefined, modelOverride: 'opus[1m]' }), 'opus[1m]')
    // A plain id without a suffix is shown as-is.
    assert.equal(claudeBadgeText({ reportedModel: null, modelOverride: 'claude-opus-4-8' }), 'opus-4-8')
  })

  it('neither signal → the tappable "model" affordance (no override, no reply)', () => {
    assert.equal(claudeBadgeText({ reportedModel: undefined, modelOverride: '' }), 'model')
    assert.equal(claudeBadgeText({ reportedModel: '', modelOverride: undefined }), 'model')
    assert.equal(claudeBadgeText({}), 'model')
  })

  it('clearing the override leaves NO stale residue (badge falls back to model)', () => {
    // Before clear: the override was opus[1m] and a real reply had reported it,
    // so the badge showed the reported model.
    const before = claudeBadgeText({ reportedModel: 'opus[1m]', modelOverride: 'opus[1m]' })
    assert.equal(before, 'opus[1m]')
    // The picker dispatches nanocode:claude-model with model:'' on clear → the
    // listener deletes the reported entry; the override is cleared to ''. The
    // helper is stateless, so the cleared state resolves to 'model' — the old
    // value must NOT linger.
    const after = claudeBadgeText({ reportedModel: undefined, modelOverride: '' })
    assert.equal(after, 'model', 'cleared override must not leave the old model in the badge')
  })
})
