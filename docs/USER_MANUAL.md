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
| Codex | Codex SDK | Terminal (default) or Block (experimental) |
| Fable5/OpenCode | `opencode` CLI | Block (default) or Terminal (TUI raw) |

### Render Modes

Switch via **Settings > Session > Render Mode**:
- **Block mode**: Rich text rendering with foldable sections, copy buttons, markdown formatting. Best for reading long outputs on mobile.
- **Terminal mode**: Raw PTY output via xterm.js canvas. Best for TUI applications (opencode, vim, htop).

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

1. **Waker Health**: tmux session alive/dead, singleton lock status, mode (LIVE/DRY), auto-live flag, last tick age (red warning if >10 min stale)

2. **Army Fleet Table**: Real-time agent fleet status from `~/codex_work/army_status.json`:
   - Tag (task name)
   - Iteration count
   - Last active time
   - Status: running (green), STALL (yellow, >25min idle), FLAG (blue, completed)
   - Last output line

3. **Briefing Stream**: Tail of `waker.log` showing recent historian briefings -- what was injected, what was skipped, gate reasons (min gap, hourly cap, busy)

4. **Controls**:
   - **Start/Stop**: Launch or kill the waker tmux session
   - **LIVE/DRY switch**: LIVE = inject briefings into the secretary session; DRY = log only, no injection

### Waker Modes

| Mode | Behavior |
|------|----------|
| DRY | Default on fresh start. Logs briefings but never injects. Auto-promotes to LIVE after 3 successful dry ticks. |
| LIVE | Active injection into the secretary session via WS claude-input. |

### Cadence

- Work hours (09:00-19:30 Beijing): every 4.5 minutes
- Off hours: every 20 minutes
- Gate: min 270s between injections, max 15/hour, skip if user typed < 60s ago

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

---

## Keyboard & Navigation Tips

- **Ctrl+Shift+`** (backtick): Toggle right panel open/close
- Click a tab name in the tab bar to switch sessions
- Right-click a tab for context menu (close, rename, etc.)
- The right panel has two domains: **Work** (top) and **Monitor** (bottom) -- switch with the domain buttons at the top of the panel

---

*This manual covers nanocode as of 2026-07-16. For architecture details, see `docs/architecture.md`. For the historian waker spec, see `~/code/worker-core/HISTORIAN_WAKER.md`.*
