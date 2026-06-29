# NanoCode Architecture — Core/Plugin Boundary & Extraction Plan

**Repo:** `~/code/nanocode2` · **Branch:** `zhining/plugins`
**Author:** PM/architect pass · **Date:** 2026-06-27 (updated: renderer pass)
**Scope:** Analyze the core/plugin boundary, compare against reference extension
systems (VS Code, Fastify, Backstage, ttyd/wetty, webpack, Obsidian), identify
gaps, and propose a safe, incremental extraction + lifecycle plan. The renderer
registry extraction (§6.5) is now implemented.

---

## 1. Executive summary

NanoCode is a self-hosted, multi-terminal agent host: an Express + WebSocket
server that drives Claude/Codex SDK processes inside persistent tmux sessions,
surfacing them in a browser xterm UI with a panel/settings/plugin system. The
architecture honors a healthy **"core small, plugins own features"** doctrine —
TTS, monitor, and fleet-term all live in `plugins/` and talk to core only
through a documented host API.

The plugin host API is clean and minimal (6 extension points on the server, 5
on the client), and the browser host already supports **live load/unload without
a page reload** via a per-plugin `_uiForPlugin` registry. This is genuinely good
work — comparable in shape to VS Code's extension host, though without its
process isolation, dependency declaration, or explicit lifecycle contract.

The gaps are narrow but real, and all fixable additively without a refactor:

| Gap | Impact | Fix shape |
|-----|--------|-----------|
| No server-side lifecycle / unload | plugins leak timers/PTYs on shutdown & toggle-off | `registerLifecycle({onStop})` + `shutdownPlugins()` on SIGINT |
| No plugin health reporting | core can't surface "tts circuit open" / "monitor unreachable" generically | `host.reportStatus(level, msg)` → notify WS |
| No dependency declaration | load order is implicit; a plugin needing another silently fails | `plugin.json#dependencies` + load validation |
| No process isolation / sandbox | a misbehaving plugin can crash the worker | out of scope (single-user, trusted first-party) — documented |
| `registerWebSocket` works but is under-documented | fleet-term uses it; not obviously wired | already correct; doc only |

**None** of these require moving existing code out of core. The extraction plan
below is about *what could* move to plugins to keep core lean, ranked by safety.

> **Update (renderer pass):** Block rendering — previously hard-wired if/else in
> `tab-manager.js` dispatching Claude/Codex/Terminal pane types — has been
> extracted into a **renderer registry** extension point
> (`renderer-registry.js` + `default-renderers.js`). `tab-manager.js` now
> resolves panes through the registry instead of branching on session type.
> Plugins can register custom renderers via `ui.registerRenderer()`. See §6.5.

---

## 2. System overview

### 2.1 Process & transport model

```
 Browser (xterm + panels) ──HTTP/WS──▶ Express server (server/index.js)
                                          │
            ┌─────────────────────────────┼──────────────────────────┐
            ▼                             ▼                          ▼
   terminal/routes.js            server/plugin-host.js        server/store.js
   (session controller,           (host API → plugins/)        (atomic JSON
    PTY, queue, replay)                  │                       settings)
                                        ▼
                          terminal/sessions.js (node-pty)
                          terminal/claude-*-driver.js (tmux bridge)
```

- **Server** (`server/index.js`, 574 lines): Express app, 5 WebSocket servers
  (`terminal`, `tabs`, `notify`, `plugin`, `teamLogin`), HTTP upgrade router,
  service checks, qa-watcher, plugin host creation.
- **Terminal layer** (`terminal/`): the real session controller. `routes.js`
  owns REST + WS for terminals; `claude-session-controller.js` owns the busy-lock
  / queue / interrupt state machine; `claude-tmux-driver.js` talks to a
  persistent tmux bridge process over a Unix socket (so a Claude OS process
  outlives nanocode reloads); `sessions.js` wraps `node-pty`.
- **Plugins** (`plugins/`): trusted first-party ES modules loaded by
  `loadPlugins()`. Each has `plugin.json` (manifest) + `server.js`
  (`register(host)`) + `client.js` (`register(ui)`).
- **Frontend** (`public/js/`): `app.js` (coordinator), `tab-manager.js`
  (multi-tab carousel), `terminal-view.js` (split pane + chat), `sidebar.js`,
  `agents.js`, `plugin-host.js` (browser host), block renderers.

### 2.2 Core capabilities (what must stay in core)

These are the load-bearing primitives everything else builds on:

| Capability | Location | Why it's core |
|------------|----------|---------------|
| Express app + middleware | `server/index.js`, `middleware/` | Shared transport; plugins mount onto it |
| WebSocket upgrade router | `server/index.js:484` | Single upgrade handler dispatches to core WS + plugin WS |
| Settings store (atomic JSON) | `server/store.js` | Plugins read/write through it; single source of truth |
| PTY (node-pty) | `terminal/sessions.js` | Terminal primitive; fleet-term reuses it via host |
| Agent session state machine | `terminal/claude-session-controller.js` | busy-lock / queue / interrupt is the safety-critical hinge |
| Persistent tmux bridge | `terminal/claude-tmux-driver.js` | Durability model; survives restarts |
| Agent health monitor | `terminal/agent-health-monitor.js` | Observes all sessions; must be above plugins |
| Auth / system mode | `server/auth/`, `router-mode.js`, `proxy.js` | Multi-user isolation; security boundary |
| Plugin host (both) | `server/plugin-host.js`, `public/js/plugin-host.js` | The extension boundary itself |
| Notify broadcast | `broadcastNotify` in `index.js:550` | Plugin → browser push channel |
| Team manager | `server/team-manager.js` | Credential-existence check + login PTY (security-sensitive) |
| Renderer registry | `public/js/renderer-registry.js` | Pane-type → renderer dispatch; the browser extension point for block rendering |

### 2.3 Plugin-owned capabilities (correctly already extracted)

| Capability | Plugin | Extension points used |
|------------|--------|----------------------|
| Text-to-speech (GPT-SoVITS proxy) | `tts` | settings, event bus (`agent:output`), routes, notify |
| Worktree/team health dashboard | `monitor` | settings, routes, notify, panel |
| Fleet terminal (multi-PTY) | `fleet-term` | settings, routes, **registerWebSocket**, panel |
| Dual-team login/switch | (in `plugin-host.js` UI + `team-manager.js`) | routes, notify, WS — *see §6.2* |
| Block pane rendering | `default-renderers.js` (registered as default plugins) | `ui.registerRenderer(sessionType, {factory, gate, priority})` — *see §6.5* |

---

## 3. The plugin host API (the boundary contract)

### 3.1 Server host — `server/plugin-host.js`

Created by `createPluginHost({ app, store, broadcastNotify })`. Exposed to every
enabled plugin via `register(host)`:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `on` | `(event, cb)` | Subscribe to the core event bus (`EventEmitter`, max 50 listeners) |
| `emit` | `(event, payload)` | Emit onto the bus (plugins can talk to each other) |
| `registerSetting` | `(def)` | Declare a persisted setting (Core stores value; plugin reads via getSetting) |
| `getSetting` / `setSetting` | `(key[, value])` | Read/write through the store |
| `registerRoute` | `(method, path, handler)` | Mount an Express route under `/api` |
| `registerWebSocket` | `(path, handler)` | Own a WS upgrade path; Core dispatches before its own WS endpoints |
| `broadcastNotify` | `(payload)` | Push a message to all browser notify-WS clients |
| `getAllSettingDefs` | `()` | Introspect registered setting defs (used by settings UI) |
| `getWebSocketHandler` | `(pathname)` | Core-internal: resolve a plugin WS handler by path prefix |

**Loading** (`loadPlugins`): scans `plugins/*/plugin.json`, checks the
`plugin_<name>_enabled` setting (auto-opts-in when `enabledByDefault:true` on
first sight), dynamically imports `server.js`, calls `register(host)`, tracks
success in `_loaded` Set. Failures are caught + warned, never fatal.

**Discovery** (`discoverPlugins`): returns manifest metadata + enabled state
without importing — powers the plugin-manager UI.

### 3.2 Browser host — `public/js/plugin-host.js`

Created by `createPluginUiHost({ notifyWs })`. Exposed via `register(ui)`:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `on` / `emit` | `(event[, payload])` | Local `EventTarget` bus (browser-side only) |
| `registerSetting` | `({ id, render })` | Render a settings slot into the settings panel |
| `registerPanel` | `(id, { title, render })` | Add a top-level tab panel (Core owns the tab strip) |
| `registerHeaderEntry` | `({ id, icon, label, onClick\|panel, order })` | Contribute a button to the top-right header slot area (`#plugin-header-slots`) |
| `registerLifecycle` | `({ onStop })` | Register a cleanup hook called on plugin unload |
| `onMessage` | `(cb)` | Receive notify-WS payloads whose `type` starts with `plugin:` |
| `fetchSettings` / `updateSetting` | `([key, value])` | REST settings round-trip |
| `loadClientPlugin` / `unloadClientPlugin` | `(name)` | **Live** load/unload without reload (per-plugin registry tracks ownership) |
| `attachNotifyWs` | `(ws)` | Wire the notify WS; idempotent |
| `renderPanels` / `renderSettings` | `(…)` | Incremental re-render preserving DOM state |

The `_uiForPlugin(name)` proxy (line 227) wraps `registerPanel`/`registerSetting`/
`registerHeaderEntry`/`on`/`onMessage` so each registration is attributed to a
plugin, enabling clean unload. `renderPanels` is incremental (line 131): it
adds/removes only changed panels, preserving mounted DOM. This is the strongest
part of the current design.

### 3.3 Manifest — `plugins/<name>/plugin.json`

```json
{
  "name": "tts",
  "version": "1.0.0",
  "description": "…",
  "extensionPoints": ["settings", "routes", "events", "notify"],
  "enabledByDefault": false
}
```

`extensionPoints` is **informational only** today (logged on load); it does not
gate anything. `enabledByDefault` controls first-run opt-in.

---

## 4. Gaps, risks & recommendations

### 4.1 [GAP — high] No server-side lifecycle / unload contract

**Problem.** The browser host can unload a plugin live (`unloadClientPlugin`),
but the server host has **no unload** and **no shutdown hook**. Consequences:

- Toggling a plugin off in the UI flips the setting, but the plugin's server
  routes, event listeners, and timers stay live until restart (the UI even says
  so: *"Server-side routes take effect after the server restarts."* —
  `plugin-host.js:370`).
- On `SIGINT`/`SIGTERM` there is **no** `process.on('SIGINT')` in `index.js`
  (only `uncaughtException`/`unhandledRejection`). So a kill leaks every
  plugin's timers, PTYs, and fs.watchers. Tests paper over this with an informal
  `host.emit('shutdown')` in `afterEach` (`plugin-host.test.js:31`) — but
  **neither tts nor monitor actually listens for `shutdown`**. Monitor exports a
  module-level `stop()` (`monitor/server.js:60`) that only tests call; tts has
  no cleanup at all (its `debounceTimer` leaks).

**Recommendation.** Add an explicit, typed lifecycle contract (mirrors VS Code's
`ExtensionContext.subscriptions` / Disposable and Fastify's `onClose` hook):

- `host.registerLifecycle({ onStop })` — plugin registers a cleanup callback
  (sync or async). 
- `host.shutdownPlugins()` — Core runs all `onStop` handlers in reverse load
  order. Called on `SIGINT`/`SIGTERM` in `index.js` and (future) on server-side
  hot-unload.
- Update `tts` and `monitor` to register their existing cleanup via this API.

This is **purely additive**: existing plugins that don't call it behave exactly
as before. See §7 + the accompanying code change.

### 4.2 [GAP — medium] No plugin health/status reporting

**Problem.** Plugins can push arbitrary notify messages, but there's no standard
channel for a plugin to tell core/browser *"I'm degraded"*. Monitor computes
rich health internally but only emits full snapshots; tts's circuit-breaker
state is invisible to anything outside its own request handlers. A plugin
manager UI can't show a "⚠ tts circuit open" badge because there's no contract.

**Recommendation.** Add `host.reportStatus(level, message, { detail })` where
`level ∈ {ok, warn, error, info}`. Core broadcasts `{ type: 'plugin:status',
plugin, level, message }` on the notify WS. The browser host already routes
`plugin:`-prefixed messages to `onMessage` callbacks, so the plugin-manager UI
can render health badges with zero new transport. Optional; plugins that never
call it simply have no badge.

### 4.3 [GAP — medium] No dependency declaration

**Problem.** `plugin.json` has no `dependencies` field. If a future plugin
needs another plugin's route or event (e.g. a "notifications" plugin depending
on "monitor"), load order is implicit (directory order) and a missing dep
fails silently at runtime. VS Code solves this with `extensionDependencies`;
Fastify with `avvio` boot ordering.

**Recommendation.** Accept `dependencies: ["monitor"]` in `plugin.json`.
`loadPlugins` topologically orders loads and skips+warns a plugin whose
declared dep is disabled or absent. No runtime injection of one plugin into
another (keep it simple) — just ordering + presence validation.

### 4.4 [NON-ISSUE] `registerWebSocket` — already correct

Earlier audit notes flagged `fleet-term`'s declared `host.registerWebSocket`
extension point as "unimplemented". **This is incorrect.** The server host
implements it (`plugin-host.js:98`) **and** wires it into the HTTP upgrade
handler (`index.js:510`): Core calls `pluginHost.getWebSocketHandler(pathname)`
before its own WS branches and hands the upgrade to the plugin's handler. The
fleet-term test (`fleet-term.test.js:50`) exercises `getWebSocketHandler`
end-to-end. No code change needed; this is documented in §3.1 above.

### 4.5 [RISK — low, accepted] No process isolation / sandbox

Plugins are trusted first-party ES modules running in the worker process. A
throw in `register()` is caught (`loadPlugins` try/catch), but a plugin that
holds an open handle or throws asynchronously can wedge the worker. VS Code
isolates extensions in a separate extension-host process. **This is accepted**
for NanoCode's single-user, self-hosted, first-party deployment — the cost of a
process boundary isn't justified yet. Documented here so the trade-off is
explicit, not accidental.

### 4.6 [RISK — low] Multi-device team-switch race

`/api/teams/switch` changes `CLAUDE_CONFIG_DIR` globally for *new* sessions but
doesn't reconcile sessions already running under the other team across browser
tabs. Two tabs switching teams rapidly could start a claude session under the
wrong config dir. Low impact (single user); flagged in the prior review
(`NANOCODE_REVIEW.md §1.4`). No fix — awareness only.

---

## 5. Reference library comparison

How NanoCode's plugin model maps onto three well-known extension systems +
the terminal-transport libraries it already depends on.

### 5.1 Extension systems

| Dimension | **NanoCode** | **VS Code** | **Fastify** | **Backstage** |
|-----------|--------------|-------------|--------------|---------------|
| Unit of extension | `plugins/<n>/{plugin.json,server.js,client.js}` | extension folder + `package.json` manifest | `register(plugin, opts)` | `createPlugin({id, routes, apis})` |
| Manifest | `plugin.json` (name, version, extensionPoints, enabledByDefault) | `package.json` (`engines.vscode`, `contributes`, `activationEvents`, `extensionDependencies`) | none (plugin is a function) | plugin config in app `.createFrontendModule` |
| Activation model | eager on boot if enabled; lazy only via setting toggle | **lazy** via `activationEvents` (onCommand, onLanguage…) — activated on first use | eager at `.ready()` (avvio boot graph) | eager plugin composition at app build |
| Extension surface | host API: events, settings, routes, WS, notify, panels | `vscode.*` namespace + `contributes` (commands, views, menus…) | `decorate`/`decorateRequest`/`decorateReply` + hooks | extension points + APIs (identityApi, discoveryApi…) |
| Encapsulation | flat — all plugins share one host/event bus | each extension gets its own `ExtensionContext` | `register` creates encapsulated context; `fastify-plugin` escapes it | plugin-scoped APIs via dependency injection |
| Lifecycle | ❌ none (the gap) | `activate()` returns; cleanup via `context.subscriptions` (Disposable[]); `vscode:uninstall` hook | `onClose` hook + avvio enforces close order | app-lifecycle bound; no per-plugin deactivate |
| Dependencies | ❌ none (the gap) | `extensionDependencies` + `extensionPack` | avvio topological boot order; `after()` for sequencing | plugin composition order in app |
| Distribution | first-party, in-repo | Marketplace (publisher, semver) | npm `@fastify/*` | npm `@backstage/plugin-*` |
| Isolation | same process (trusted) | separate extension-host process | same process | same process (frontend) |
| Health/telemetry | ❌ none (the gap) | `@vscode/extension-telemetry` | `process-warning`, `@fastify/error` | backend health endpoints |

**What to steal from each:**
- **VS Code**: the *typed lifecycle* (`subscriptions`/Disposable) and
  *dependency declaration* (`extensionDependencies`). Its lazy activation is
  overkill for NanoCode's ~3 plugins, but the Disposable pattern is exactly
  what §4.1 prescribes.
- **Fastify**: the *encapsulation* idea is tempting (a per-plugin context so a
  decorator doesn't leak) but NanoCode's flat shared bus is simpler and fits
  its small plugin count. The **avvio boot/close ordering** is the model for
  `shutdownPlugins()` running `onStop` handlers in reverse.
- **Backstage**: the *API composition* pattern (identityApi, discoveryApi
  injected via DI) is the distant-future shape if NanoCode ever grows many
  plugins that need each other's services. Not needed now.

### 5.2 Terminal transport libraries (already in use)

| Library | Version | Role in NanoCode | Notes |
|---------|---------|-------------------|-------|
| `node-pty` | `^1.1.0-beta34` (npm 1.1.0 stable) | Cross-platform PTY fork in `terminal/sessions.js` | The terminal primitive; fleet-term reuses the spawn hook |
| `@xterm/xterm` | `^5.5.0` (npm 6.0.0) | Browser terminal renderer | Loaded as vendored global `window.Terminal` |
| `@xterm/addon-fit` / `addon-web-links` | `^0.10` / `^0.11` | xterm addons | Used in team-login modal + main terminal |
| `ws` | `^8.18.0` | WebSocket server + client | 5 `WebSocketServer`s; plugin WS via `noServer` upgrade |
| `reconnecting-websocket` | (npm 4.4.0) | **not used** — NanoCode rolls its own reconnect | See §6.3 — candidate if reconnect logic grows |
| `express` | `^4.21.0` | HTTP server + plugin route mounting | `registerRoute` wraps `app[method]` |

**ttyd / wetty comparison:** ttyd (C, libwebsockets) and wetty (Node) are
*standalone* web-terminal servers — a single shell over WS to xterm. NanoCode is
a *multi-session agent host* that happens to use the same xterm+node-pty+WS
primitives but layers a session controller, tmux-bridge durability, plugin
panels, and dual-team auth on top. The relevant takeaway from ttyd/wetty is the
**minimal WS-to-PTY relay** pattern; NanoCode already implements this in
`team-manager.js`'s login terminal and could reuse the same relay shape for any
future "raw shell" plugin.

---

## 6. Extraction plan

What *could* move from core to plugins, ranked by safety. None of this is
required today — core is lean enough. These are options to keep it lean as
features accrete.

### 6.1 Safe extractions (additive, low risk)

| Candidate | Current home | Plugin shape | Why safe |
|-----------|--------------|--------------|----------|
| Service checks (`runServiceChecks`) | `index.js:560` | new `services` plugin (settings + notify + health) | Already settings-driven; just relocate the loop |
| qa-watcher (`startQaWatcher`) | `server/qa-watcher.js` + `index.js:557` | `qa` plugin (events + notify) | Already a side-effect loop; core just calls `start` |
| Fleet terminal as first-class | `plugins/fleet-term` (already a plugin) | — | Already extracted; serves as the template |

### 6.2 Borderline — dual-team management

`server/team-manager.js` (routes + login PTY) plus the `renderTeamManagement` UI
inside `public/js/plugin-host.js` implement dual-team login/switch. This is
**security-sensitive** (credential-existence checks, login PTY relay) and is
correctly kept close to core auth. The UI currently lives *inside the plugin
host module* rather than as its own `plugins/teams/` — a reasonable future move
is to extract it into a `teams` plugin so the plugin host stays generic. **Not
recommended now** — it works and touches the auth boundary; leave it.

### 6.3 Do-not-extract (must stay core)

- The **notify broadcast** (`broadcastNotify`) — plugins push *through* it; it
  can't itself be a plugin.
- The **upgrade router** (`index.js:484`) — it dispatches *to* plugin WS; it's
  the dispatcher, not a feature.
- The **session controller busy-lock/queue** — the safety-critical hinge for
  interrupt semantics. Must stay core.
- **Auth/system-mode** — the security boundary.

### 6.4 If reconnect logic grows

NanoCode rolls its own WS reconnect in the browser (notify WS reconnect on
close). If a fourth or fifth reconnecting WS client appears (today: notify,
team-login, fleet-term, terminal), consider adopting `reconnecting-websocket`
(4.4.0) to deduplicate the backoff/retry logic. Not warranted at the current
count.

### 6.5 Block-renderer extraction — DONE

**Problem:** `tab-manager.js` had a hard-wired if/else chain dispatching on
session type: Claude sessions got `ClaudeBlockRenderer`, Codex sessions got
`CodexBlockRenderer`, everything else got `TerminalPane`. Adding a new pane
type meant editing core; there was no way for a plugin to contribute a custom
renderer.

**Solution (implemented):**

| File | Role |
|------|------|
| `public/js/renderer-registry.js` | The registry: `register(sessionType, {name, factory, gate, priority})`, `createPane(type, el, opts)`, `unregister`, `list`. Selection = match `sessionType` + pass `gate(settings)` + highest `priority`. `*` is the universal fallback (TerminalPane, priority 0). |
| `public/js/default-renderers.js` | Side-effect module that registers the 3 built-in renderers as "default plugins": ClaudeBlockRenderer (priority 10, gated on `renderMode !== 'terminal'`), CodexBlockRenderer (priority 10, gated on `codexRenderMode === 'block'`), TerminalPane (`*`, priority 0, always on). |
| `public/js/tab-manager.js` | Refactored: replaced if/else with `rendererRegistry.createPane(type, paneEl, paneOpts)`. No more direct imports of ClaudeBlockRenderer / CodexBlockRenderer. |
| `public/js/plugin-host.js` | New `ui.registerRenderer(sessionType, {name, factory, gate, priority})` extension point. Per-plugin ownership tracked in `registry.renderers Set` so `unloadClientPlugin` can unregister cleanly. |

**Design model (webpack `module.rules` + VS Code `CustomEditor`):**

The renderer registry borrows two ideas:
- **webpack `module.rules`** ([loader concepts](https://webpack.js.org/configuration/module/#ruletest)): each rule has a `test` predicate + a loader; the first match wins. NanoCode's analog is `sessionType` (exact match) + `gate(settings)` (runtime predicate). Priority breaks ties when multiple rules match the same type.
- **VS Code `CustomEditorProvider`** ([extensibility patterns](https://code.visualstudio.com/api/extension-guides/custom-editors)): a plugin registers a factory that produces a webview for a given resource type. NanoCode's `factory(paneEl, opts)` returns a pane instance the same way.

**Selection algorithm** (`rendererRegistry.createPane`):

```
1. Collect all entries where entry.sessionType === type && entry.gate(settings)
2. If none match, fall back to entries where entry.sessionType === '*' && entry.gate(settings)
3. Among candidates, pick the highest priority
4. Instantiate: entry.factory(paneEl, paneOpts)
5. If factory throws, fall through to next candidate (defensive)
```

This guarantees: (a) a pane is always rendered (TerminalPane `*` fallback), (b)
plugins can override built-ins by registering a higher priority for the same
session type, (c) a plugin's renderer is automatically unregistered when the
plugin is unloaded.

**Tests:** `server/tests/renderer-registry.test.js` — 10 cases covering
register/get, missing-factory throw, gate filtering, priority ordering, `*`
fallback, null handling, createPane instantiation, re-register replaces,
unregister cleanup, and list introspection. Test count: 207 → 217, 0 failures.

### 6.6 Full feature extraction table

A complete inventory of features that are or could be plugin-extracted:

| Feature | Current home | Status | Difficulty | Extraction method |
|---------|-------------|--------|------------|-------------------|
| Block pane rendering | `default-renderers.js` | ✅ done | low | `renderer-registry.js` + `ui.registerRenderer()` |
| TTS (GPT-SoVITS proxy) | `plugins/tts/` | ✅ done | low | settings + events + routes |
| Worktree/team health dashboard | `plugins/monitor/` | ✅ done | low | settings + routes + notify + panel |
| Fleet terminal (multi-PTY) | `plugins/fleet-term/` | ✅ done | medium | settings + routes + `registerWebSocket` + panel |
| Service checks (`runServiceChecks`) | `index.js` | candidate | low | relocate loop to `services` plugin |
| QA watcher (`startQaWatcher`) | `server/qa-watcher.js` | candidate | low | side-effect loop → `qa` plugin |
| Dual-team login/switch | `plugin-host.js` UI + `team-manager.js` | borderline | high | security-sensitive; see §6.2 |
| Settings panel UI | `plugin-host.js` (browser) | borderline | medium | could move to `settings` plugin; currently shared host concern |
| Notify broadcast | `index.js:550` | ❌ never | — | core dispatcher; plugins push *through* it |
| WS upgrade router | `index.js:484` | ❌ never | — | core dispatcher to plugin WS |
| Session busy-lock/queue | `claude-session-controller.js` | ❌ never | — | safety-critical hinge |
| Auth / system mode | `server/auth/`, `router-mode.js` | ❌ never | — | security boundary |

---

## 7. Recommended lifecycle improvements (this change set)

The accompanying code change implements §4.1–§4.3 additively:

1. **`server/plugin-host.js`**
   - `registerLifecycle({ onStop })` — push to a `lifecycle` array, returns the
     plugin name for attribution (host tracks which plugin registered which
     handler so future unload can scope cleanup).
   - `reportStatus(level, message, { detail })` — broadcasts
     `{ type:'plugin:status', plugin, level, message, detail }` via
     `broadcastNotify`.
   - `shutdownPlugins()` — runs all `onStop` handlers in reverse load order,
     catches errors, returns a summary. Idempotent.
   - `loadPlugins` — read optional `dependencies: []` from manifest; topologically
     order loads; skip + warn a plugin whose dep is disabled/absent.

2. **`server/index.js`** — register `SIGINT`/`SIGTERM` handlers that call
   `pluginHost.shutdownPlugins()` before `process.exit`.

3. **`plugins/tts/server.js`** — `registerLifecycle({ onStop: () => clearTimeout(debounceTimer) })`
   + `reportStatus` when the circuit opens/closes.

4. **`plugins/monitor/server.js`** — `registerLifecycle({ onStop: stop })`
   wiring the existing exported `stop()` into the contract (tests can still call
   `stop()` directly).

5. **Tests** — `server/tests/plugin-host.test.js` gains cases for lifecycle,
   status, and dependency validation.

**Renderer-registry pass (this change set, additive):**

6. **`public/js/renderer-registry.js`** — new registry module (register /
   unregister / createPane / list / `_reset`). Selection by sessionType +
   gate(settings) + priority; `*` universal fallback.
7. **`public/js/default-renderers.js`** — side-effect import that registers the
   3 built-in renderers (ClaudeBlockRenderer, CodexBlockRenderer, TerminalPane)
   as default plugins with appropriate gates and priorities.
8. **`public/js/tab-manager.js`** — replaced if/else dispatch with
   `rendererRegistry.createPane()`; removed direct renderer imports.
9. **`public/js/plugin-host.js`** — added `ui.registerRenderer()` extension
   point with per-plugin ownership tracking + clean unregister on unload.
10. **`server/tests/renderer-registry.test.js`** — 10 new unit tests.

All changes are additive: existing plugins and renderers behave exactly as
before. The `npm test` baseline (207 pass) grows to 217, 0 failures.

---

## 8. Files read for this audit

Server: `index.js`, `plugin-host.js`, `store.js`, `team-manager.js`,
`router-mode.js`, `proxy.js`, `qa-watcher.js`, `middleware/auth.js`
Terminal: `routes.js`, `sessions.js`, `claude-session-controller.js`,
`claude-tmux-driver.js`, `agent-health-monitor.js`, `team-env.js`
Frontend: `app.js`, `tab-manager.js`, `terminal-view.js`, `sidebar.js`,
`agents.js`, `state.js`, `plugin-host.js` (browser), `index.html`,
`renderer-registry.js` (new), `default-renderers.js` (new),
`claude-block-renderer.js`, `codex-block-renderer.js`
Plugins: `README.md`, `tts/{server.js,client.js,plugin.json}`,
`monitor/{server.js,client.js,plugin.json,config.json}`,
`fleet-term/{server.js,client.js,plugin.json}`
Tests: `plugin-host.test.js`, `fleet-term.test.js`, `tts-plugin.test.js`,
`renderer-registry.test.js` (new)
Prior art: `research/arch-refactor/NANOCODE_ARCH_REPORT.md`, `NANOCODE_REVIEW.md`

### 8.1 Reference research (external)

| Source | What was studied | How it informed the design |
|--------|-----------------|---------------------------|
| [VS Code — Extension Capabilities Overview](https://code.visualstudio.com/api) | `contributes` manifest, `activationEvents`, `CustomEditorProvider` | The `ui.registerRenderer()` API mirrors `CustomEditorProvider`'s factory-for-resource-type pattern |
| [VS Code — Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) | Separate extension-host process, activation lifecycle | Confirmed NanoCode's same-process model is acceptable for trusted first-party plugins; the Disposable pattern informed `registerLifecycle` |
| [webpack — Module Rules](https://webpack.js.org/configuration/module/) | `module.rules` with `test` predicate + loader + first-match-wins | Directly inspired the renderer registry's `sessionType` + `gate(settings)` + `priority` selection model |
| [Obsidian — Plugin API](https://help.obsidian.md/Extending+Obsidian) | `registerMarkdownPostProcessor`, `registerView`, `registerCommands` | Obsidian's post-processor pattern (decorate rendered markdown by type) is the conceptual ancestor of `registerRenderer` |
| [Tauri — Sidecar / Shell](https://tauri.app/v1/guides/building/sidecar/) | Managed external process lifecycle | Context for NanoCode's tmux-bridge durability model (a sidecar that outlives the host) |
