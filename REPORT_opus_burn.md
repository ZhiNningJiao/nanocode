# REPORT: opus_burn — T2 3h Sprint (Round 2)

**Date**: 2026-07-16
**Branch**: `zhining/nano-plugin-akari`

---

## Line 1: Codex Rendering (SDK Event Stream -> Block Renderer)

**Goal**: Bring Codex block rendering to parity with Claude tab experience.

### Changes (all in `public/js/codex-block-renderer.js` + `public/style.css`):

1. **Copy buttons on code blocks** — Markdown-rendered agent messages now inject copy buttons into `<pre><code>` fences, matching Claude tab's UX pattern. CSS classes `.cbx-code-wrap`, `.cbx-code-header`, `.cbx-copy-btn` added. Copy handlers attached on message finalization via `_attachCopyHandlers()`.

2. **LCS-based diff for file changes** — Replaced the simple positional line-by-line diff with a proper Longest Common Subsequence (LCS) algorithm, ported from Claude's `computeLineDiff()`. Now correctly identifies moved/reordered lines and produces minimal diffs. Handles files up to 500 lines with DP; falls back to full remove+add for larger files. Max 200 lines rendered per diff block.

3. **Thinking indicator with elapsed timer** — The "Thinking..." block now shows a live elapsed timer (updated every second: `3s`, `12s`, etc.) so users know how long Codex has been processing. Timer is cleaned up properly in `_removeThinkingBlock()`.

4. **CSS polish** — Added styles for:
   - `.cbx-code-wrap` / `.cbx-code-header` — code block header with language label
   - `.cbx-copy-btn` — copy button matching Claude's styling
   - `.cbx-thinking-elapsed` — monospace elapsed timer aligned right

### Architecture preserved:
- SDK mode (`_sdkMode = true`) still suppresses duplicate PTY text
- `extractCodexTodos` export unchanged (S5 todo dispatch)
- No server-side changes needed — all rendering improvements are frontend-only

---

## Line 2: Nanocode Polish

### Historian fleet summary
`public/js/historian-panel.js` — Added a **fleet summary stats grid** at the top of the Army table showing:
- running / stalled / flagged / total agent counts
- Provides at-a-glance fleet health without reading the full table

### USER_MANUAL update
`docs/USER_MANUAL.md` — Updated Codex rendering documentation:
- Changed "Block (experimental)" to "Block (SDK-driven)"
- Added new "Codex Block Rendering (SDK Mode)" section documenting: markdown with copy buttons, command blocks, LCS diffing, thinking timer, turn separators, fold states

---

## Line 3: Akari Polish

### External Army section
`public/js/akari-panel.js` — Added **External Army** section to the akari inspector panel:
- Cross-references `army_status.json` data via `/api/historian/state`
- Shows agent fleet table: tag, status (running/STALL/FLAG with colored dots), last active time, activity
- Graceful degradation: section simply doesn't appear if historian data is unavailable
- Uses existing akari table styling (`.akari-table`, `.akari-state-dot`)

---

## Test Results

```
652 tests, 144 suites, 652 pass, 0 fail
```

Smoke test on port 9477: health=ok, services=ok, akari=up.

## Files Changed

- `public/js/codex-block-renderer.js` — copy buttons, LCS diff, thinking timer
- `public/style.css` — CSS for code wraps, copy buttons, elapsed timer
- `public/js/historian-panel.js` — fleet summary stats grid
- `public/js/akari-panel.js` — External Army section
- `docs/USER_MANUAL.md` — codex SDK rendering documentation
