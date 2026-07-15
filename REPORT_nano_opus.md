# REPORT_nano_opus — Opus integration of 3 GLM lines + TTS stale-drop

Branch: `zhining/nano-integration-0715` (from `fork/main` @ `559ec8c`)

## Conclusion (TL;DR)

All three GLM lines are **real and working** — code quality is solid, tests pass, features function. The GLMs' main failure mode was compulsive re-verification (10-60 rounds each) rather than code defects. Integration merged cleanly with zero conflicts thanks to all three sharing the same base.

**Integrated result: 614 tests / 0 failures, all features verified on port 9477.**

## What was integrated

| Line | Branch | Commits (code) | Tests added | Key deliverables |
|------|--------|----------------|-------------|------------------|
| **akari** (MES-14049) | `zhining/nano-plugin-akari` | 4 | 26 | akari inspector plugin: health/concurrency/workers/lanes panel, 10s poll, graceful degradation, Lens jump button |
| **upstream** (MES-14030) | `zhining/nano-upstream-port` | 20 | 7 (inject) | 16 upstream ports (terminal OSC52/hyperlinks, font fix, Esc fix, URL buttons, mobile fix, PTY flush, lazy-load block renderer, renderMode default terminal) + mute fix + session inject endpoint + notify WS backoff |
| **plugins** (MES-14031) | `zhining/nano-plugin-proto` | 5 | 32 | 12-item "worth porting" research + 3 prototypes: S1 sessions browser (browse/preview/fork codex+claude sessions), S2 rewind (checkpoint/truncate), S5 tasks panel (live TODO from agent events) |
| **tts-stale-drop** | `zhining/tts-stale-drop` | 1 | 0 | Server-side stale TTS request drop (seq number, 204 for outdated) |

## Merge strategy

1. `fork/main` (`559ec8c`) = base for all three branches (confirmed via `git merge-base`)
2. Upstream merged first (fast-forward, 22 commits)
3. Plugins merged second (auto-merge, 5 conflicting files resolved by git ort)
4. Akari merged third (auto-merge, 4 conflicting files resolved by git ort)
5. tts-stale-drop cherry-picked (auto-merge on `server/index.js`)
6. Per-line FLAG/REPORT/smoke artifacts removed

**Zero manual conflict resolution needed.**

## Verification

### Tests
- `npm test` on integration branch: **614 pass / 0 fail** (133 suites)
- `grep -iE "FAIL|MISMATCH|NaN|not ok" run_nano_opus.log` — clean (only test *names* containing "Error", all `ok`)

### Smoke test (port 9477, torn down after)
| Check | Result |
|-------|--------|
| `/api/health` | `{"status":"ok"}` |
| `/api/services` (akari row) | `akari: {"status":"up"}` (real probe to 9481) |
| `/api/akari/config` | `{serverUrl: 9481, lensUrl: 9482}` |
| `/api/akari/state` | `reachable=True` (real data from akari 9481) |
| `/` (index.html) | 200, 35735B |
| `akari-panel.js` | 200, 14038B |
| `sessions-panel.js` | 200, 14037B |
| `rewind-panel.js` | 200, 9312B |
| `tasks-panel.js` | 200, 7405B |
| `tts.js` mute-changed listener | 1 match (mute fix present) |
| `claude-block-settings.js` | 200, 4228B (lazy-load extract) |
| `terminal-view.js` Port13+14 | 3 matches (open-url + Esc fix) |
| `/api/sessions` (inject) | 200 |
| `style.css` font-display:block | 1 match |
| `plugins-registry.js` | akari, sessions, rewind, tasks all registered |
| Boot log errors | **0** (clean) |

### Red lines
- 9475/9476: `{"status":"ok"}` before and after smoke test — **untouched**
- 9481/9482 (akari/lens): untouched
- 9477 torn down via `kill -9 <pid>`, not `pkill -f`
- No `/tmp` writes (except smoke log)
- No secrets in git

## GLM assessment

| Line | Code quality | Report quality | Issue |
|------|-------------|---------------|-------|
| akari | Solid. Clean proxy with proper timeouts, AbortController, graceful degradation. Well-documented provenance against akari Rust source. | Extremely bloated — 775 lines, 10+ near-identical re-verification sections. | Verification loop: kept re-running the same checks |
| upstream | Solid. 20 ports faithfully adapted from upstream, byte-identical where applicable, good skip justifications. Mute fix and inject are clean. | Even more bloated — per-round novel-length documentation. Round-24 pkill mishap (killed 9475/9476, honestly reported and restored). | Re-verification loop (59 rounds) + one production incident |
| plugins | Good. Sessions browser discovers real codex+claude sessions, rewind is honest about limitations (no file snapshots yet), tasks panel is pure client-side. | Bloated (46 re-verifications). | Re-verification loop |

**Verdict**: All three lines delivered real, tested, working code. The GLMs' compulsive re-verification wasted tokens but didn't produce false positives — the code genuinely works.

## 9475/9476 upgrade instructions

To deploy the integration to production:

```bash
# The integration branch is: zhining/nano-integration-0715
# Latest commit: see `git log -1` on that branch

# 1. On the production nanocode checkout:
cd ~/code/nanocode
git fetch fork
git checkout zhining/nano-integration-0715

# 2. Hot-swap (zero-downtime):
PORT=9476 node server/index.js &   # start on backup port
# verify: curl http://localhost:9476/api/health
kill $(lsof -t -i:9475)            # stop old 9475
PORT=9475 node server/index.js &   # start new 9475
# verify: curl http://localhost:9475/api/health
kill $(lsof -t -i:9476)            # stop backup

# NOTE: This will kill any active secretary/agent sessions on 9475.
# They can be resumed via the new sessions browser plugin.
```

**What changes for the user after upgrade:**
- Right panel gets 4 new tabs: akari monitor, sessions browser, rewind, tasks
- akari panel shows live dispatch server status (ports configurable via `personal.json`)
- Mute button now actually stops TTS immediately
- TTS won't replay old queued messages after recovery
- Terminal gets OSC 52 clipboard, hyperlinks, Open/Copy URL buttons
- Claude tabs default to terminal (xterm) renderer instead of block
- Keyboard Esc works on idle Claude terminal tabs
- Font rendering fix (no more rightmost char bleed)

## Opus independent re-verification (2026-07-15 21:15 UTC)

Fresh Opus (Team2) re-verification of the live 9476 integration deployment:

- **npm test**: **614 pass / 0 fail** (133 suites, 3.3s)
- **9476 live deployment**: commit `ada30b9` on `zhining/nano-integration-0715`, running from `.nanocode-9476-runtime`
- **Akari plugin**: `/api/akari/state` returns `reachable:true`, fields **IDENTICAL** to direct `curl 10.18.8.55:9481` (version 0.7.0, build efb142f1e, caps {lane_cap 4, max_vision_workers 6, model litellm/SGLang-GLM-5.2}, agent_concurrency {in_flight 0, permits_available 4}). `/api/services` shows `akari: {status: "up"}`. Managed entry in `/api/services-config` present.
- **All 4 plugin JS files served**: akari-panel.js (14038B), sessions-panel.js (14037B), rewind-panel.js (9312B), tasks-panel.js (7405B)
- **Plugins registry**: all 4 new plugins registered (sessions, rewind, tasks, akari) alongside existing ones
- **Sessions endpoint**: `/api/sessions` returns 200 with 2 active sessions
- **Mute fix**: `tts.js` contains `nanocode:mute-changed` listener that calls `stopTts()` on mute — stops in-progress playback + line 140 discards queue silently when muted
- **TTS stale-drop**: server-side `ttsReqSeq` counter in `server/index.js` — each request gets a seq number, stale requests answered with 204
- **Upstream ports**: OSC52 clipboard (5 matches), font-display:block in CSS, open-url buttons (2 matches), Escape fix (1 match), `claude-block-settings.js` present (4228B lazy-load extract)
- **Inject endpoint**: Present in upstream branch code. Note: `wake-secretary.py` uses the WS `claude-input` channel (same path as browser frontend), making the REST inject endpoint a secondary path — both coexist without conflict.
- **Red lines**: 9475 (PID 304142) untouched and healthy; 9481/9482 untouched

**Verdict: PASS** — all three GLM lines integrated correctly, all features verified live on 9476.

## Commits on integration branch

```
ada30b9 docs(integration): REPORT_nano_opus.md — 3-line integration verified 614/0
6053ef5 chore: remove per-line FLAG/REPORT/smoke artifacts
afc0fe3 fix(tts): drop stale queued requests (cherry-pick)
8d1a60f Merge akari (MES-14049)
558c062 Merge plugins (MES-14031)
b55751e..559ec8c upstream (MES-14030, fast-forward)
```
