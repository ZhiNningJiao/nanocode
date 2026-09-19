# Nanocode

A multi-user web workspace for shared dev hosts. Browse to `http://<host>:2333`, log in with a one-time code from your terminal, and you get multi-tab terminals, a project file explorer, and coding-agent tabs (Claude / Codex / Cursor / OpenCode) — all persisted across reloads, reboots, and device hand-offs.

## Features

- **Multi-user system mode** — single systemd-managed router runs as an unprivileged service account; per-user workers run as the invoking UID. No user needs to join any group.
- **Multi-tab terminals** — bash, Claude Code, Codex, Cursor Agent, OpenCode. Each agent launches with its max-permissions / no-approvals flag. Agent `/exit` drops you to a raw login shell instead of going dead.
- **Project file explorer** — tree, breadcrumb, inline edit, drag-drop uploads, markdown / code / image / **GLB 3D-model** preview.
- **Persistent sessions** — 3-day rolling TTL on the auth cookie; PTYs survive worker restarts; scrollback replays after a host reboot.
- **Cross-device** — log in on a laptop, pick the same session up on a phone.
- **Dark mode** — header toggle, OS-preference detection, FOUC-free pre-paint, xterm theme swap on the fly.
- **No build step** — vanilla JS served as static files by the router (decoupled from worker health, so a busy worker can't break cold-load).
- **Auto-update** — systemd timer checks GitHub releases nightly, drops in new versions without manual intervention.

## Install (system mode, recommended)

Requires Linux with systemd, Node ≥ 18, and a user that can `sudo`.

```bash
sudo apt-get update
sudo apt-get install -y git build-essential nodejs npm curl

git clone https://github.com/victoriacity/nanocode.git /tmp/nanocode
sudo /tmp/nanocode/scripts/install.sh
sudo systemctl enable --now nanocode
```

The installer:

- Creates a `nanocode` system user/group (service account; **no human user needs to be in this group**).
- Lays the app under `/usr/lib/nanocode/`, the CLI at `/usr/local/bin/nanocode`, the systemd unit at `/etc/systemd/system/nanocode.service`.
- Builds + installs `nanocode-spawn` as setuid-root (mode 4755). This is the only piece that runs with elevated privileges, and only momentarily — it drops to the invoking UID before exec'ing the worker.
- Installs and enables the daily auto-update timer (`nanocode-update.timer`).
- Listens on port **2333** by default. Change with `Environment=PORT=…` in `/etc/systemd/system/nanocode.service`.

**Per user — run as that user, NOT as root:**

```bash
nanocode login
# → prints a one-time claim code
# → paste it at http://<host>:2333/login in your browser
```

Any user on the host can run `nanocode login`. No group membership required. Sessions last 3 days rolling. Workers auto-reconnect to the router after restarts.

## Maintain

### Check status

```bash
systemctl status nanocode               # router (always running)
nanocode status                         # your worker
journalctl -u nanocode -f               # router logs (live)
sudo systemctl list-timers nanocode-update.timer
```

### Restart the router (workers preserved)

```bash
sudo systemctl restart nanocode
# Workers auto-reconnect through their backoff loop.
# PTYs and live agent sessions survive.
```

### Restart your worker (PTYs and agent state lost)

```bash
nanocode logout && nanocode login
```

You'd do this if your worker is stuck, or to pick up new worker-side code after an update. Agents' on-disk work (git commits, file edits) is preserved; only their in-memory conversation context is lost.

### Update

The `nanocode-update.timer` runs `/usr/lib/nanocode/nanocode-update.sh` daily at ~04:00 + jitter. It compares `/usr/lib/nanocode/package.json`'s version to the latest GitHub release tag; if they differ, it downloads the release tarball, runs `install.sh` from inside it, restarts the router.

Run it on demand:

```bash
sudo /usr/lib/nanocode/nanocode-update.sh
```

Disable auto-update:

```bash
sudo systemctl disable --now nanocode-update.timer
```

### Uninstall

```bash
sudo systemctl disable --now nanocode nanocode-update.timer
sudo rm -rf /usr/lib/nanocode /etc/systemd/system/nanocode.service /etc/systemd/system/nanocode-update.{service,timer}
sudo rm /usr/local/bin/nanocode
sudo userdel nanocode && sudo groupdel nanocode
sudo systemctl daemon-reload
```

User data at `~/.nanocode/` (data.json, scrollback, runtime env) is preserved unless you explicitly remove it.

## Known limitations

- After a host reboot, each user must run `nanocode login` once to bring their worker back. `loginctl enable-linger <user>` + a per-user `systemctl --user` template will fully automate this (open follow-up).
- File explorer browses local projects only. Remote-SSH projects show a "remote browsing unsupported" state — use terminal tabs.
- xterm symlink-escape from a project sandbox isn't lexically blocked (acceptable for the single-user-trusted-host model).

## Single-user mode (dev / hacking)

If you don't want system mode and just want to run nanocode against your own user, the legacy single-user mode still works:

```bash
git clone https://github.com/victoriacity/nanocode.git
cd nanocode
npm install
npm start
# → http://localhost:3000
```

PM2 / `npm run pm2:start` keeps it alive across reboots if you want a quick persistent setup without going through system mode.

## Architecture

See [`docs/system-mode-design.md`](docs/system-mode-design.md) for the privilege-drop, auth flow, IPC framing, and the trust model. [`docs/architecture.md`](docs/architecture.md) covers the application layer (project store, PTY sessions, file explorer).

## Tests

```bash
npm test
```

---

## Architecture & Code Logic (for AI contributors)

This section documents internals so AI agents making code changes understand the system before editing it. **Read this before modifying any server, worker, or terminal file.**

### Layer Responsibilities

| Layer | Entry point | Responsibility |
|---|---|---|
| `server/index.js` | `node server/index.js` | Single-user HTTP+WS server. Hosts all Express routes, serves `public/`, owns the store singleton, proxies TTS, manages the agents config. In system mode this becomes the router; workers handle per-user sessions. |
| `server/store.js` | `getStore()` | Persistent JSON store for projects, tabs, settings. Single file: `data/nanocode.json`. Uses atomic tmp+rename writes. |
| `worker/index.js` | spawned by setuid helper | Per-user process in system/multi-user mode. Owns PTY sessions and per-user `~/.nanocode/data.json`. Connects to router via Unix socket. |
| `worker/data-store.js` | `DataStore` class | Atomic JSON store for worker (same shape as server/store, already uses tmp+rename). |
| `terminal/routes.js` | `createTerminalRoutes()` | Express router for all `/api/projects`, `/api/tabs`, PTY management. Shared by both server and worker. |
| `terminal/sessions.js` | `SessionStore` | In-memory PTY/session Map. Flushes scrollback to `~/.nanocode/scrollback/<tabId>` every 5 s using tmp+rename. |
| `terminal/claude-sdk-driver.js` | `ClaudeSDKDriver` | Drives `@anthropic-ai/claude-agent-sdk` for Claude Code sessions. Handles streaming, tool use, session resume. |
| `public/` | static files | Vanilla JS frontend — no build step. `app.js` is the main entry. |

### Session History — Three Storage Layers

Understanding these layers is critical for diagnosing "session disappeared" bugs:

| Layer | What is stored | Location | Crash behavior |
|---|---|---|---|
| Structural metadata | projects, tabs (IDs, labels, types, claudeSessionId) | `data/nanocode.json` (server) or `~/.nanocode/data.json` (worker) | Safe since atomic write: either old or new file survives |
| PTY scrollback | Terminal output buffer for display on reconnect | `~/.nanocode/scrollback/<tabId>` | Last ≤5 s of output may be lost (flush interval) |
| Runtime session Map | Active PTY/process handles, in-memory state | RAM only | Lost on crash. But `claudeSessionId` in the metadata layer persists, so `--continue` can resume the Claude conversation |

True "session loss" = metadata file corrupted on write. That is prevented by the atomic write in `save()` / `_write()`. Do not weaken these.

### Robustness Hard Rules (AI must not violate these)

1. **Every async Express route handler must have a try/catch (or use asyncWrap).**
   Express 4 does not catch rejected async handlers — they become `unhandledRejection` which kills the process in Node ≥ 15. Always wrap:
   ```js
   app.get('/api/foo', async (req, res) => {
     try {
       // ...
     } catch (err) {
       console.error('[/api/foo]', err)
       res.status(500).json({ error: err.message })
     }
   })
   ```

2. **Critical state writes must use tmp+rename atomic write.**
   Direct `writeFileSync(path, data)` can truncate the file if the process crashes mid-write. Always:
   ```js
   const tmp = filePath + '.tmp'
   writeFileSync(tmp, JSON.stringify(data, null, 2))
   renameSync(tmp, filePath)
   ```
   `server/store.js` `save()` and `worker/data-store.js` `_write()` both implement this. Do not change them to direct writes.

3. **Process-level uncaughtException/unhandledRejection handlers must log and keep alive.**
   Both `server/index.js` and `worker/index.js` install these handlers. They must never call `process.exit()`. If you add a new process entry point, replicate these handlers.

4. **Side-channel features (TTS, ntfy, auth status) must not crash the main process or lose data.**
   TTS failures are caught at three layers: outer try/catch in the handler, ttsSerialize queue safeFn wrapper, and the process-level unhandledRejection guard. Do not remove any of these layers.

5. **Corrupt JSON on load must be backed up, not silently erased.**
   `server/store.js` backs up to `.bak` before falling back to `emptyData()`. This preserves the broken file for forensic recovery. Do not change the catch block to silently return `emptyData()` without a backup.

### Deployment — DO NOT MODIFY

> AI contributors: this section describes the actual deployment. Do not change any of the files or behavior described here.

**Dev / single-user mode (this repo's typical usage):**
- `npm start` or `npm run dev` — runs `node server/index.js` directly.
- Port defaults to `3000` (override with `PORT=`).
- Data stored in `data/nanocode.json` relative to the repo.
- The working instance at port `3001` on `10.18.8.55` is the live server. Do not kill or restart it without explicit instruction.

**System / multi-user mode (`NANOCODE_SYSTEM=1`):**
- `scripts/install.sh` (requires root) copies the app to `/usr/lib/nanocode/`, creates a `nanocode` system user, installs a setuid helper (`helper/nanocode-spawn`), and installs a systemd unit.
- The router listens on TCP, each user spawned via `nanocode login` gets their own worker process with their own data file under `~/.nanocode/`.
- Auto-update timer (`nanocode-update.timer`) pulls from git daily.
- The CLI is `bin/nanocode` (login/logout/status subcommands).

**What "deployment logic" means and why not to touch it:**
`scripts/install.sh`, `scripts/nanocode.service`, `scripts/nanocode-update.sh`, `bin/nanocode`, `helper/`, `server/router-mode.js` — these files control how the system-wide service is installed and started. Modifications require root access and systemd restarts. Changes to port numbers, startup scripts, or process topology belong to the ops layer, not to feature development.
