# REPORT: opus_burn — T2 3h Sprint

**Date**: 2026-07-16
**Branch**: `zhining/codex-render-polish` (nanocode) + `zhining/lens-external-army` (akari)
**Commits**: Rounds 1-4 (prior) + Round 5 (this session)

---

## Round 5 (this session)

### Line 1: Codex 渲染完善

**Commit** `04540b6` (pushed to fork/main) — 251 insertions:

1. **Smart auto-scroll** — mirrors Claude tab: pauses auto-scroll when user scrolls up to read; resumes on scroll-to-bottom button click or new user input. Tracks `_userScrolledUp` state.

2. **Usage/token display** — renders end-of-turn token counts (input/output/cached/reasoning) and cost as a subtle bar below each turn separator. Handles both SDK (`cached_input_tokens`) and Claude (`cache_read_input_tokens`) field names.

3. **Reasoning blocks** — collapsible thinking summaries. Header shows 80-char preview; expand for full text. Auto-folds by default.

4. **MCP tool call blocks** — structured blocks for Model Context Protocol tool invocations. Shows tool name, server name, arguments (pretty-printed JSON), and running/done/error status. Auto-folds on success.

5. **Web search blocks** — visual indicator when Codex performs web searches (query displayed).

6. **turn.started handling** — sets thinking state immediately on new turn.

7. **turn-complete notification** — dispatches `nanocode:turn-complete` CustomEvent for the alert system (matching Claude tab behavior).

8. **USER_MANUAL.md** — updated with all new codex features (reasoning blocks, MCP, web search, usage display, smart scroll, stats bar, notifications).

Tests: 653/0 all pass. Smoke: 9477 HTTP 200.

### Line 2: Nanocode 打磨

USER_MANUAL.md comprehensive update covering Round 5 features. Upstream cherry-picks evaluated (3 candidates: URL toolbar, OSC 52/8, v1.3.0 stabilize) but deferred — too divergent for safe cherry-pick during burn sprint.

### Line 3: Akari 打磨

**Commit** `6046c281f` on `zhining/lens-external-army` — pre-commit 17/17 gates pass:

1. **Flag indicator** — external army rows now show `flag` field from `army_status.json`. Flagged (completed) workers display with green `⚑ done` status, green tint background, and green tag text.

2. **Summary counts** — band header now shows stalled/flagged counts (e.g. "5 workers · 1 stalled · 2 flagged").

3. **CSS** — new `.astat.flag`, `.army-row.flagged` styles.

Build: `tsc --noEmit` clean.

### Smoke Test

- PORT=9477: HTTP 200, codex-block-renderer with all Round 5 features served correctly
- 9475/9476/9481/9482 untouched

### Collision Report

| Worker | Zone | Touched? |
|--------|------|----------|
| mobile_scroll | nanocode touch | No |
| session_singleton | nanocode session | No |
| akari_fleet2 | 9481/9482 | No (local commits only) |
| quick3stage | dcc | No |

---

## Round 4 (prior session)

### Line 1: Codex 渲染完善

**Finding**: fork/main already has full SDK event-driven block rendering from Rounds 2-3:
- command_execution tool blocks with fold + expandable output + Show All
- file_change diff blocks with LCS line-number diff + context collapse
- thinking block with elapsed timer
- markdown streaming with cursor + hljs + copy buttons
- turn separators + stats bar
- `_sdkMode` PTY suppression
- tool icons per command type

**Round 4 additions** (commit `ec19638`, pushed to fork/main):
1. **Batch SDK output render** — was per-line DOM render, now batched
2. **Auto-fold exit 0** — successful commands auto-fold to header
3. **Command timestamps** — HH:MM:SS on bash block headers

Tests: 653/0 all pass.

### Line 2: Nanocode 打磨

Historian, waker, usage panel, right-panel IA, sessions, tasks, i18n — all on fork/main. Upstream cherry-picks too divergent. Minor CSS/codex improvements bundled with Line 1.

### Line 3: Akari 打磨

Branch: `zhining/lens-external-army` (local, no push access)

3 commits converging WIP changes:

1. `af48d188c` — **fix(assembly+agent-loop)**: orphan tool_result → USER message. Idless tool blocks now assemble as user(), not orphan tool_result. 7 agent-loop feedback blocks fixed. 4 new tests. All 17 pre-commit gates pass.

2. `4afc03649` — **feat(tools)**: grep glob inclusion/exclusion (391 lines) + 197-line test suite. Tool trait extended.

3. `bdd57f5b7` — **docs(agents)**: simplify contributor guide (-101/+40 lines).

Build: `cargo check` clean, `tsc --noEmit` clean.

### Smoke Test

- PORT=9477: HTTP 200, codex-block-renderer with new features served correctly
- 9475/9476/9481/9482 untouched

### Collision Report

| Worker | Zone | Touched? |
|--------|------|----------|
| mobile_scroll | nanocode touch | No |
| session_singleton | nanocode session | No |
| akari_fleet2 | 9481/9482 | No (local commits only) |
| quick3stage | dcc | No |
