/**
 * Compute the #model-badge text for a claude (block) tab.
 *
 * Priority (strongest signal first):
 *   1. reportedModel — the model that ACTUALLY generated the last reply. Filled
 *      by the block renderer's `nanocode:claude-model` dispatch on each
 *      assistant message_start (and by the picker's dispatch on a manual pick).
 *      Strongest fact, so it wins — a live reply always overrides the pick.
 *   2. modelOverride — the tab's per-tab model pick (set by the model picker via
 *      PATCH /api/projects/:id/tabs/:tabId/model). Shown when no reply has
 *      happened yet, so the user sees their selection immediately. Root fix
 *      for "badge stuck on 'model' after picking; refresh still shows 'model'"
 *      — the old code only read reportedModel, so a tab with an override but no
 *      turn yet always rendered the bare 'model' affordance.
 *   3. '' — no signal; the caller renders the tappable 'model' affordance.
 *
 * Display: a leading `claude-` prefix is stripped to keep the pill short
 * (mobile-friendly), but suffixes like `[1m]` are preserved verbatim — the user
 * selected `opus[1m]`, so the badge shows `opus[1m]`, not a rewritten form.
 *
 * Pure by design (no DOM / no closures): terminal-view.js passes the two
 * signals in, so the resolution is unit-testable with plain inputs — the
 * "equivalent evidence" for all three priority cases plus the clear-override
 * no-residue case. Mirrors model-picker-mount.js's extract-to-test pattern.
 */
export function claudeBadgeText({ reportedModel, modelOverride } = {}) {
  const model = reportedModel || modelOverride || ''
  return model ? model.replace(/^claude-/, '') : 'model'
}
