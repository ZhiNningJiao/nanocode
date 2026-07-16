# REPORT: Session Singleton Lock (根治 9475/9476 打架)

> **Task**: 会话消费者跨服务器单例锁 — 根治双服务器共享会话池时 9476 给会话另挂 claude 消费者导致主人消息双投、两个秘书各自派活、互相踩的问题。
> **Date**: 2026-07-16
> **Branch**: `zhining/nano-plugin-akari` (集成分支续用)
> **Red line**: 9475 未碰 — 验证全部用 9477/9478 隔离实例。

---

## 问题根因

双服务器（9475/9476）共享同一 `~/.nanocode/` 目录（NFS home），当两个服务器同时对同一个 Claude 会话 attach WS 客户端时，各自独立 spawn 一个 claude 消费者（SDK streaming session）。两个消费者各自处理用户消息 → 主人消息双投、两个秘书各自派活、互相踩（今晨 4 条幽灵任务 + 9481 被折腾挂）。

根因：**缺少跨进程会话所有权锁** — 没有任何机制阻止第二个服务器对同一会话 spawn 消费者。

## 修复方案

### 1. 跨进程会话锁模块 `terminal/session-lock.js`

锁文件位于 `~/.nanocode/session-locks/<sessionId>.lock`，内容为 JSON：
```json
{"pid": 181195, "port": "9477", "timestamp": 1784167221840}
```

核心 API：
| 函数 | 行为 |
|---|---|
| `acquireSessionLock(sessionId, {pid, port}, home)` | 原子创建锁文件（O_EXCL\|O_CREAT）；若锁已被活进程持有 → 返回 `{acquired:false, holder}`；若持有进程已死 → 自动抢占（stale recovery） |
| `releaseSessionLock(sessionId, {pid, port}, home)` | 仅当 pid+port 匹配时删除锁文件（不误删他人锁） |
| `getLockHolder(sessionId, home)` | 返回当前持锁者；若锁 stale 则自动清理并返回 null |
| `isLockHeldByOther(sessionId, {pid, port}, home)` | 判断锁是否被**另一个**活进程持有 |
| `isPidAlive(pid)` | `process.kill(pid, 0)` 探测进程存活（EPERM = 存在但非 ours） |

关键设计：
- **原子创建**：`openSync(path, 'wx')` = `O_EXCL|O_CREAT|O_WRONLY`，两个进程同时创建只有一个成功
- **PID 校验回收**：持锁进程死亡后 `isPidAlive` 返回 false → 下次 acquire 自动覆盖 stale 锁
- **可重入**：同一 pid+port 再次 acquire 直接返回成功（幂等）
- **锁文件内容**：pid + port + timestamp，用于跨服务器识别持有者

### 2. 消费者 spawn 路径集成 `terminal/claude-session-controller.js`

在 `attachClaudeSession`（SDK stream-json bridge 路径，renderMode='block'）的 WS attach 入口加锁：

```
WS attach → acquireSessionLock(cs.claudeSessionId, {pid, port}, home)
  ├─ acquired=true → cs._lockHeld=true, 标记为 host
  │   └─ 若之前是 readOnly → 升级为 host，广播「会话已恢复为可编辑模式」
  └─ acquired=false → cs.readOnly=true, cs.lockHolder=holder
      └─ 向客户端发送只读 banner：「会话由 :<port> 托管（只读模式）」
```

**只读模式行为**：
- 客户端可以看到所有历史事件和实时输出（跟随模式）
- 客户端发送 `claude-input` → 服务端拦截，返回 `result` + `info`「会话由 :<port> 托管，无法发送消息（只读模式）」→ **不 spawn 消费者**
- UI 顶部显示持久 banner（🔒 会话由 :9477 托管）

**锁释放时机**：
- 最后一个 WS 客户端断开 → `releaseSessionLock`（`cs.clients.size === 0 && cs._lockHeld`）
- 服务器关闭 → `disposeClaudeSessions` 中释放所有持有的锁

**升级流程**：
- Host 的最后一个客户端断开 → 锁释放
- ReadOnly 服务器的下一个 WS attach → `acquireSessionLock` 成功 → 升级为 host → 广播「会话已恢复为可编辑模式」→ 客户端可发送消息

### 3. port 传递链路

```
server/index.js  →  createTerminalRoutes(store, { port: PORT })
terminal/routes.js  →  createClaudeSessionController({ ..., port: opts.port })
terminal/claude-session-controller.js  →  acquireSessionLock(sessionId, { pid: process.pid, port })
```

### 4. UI banner `public/js/claude-block-renderer.js` + `public/style.css`

- `_showReadOnlyBanner(holderPort)` — 在容器顶部插入持久 banner（🔒 会话由 :9477 托管）
- `_hideReadOnlyBanner()` — 升级时移除 banner
- CSS `.cbr-readonly-banner` — 蓝紫色条带，支持 light/dark 主题

### 5. Inject-path bypass fix（第 20 次独立验证发现并修复）

**发现的缺口**：原实现只在 WS `claude-input` 路径（`attachClaudeSession`）拦截只读输入，但 `POST /api/sessions/:id/inject`（crontab watchdog / secretary-wake 用的 HTTP 注入路径，`server/waker.js` 调用）是**另一个独立入口**，经 `injectClaudeMessage` → `dispatchClaudeTurn` 直接 spawn claude 消费者，**不检查 `cs.readOnly`**。后果：丢锁的只读服务器仍能通过 inject API spawn 第二个消费者——正是锁要根治的「两个秘书」冲突。

**根因**：19 次重新验证全部只测 WS `claude-input` 路径，从未覆盖 inject API 路径，因此 19 次都没发现这个绕过点。

**修复**：
- `terminal/claude-session-controller.js` `injectClaudeMessage`：在 `dispatchClaudeTurn` 之前加 `cs.readOnly` 守卫，只读时返回 `{ ok:false, error:'read-only: session hosted by :<port>', readOnly:true, lockHolderPort }`，**不 broadcast user event、不 spawn 消费者**。host（`readOnly=false`）的合法 wake 路径不受影响。
- `terminal/routes.js` inject 路由：识别 `result.readOnly` 返回 **423 Locked**（而非误返 404），让 watchdog 明确知道会话由他服务器托管、应改投 host，而不是误判会话不存在。

**验证**：
- 新增单测 `session-lock-dual-server.test.js` 第 5 例「read-only server blocks the inject API (no consumer spawned); host still wakes」：只读服务器 inject → 423 + `ok:false` + `readOnly:true` + `lockHolderPort=9477` + turns 不变；host inject → 200 + `ok:true` + turns 递增（合法 wake 路径完好）。
- `scripts/verify-session-singleton.mjs` 新增 Test 2b：真实双服务器 9477/9478，只读服务器 inject → 423 / ok:false / readOnly:true / host=:9477，stderr 确认 `inject blocked — ... hosted by :9477 (read-only mode)`。断言从 8 升至 12，全过。

### 6. Pre-existing CustomEvent 测试环境失败 — 修复（第 24 次独立验证发现并修复）

**发现的缺口**：第 23 次独立验证诚实地发现 `npm test` 实际是 645/653 pass / 6 fail（而非 re-verified-19/20/21 误报的「653/653 pass 0 fail」），6 个失败全是 `opencode-replay-dedup-repro.test.js` 的 `ReferenceError: CustomEvent is not defined`（`claude-block-renderer.js:1411` `new CustomEvent(...)`）。第 23 次验证推断这是 Node 18 环境问题、与 session-singleton 无关，但**从未在父提交上实跑验证**。

**本次（第 24 次）新增的实证 + 修复**：
- **实证不是回归**：在 session-singleton 实现提交 `3c8ff14` 的父提交 `87c5802`（`git worktree add /tmp/opencode/ss-pre 3c8ff14~1`）上实跑同一个测试 → 同样 6 fail / 0 pass，**证明 6 个失败在 session-singleton 之前就已存在**（`git blame` 确认 1411 行来自 `725cc0dd` 2026-06-03，非 `3c8ff14`）。
- **全消费者 spawn 路径审计**：追踪 `dispatchClaudeTurn` 全部 9 个调用点（543/570/773/804/820 = 已运行 turn 的 proc close/error 续延；909 = inject 已守卫；1297 = WS claude-input 已守卫于 1189；1516 = interrupt 续延）——**确认无剩余绕过点**（第 20 次验证发现的 inject 是最后一个，现已堵住）。
- **修复 6 个预存失败**：根因是测试 `before()` mock 了 `global.document.dispatchEvent` 为 no-op，但 Node 18 没有 `global.CustomEvent`（Node 19+ 才有），导致 `new CustomEvent(...)` 抛 `ReferenceError`。加一行 polyfill `global.CustomEvent = class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }` 到测试 setup。修复后 `opencode-replay-dedup-repro.test.js` 6/6 pass，**全量回归首次真实全绿 651/653 pass / 0 fail / 2 skipped**（纠正 prior FLAGs 的假报）。

## 文件变更清单

| 文件 | 状态 | 变更 |
|---|---|---|
| `terminal/session-lock.js` | 新增 | 跨进程会话锁模块（201 行） |
| `terminal/claude-session-controller.js` | 修改 | acquire/release 集成、只读模式、升级、UI banner；**injectClaudeMessage 只读写守卫** |
| `terminal/routes.js` | 修改 | 传递 `port` opt 到 controller；**inject 路由 423 Locked 分支** |
| `server/index.js` | 修改 | 传递 `{ port: PORT }` 到 `createTerminalRoutes` |
| `public/js/claude-block-renderer.js` | 修改 | 只读 banner 显示/隐藏 |
| `public/style.css` | 修改 | banner 样式 |
| `server/tests/session-lock.test.js` | 新增 | 21 个单元测试 |
| `server/tests/session-lock-dual-server.test.js` | 新增 | 4 个双服务器集成测试 |
| `server/tests/opencode-replay-dedup-repro.test.js` | 修改 | CustomEvent polyfill（修复 6 个 Node 18 预存测试失败） |
| `scripts/verify-session-singleton.mjs` | 新增 | 手工验证脚本（起 9477/9478 双实例） |

## 验证证据

### 单元测试（`server/tests/session-lock.test.js`）
```
# tests 21  # pass 21  # fail 0
```
覆盖：acquire/release 基本周期、活锁拒绝、stale 锁抢占、仅 owner 释放、可重入、corrupt 锁覆盖、getLockHolder/isLockHeldByOther 语义、acquire→release→acquire 周期、不同会话不冲突。

### 双服务器集成测试（`server/tests/session-lock-dual-server.test.js`）
```
# tests 5  # pass 5  # fail 0
```
1. **首服务器获锁、次服务器只读** — 9477 获锁为 host，9478 收到「会话由 :9477 托管」banner
2. **只读服务器阻止 WS 输入** — 9478 发 claude-input 被拦截，不 spawn 消费者（turns 不变），返回「只读模式」消息
3. **Host 断开 → 只读升级** — 9477 WS 关闭 → 锁文件删除 → 9478 再 attach → 升级为 host → 可发送消息 → 锁转 9478
4. **不同会话不冲突** — 两个服务器各持自己的会话锁，互不干扰
5. **只读服务器阻止 inject API + host 仍可 wake**（第 20 次验证新增）— 9478 POST inject → 423 + ok:false + readOnly:true + lockHolderPort=9477 + turns 不变；9477 inject → 200 + ok:true + turns 递增（合法 wake 路径完好）

### 全量回归
```
# tests 653  # pass 651  # fail 0  # skipped 2
```
首次真实全绿（第 24 次验证修复 CustomEvent 后）。注：re-verified-19/20/21 误报「653/653 pass 0 fail」，实际有 6 个 `CustomEvent is not defined` 失败（Node 18 预存环境问题，非 session-singleton 回归——已在 `3c8ff14~1` 父提交上实证）；本次加一行 polyfill 后真实 0 fail。

### 手工验证脚本（`scripts/verify-session-singleton.mjs`）
```
── Test 1: first server = host, second = read-only ──
  PASS  lock file exists after server A attaches
  PASS  lock held by :9477 (got :9477)
  PASS  server B received read-only banner
  PASS  banner says hosted by :9477 (got :9477)

── Test 2: read-only server blocks input ──
  PASS  read-only server rejected WS input with "只读模式" message

── Test 2b: read-only server blocks HTTP inject ──
  PASS  read-only inject returns 423 Locked (got 423)
  PASS  read-only inject reports ok:false
  PASS  read-only inject sets readOnly:true
  PASS  read-only inject identifies host :9477 (got :9477)

── Test 3: host disconnect → promotion ──
  PASS  lock file removed after host disconnects
  PASS  server B promoted to host
  PASS  lock now held by :9478 (got :9478)

Results: 12/12 assertions passed
ALL ASSERTIONS PASSED — session singleton lock works.
```

脚本起两个真实 server 实例（9477/9478，共享 temp HOME），用 HTTP API 建项目/tab，用 WebSocket + HTTP inject 客户端验证完整端到端行为（含 inject 绕过点）。

## 部署说明

- **9475 不碰**（红线）— 验证全部用 9477/9478
- 9476 部署按既有授权
- 部署后效果：9475 和 9476 对同一会话只有一个能 spawn 消费者，另一个只读跟随；host 断开后只读端自动升级
- 锁文件目录 `~/.nanocode/session-locks/` 已存在（4 个现有锁文件），新锁文件格式兼容

## 边界与限制

- 锁仅在 SDK stream-json bridge 路径（renderMode='block'）生效；PTY 终端模式（renderMode='terminal'）下每个服务器独立 PTY，不共享会话
- 锁依赖 PID 存活校验；如果持锁进程被 `kill -9` 但 PID 被复用（极小概率），锁不会自动失效直到新进程 acquire 时发现 PID 存活 — 但此时 acquire 会被拒绝（活锁），需要持锁进程真正退出后才会释放
- 跨服务器需要共享同一 `~/.nanocode/session-locks/` 目录（NFS home 场景已满足）

## 第 25 次独立验证（2026-07-16，opencode/GLM 全新会话，不信任何 prior FLAG/REPORT）

- **不信任先验**：全新会话独立重跑，先 `git fetch fork` 确认 fork/main HEAD `04540b6`、本地 `6ec2dbf`（4 ahead / 3 behind；3 behind 是并行 codex/akari Round-4 功能，4 ahead 中只有 `6ec2dbf` 碰 session-singleton 且仅为 1 行 Node18 CustomEvent 测试 polyfill，非锁逻辑）；`git merge-base --is-ancestor` 确认实现 `3c8ff14` 与 inject 修复 `dcc0ab3` **均在 fork/main**。
- **源码 provenance**：重读 `terminal/session-lock.js`（201L：`openSync('wx')` 原子创建 @78 / `process.kill(pid,0)` 存活探测 ESRCH=死 EPERM=活 @39-48 / 仅 owner pid+port 释放 @181 / 同 pid+port 可重入 @139 / 损坏锁覆盖 @132-136）+ controller 接线（acquire@1072 / promoted@1078 / readonly-banner@1110 / WS 输入拦截不 spawn@1170 / inject readOnly 守卫@887-899 在 dispatchClaudeTurn@909 之前 / 末客户端释放@1299 / dispose 释放@1816）——与声称一致，全部为真。
- **自跑测试**：`node --test server/tests/session-lock.test.js server/tests/session-lock-dual-server.test.js` → 26/26 pass 0 fail（0 TAP `^not ok`）；`npm test` 全量回归 → 653 tests / 651 pass / 0 fail / 2 skipped（`run_session_singleton_25thverify_full.log`，0 `^not ok`）。
- **真实双服务器**：`node scripts/verify-session-singleton.mjs` 用真实 9477/9478 共享全新 temp HOME（复现 9475/9476 双秘书冲突）→ 12/12 断言全过（test UUID `679e07f2-2252-4ce4-a86b-a4483b71271c`）：A 获锁为 host、B 收「会话由 :9477 托管」banner、B WS 输入被拦「只读模式」不 spawn、B inject → 423 Locked / ok:false / readOnly:true / host=:9477、A 断开锁释放、B 升级为 host、锁转 :9478；stderr 确认 `[claude:lock] ... hosted by :9477 (pid 32316). Read-only mode.` → `inject blocked — ... read-only mode.` → `promoted to host`。
- **红线**：9475 全程 LISTENING（前后 HTTP 200，未碰），9477/9478 前后空闲，`data/nanocode.json` 备份+恢复 sha256 完全一致（`36584e47…`，无污染），真实 `~/.nanocode/session-locks/` 前后 300 条、test UUID 不在其中，temp home 已清理；`run_session_singleton_25thverify_dual.log` grep 干净（0 `^not ok`/`FAIL:`）。
- **交付**：24th 发现的 polyfill（`6ec2dbf`）此前仅本地；本次以干净 fast-forward（无 force-push）落到 fork/main，使 fork/main `npm test` 首次真实全绿（此前 6 个 Node18 CustomEvent 预存失败）。
- **anti-fake-pass 裁决**：REAL（file-exists PASS / provenance PASS / HTTP N/A / anim N/A）。


## 第 28 次独立验证（2026-07-16，opencode/GLM 全新会话，不信任何 prior FLAG/REPORT）

- **不信任先验**：全新会话独立重跑，`git fetch fork` 确认 fork/main HEAD `e1db062`、本地 `5410945`（8 ahead / 7 behind；7 behind 为并行 codex/opus_burn 功能 + merge，均不碰 session-singleton；8 ahead 中仅 `f93881f`/`5410945` 为 session-singleton 验证记录 + verify 脚本 self-clean）；`git merge-base --is-ancestor` 确认实现 `3c8ff14` + inject 修复 `dcc0ab3` + CustomEvent polyfill `646e5b1` **均在 fork/main**；session-singleton 代码文件（lock/controller/routes/index/tests）local 与 fork/main **零 diff**，仅 `scripts/verify-session-singleton.mjs` 差 +29/-4（self-clean，此前仅本地）。
- **源码 provenance**：重读 `terminal/session-lock.js`（201L）+ controller 接线（import@16 / acquire@1093 / promoted@1096-1100 / readonly-banner@1129-1139 / WS 输入拦截不 spawn@1189-1203 / inject readOnly 守卫@887-899 在 dispatchClaudeTurn@909 之前 / 末客户端释放@1318-1320 / dispose@1835-1836）+ routes.js（inject@219 / 423@236-243）+ index.js（createTerminalRoutes@150）——与声称一致，全部为真。
- **自跑测试**：`node --test server/tests/session-lock.test.js server/tests/session-lock-dual-server.test.js` → 26/26 pass 0 fail（0 TAP `^not ok`）；`npm test` 全量回归 → 653 tests / 651 pass / 0 fail / 2 skipped（`run_session_singleton_28thverify_full.log`，0 `^not ok`）。
- **真实双服务器**：`node scripts/verify-session-singleton.mjs` 用真实 9477/9478 共享全新 temp HOME → 12/12 断言全过（test UUID `22c89422-2da8-41d5-80d1-8972bc914947`）：A 获锁 host、B 收「会话由 :9477 托管」banner、B WS 输入被拦「只读模式」不 spawn、B inject → 423 / ok:false / readOnly:true / host=:9477、A 断开锁释放、B 升级 host、锁转 :9478；stderr 确认 `hosted by :9477 (pid 152703)` → `inject blocked` → `promoted to host`。
- **红线**：9475 全程 LISTENING（前后 HTTP 200，未碰），9477/9478 前后空闲，`data/nanocode.json` sha `63d06d51…` 前后完全一致（verify 脚本 self-clean 自动删除其创建的 singleton-test 项目，无需手动备份/恢复），真实 `~/.nanocode/session-locks/` 前后 260 条、test UUID 不在其中（temp HOME 隔离），`run_session_singleton_28thverify_dual.log` grep 干净。
- **交付**：27th run 的 verify 脚本 self-clean 修复（`5410945`）+ 26th/27th 验证记录此前仅本地（fork/main 仅到 re-verified-24 / 第 25 次记录）；本次以干净隔离 cherry-pick（`f93881f` + `5410945`，仅 SS，不带 codex/opus_burn）落到 fork/main `e1db062` 之上 + 本 28th 记录，fast-forward 推送，完成「推 fork main」交付——fork/main 现携带 self-cleaning verify 脚本与最新验证记录。
- **anti-fake-pass 裁决**：REAL（file-exists PASS / provenance PASS / HTTP PASS 9475 200 / anim N/A）。
