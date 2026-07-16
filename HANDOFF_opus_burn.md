# HANDOFF: opus_burn — GLM Maintenance Handoff

**Date**: 2026-07-16
**Author**: Opus (T2)
**Branch**: `zhining/opus-burn-r8` (= `fork/main`, fully pushed)

---

## What's Done (Rounds 4-9, all on fork/main)

### Line 1: Codex Block Renderer (`public/codex-block-renderer.js`)

Full SDK event-driven block rendering, now at parity with Claude tab:

| Feature | Round | Status |
|---------|-------|--------|
| command_execution blocks (fold/expand, Show All, exit code) | R2-3 | Done |
| file_change diff blocks (LCS diff, line numbers, context collapse) | R2-3 | Done |
| Thinking/reasoning blocks (fold, preview, elapsed timer) | R3,5 | Done |
| Markdown streaming (cursor, hljs, copy buttons) | R3 | Done |
| Turn separators + stats bar | R3 | Done |
| SDK mode PTY suppression (`_sdkMode`) | R3 | Done |
| Tool icons per command type | R3 | Done |
| Batch SDK output render | R4 | Done |
| Auto-fold exit 0 commands | R4 | Done |
| Command timestamps (HH:MM:SS) | R4 | Done |
| Smart auto-scroll (pause on scroll-up, resume on click) | R5 | Done |
| Usage/token display (input/output/cached/reasoning + cost) | R5 | Done |
| MCP tool call blocks (name, server, args, status) | R5 | Done |
| Web search blocks | R5 | Done |
| turn.started + turn-complete notification events | R5 | Done |
| Copy output buttons (bash, altscreen, sync-output) | R6 | Done |
| PTY-path markdown rendering | R6 | Done |
| Reasoning block markdown (not just plain pre) | R6 | Done |
| Fold-all shortcut (Ctrl+Shift+F) | R6 | Done |
| Search overlay (Ctrl+F in codex) | R6* | Done |
| File change grouping by directory | R6* | Done |
| Error jump (click error to scroll to source) | R6* | Done |
| File path & URL auto-linking | R7 | Done |
| Word-level inline diff highlighting | R7 | Done |
| Expandable collapsed diff context | R7 | Done |
| Rate-limit event handling + countdown | R7 | Done |
| Interrupt via POST API (not just PTY byte) | R7 | Done |
| Connection recovery (reconnect on WebSocket drop) | R8 | Done |
| Command elapsed timers | R8 | Done |
| Turn timestamps | R8 | Done |
| Inline image rendering (base64/URL) | R9 | Done |
| Block navigation shortcuts (Alt+Up/Down) | R9 | Done |
| Keyboard-accessible fold headers (tabindex, aria) | R9 | Done |
| MCP result markdown rendering | R9 | Done |

**Entry file**: `public/codex-block-renderer.js` (~2200 lines)
**CSS**: Bottom of `public/codex-block-renderer.js` (injected via `<style>`)
**Integration point**: `public/codex.js` creates `CodexBlockRenderer` instance

### Line 2: Nanocode Polish

- `USER_MANUAL.md` updated through R9 features
- Upstream cherry-picks (URL toolbar, OSC 52/8, terminal bleed fixes) done in early rounds
- No remaining upstream features to pick

### Line 3: Akari (`zhining/lens-external-army` — local branch)

- External Army panel (`bands-army.tsx`): flag indicator, summary counts, stalled/flagged styling
- Agent loop fix: orphan tool_result → USER message assembly
- Grep/glob inclusion/exclusion tool extension + test suite
- Contributor guide simplification
- `tsc --noEmit` clean in lens + dispatch
- **Note**: This branch is local only (no push access from this worktree). The akari repo is at `/jfs/home/zhiningjiao/code/akari/`.

---

## What's Half-Done / Not Started

| Item | Status | Notes |
|------|--------|-------|
| Playwright screenshot e2e for codex blocks | Not started | Manual smoke tests done each round; no automated visual regression |
| Akari poll UX integration with live 9481 | Half-done | R8 added poll logic but fleet2 worker occupied 9481/9482; needs live test when free |
| Historian plugin UI polish | Not started | Historian works, UI is functional but unstyled |
| Usage panel detailed breakdown | Not started | Basic token counts shown; no per-tool cost breakdown |
| Akari lens-external-army push | Blocked | Branch exists locally in akari repo, needs push to akari fork |

---

## Key Files

| File | Purpose |
|------|---------|
| `public/codex-block-renderer.js` | Main codex rendering engine (SDK events → DOM blocks) |
| `public/codex.js` | Codex tab controller (WebSocket, PTY, SDK mode switching) |
| `public/style.css` | Global styles (codex styles are in block-renderer) |
| `USER_MANUAL.md` | User-facing feature documentation |
| `REPORT_opus_burn.md` | Detailed per-round report |
| `server/index.js` | Express server entry point |

---

## Tests

- `npm test`: 653 tests, 0 failures (as of R9)
- Smoke test pattern: `PORT=9477 node server/index.js &` then `curl localhost:9477`
- Never touch 9475 (prod) or 9476 (integ staging)
