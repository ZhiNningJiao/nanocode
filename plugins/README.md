# NanoCode Plugin System

NanoCode keeps a tiny Core (projects, tabs, PTY/agent sessions, event bus) and
pushes everything else into optional plugins under `plugins/<name>/`.  This
document defines the host API that Core exposes and that every plugin consumes.

> Scope note (MES-13256): this first cut implements the host API and extracts
> TTS as the reference plugin.  Subscription billing and Cloud management are
> backlog items and will reuse the same host API.

## What a plugin is

```
plugins/<name>/
  plugin.json   # manifest: name, version, extensionPoints
  server.js     # server-side register(host)  (optional)
  client.js     # browser-side register(ui)   (optional)
```

A plugin is an ES module.  It is trusted first-party code (group-authored), not
sandboxed.  Enable/disable is opt-in via the Core settings store under
`plugin_<name>_enabled`.  The server lazily imports a plugin only when it is
enabled.

## Extension points (host API)

Core exposes three extension points.  The TTS plugin exercises all of them.

### 1. Server event bus — `host.on(event, cb) / host.emit(event, payload)`

Core broadcasts the raw agent/terminal output stream as `'agent:output'` events.
Server plugins subscribe to react to the stream without changing Core.

```js
// plugins/tts/server.js
export function register(host) {
  host.on('agent:output', (text) => {
    // extract [TTS_START]...[TTS_END] and enqueue
  })
}
```

Plugins may also emit their own events for cross-plugin coordination; only
listeners registered via `host.on` receive them.

### 2. Server settings registration — `host.registerSetting(def)`

Plugins declare settings so the Core settings REST API (`/api/settings`) and the
frontend settings panel know about them.

```js
host.registerSetting({
  key: 'tts_enabled',
  type: 'boolean',
  default: false,
  label: 'Enable TTS',
})
```

Core persists the value in the same JSON store as native settings.  Plugins read
values through `host.getSetting(key)` and write through `host.setSetting(key, value)`.

### 3. Server routes — `host.registerRoute(method, path, handler)`

Plugins can mount Express routes under `/api`.  This is how TTS exposes its
`/api/tts` proxy without Core knowing anything about GPT-SoVITS.

```js
host.registerRoute('post', '/tts', async (req, res) => { ... })
```

### 4. Client settings UI slot — `ui.registerSetting(def)`

Browser plugins inject settings controls into the settings panel.  Core reserves
a DOM container and each plugin appends its own subsection.

```js
// plugins/tts/client.js
export function register(ui) {
  ui.registerSetting({
    id: 'tts-settings',
    render(container) {
      container.innerHTML = '...'
    },
  })
}
```

### 5. Client message bus — `ui.onMessage(cb)`

Server plugins can push messages to the browser through the existing notify
WebSocket.  The client host forwards messages whose `type` starts with
`plugin:` to registered callbacks.

```js
ui.onMessage((msg) => {
  if (msg.type === 'plugin:tts:enqueue') playAudio(msg.text)
})
```

Plugins may also use `ui.on(event, cb) / ui.emit(event, payload)` for local
browser events such as `nanocode:terminal-output`.

## Enabling a plugin

Add to `data/nanocode.json` settings (or via the settings UI once the plugin
registers its control):

```json
{
  "settings": {
    "plugin_tts_enabled": true
  }
}
```

When disabled, the plugin is not imported on the server and its client-side UI is
not injected, so its feature completely disappears.

## Design rules for future plugins

1. **Core stays small.**  Do not add feature-specific routes or UI to Core.
2. **First-party trust.**  Plugins are plain ES modules; no sandbox for now.
3. **Lazy load.**  Only enabled plugins are imported.
4. **Event-first.**  Prefer `host.on('agent:output', ...)` over hooking into
   Core internals.
