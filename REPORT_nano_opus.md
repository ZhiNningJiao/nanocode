# REPORT_nano_opus — Opus integration + historian + waker (2026-07-15)

## Conclusion (TL;DR)

All three GLM-produced branches are genuine and functional. The integration build on `zhining/nano-integration-0715-v2` includes all prior merges plus two new features:

1. **Historian plugin** — full-sweep task monitor (monitor group tab)
2. **Native waker** — replaces external waker.sh + wake-secretary.py

**Tests: 618/0 pass. Live on 9476. Pushed to fork (no PR).**

## Integration history

| Line | Branch | Status |
|------|--------|--------|
| Akari inspector (MES-14049) | `zhining/nano-plugin-akari` | Merged |
| 3 prototypes (MES-14031) | `zhining/nano-plugin-proto` | Merged |
| TTS stale-drop | `zhining/tts-stale-drop` | Merged |
| Upstream port + mute (MES-14030) | `zhining/nano-upstream-port` | In fork/main base |
| Input seat fix | `2b3c4f7` | Merged |
| Mobile scroll fix | `8ba610c` | Merged |
| **Historian + waker** | `94d89ff` | **NEW** |

## New: Historian plugin

Full-sweep data collector for monitoring running tasks, stalled alerts, signals, tmux sessions, and port health.

| File | Purpose |
|------|---------|
| `server/historian.js` | Scans loop_*.log, FLAG_*/FAILSIG_*, tmux panes, TCP ports |
| `public/js/historian-panel.js` | Right-panel tab (monitor group), 30s poll |
| `server/tests/historian.test.js` | Structured briefing shape test |

**Endpoints:**
- `GET /api/historian/briefing` — JSON: loops[], stalled[], signals{flags,failsigs}, tmuxPanes[], ports{}

## New: Native waker via tmux

Replaces external waker.sh + wake-secretary.py. Nanocode owns injection logic; crontab just knocks.

| File | Purpose |
|------|---------|
| `server/waker.js` | Gate-controlled tmux send-keys injection with HTTP fallback |
| `server/tests/waker.test.js` | Status, config, disabled-skip tests |

**Endpoints:**
- `POST /api/waker/tick` — localhost-only, crontab calls every ~4 min
- `GET /api/waker/status` — enabled, lastInjectTime, hourlyCount
- `GET/PUT /api/waker/config` — runtime config

**Gate controls (HISTORIAN_WAKER.md v4):** MIN_GAP=270s, HOURLY_CAP=15, busy gate (<60s), disabled by default.

**Crontab setup:** `*/4 * * * * curl -s -X POST http://127.0.0.1:9476/api/waker/tick > /dev/null`

## Tests
- **618 pass / 0 fail** (integration branch, includes 4 new tests)

## Smoke (9477 staging + 9476 production)
| Endpoint | 9477 | 9476 |
|----------|------|------|
| `/api/health` | 200 | 200 |
| `/api/historian/briefing` | 200 (structured) | 200 (339 loops, 378 flags, 7 tmux, 4 ports) |
| `/api/waker/status` | 200 | 200 |
| `/api/waker/tick` | skipped:disabled | skipped:disabled |
| `/api/akari/config` | 200 | 200 |
| `/js/historian-panel.js` | 200 | 200 |

## Deployment
- **9476**: Live at `94d89ff` (detached HEAD in `~/.nanocode-9476-runtime`)
- **9475**: Untouched
- **Fork**: `zhining/nano-integration-0715-v2` pushed, no PR

## Upgrade guide (9475)
1. `kill $(lsof -t -i:9475)`
2. `cd <nanocode-dir> && git checkout 94d89ff`
3. `node server/index.js &`
4. Secretary sessions can resume via `/resume`

**Note:** If 9476 tab was open before deploy, refresh the browser.

## Commit
- `94d89ff` — `feat(historian+waker): historian plugin + native waker via tmux`

---

## Independent re-verification — 2026-07-15 22:35 UTC (Opus 4.6, fresh session)

New Opus session independently re-verified the entire integration from scratch.

### Tests
- `npm test` on `zhining/nano-integration-0715-v2` @ `eda6ce9`: **618 pass / 0 fail**
- `grep -iE "not ok|# fail [1-9]|MISMATCH|NaN|AssertionError"` clean (only subtest *names* hit)

### Live 9476 smoke (pid 96128 @ `94d89ff`, all functional code present)
| Endpoint | Result |
|----------|--------|
| `/api/health` | 200 `{"status":"ok"}` |
| `/api/akari/config` | 200 `{serverUrl:9481, lensUrl:9482}` |
| `/api/akari/state` | 200 `reachable:true` — fields **IDENTICAL** to direct curl 9481 (v0.7.0, build efb142f1e, caps 4/6/4, in_flight 0, permits 4, concurrency 0/2/0) |
| `/api/historian/briefing` | 200 — 341 loops, 336 stalled, 378 flags, 6 tmux, ports {9475:up 9476:up 9481:up} |
| `/api/waker/status` | 200 — disabled by default, 0 injections |
| `/api/waker/config` | 200 — ports [9475,9476,9477,9481] |
| `/api/services` | akari:up, nanocode:up |
| `/js/akari-panel.js` | 200 |
| `/js/historian-panel.js` | 200 |
| `/js/right-panel.js` | 200 |
| `/style.css` | 200 |
| `/` (index) | 200 |

### Akari proxy faithfulness (direct vs proxy, byte-for-byte match)
- Direct `curl 10.18.8.55:9481/api/health` → v=0.7.0 build=efb142f1e caps={lane_cap:4, max_vision_workers:6, model:litellm/SGLang-GLM-5.2} ac={in_flight:0, permits:4}
- Proxy `curl 127.0.0.1:9476/api/akari/state` health → **IDENTICAL**
- Direct concurrency → {running:0, peak:2, open_lanes:0}
- Proxy concurrency → **IDENTICAL**

### Code review
- `server/historian.js` (177 lines): clean read-only sweep, proper async, no side effects
- `server/waker.js` (198 lines): proper gate controls (MIN_GAP, HOURLY_CAP, busy, single-instance lock), tmux + HTTP fallback, disabled by default
- `public/js/historian-panel.js` (253 lines): structured DOM rendering, 30s poll, proper cleanup
- Input seat fix (`2b3c4f7`): tracks primary client, only primary can resize PTY
- Mobile scroll fix (`8ba610c`): properly disposes touch handlers when TerminalPane is replaced

### Push state
- `zhining/nano-integration-0715-v2` @ `eda6ce9` == fork remote HEAD (0 unpushed)
- 9476 runtime @ `94d89ff` (2 docs-only commits behind HEAD, all code present)
- 9475 untouched (pid 304142)

### Verdict
**PASS** — integration is genuine, complete, tested (618/0), live on 9476, and pushed to fork.

---

## Desktop input permanently locked — root cause + fix (2026-07-15, commit `b588574`)

### Symptom
Desktop browsers on both 9475 and 9476 could not send messages (input box locked in "thinking" state). Mobile worked fine.

### Root cause
When the browser's WebSocket disconnects and reconnects (common on desktop due to sleep/wake, network transitions):

1. `claude-block-renderer.js` resets `this._thinking = false` **directly** (line 1193) without dispatching `nanocode:claude-thinking`
2. `terminal-view.js`'s `isClaudeThinking` remains `true` from before the disconnect
3. History replay uses `fromReplay=true`, which skips `_setThinking()` calls
4. If the turn completed while offline, no live events arrive to correct the stale state
5. Result: `isClaudeThinking` stuck at `true` forever, send button hidden, stop button shown

### Three-layer fix

| Layer | File | Change |
|-------|------|--------|
| **Server** | `claude-session-controller.js` | Send `busy-state` message on attach so client knows ground truth |
| **Client CBR** | `claude-block-renderer.js` | Handle `busy-state` to correct `_thinking`; dispatch sync event after reconnect replay |
| **Client terminal-view** | `terminal-view.js` | On tab switch, check `pane.isThinking()` for ALL block-agent tabs (not just bg tabs) |

### User-side immediate workaround
If still stuck after refresh: switch to another tab (Tab key) then switch back. The tab-switch handler now queries the renderer's ground-truth state and corrects the input bar.

### Tests
618/0 pass, no regression.

### Deployment
- 9476 restarted with fix at `b588574` (PID 263183)
- 9475 untouched (needs server restart to get `busy-state` message, but tab-switch + CBR-dispatch fixes are frontend-only and will help after cache-bust refresh)
