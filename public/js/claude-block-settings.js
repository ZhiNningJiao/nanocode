// Tool-fold and subagent-visibility settings — extracted from
// claude-block-renderer.js so that app.js (settings panel) can wire them up
// WITHOUT pulling in the full 100 KB block-renderer module on cold start.
// The block renderer imports these from here; app.js imports only this tiny
// module. (port of upstream d952583 — makes lazy-load of block renderers real)

// ── Tool fold levels ──────────────────────────────────────────────────────────
//   'full'    — show the entire tool block (input + output)
//   'header'  — show only the summary header
//   'line'    — collapse to a single thin line (default, Q4 answer C)
//
// Cycle order (Q2 answer A): full → header → line → full → …
// Default is 'line' (most screen-efficient, user-requested).
const TOOL_FOLD_KEY = 'cbr_tool_fold'
const TOOL_FOLD_LEVELS = ['full', 'header', 'line']

// 2-state click cycle: full ↔ line (header accessible via settings panel only)
const TOOL_FOLD_CYCLE = { full: 'line', header: 'full', line: 'full' }

function getToolFoldLevel() {
  const v = localStorage.getItem(TOOL_FOLD_KEY)
  // Default: 'line' (Q4 answer C — most screen-efficient)
  return TOOL_FOLD_LEVELS.includes(v) ? v : 'line'
}

/**
 * Cycle a tool block's data-fold attribute through 2 states on click.
 * full → line → full → …
 * Header state is still reachable via settings panel only.
 * Works for both .cbr-block-tool and .cbr-block-tool-result articles.
 */
function cycleToolFold(article) {
  const cur = article.getAttribute('data-fold') || getToolFoldLevel()
  const next = TOOL_FOLD_CYCLE[cur] || 'full'
  article.setAttribute('data-fold', next)
}

// ── Subagent visibility toggles ───────────────────────────────────────────────
// Two independent booleans (persisted in localStorage):
//   cbr_subagent_prompt  — show the message/prompt sent TO a subagent (default on)
//   cbr_subagent_activity — show subagent internal activity (nested events, default off)
const SUBAGENT_PROMPT_KEY = 'cbr_subagent_prompt'
const SUBAGENT_ACTIVITY_KEY = 'cbr_subagent_activity'

function getSubagentPromptVisible() {
  const v = localStorage.getItem(SUBAGENT_PROMPT_KEY)
  return v === null ? true : v !== 'false'
}

function setSubagentPromptVisible(val) {
  localStorage.setItem(SUBAGENT_PROMPT_KEY, val ? 'true' : 'false')
  // Apply immediately to all existing subagent-prompt blocks.
  // Prompt blocks keep data-fold='full' so the body is always readable when visible.
  document.querySelectorAll('.cbr-block-subagent-prompt').forEach((el) => {
    el.style.display = val ? '' : 'none'
    el.setAttribute('data-fold', 'full')
  })
  document.dispatchEvent(new CustomEvent('cbr:subagent-prompt-changed', { detail: { visible: val } }))
}

function getSubagentActivityVisible() {
  const v = localStorage.getItem(SUBAGENT_ACTIVITY_KEY)
  return v === null ? false : v === 'true'
}

function setSubagentActivityVisible(val) {
  localStorage.setItem(SUBAGENT_ACTIVITY_KEY, val ? 'true' : 'false')
  // Apply immediately to all existing subagent-activity blocks
  document.querySelectorAll('.cbr-block-subagent-activity').forEach((el) => {
    el.style.display = val ? '' : 'none'
  })
  document.dispatchEvent(new CustomEvent('cbr:subagent-activity-changed', { detail: { visible: val } }))
}

function setToolFoldLevel(level) {
  if (!TOOL_FOLD_LEVELS.includes(level)) return
  localStorage.setItem(TOOL_FOLD_KEY, level)
  // Apply to all currently-rendered tool blocks in the page
  document.querySelectorAll('.cbr-block-tool, .cbr-block-tool-result').forEach((el) => {
    applyToolFold(el, level)
  })
  document.dispatchEvent(new CustomEvent('cbr:tool-fold-changed', { detail: { level } }))
}

function applyToolFold(el, level) {
  el.setAttribute('data-fold', level || getToolFoldLevel())
}

export {
  getToolFoldLevel, setToolFoldLevel, TOOL_FOLD_LEVELS,
  getSubagentPromptVisible, setSubagentPromptVisible,
  getSubagentActivityVisible, setSubagentActivityVisible,
  applyToolFold, cycleToolFold,
}
