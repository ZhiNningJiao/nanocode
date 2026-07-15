# REPORT: akari inspector plugin for nanocode (MES-14049)

## Summary
Implemented a nanocode plugin that inspects the self-hosted akari dispatch server
(`http://10.18.8.55:9481`), rendering health / concurrency / workers / fleet lanes
in a dedicated Monitor tab with gentle 10s polling and graceful degradation.

## Commits (pushed to fork)
- `c58be29` — `feat(akari): add akari inspector plugin for nanocode (MES-14049)` (+1029 lines, 12 files)
- `eeaedd3` — `fix(akari): stateClass maps PascalCase lane states + waiting worker state` (+58 lines, 3 files)
- `af77009` — `fix(akari): replace non-existent max_concurrent_workers with agent_concurrency-derived agent cap (MES-14049)` (+33 lines, 4 files)

**Remote:** `fork/zhining/nano-plugin-akari` → https://github.com/ZhiNningJiao/nanocode.git

## What was built
| File | Purpose |
|------|---------|
| `public/js/akari-panel.js` | Main panel renderer: health / concurrency / workers / lanes sections, 10s poll, graceful degrade |
| `public/js/plugins-registry.js` | akari builtin manifest (lines 191-210), apiVersion 1.0, group monitor |
| `public/js/right-panel.js` | LAZY_PLUGINS akari entry (line 92-94); mountPlugin renders the tab |
| `server/akari-proxy.js` | Same-origin proxy: `/api/akari/state` bundles health+concurrency+workers+lanes |
| `server/index.js` | `/api/akari/config` (621), `/api/akari/state` (626), health probe (585), managed entry (603) |
| `terminal/personal-config.js` | akari config defaults (serverUrl / lensUrl), loader (190-209) |
| `server/tests/akari-proxy.test.js` | 26 hermetic tests |
| `public/js/i18n.js` | akari i18n keys (en + zh) |
| `public/style.css` | akari + rp CSS classes |
| `scripts/shot_akari_panel.mjs` | Smoke-test screenshot helper |

## Source provenance (verified against akari source, NOT guessed)
Read `~/code/akari` source to confirm every field name matches the real serde wire format:
- `small_handlers.rs` — concurrency/workers/lanes handlers
- `health_handler.rs:117` — health handler
- `worker_status.rs:90` — WorkerStatus struct
- `health.rs` — HealthResponse / ConcurrencyResponse / DispatchCaps
- `worker_state.rs` — WorkerState enum (`#[serde(rename_all = "snake_case")]`)
- `lane.rs:72-96` — LaneState enum (`#[serde(rename_all = "PascalCase")]` + legacy aliases)

The `stateClass()` fix (commit `eeaedd3`) maps BOTH the current PascalCase lane names
(InUse/Free/Finishing/Error) AND the legacy aliases (Idle/Busy/AwaitingMerge/Quarantined),
plus the `waiting` worker state — so the colored dot lights up whichever akari build is deployed.

The `max_concurrent_workers` fix (commit `af77009`): `DispatchCaps` has no such field
(verified against `health.rs`). Replaced the panel stat "workers cap" → "agent cap",
computed as `ac.in_flight + ac.permits_available` from the real `agent_concurrency` object.
Proxy doc comments and test mocks/asserts updated to match the real akari live format.
Also added `public/akari_harness.html` so smoke screenshots are reproducible from HEAD.

## Tests
- **562 pass / 0 fail** (re-run after fix)
- `run_nano_akari.log` clean — `grep -i "FAIL|MISMATCH|NaN|NOT FOUND"` returns only `# fail 0`
- 26 hermetic akari-proxy tests pass

## Smoke tests (real data, 0 console errors)

### Good server (port 9479, real akari at 10.18.8.55:9481)
Panel renders real health data (verified via Playwright text dump, 0 console errors):
```
akari · http://10.18.8.55:9481 · 07:53
Health: version 0.7.0 · build efb142f1e · agent cap 4 · vision cap 6 · lane cap 4
       · in-flight 0 · permits 4 · fallback on · tok in 0 · tok out 0
       · model: litellm/SGLang-GLM-5.2
Concurrency: running 0 · peak 0 · open lanes 0
Workers (0): no active workers
Lanes / Fleet (0): no lanes open
```
- `/api/akari/config` → 200
- `/api/akari/state` → 200, `reachable:true`, real data (proxy is faithful passthrough: direct 9481 vs proxy 9479 show IDENTICAL values)
- `/api/services` → akari `{"status":"up"}`
- `akari-panel.js` → HTTP 200, served correctly
- **0 console errors**
- Screenshot: `codex_work/nano_akari/akari_panel_good.png`

### Degraded server (port 9483, bad URL http://10.18.8.55:9999)
Panel renders calm unreachable state (verified via Playwright text dump, 0 console errors):
```
akari · http://10.18.8.55:9999 · unreachable · 07:53
akari server unreachable — the panel will retry quietly and recover automatically.
health: fetch failed · concurrency: fetch failed · workers: fetch failed · lanes: fetch failed
```
- `/api/akari/state` → 200, `reachable:false`, all sections null
- `/api/services` → akari `{"status":"down"}`
- **0 console errors (no error spam)** — graceful degradation as required
- Screenshot: `codex_work/nano_akari/akari_panel_degraded.png`

## Polling
- 10s interval (≥10s, gentle on the dispatch server)
- When akari is down, poll keeps running silently, auto-recovers when akari returns
- Fetch errors swallowed into structured `reachable:false` bundle — no console spam

## Status
Plugin is complete, tested, and pushed to fork. Ready for visual review.

## 2026-07-15 17:11 — independent re-verification against LATEST akari (worker-core)
主人原话要求「用最新的 akari」。At re-verify time `origin/main` had advanced 5 commits
past the deployed build (`efb142f1e` → `42ec879a6`). I diffed the 6 API-wire-format source
files the plugin depends on (`health_handler.rs`, `small_handlers.rs`, `health.rs`,
`worker_state.rs`, `worker_status.rs`, `lane.rs`) across `efb142f1e..origin/main`:
**the diff is EMPTY** — the 5 new commits only touch engine/jsembed/tools internals
(lane merge sync, grep include-glob, laneless tool loop), not the HTTP control surface.
So the plugin remains aligned with the latest akari source; no code change needed.

Fresh full verification (not trusting the prior FLAG):
- `npm test` → **562 pass / 0 fail** (`run_nano_akari.log`, grep clean of real failures)
- live smoke 9479 → real akari 9481:
  - `/api/akari/config` → `{serverUrl 9481, lensUrl 9482}`
  - `/api/services` → `akari: {status: "up"}` (real /api/health probe)
  - `/api/akari/state` → `reachable:true`, every field **IDENTICAL** to direct `curl 9481`
    (version 0.7.0 · build efb142f1e · caps {lane_cap 4, max_vision_workers 6,
    model litellm/SGLang-GLM-5.2} · agent_concurrency {in_flight 0, permits 4} ·
    fallback true · concurrency {running 0, peak 2, open_lanes 4} · 4 InUse lanes,
    head d6804691, @main ✓) — faithful passthrough confirmed
  - panel text dump (Playwright): all sections render, **0 console errors**
- degraded 9483 → fake 9999:
  - `/api/services` → `akari: {status: "down"}` after probe cycle
  - `/api/akari/state` → `reachable:false`, all sections null, per-section
    "fetch failed"; panel calm "unreachable", **0 console errors (no spam)**
- screenshots: `codex_work/nano_akari/akari_panel_good.png` (804×1000) +
  `akari_panel_degraded.png` (460×1000), real PNGs, fresh 17:11.
  (Note: this model cannot read images, so the visual verdict rests on the
  rendered DOM text dump captured by Playwright — it shows every field value
  that a human/Sonnet visual judge would read off the screenshot.)
- 9475/9476 untouched; 9479/9483 torn down after the run.

## 2026-07-15 17:24 — fresh re-verification against LATEST akari (worker-core, not trusting prior FLAG)
主人原话要求「用最新的 akari」。At re-verify time akari `origin/main` had advanced 2 commits
past the 17:11 baseline (`42ec879a6` → `44a1393ff`):
- `bfa6c5323` fix(compaction): budget basis is the SERIALIZED message array
- `34ed7fb69` gate(no_raw_lane_reset): allowlist post-merge lane-sync reset
- `44a1393ff` merge: akari/lane/0 into main

Diffed the 6 API-wire-format source files the plugin depends on
(`health_handler.rs`, `small_handlers.rs`, `health.rs`, `worker_state.rs`,
`worker_status.rs`, `lane.rs`) across `efb142f1e..origin/main` (`44a1393ff`):
**the diff is EMPTY** — the new commits touch compaction internals + lane-merge
reset gating, NOT the HTTP control surface. Plugin remains aligned with the
latest akari source; no code change needed (用最新的 akari satisfied).

Fresh full verification (reproducing reality, not trusting the prior FLAG):
- `npm test` → **562 pass / 0 fail** (`run_nano_akari.log`; grep of
  `RESULT: FAIL|Traceback|Error|FAILED|NaN|NOT FOUND` hits only subtest
  *names* containing "Error" — all marked `ok`, `# fail 0`, no real failures)
- live smoke 9479 → real akari 9481:
  - `/api/akari/config` → `{serverUrl 9481, lensUrl 9482}`
  - `/api/services` → `akari: {status: "up"}` (real /api/health probe)
  - `/api/akari/state` → `reachable:true`, every field **IDENTICAL** to direct
    `curl 9481` (version 0.7.0 · build efb142f1e · caps {lane_cap 4,
    max_vision_workers 6, model litellm/SGLang-GLM-5.2} · agent_concurrency
    {in_flight 0, permits 4} · fallback true · concurrency {running 0, peak 2,
    open_lanes 2} · 4 lanes mix Free/InUse, head d6804691, @main ✓) — faithful
    passthrough confirmed
  - panel text dump (Playwright): all sections render, **0 console errors**
- degraded 9483 → fake `AKARI_SERVER_URL=http://10.18.8.55:9999`:
  - `/api/services` → `akari: {status: "down"}` (first probe cycle)
  - `/api/akari/state` → `reachable:false`, all sections null, per-section
    "fetch failed"; panel calm "unreachable", **0 console errors (no spam)**
- screenshots: `codex_work/nano_akari/akari_panel_good.png` (804×1000, 224KB) +
  `akari_panel_degraded.png` (460×1000, 158KB), real PNGs, fresh 17:24.
- **Visual verdict (Team2 Sonnet, headless Read on the fresh PNGs)**:
  `VERDICT: PASS` — "Both states render correctly: the healthy panel shows all
  expected data fields populated, and the degraded panel fails gracefully with
  per-section messages and no error noise." One minor cosmetic noted: at the
  460px harness viewport the "@main" column header clips to "@ma" (content
  still readable; the real nanocode app renders wider, non-blocking).
- 9475/9476 untouched; 9479/9483 torn down after the run.
- Push: `zhining/nano-plugin-akari` fully pushed to `fork/zhining/nano-plugin-akari`
  (no unpushed commits); Linear MES-14049 self-report posted by prior sessions.

