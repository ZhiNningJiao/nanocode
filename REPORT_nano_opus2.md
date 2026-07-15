# REPORT: nano_opus2 -- Historian Plugin + User Manual

## Task Summary
1. **Historian Health Plugin** -- full monitor plugin for the waker system
2. **Nanocode User Manual** -- onboarding document at `docs/USER_MANUAL.md`
3. **Playwright Smoke Tests** -- desktop + mobile viewport e2e coverage

## Deliverables

### Task 1: Historian Health Plugin

New files:
- `server/historian.js` -- Backend: reads `army_status.json`, `waker.log` tail, waker health (tmux alive, singleton lock, mode, last tick age, stats, coverage, dry count)
- `server/waker-control.js` -- Backend: start/stop/restart waker tmux session, LIVE/DRY mode switching, day/night interval control
- `public/js/historian-panel.js` -- Frontend panel renderer with 5 sections:
  1. **Waker Health card** -- tmux alive/dead, lock status, mode, auto-live, last tick age (red warning if >10min stale), akari status
  2. **Waker Usage row** -- parsed stats (beats, skip reasons: busy/quiet/rate), dry ticks, coverage list
  3. **Army Fleet table** -- reads `~/codex_work/army_status.json` (tag, iter, last_active, status dot with color, last line)
  4. **Briefing Stream** -- `waker.log` tail (most recent first), pre-formatted monospace
  5. **Controls** -- Start/Stop, LIVE/DRY toggle, Day/Night/Auto interval buttons, flash feedback
- `server/tests/historian.test.js` -- 5 unit tests for data collectors
- `server/tests/waker-control.test.js` -- 4 unit tests for waker control functions

Modified files:
- `server/index.js` -- 7 API routes: `GET /api/historian/{state,briefing}`, `POST /api/historian/waker/{start,stop,restart,interval}`, `GET /api/historian/waker/control`
- `public/js/plugins-registry.js` -- Added `historian` manifest (monitor group, refreshOnActivate)
- `public/js/right-panel.js` -- Added lazy-load entry for historian-panel
- `public/js/i18n.js` -- Added 18 i18n keys (en + zh) for the historian plugin
- `public/style.css` -- ~45 lines of historian-specific CSS (table, status dots, log viewer, controls, flash, degraded dot, mobile responsive)

Plugin characteristics:
- **Optional** -- zero impact when waker is not running; degrades to calm "stopped" state
- **Read-only** -- follows historian red line: never modifies waker internals
- **Lazy-loaded** -- module only fetched when tab is first activated
- **Polls every 15s** -- gentle on the system
- **refreshOnActivate** -- data refreshes each time the tab is switched to
- **Mobile responsive** -- grid columns stack 2-up on narrow viewports, table/log shrink

### Task 2: User Manual

`docs/USER_MANUAL.md` -- 10 sections covering:
- Quick start, port conventions (9475/9476/9477/949x), hot-swap deploy
- Sessions & tabs (claude/codex/opencode), render modes (block/terminal)
- Resume & recovery (deaf window fix, auto-resume, persistence)
- Team switching & usage monitoring
- TTS (stale-drop behavior, muting, configuration)
- akari inspector panel
- Historian (waker) plugin -- modes, cadence, controls, optional plugin form
- Plugin system overview (all 11 built-in plugins table)
- Common troubleshooting table (7 scenarios with fixes)
- Keyboard & navigation tips

### Task 3: Playwright Smoke Tests

New files:
- `playwright.config.js` -- Two projects: desktop (1280x800) and mobile (375x812)
- `e2e/historian-smoke.spec.js` -- 8 tests x 2 viewports = 16 total:
  - API smoke: `/api/health`, `/api/historian/state`, `/api/historian/briefing`, `/api/historian/waker/control`
  - UI smoke: homepage title, historian-panel.js served, style.css historian rules, plugins-registry historian entry

## Verification (2026-07-16 final)

- **572/0 pass** -- full `npm test` suite (`node --test server/tests/*.test.js`)
- **22/22 Playwright pass** -- `TEST_PORT=9477 npx playwright test` (11 desktop + 11 mobile)
- **9477 smoke** -- server starts clean, health 200, historian state returns live army data
- **9476 deploy** -- hot-swap deployed, cwd confirmed `/jfs/home/zhiningjiao/code/wt-nano-akari`
- **API endpoints** -- `/api/historian/state` returns `{ army, logTail, wakerHealth, akariUp }` with live agent data
- **JS served** -- `/js/historian-panel.js` returns 200 with `renderHistorianPane`
- **Existing tests preserved** -- plugins-registry.test.js (22/22), akari-proxy.test.js (20/20), historian.test.js (5/5), waker-control.test.js (4/4)
- **Branch pushed** -- `zhining/nano-plugin-akari` pushed to fork (e73c6bd)
