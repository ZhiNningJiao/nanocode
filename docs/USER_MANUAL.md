# Nanocode User Manual

> Web terminal workstation for managing AI coding agents (Claude Code, Codex, OpenCode/Fable5).
> Last updated: 2026-07-16

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Port Conventions](#port-conventions)
3. [Sessions & Tabs](#sessions--tabs)
4. [Resume & Recovery](#resume--recovery)
5. [Team Switching & Usage](#team-switching--usage)
6. [TTS Voice Playback](#tts-voice-playback)
7. [akari Inspector Panel](#akari-inspector-panel)
8. [Historian (Waker) Plugin](#historian-waker-plugin)
9. [Plugin System Overview](#plugin-system-overview)
10. [Common Troubleshooting](#common-troubleshooting)

---

## Quick Start

Open your browser and navigate to:

```
http://<server-ip>:9475
```

You'll see the nanocode workstation with:
- **Left sidebar**: project list, tab management
- **Center**: terminal panes (xterm.js) for your AI sessions
- **Right panel**: plugins (team/model, usage, memory, services, akari, historian, etc.)

---

## Port Conventions

| Port | Purpose | Notes |
|------|---------|-------|
| **9475** | Production server | The always-on primary instance. **Never kill this manually.** |
| **9476** | Hot-swap deploy target | Used during zero-downtime deploys (start 9476, verify, swap to 9475, stop 9476). |
| **9477** | Smoke test port | Used for automated testing before deploys. |
| **949x** | Test segment | Ports 9490-9499 reserved for integration tests and Playwright smoke tests. |
| **9480** | Codex provider | Codex sessions use this port range. |
| **9481** | akari dispatch server | Self-hosted akari dispatch (axum). |

### Hot-swap Deploy Procedure

1. `PORT=9476 node server/index.js &` -- start new instance
2. Verify: `curl http://localhost:9476/api/health`
3. Kill old: `kill $(lsof -t -i:9475)`
4. `node server/index.js &` -- start on default 9475
5. Verify 9475, then stop 9476.

**Rule: Always have at least one port serving.**

---

## Sessions & Tabs

### Creating Sessions

- Click **"+ New Tab"** or use the tab bar dropdown
- Choose agent type: **claude**, **codex**, or **opencode/fable5**
- Each tab is an independent session with its own PTY

### Session Types

| Type | Engine | Render Mode |
|------|--------|-------------|
| Claude | `claude` CLI | Block (rich text, default) or Terminal (PTY raw) |
| Codex | Codex SDK | Terminal (default) or Block (SDK-driven, see below) |
| Fable5/OpenCode | `opencode` CLI | Block (default) or Terminal (TUI raw) |

### Render Modes

Switch via **Settings > Session > Render Mode**:
- **Block mode**: Rich text rendering with foldable sections, copy buttons, markdown formatting. Best for reading long outputs on mobile.
- **Terminal mode**: Raw PTY output via xterm.js canvas. Best for TUI applications (opencode, vim, htop).

### Codex Block Rendering (SDK Mode)

When the Codex SDK driver is active, codex tabs use **structured event rendering** instead of raw PTY text:

- **Agent messages**: Rendered as markdown with code blocks, syntax highlighting, and **copy buttons** on each code fence
- **Command execution**: Foldable blocks showing the command, live "running..." status, exit code (green checkmark or red X), and **HH:MM:SS timestamps**. Successful commands (exit 0) **auto-fold** to save screen space
- **File changes**: Diff blocks with **LCS-based diffing** (same quality as Claude tab) showing added/removed/unchanged lines with **line numbers** and context collapse
- **Reasoning blocks**: Collapsible thinking summaries with markdown rendering, elapsed time badge, and first-sentence preview when folded
- **MCP tool calls**: Blocks for external tool invocations via Model Context Protocol, showing tool name, server, arguments, and success/error status
- **Web search**: Visual indicator when Codex performs web searches
- **Usage/token display**: End-of-turn token usage (input, output, cached, reasoning tokens) shown below each turn separator
- **Thinking indicator**: Animated dot with elapsed timer showing how long Codex has been processing
- **Turn separators**: Visual dividers between conversation turns with a notification event for the alert system
- **Smart auto-scroll**: Auto-scrolling pauses when you scroll up to read earlier output, and resumes when you click the scroll-to-bottom button or send new input
- **Copy output buttons**: Every command block, response block, and sync-output block has a "Copy" button in the header for one-click clipboard copy
- **Fold states**: Click any block header to cycle between full/header/line views (persisted in localStorage). **Ctrl+Shift+F** toggles all blocks open/closed at once
- **PTY text markdown**: Even in PTY mode (non-SDK), text output is rendered as markdown with syntax highlighting and copy buttons
- **Session stats bar**: Live counters for total blocks, commands, file changes, turns, and errors (click error count to jump to last error)
- **Search in blocks** (Ctrl+G): Opens a search overlay to find text across all rendered blocks. Use Enter/Shift+Enter to navigate matches. Also accessible via the search icon in the stats bar
- **File change grouping**: When multiple file changes arrive in quick succession, they are automatically grouped under a collapsible "N files changed" header showing affected paths
- **File path & URL auto-linking**: File paths and URLs in agent messages and PTY output are automatically detected and made clickable. File paths open in the explorer; URLs open in new tabs
- **Word-level inline diff**: Adjacent removed/added lines in file change diffs show word-level highlights to pinpoint exactly what changed within a line
- **Expandable diff context**: Collapsed "N unchanged lines" sections in diffs are clickable to reveal the hidden lines in-place
- **Rate-limit indicator**: Displays a countdown when the model is rate-limited

---

## Resume & Recovery

### "Can't send messages" / Deaf Window

**Symptom**: The terminal tab appears active but messages won't send. Cursor blinks but input doesn't reach the agent.

**Fix**: Open a **new browser tab** and navigate to nanocode. Your sessions are preserved server-side. The new tab will reconnect to the same sessions via WebSocket. Close the old "deaf" tab.

**Why this happens**: WebSocket connections can drop silently (network hiccup, browser sleep on mobile). The terminal looks alive (cursor blinking) but the input channel is dead.

### Auto-Resume

When a Claude session exits (completes a task), nanocode can auto-resume it with `--continue`:
- Enable in **Settings > Session > Auto-Resume**
- A 3-second countdown appears before resuming (click to cancel)
- Useful for long-running agent loops

### Session Persistence

- Sessions survive page refreshes (server keeps the PTY alive)
- Sessions survive server restarts only if the underlying `claude`/`codex` process is still running in tmux
- Use `--resume` flag when restarting a claude session manually

---

## Team Switching & Usage

### Teams

Nanocode supports multiple Anthropic teams (organizations). Each team has its own API quota.

- **Default Team (team1)**: `~/.claude` -- primary org
- **Team 2**: `~/.claude-team2` -- secondary org for overflow

Switch teams via **Work > Team & Model** in the right panel:
- **Global switch**: Changes the default for all new sessions
- **Per-session switch**: Moves the current active Claude tab to another team (copies transcript + switches org)
- **Auto-failover**: Enable the toggle to automatically switch teams on 429 / rate-limit errors

### Usage Monitoring

The **Usage** tab (Monitor domain) shows:
- **AIGW Budget**: Remaining dollars, progress bar, tier badge, reset date
- **Per-source breakdown**: Team1, Team2, AIGW usage with 5h/weekly/monthly windows
- **Claude Token usage**: Input/output/cache tokens from JSONL logs
- **OpenCode usage**: SQLite session token counts
- **AIGW Cost Probe**: One-click probe to measure AIGW API cost

---

## TTS Voice Playback

Nanocode integrates with a local GPT-SoVITS v3 service for text-to-speech.

### How It Works

Agent output wrapped in `[TTS_START]...[TTS_END]` tags is extracted and sent to the TTS service. The audio plays automatically in the browser.

### Stale-drop Behavior

If TTS audio arrives after the user has scrolled past or a new message has appeared, the audio is **dropped** (not queued) to avoid annoying delayed playback. This is intentional.

### Muting

- Toggle TTS on/off via **Monitor > Plugin Manager > TTS > Settings**
- Or use the `ttsEnabled` localStorage key: `localStorage.setItem('ttsEnabled', 'false')`

### Configuration

Via the TTS plugin settings panel:
- **Reference audio**: Path to the reference voice WAV file
- **Prompt text**: The prompt text for voice cloning
- **Streaming**: Enable/disable chunked streaming mode (lower latency)

---

## akari Inspector Panel

The **akari** tab (Monitor domain) provides real-time monitoring of the self-hosted akari dispatch server.

### What It Shows

- **Health**: Version, build commit, dispatch caps, agent concurrency, fallback status, instance token counters
- **Concurrency**: Running workers, peak, open lanes
- **Workers Table**: Live worker status -- ID, state (running/done/failed/queued), model, turn count, tool calls, elapsed time, tokens in/out, current activity
- **Lanes / Fleet**: Lane pool state -- ID, state (Free/InUse/Finishing), marker, head commit, occupant

### Behavior

- Polls every 10 seconds (gentle on the server)
- When akari is unreachable: shows a calm "unreachable" state with dimmed dot -- no error spam
- Auto-recovers when akari comes back online
- Click **"Lens"** button to open the akari web dashboard in a new tab

---

## Historian (Waker) Plugin

The **Historian** tab (Monitor domain) monitors the external waker system (`waker_core.py` / `waker.sh`) that produces structured briefings.

### What It Shows

1. **Waker Health**: tmux session alive/dead, singleton lock status, mode (LIVE/DRY), auto-live flag, last tick age (red warning if >10 min stale), akari status (up/down)

2. **Waker Usage**: Parsed stats from the waker state directory:
   - **Beats**: Total tick count since the waker started
   - **Skipped**: Total skipped injections, broken down by reason (busy = agent was typing, quiet = heartbeat quiet, rate = hourly cap hit)
   - **Injected**: Total successful briefing injections
   - **Dry ticks**: Number of dry ticks completed (auto-promotes to LIVE after 3)
   - **Gate stats**: Injection gate counters (gap = too soon after last inject, cap = hourly limit hit, busy = user was typing)
   - **Interval**: Current cadence mode (day/night/auto or custom seconds)
   - **Coverage**: List of agent tags currently monitored by the waker

3. **Army Fleet Table**: Real-time agent fleet status from `~/codex_work/army_status.json`:
   - Tag (task name)
   - Iteration count
   - Last active time
   - Status: running (green), STALL (yellow, >25min idle), FLAG (blue, completed)
   - Last output line

4. **Briefing Stream**: Tail of `waker.log` showing recent historian briefings -- what was injected, what was skipped, gate reasons (min gap, hourly cap, busy)

5. **Controls**:
   - **Start/Stop**: Launch or kill the waker tmux session
   - **LIVE/DRY switch**: LIVE = inject briefings into the secretary session; DRY = log only, no injection
   - **Day/Night/Auto interval**: Set waker tick cadence manually or let it auto-select based on time of day

### Waker Modes

| Mode | Behavior |
|------|----------|
| DRY | Default on fresh start. Logs briefings but never injects. Auto-promotes to LIVE after 3 successful dry ticks. |
| LIVE | Active injection into the secretary session via WS claude-input. |

### Cadence

- Work hours (09:00-19:30 Beijing): every 4.5 minutes (270s)
- Off hours: every 20 minutes (1200s)
- Gate: min 270s between injections, max 15/hour, skip if user typed < 60s ago

The interval buttons in the Controls section let you override this:
- **Day (4.5m)**: Force work-hour cadence (WAKE_WORK_INTERVAL=270, WAKE_OFF_INTERVAL=270)
- **Night (20m)**: Force off-hour cadence (WAKE_WORK_INTERVAL=1200, WAKE_OFF_INTERVAL=1200)
- **Auto**: Remove the override, let waker auto-select based on current Beijing time

The currently active interval button is highlighted (blue). The Stop button requires confirmation to prevent accidental shutdown.

### Historian as an Optional Plugin

The historian is a standard nanocode plugin (group: `monitor`). It can be enabled/disabled in **Plugin Manager** like any other plugin. When disabled, no historian tab appears and no polling occurs. When the waker is not running, the panel degrades to a calm "stopped" state with a Start button.

### akari Status Row

The historian health card includes an **akari** status indicator (up/down). This is a quick-glance check -- for detailed akari monitoring (workers, lanes, concurrency), use the dedicated akari plugin tab.

---

## Plugin System Overview

Nanocode uses a plugin architecture for the right panel. Each plugin has:
- **Manifest**: name, version, apiVersion, group (work/monitor), permissions
- **Tab**: Optional -- plugins with tabs appear in the right panel; settings-only plugins (notify, tts) appear only in the Plugin Manager

### Built-in Plugins

| Plugin | Group | Type | Description |
|--------|-------|------|-------------|
| team-model | work | tab | Team switching + model selection (AIGW, Claude, Codex, effort) |
| usage | monitor | tab | Token usage, AIGW budget, cost probe |
| memory | work | tab | Browse Claude memory files across teams/projects |
| persona | work | tab | Persona (system prompt) management |
| compare | work | tab | Git branch diff comparison |
| remote | monitor | tab | Remote machine address book (RustDesk launcher) |
| services | monitor | tab | Port health monitoring grid |
| akari | monitor | tab | akari dispatch server inspector |
| historian | monitor | tab | Waker/historian health and army fleet status |
| notify | monitor | settings | ntfy push notification configuration |
| tts | monitor | settings | GPT-SoVITS voice configuration |

### Enabling/Disabling Plugins

Go to **Monitor > Plugin Manager**. Toggle the switch for each plugin. Disabled plugins remove their tab; re-enabling mounts it back. Settings-only plugins are always shown in the manager.

---

## Common Troubleshooting

### "Deaf window" -- can't type or send messages

**Cause**: WebSocket disconnected silently.
**Fix**: Open nanocode in a new browser tab. Close the old one.

### Double-open / seat conflict

**Cause**: Two browser tabs connected to the same session.
**Fix**: Close duplicate tabs. Each session should have exactly one active WebSocket connection. The server warns about duplicate connections in the console.

### Session won't start / "No claude process"

**Cause**: The `claude` CLI is not installed or not in PATH; or the team config dir doesn't exist.
**Fix**:
1. Check: `which claude` -- should return a path
2. Check team dir: `ls ~/.claude/` or `ls ~/.claude-team2/`
3. Check auth: `claude auth status`

### TTS not working / circuit breaker open

**Cause**: GPT-SoVITS service is down or slow.
**Fix**:
1. Check TTS service: `curl http://127.0.0.1:9880/tts` -- should respond
2. The circuit breaker auto-recovers after 30s cooldown
3. Check status: `curl http://localhost:9475/api/tts/status`

### akari panel shows "unreachable"

**Cause**: akari dispatch server is down or the URL is wrong.
**Fix**:
1. Check directly: `curl http://10.18.8.55:9481/api/health`
2. Verify URL in personal config: `~/.nanocode/personal.json` > `akari.serverUrl`
3. The panel auto-recovers when akari comes back (polls every 10s)

### Historian shows "dead" / no army data

**Cause**: Waker tmux session not running.
**Fix**:
1. Check: `tmux has-session -t waker`
2. Start via the Historian panel controls, or manually: `tmux new-session -d -s waker 'bash ~/code/waker.sh'`
3. Crontab self-heal: `*/5 * * * * tmux has-session -t waker 2>/dev/null || tmux new-session -d -s waker 'WAKE_LIVE=1 bash ~/code/waker.sh'`

### Port 9475 accidentally killed

**Emergency**: Start a new instance immediately:
```bash
cd ~/code/nanocode && node server/index.js &
```
Active sessions (PTY processes) survive the server restart; WebSocket reconnects restore the UI.

### Usage shows "unavailable" for a source

**Cause**: The API source (AIGW, OAuth) is down or the token expired.
**Fix**: This is honest degradation -- nanocode shows what's available and labels unavailable sources clearly. Check the specific source's health independently.

### Historian shows stale tick warning (yellow)

**Cause**: Waker is alive but hasn't ticked in >10 minutes. Could be stuck in a long data collection, rate-limited, or the waker_core.py process crashed inside the tmux session while tmux session survives.
**Fix**:
1. Check the tmux pane: `tmux attach -t waker` -- look for errors or hung state
2. If crashed: `tmux kill-session -t waker` then restart via the panel
3. If rate-limited: wait for the rate window to reset (usually <5 minutes)

### Interval buttons don't seem to take effect

**Cause**: The interval override is written to `~/code/.waker_env`, but the running waker process only reads it on the next tick. Changes take effect on the *next* waker cycle, not immediately.
**Fix**: Wait for one tick cycle (up to the current interval duration). Or restart the waker via the controls to pick up the new interval immediately.

### Waker injects but secretary doesn't respond

**Cause**: The secretary claude session may have exited or be in a "deaf" state.
**Fix**:
1. Check that the secretary session is alive in the tab bar
2. If the tab shows "exited", open a new session and resume
3. The waker's inject mechanism uses WebSocket `claude-input` -- if the WS is dead, injection silently fails. Check waker.log for "inject failed" entries.

---

## Keyboard & Navigation Tips

- **Ctrl+Shift+`** (backtick): Toggle right panel open/close
- **Ctrl+G**: Open search overlay in codex block renderer (search through blocks)
- **Ctrl+Shift+F**: Toggle fold all blocks open/closed (codex block renderer)
- **Ctrl+C** (in codex tab): Sends interrupt via POST API to properly stop the agent
- Click a tab name in the tab bar to switch sessions
- Right-click a tab for context menu (close, rename, etc.)
- The right panel has two domains: **Work** (top) and **Monitor** (bottom) -- switch with the domain buttons at the top of the panel

---

*This manual covers nanocode as of 2026-07-16. For architecture details, see `docs/architecture.md`. For the historian waker spec, see `~/code/worker-core/HISTORIAN_WAKER.md`.*
