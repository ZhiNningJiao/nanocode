# REPORT_nano_opus v3 — Bug Fixes + Redeployment

Branch: `zhining/nano-integration-0715-v2` (pushed to fork)
Deployed to: **9476** (PID 49993)

## What changed since v2

### 1. Mobile scroll fix (`8ba610c`)

**Root cause**: When `renderMode='block'`, `TerminalPane` is created first with touch handlers via `_initTouchScroll()` on the container element. When `ClaudeBlockRenderer` replaces it, `dispose()` never removed these handlers. The old `touchmove` handler called `e.preventDefault()`, blocking native scroll on the `.cbr-scroll` div.

**Fix**: Store handler references in `_touchStartHandler`/`_touchMoveHandler`/`_touchEndHandler` and remove them in `dispose()`.

**File**: `public/js/terminal-pane.js`

### 2. Input seat fix (already in v2, now deployed)

**Root cause** (commit `2b3c4f7`): `Session.attach()` unconditionally resized PTY on every client attach. When wake-secretary connected with 80x24, it clobbered the browser's terminal dimensions.

**Fix**: Track primary (first-attached) client; only honour resize from primary. On primary disconnect, promote next client.

**File**: `terminal/sessions.js`

### 3. Deployment

Killed old 9476 process (PID 5883, running v1 without either fix). Copied both fixed files to `~/.nanocode-9476-runtime/` and restarted. Log at `~/code/nano9476.log`.

## Verification

| Check | Result |
|-------|--------|
| `npm test` on v2 | 614/0 pass |
| `curl localhost:9476/api/health` | `{"status":"ok"}` |
| `curl localhost:9475/api/health` | `{"status":"ok"}` (untouched) |
| `/api/akari/config` | serverUrl 9481, lensUrl 9482 |
| `/api/akari/state` | reachable=True, version=0.7.0 |
| `/api/services` | nanocode=up, akari checked |
| `sessions.js` primaryClient grep | 5 matches (fix present) |
| `terminal-pane.js` touchContainer grep | 8 matches (fix present) |

## Notes for the user

- **If you had 9476 open in a browser tab, refresh it** to pick up the new frontend JS
- Mobile scroll should now work in block render mode (the default for your config)
- Desktop input should work even when wake-secretary connects
- 9475 was NOT touched at any point
