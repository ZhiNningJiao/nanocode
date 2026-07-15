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
