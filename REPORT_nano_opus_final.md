# REPORT_nano_opus_final -- Opus handoff (2026-07-15/16)

## Status: COMPLETE

**Branch**: `zhining/nano-integration-0715-v2` @ `ab4629d`
**Fork main**: pushed (`559ec8c..ab4629d`, fast-forward)
**9476**: Live with all fixes (PID 277196), health OK
**9475**: Untouched
**Tests**: 618/0 pass

## What's deployed on 9476

| Feature | Commit | Status |
|---------|--------|--------|
| Akari inspector panel (MES-14049) | merged | LIVE |
| 3 prototypes (MES-14031) | merged | LIVE |
| TTS stale-drop | merged | LIVE |
| Input seat fix (PTY resize primary-only) | `2b3c4f7` | LIVE |
| Mobile scroll fix (touch handler dispose) | `8ba610c` | LIVE |
| Historian plugin (monitor tab) | `94d89ff` | LIVE |
| Native waker via tmux | `94d89ff` | LIVE |
| **Desktop input busy-state resync** | `b588574` | **LIVE (just deployed)** |

## Desktop input fix deployment note

The previous Opus session committed the fix at `b588574` and reported it deployed, but the 9476 runtime at `~/.nanocode-9476-runtime` was still at `94d89ff` without the fix files. This session:

1. Confirmed `busy-state` was missing from runtime's `claude-session-controller.js`
2. Copied 3 fixed files from integration branch to runtime
3. Restarted 9476 (kill old PID 263206 -> new PID 277196)
4. Verified health + all endpoints (akari, historian, waker)

**User action**: Refresh any open 9476 browser tabs to get the new frontend JS.

## Endpoints verified on 9476

| Endpoint | Result |
|----------|--------|
| `/api/health` | 200 `{"status":"ok"}` |
| `/api/akari/config` | 200 `{serverUrl:9481, lensUrl:9482}` |
| `/api/historian/briefing` | 200 (341 loops, 377 flags, 6 tmux) |
| `/api/waker/status` | 200 (disabled by default) |

## 9475 upgrade guide

1. `kill $(lsof -t -i:9475)`
2. `cd ~/.nanocode-9476-runtime && PORT=9475 node server/index.js &`
   (or checkout `ab4629d` in your nanocode repo)
3. Secretary sessions resume via `/resume`

## User-side workaround if desktop input gets stuck

Switch to another tab (Tab key) then switch back. The tab-switch handler queries the renderer's ground-truth thinking state and corrects the input bar. After refreshing to get the new frontend, this should no longer happen (the server now sends `busy-state` on attach).
