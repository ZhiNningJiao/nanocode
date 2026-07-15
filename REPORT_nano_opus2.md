# REPORT: nano_opus2 -- Historian Plugin + User Manual

## Task Summary
1. **Historian Health Plugin** -- full monitor plugin for the waker system
2. **Nanocode User Manual** -- onboarding document at `docs/USER_MANUAL.md`

## Deliverables

### Task 1: Historian Health Plugin

New files:
- `server/historian.js` -- Backend: reads `army_status.json`, `waker.log` tail, waker health (tmux alive, singleton lock, mode, last tick age, stats)
- `server/waker-control.js` -- Backend: start/stop/restart waker tmux session, LIVE/DRY mode switching
- `public/js/historian-panel.js` -- Frontend panel renderer with 4 sections:
  1. **Waker Health card** -- tmux alive/dead, lock status, mode, auto-live, last tick age (red warning if >10min stale)
  2. **Army Fleet table** -- reads `~/codex_work/army_status.json` (tag, iter, last_active, status dot, last line)
  3. **Briefing Stream** -- `waker.log` tail (most recent first), pre-formatted
  4. **Controls** -- Start/Stop button, LIVE/DRY toggle, with flash status feedback

Modified files:
- `server/index.js` -- Added 5 API routes: `GET /api/historian/state`, `GET /api/historian/briefing`, `POST /api/historian/waker/{start,stop,restart}`
- `public/js/plugins-registry.js` -- Added `historian` manifest (monitor group, refreshOnActivate)
- `public/js/right-panel.js` -- Added lazy-load entry for historian-panel
- `public/js/i18n.js` -- Added 16 i18n keys (en + zh) for the historian plugin
- `public/style.css` -- Added ~40 lines of historian-specific CSS (table, status dots, log viewer, controls, flash, degraded dot)

Plugin characteristics:
- **Optional** -- zero impact when waker is not running; degrades to calm "stopped" state
- **Read-only** -- follows historian red line: never modifies waker internals
- **Lazy-loaded** -- module only fetched when tab is first activated
- **Polls every 15s** -- gentle on the system
- **refreshOnActivate** -- data refreshes each time the tab is switched to

### Task 2: User Manual

`docs/USER_MANUAL.md` -- 10 sections covering:
- Quick start, port conventions (9475/9476/9477/949x), hot-swap deploy
- Sessions & tabs (claude/codex/opencode), render modes (block/terminal)
- Resume & recovery (deaf window fix, auto-resume, persistence)
- Team switching & usage monitoring
- TTS (stale-drop behavior, muting)
- akari inspector panel
- Historian (waker) plugin
- Plugin system overview (all 11 built-in plugins)
- Common troubleshooting table (7 scenarios with fixes)

## Verification

- **562/0 pass** -- full `npm test` suite (`node --test server/tests/*.test.js`)
- **Server start** -- `PORT=9477 node server/index.js` starts clean
- **API endpoints** -- `/api/historian/state` returns army + logTail + wakerHealth
- **JS served** -- `/js/historian-panel.js` returns 200
- **Existing tests preserved** -- plugins-registry.test.js (22/22), akari-proxy.test.js (20/20)
