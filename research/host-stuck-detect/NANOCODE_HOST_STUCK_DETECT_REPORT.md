# NANOCODE_HOST_STUCK_DETECT

## Scope

This task adds host-side idle/stuck detection for active Claude/Codex/agent sessions in nanocode, plus a stable backend contract for the later frontend work. UI rendering is intentionally out of scope.

## What Changed

### 1. Host-side monitor

Added [terminal/agent-health-monitor.js](/storage/home/zhiningjiao/code/nanocode/terminal/agent-health-monitor.js).

It keeps per-session state keyed by `session_key` and tracks:

- `started_at`
- `last_activity_at`
- `last_line`
- `idle_seconds`
- current derived `state`

The monitor runs independently of any single Claude turn and can notify even when the browser pane is backgrounded.

### 2. Existing output streams reused

No new data channel was added. The monitor is fed from the output paths nanocode already owns:

- Claude block mode broadcasts in [terminal/claude-session-controller.js](/storage/home/zhiningjiao/code/nanocode/terminal/claude-session-controller.js)
- Codex SDK output + event broadcasts in the same controller
- raw PTY output hooks in [terminal/sessions.js](/storage/home/zhiningjiao/code/nanocode/terminal/sessions.js)

This keeps the detector in the host process, not inside any individual agent.

### 3. Detection rules

Config is backend-driven via existing settings storage. Current keys:

- `agent_health_enabled` (default `true`)
- `agent_health_probe_interval_sec` (default `5`)
- `agent_health_idle_threshold_sec` (default `20`)
- `agent_health_background_wait_threshold_sec` (default `240`)
- `agent_health_patterns_approval`
- `agent_health_patterns_rate_limited`
- `agent_health_patterns_crashed`

Default classifications:

- `idle`: no new output for `idle_threshold_sec`
- `approval_needed`: approval prompt pattern matched
- `rate_limited`: rate-limit pattern matched
- `crashed`: crash pattern matched
- `stuck`: background-terminal wait crossed threshold

The default pattern sets are overrideable through settings, so the backend behavior is not hard-wired to one prompt spelling.

### 4. Frontend contract

Two backend exits are now available:

1. `GET /api/agents/health`
2. `WS /ws/notify` event `type: "agent_health"`

Sample payloads are in:
[agent-health-event-contract.sample.json](/storage/home/zhiningjiao/code/nanocode/research/host-stuck-detect/agent-health-event-contract.sample.json)

Stable fields for the frontend:

- `type`
- `version`
- `agent_id`
- `session_key`
- `session_id`
- `thread_id`
- `project_id`
- `tab_id`
- `tab_type`
- `provider`
- `source`
- `state`
- `reason`
- `idle_seconds`
- `last_line`
- `ts`
- `started_at`
- `last_activity_at`
- `wait_seconds`

Notes for Sonnet:

- `state` can be `active`, `idle`, `stuck`, `approval_needed`, `rate_limited`, `crashed`, `completed`, or `stopped`
- `reason` is machine-friendly and should be rendered as secondary text, not the only user-facing label
- snapshot rows and notify events intentionally share the same object shape so the frontend can reuse one renderer

### 5. Session cleanup

While wiring this in, I also fixed missing Codex session cleanup on tab/project delete. That matters here because stale backend session objects would otherwise leak stale health rows.

## Files

Primary implementation:

- [terminal/agent-health-monitor.js](/storage/home/zhiningjiao/code/nanocode/terminal/agent-health-monitor.js)
- [terminal/claude-session-controller.js](/storage/home/zhiningjiao/code/nanocode/terminal/claude-session-controller.js)
- [terminal/sessions.js](/storage/home/zhiningjiao/code/nanocode/terminal/sessions.js)
- [terminal/routes.js](/storage/home/zhiningjiao/code/nanocode/terminal/routes.js)
- [server/index.js](/storage/home/zhiningjiao/code/nanocode/server/index.js)
- [terminal/claude-sdk-driver.js](/storage/home/zhiningjiao/code/nanocode/terminal/claude-sdk-driver.js)
- [terminal/codex-sdk-driver.js](/storage/home/zhiningjiao/code/nanocode/terminal/codex-sdk-driver.js)

Tests / evidence:

- [server/tests/agent-health-monitor.test.js](/storage/home/zhiningjiao/code/nanocode/server/tests/agent-health-monitor.test.js)
- [research/host-stuck-detect/agent-health-selftest-summary.json](/storage/home/zhiningjiao/code/nanocode/research/host-stuck-detect/agent-health-selftest-summary.json)

## Bounded Self-Test

Kept bounded only. No Playwright. No foreground waiting on terminals.

Passed:

- `node --test server/tests/agent-health-monitor.test.js`
- `node --test server/tests/claude-sdk-driver.test.js`
- `node --test server/tests/codex-sdk-driver.test.js`

Covered by deterministic self-test:

- idle timeout emits `agent_health`
- new output emits recovery `state: active`
- approval prompt emits `approval_needed`
- `Waiting for background terminal (4m 12s)` emits `stuck`
- Claude `result` event removes the row from the health snapshot

I also attempted broader `node --test` / route sweeps, but the repository test runner can stop emitting TAP lines and leave the sandbox command session hanging. Per redline, those were not used as final evidence.

## Frontend Handoff

Sonnet can build against this backend without more server changes:

1. subscribe to `/ws/notify`
2. filter `type === "agent_health"`
3. seed from `GET /api/agents/health`
4. surface rows keyed by `session_key`
5. treat `active/completed/stopped` as clearing transitions for prior alerts
