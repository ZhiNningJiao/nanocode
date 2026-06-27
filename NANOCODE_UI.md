# NanoCode UI — Interaction Analysis & 5 Design Directions

**Repo:** `~/code/nanocode2` · **Branch:** `zhining/plugins`
**Author:** PM/architect pass · **Date:** 2026-06-27 (updated: responsive pass)
**Scope:** (C) analyze the current UI interaction state machine + holes/anti-patterns;
(D) propose 5 distinct UI versions that differ at the **interaction-logic** level,
not just visual skin. (E) dual-viewport interaction maps for the responsive pass.
Mockups live in `public/mockups/v1..v5.html` — all five are responsive (phone 390×844 + desktop).

---

## Part C — Current UI interaction analysis

### C.1 Layout skeleton (current)

```
┌──────────┬───────────────────────────────────────┬──────────────┐
│ Sidebar  │  Tab strip (terminal tabs, carousel)   │  Agent drawer │
│ (projects│ ┌───────────────────────────────────┐  │  (right,     │
│  list,   │ │ Terminal pane  │ Explorer pane      │  │   collapsible│
│  collapse│ │ (xterm + chat   │ (file tree / diff) │  │   overlay)   │
│  /overlay│ │  input below)   │                    │  │              │
│  on mob) │ └───────────────────────────────────┘  │              │
│          │  Plugin panel tab strip (Terminal + …)  │              │
└──────────┴───────────────────────────────────────┴──────────────┘
                    Settings modal (overlay)
```

- **Sidebar** (`sidebar.js`, 337 lines): project list, collapse/overlay. Mobile
  (`max-width:768px`) collapses to an overlay drawer.
- **Tab strip** (`tab-manager.js`, 566 lines): multi-tab carousel, persisted to
  backend per project. Each tab owns a terminal session.
- **Split pane** (`terminal-view.js`, 1869 lines): terminal (xterm) + explorer,
  with the chat input docked below the terminal. Mobile switches pane (left/fleet).
- **Agent drawer** (`agents.js`, 395 lines): right drawer, agent CRUD, recent
  sessions.
- **Plugin panels** (`plugin-host.js`): a tab strip appended after Terminal;
  switching hides the terminal layout and shows the plugin panel. Incremental.
- **Settings modal**: overlay; includes plugin-manager + dual-team management.

### C.2 The core interaction state machine

The terminal-view is the heart of the UX. Its per-tab state machine (reconstructed
from `terminal-view.js`, `claude-session-controller.js`, `claude-tmux-driver.js`):

```
                  ┌─────────────────────────────────────────────┐
                  ▼                                             │
  IDLE ──send──▶ BUSY ──result──▶ IDLE                         │
   │              │ │                                            │
   │              │ ├──bg-btn──▶ BG_RUNNING ──result──▶ IDLE     │
   │              │ │              │                              │
   │              │ │              └──(tab badge ·, UI free)      │
   │              │                                               │
   │              ├──Esc/Stop(soft)──▶ INTERRUPTING ──result──▶ IDLE
   │              │                       │ (2.5s arm)           │
   │              │                       └──2nd press──▶ FORCE ─▶ IDLE
   │              │                                               │
   │              └──type msg──▶ QUEUED (held client-side)        │
   │                                │                             │
   │                                └──on BUSY→IDLE──▶ flush as combined turn
   │                                                              │
   └──send-now (force-flush)──▶ combines queue + force-interrupt──▶ IDLE
```

Key transitions and their guards (verified in source):

| Transition | Trigger | Guard / invariant | Source |
|------------|---------|--------------------|--------|
| IDLE→BUSY | user sends message | server sets `cs.busy=true` | session-controller |
| BUSY→IDLE | WS `result` event | flush `_pendingQueue` only here | `terminal-view.js:613,651` |
| BUSY→QUEUED | user types while busy | held in `_pendingQueue`, persisted via `PUT /queue` | `terminal-view.js:432` |
| BUSY→BG_RUNNING | background button | releases UI **without** interrupt; `skipFlush=true` | `terminal-view.js:395` |
| BUSY→INTERRUPTING | Esc / Stop (soft) | POST `/interrupt {force:false}`; arms 2.5s window | `terminal-view.js:754` |
| INTERRUPTING→FORCE | 2nd press within 2.5s, or `{force:true}` | force stops **only** main turn; bg sub-agents live | `terminal-view.js:763` |
| QUEUED→flush | BUSY→IDLE transition | combined into one turn; queue discarded on interrupt | session-controller finally |
| any→IDLE | `sendNowFlush` | combines queue text + `andFlush:true` force-interrupt | `terminal-view.js:537` |

**Subagent phase:** `nanocode:claude-subagent-phase` event shows Send during a
subagent handoff so the user can queue/chat while the main model idles — a
nuanced state that lets the main turn stay alive while the UI is responsive.

### C.3 What works well (keep these in any redesign)

1. **Interrupt escalation** (soft → force) matches the Claude CLI mental model.
   The 2.5s armed window with a tooltip hint is excellent UX — discoverable
   without a modal.
2. **Background turn** decouples "is the agent working" from "is my UI blocked".
   The tab-slot `·` badge is the right lightweight signal.
3. **Client-side pending queue** with `skipFlush` guard prevents the P0
   "premature flush while still busy" race. Persisting the queue to the backend
   per-tab means it survives tab switches.
4. **Live plugin load/unload** without page reload (per-plugin registry +
   incremental render) is a genuinely strong pattern.
5. **Persistent tmux bridge** means a Claude OS process outlives nanocode
   reloads — the durability model is invisible to the user, which is the point.

### C.4 Holes & anti-patterns (to fix or design around)

| # | Issue | Where | Impact | Design implication |
|---|-------|-------|--------|--------------------|
| H1 | **Plugin toggle needs server restart for routes** | `plugin-host.js:370` | UX surprise: "I turned it off but it still responds" | Surface pending-restart state explicitly in any plugin UI |
| H2 | **No multi-device session coordination** | in-memory `claudeSessions` Map | two tabs switching teams can start a session under the wrong config dir | Designs should show team binding per-tab |
| H3 | **agent-health-monitor is observational only** | `agent-health-monitor.js` | stuck sessions can't be one-click force-unlocked | Offer an explicit "force-unlock" affordance (never auto) |
| H4 | **Two disconnected settings surfaces** | settings modal vs plugin panel tab | plugin settings live in the modal; plugin *panels* live in the tab strip — split mental model | Unify plugin config + panel, or clearly separate "config" from "view" |
| H5 | **Mobile breakpoint is a single 768px switch** | CSS | tablet gets phone layout or desktop layout, nothing between | Consider a 3-tier responsive model |
| H6 | **No global command surface** | — | power users can't keyboard-drive project/agent/plugin switching | A command palette (see V5) addresses this |
| H7 | **Chat input is docked under the terminal** | `terminal-view.js` | on long transcripts the input is far from the latest output | Canvas/chat-first designs (V3) separate this |
| H8 | **Plugin health invisible** | no status contract (§4.2 of ARCH) | a degraded plugin shows no badge | Add health affordance in plugin UI across designs |

---

## Part D — 5 UI versions (distinct interaction logic)

Each version is defined by a **different interaction paradigm** — the primary
unit of action, the state machine, and the dominant surface differ. They are
not reskins of the same layout. Each lists: concept, interaction logic, state
machine, layout, trade-offs, and who it's for.

---

### V1 — "Focus Mode" (single-conversation centric)

**Concept.** One conversation owns the screen. Everything else (sidebar, tabs,
agents, panels) is hidden by default and **summoned** as a transient overlay.
The terminal is the hero; chrome retreats until asked for.

**Interaction logic.**
- Primary action: send a message / watch the stream.
- The screen is 95% terminal + input. No persistent sidebar, no persistent tab
  strip visible unless you have >1 tab.
- Summon model: `Cmd/Ctrl+K` opens a command/switcher overlay (projects, tabs,
  agents, plugins, settings). `Esc` dismisses. Overlays never steal the
  terminal's focus for long.
- Background turns still work: the tab badge appears, but the tab strip only
  surfaces when you summon it.

**State machine:**
```
FOCUSED_TERMINAL ──Cmd+K──▶ SWITCHER_OVERLAY ──select──▶ FOCUSED_TERMINAL
      │                          │
      │                          └──Esc──▶ FOCUSED_TERMINAL
      └──type+send──▶ STREAMING ──result──▶ FOCUSED_TERMINAL
```

**Layout.** Full-bleed terminal top, slim input docked at bottom (sticky). A
floating pill in the corner shows project + tab + team. Summoning overlays slide
over with a backdrop; they don't push layout.

**Trade-offs.**
- (+) Lowest cognitive load; great for deep single-task work.
- (+) Mobile-friendly by default (nothing to collapse).
- (−) Weak for monitoring multiple agents simultaneously (that's V2).
- (−) Discoverability suffers — power-user leaning; needs onboarding hints.

**For:** the single-task developer having one focused conversation with Claude.

---

### V2 — "Multi-Lane Dashboard" (parallel agents)

**Concept.** Multiple agent terminals are visible **simultaneously** in a mosaic.
Built for the watchdog/patrol workflow where several agents run at once and you
glance between them. One lane can be expanded to full focus; the rest keep
running in mini-view.

**Interaction logic.**
- Primary action: monitor N lanes, expand one to act on it.
- Lanes are first-class — each is a live terminal with its own busy/bg/queue
  state, shown as a tile. A compact status strip per lane (busy/bg/queued/idle +
  last-line preview + team badge).
- Click a lane → it expands (others shrink to a rail); the input binds to the
  expanded lane. Click again or `Esc` → return to mosaic.
- New lane = `+` tile. Reorder by drag. Lanes persist (already backed by
  `tab-manager` server persistence).

**State machine:**
```
MOSAIC_GRID ──click lane──▶ LANE_EXPANDED ──Esc──▶ MOSAIC_GRID
    │                            │
    │                            └──type+send──▶ LANE_STREAMING ──result──▶ LANE_EXPANDED
    └──+ tile──▶ NEW_LANE ──pick project──▶ MOSAIC_GRID
```

**Layout.** Responsive grid (1 col mobile, 2 tablet, 3-4 desktop). Expanded lane
takes ~70% width; rail shows mini tiles. Status strip per lane always visible.

**Trade-offs.**
- (+) Best for the actual NanoCode power use case (multi-agent patrol).
- (+) Makes background-turn state legible at a glance.
- (−) Heavier visually; needs a real status/health contract (H8) to be useful.
- (−) Expanding/collapsing can feel busy; needs smooth transitions.

**For:** the operator running Team1 + Team2 + fleet-term + monitor concurrently.

---

### V3 — "Chat-First / Canvas" (message-centric with artifacts)

**Concept.** The primary surface is a **chat transcript**, not a raw terminal.
Terminal output is rendered as structured blocks (the existing
`claude-block-renderer` already does this). A side **canvas** shows artifacts —
files, diffs, viewer links, images. Sending a message is the atomic action.

**Interaction logic.**
- Primary action: send a message; read structured response.
- The raw xterm is secondary — it lives in a collapsible "raw terminal" drawer
  for debugging. By default the user sees rendered blocks (tool calls, diffs,
  text) like a chat.
- Artifacts open in the canvas: clicking a file-edit block opens the diff in the
  right pane; a viewer-link block opens the GLB/image. Multiple artifacts stack
  as tabs in the canvas.
- The input is anchored to the bottom of the transcript (not under the
  terminal), so it's always near the latest message (fixes H7).

**State machine:**
```
TRANSCRIPT ──send──▶ STREAMING(blocks render inline) ──result──▶ TRANSCRIPT
    │                        │
    │                        └──artifact block──▶ CANVAS_OPEN(tabbed)
    │                                                │
    └──click past block──▶ SCROLL_HISTORY            └──close──▶ TRANSCRIPT
```

**Layout.** Left: scrollable transcript (60%). Right: canvas with artifact tabs
(40%). Bottom: input bar (full width under transcript). Raw-terminal drawer is a
collapsible bottom panel.

**Trade-offs.**
- (+) Most legible for humans; diffs/links are first-class.
- (+) Input near latest output (fixes H7); great for review.
- (−) Loses the "I'm driving a real terminal" feel some power users want.
- (−) Block rendering complexity is already high (`claude-block-renderer.js`
  2258 lines); leaning on it harder raises the stakes.

**For:** the reviewer/PM who reads agent output more than they type commands.

---

### V4 — "Workspace IDE" (file-tree + terminal + diff triad)

**Concept.** Borrows the IDE mental model (VS Code-like): a persistent file
explorer (left), terminal(s) (bottom), and a diff/preview pane (right). Agents
operate **on files**; every file-mutating agent action surfaces as a diff you
accept/reject. Interaction is file-centric, not terminal-centric.

**Interaction logic.**
- Primary action: run an agent on a file/range; review the resulting diff.
- The file explorer is the navigator. Right-click a file → "ask agent to…".
- Agent turns that touch files produce a diff entry in a review queue; the diff
  pane shows the proposed change with Accept/Reject. Accepted diffs are applied;
  rejected ones are noted in the transcript.
- Terminals are docked bottom (like an IDE terminal panel), one per agent. The
  explorer + diff are the focus.

**State machine:**
```
BROWSE_TREE ──run-agent-on-file──▶ AGENT_RUNNING ──result+diff──▶ DIFF_REVIEW
                                                                     │
               ┌─────────────────────────────────────────────────────┤
               ▼                                                     ▼
          ACCEPT (apply)                                       REJECT (note)
               └──▶ BROWSE_TREE ◀──────────────────────────────────┘
```

**Layout.** Left: file explorer (collapsible). Center-top: editor/diff preview.
Center-bottom: terminal panel (tabbed, one per agent). Right: review queue +
accept/reject. Top bar: project + active agent + team.

**Trade-offs.**
- (+) Maps onto how developers actually think (file/diff centric).
- (+) Accept/reject gives explicit control over agent mutations — safe.
- (−) Most divergent from current NanoCode; largest build.
- (−) Assumes agent output is diffable; non-file work (research, chat) fits
  poorly — needs a fallback to transcript view.

**For:** the developer using agents to edit a real codebase, wanting review gates.

---

### V5 — "Command Console" (keyboard-driven, Vim/Raycast-like)

**Concept.** No persistent chrome. A single **command bar** is the entry point
(like Vim, rofi, Raycast, Linear's `Cmd+K`). You type or fuzzy-search to switch
projects, open agents, send messages, toggle plugins, jump to settings. Output
appears in a transient pane that auto-hides; the bar always reclaims focus.

**Interaction logic.**
- Primary action: type a command / query.
- The command bar is always present (top, slim). `Cmd+K` focuses it; `Esc`
  returns focus. Commands: `>project <name>`, `>agent <name>`, `>send <msg>`,
  `>plugin toggle <n>`, `>settings`, `>lane new`.
- Output (terminal stream) opens in a transient pane below the bar that
  auto-dismisses on completion (or pins on `Shift+Enter`). Mouse is secondary.
- Mode-based: `normal` (browse results) vs `insert` (type a message to the active
  agent). `i` to insert, `Esc` to normal — Vim muscle memory.

**State machine:**
```
COMMAND_BAR ──type + Enter──▶ EXECUTE ──output──▶ TRANSIENT_PANE
     ▲                                                │
     │                                                ├──auto-dismiss──▶ COMMAND_BAR
     │                                                └──Shift+Enter──▶ PINNED ──Esc──▶ COMMAND_BAR
     │
     └──i──▶ INSERT(message to active agent) ──Enter──▶ EXECUTE
```

**Layout.** Top: command bar (full width, slim). Below: transient output pane
(takes remaining height when active; collapses to a thin status line when not).
No sidebar/drawer unless summoned. Status line: active project + agent + team +
busy/bg indicator.

**Trade-offs.**
- (+) Fastest for keyboard users; near-zero chrome noise.
- (+) Scales to many commands without UI clutter.
- (−) Steepest learning curve; unusable without knowing commands.
- (−) Discoverability is poor without a cheat-sheet / `?` help.
- (−) Mobile-hostile (no keyboard) — needs a touch fallback (tap bar → pick).

**For:** the keyboard-first power user / operator who lives in the terminal.

---

## Comparison matrix

| Axis | V1 Focus | V2 Dashboard | V3 Chat/Canvas | V4 Workspace IDE | V5 Console |
|------|----------|--------------|----------------|------------------|------------|
| Primary unit | single conversation | parallel lane | message + artifact | file + diff | typed command |
| Dominant surface | terminal | mosaic grid | transcript | explorer+diff | command bar |
| Input location | docked bottom | expanded lane | under transcript | bottom panel | top bar |
| Multi-agent | weak | **native** | medium | medium | medium |
| Keyboard-first | medium | low | low | medium | **native** |
| Mobile | great | good (stacked cards) | good (bottom sheet) | good (drawer) | good (touch bar) |
| Review/gate | none | status strip | artifact tabs | **accept/reject** | transient |
| Build cost | low | medium | medium | **high** | medium |
| Best for | deep single task | patrol/monitor | reading output | code editing | power ops |

## Recommendation

These are **directions**, not a forced choice. The current NanoCode UI is
closest to a hybrid of V1+V2 (focused terminal with multi-tab). The lowest-risk
high-value moves:

1. **Adopt V5's command palette** (`Cmd+K`) as an overlay on the current layout —
   addresses H6 (no global command surface) with minimal disruption.
2. **Adopt V2's per-lane status strip** as a tab-slot enhancement — makes
   background-turn + health legible (H8) without a full mosaic.
3. **Keep V3's "input near latest output"** as an option for long transcripts —
   a toggle to dock input under the transcript rather than under the terminal.

V4 (Workspace IDE) is the most ambitious and should be a separate track if
pursued, since it inverts the terminal-first model.

Mockups for all five live in `public/mockups/v1..v5.html` as static,
self-contained HTML prototypes (no build step) so each paradigm can be felt.

---

## Part E — Dual-viewport interaction maps (responsive pass)

All five mockups are now genuinely responsive: each has a `viewport` meta tag
and `@media` breakpoints. Below is the per-variant desktop vs phone (390×844)
interaction map. **Design constraints:** touch targets ≥44px, input font-size
≥16px (prevents iOS auto-zoom), no horizontal scroll at 390px (verified by
headless Playwright check — 0 overflow, 0 console errors on all 5).

### V1 — Focus Mode

| Aspect | Desktop (≥640px) | Phone (390×844) |
|--------|-----------------|-----------------|
| Switcher access | `Cmd/Ctrl+K` keyboard overlay | Tap the floating **pill** (project+tab+team) → opens switcher |
| Input | Slim input docked at bottom | 16px font, full-width, 44px send button |
| Kbd hints | Visible `⌘K` hint text | Hidden (no keyboard); pill is the affordance |
| Overflow | Pill floats top-right | Pill floats top-right, compact padding |

**Breakpoint:** `@media (max-width:640px)` — reduces padding, hides kbd hints,
enlarges pill to 44px tap target, input goes full-width 16px.

### V2 — Multi-Lane Dashboard

| Aspect | Desktop (≥900px) | Phone (390×844) |
|--------|-----------------|-----------------|
| Grid | 3-4 column mosaic | 1 column (stacked cards) |
| Expand lane | Lane takes ~70%, rail shows mini tiles | Lane expands to **full-screen overlay** (covers mosaic) |
| Collapse | `Esc` or click rail | Tap backdrop or close button |
| Tablet (600-900px) | — | 2 column grid |

**Breakpoints:** `@media (max-width:900px)` → 2 columns; `@media (max-width:600px)` → 1 column stacked, expanded lane = full-screen overlay.

### V3 — Chat-First / Canvas

| Aspect | Desktop (≥760px) | Phone (390×844) |
|--------|-----------------|-----------------|
| Canvas | Right-side panel (40% width, static) | **Bottom sheet** — slides up from bottom (`translateY(100%)` → `0`) |
| Close canvas | Click artifact tab or close button | Tap **✕ close** button (`.canvas-close`, mobile-only) |
| Transcript | Left 60%, scrolls independently | Full-width, canvas covers bottom portion when open |
| Input | Bottom of transcript, 40% width under transcript | 16px font, full-width, 44px send |

**Breakpoint:** `@media (max-width:760px)` — canvas transforms from static side panel to sliding bottom sheet with close button; `_syncCanvas()` JS toggles `.canvas.open`.

### V4 — Workspace IDE

| Aspect | Desktop (≥820px) | Phone (390×844) |
|--------|-----------------|-----------------|
| File tree | Left sidebar, persistent | **Drawer** — slides in from left, hidden by default |
| Open tree | Always visible | Tap **☰ hamburger** (`.menu-btn`, mobile-only) |
| Close tree | — | Tap backdrop (`.tree-backdrop`) or select a file |
| Diff/preview | Center-top, full height | Stacks below terminal (terminal shrinks) |
| Accept/Reject | Side buttons | Full-width 44px buttons |
| Terminal | Bottom panel, tabbed | Shrinks to make room for diff |

**Breakpoint:** `@media (max-width:820px)` — tree becomes a drawer with hamburger toggle + backdrop; diff and terminal stack vertically; accept/reject buttons go full-width 44px.

### V5 — Command Console

| Aspect | Desktop (≥640px) | Phone (390×844) |
|--------|-----------------|-----------------|
| Insert mode entry | `i` key | Tap **✉ insert toggle** (`.insert-btn`, mobile-only) |
| Suggestion rows | Keyboard-navigable, compact | Full-width 44px tap targets |
| Kbd help | Visible `?`/`Esc` hints | Hidden (no keyboard) |
| Output pane | Transient, auto-dismiss | Same (touch to dismiss) |

**Breakpoint:** `@media (max-width:640px)` — shows insert toggle button (✉), enlarges suggestion rows to 44px, hides keyboard help text. `enterInsert`/`exitInsert` JS toggles button active state.

### Responsive verification

Headless Playwright checks were run against a live 9478 server instance:

1. **Overflow check** — all 5 mockups + gallery at 390×844 and 1280×800:
   `scrollWidth ≤ clientWidth` (0 horizontal overflow), 0 console errors. ✅
2. **Affordance check** — mobile-only elements (`.canvas-close`, `.menu-btn`,
   `.tree-backdrop`, `.insert-btn`) are `display:none` at 1280px and visible at
   390px; shared elements (`.pill`, `.lane`) visible at both. ✅
