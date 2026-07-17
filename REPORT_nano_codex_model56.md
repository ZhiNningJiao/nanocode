# REPORT: Codex Block-Mode `/model` → gpt-5.6-sol + Cross-Tab /model Isolation (Tab-Level Override)

> **Task**: 修复 nanocode codex block 模式下 `/model` 无法切换到 `gpt-5.6-sol` 的问题，并修复
> 一个 claude tab 切模型会把另一个 claude tab 也同步切走的 cross-tab 同步 bug。
> **Date**: 2026-07-18
> **Branch**: `zhining/nano-9476-integ-0716`
> **Commit**: `393acc7` (fix + tests + report + flag)
> **Parent**: `12d17aa` (merge onto fork/main)
> **Remote**: pushed to `fork` (ZhiNingJiao/nanocode) `main`, fast-forward, no force.
> **Red line**: 9475 未碰。9476 重启由 secretary 执行（见末尾部署说明）。

---

## 问题根因（三个独立根因）

### 根因 (a)：前端 `/model` 拦截只对 claude tab 生效，codex tab 从未拦截

`public/js/terminal-view.js` 的 `sendInput()` 里 `/model` 拾取器被 `isClaudeTab` 守卫包住
（原 `if (isClaudeTab && text.trim().match(/^\/model\s*$/))`），codex tab 走不进这个分支。

**后果**：codex tab 里输入 `/model gpt-5.6-sol` 被原样作为 prompt 发给模型。关键在于
**codex SDK driver 走的是 `thread.runStreamed()` 直接 API 调用，绕过 codex CLI 的 REPL**——
所以字面 `/model <name>` 对模型来说只是普通文本，**永远不会切换模型**。这和 claude tab 不同
（claude block 模式的 `/model` 是前端拦截→写设置）。

### 根因 (b)：SDK driver 默认用 bundled 0.137 codex，跑不了 gpt-5.6-sol

`terminal/codex-sdk-driver.js` 读 `codex_path_override` 设置；**未设置时直接传空 override**，
SDK 于是用自己的 bundled `@openai/codex-sdk` 0.137 codex 二进制。该版本对 `gpt-5.6-sol`
返回 **400 "requires a newer version of Codex"**。

主人已重装用户级 CLI：`~/.local/lib/npm-global/bin/codex`（codex-cli **0.144.5**，
gpt-5.6-sol smoke-tested OK），但 driver 不会自动用它。

### 根因 (c)：`/model` 写全局设置 → 所有 tab 同步切模型（cross-tab sync bug）

`/model` 在 server 端写 **全局** `claude_model` / `codex_model` 设置（`server/index.js`
`PUT /api/settings`）。在一个 tab 里切模型，**所有同类型 tab 下一轮都跟着切**——两个 claude
tab 想用不同模型根本不可能。主人 01:5x 指示："别再走全局 codex_model"。

## 修复方案：Tab-Level Model Override（根治三根因）

**核心思路**：模型选择从"全局设置"改为"tab 级 override"。driver 读
`cs.*Override || global`，前端 `/model` picker PATCH 到 tab，sibling tab 各自独立。

### Cut 1：后端 tab 级 override 持久化 + driver 读取

- **`server/store.js:215`**：`updateTabMetadata` 白名单加 `modelOverride`, `effortOverride`。
  `createTab` 不初始化它们（undefined = 跟全局），`listTabs`/`getTab` 自然带出。
- **`terminal/claude-session-controller.js`**：
  - cs 创建（claude ~line 1204、codex ~line 1474）：`cs.claudeModelOverride = tab?.modelOverride || null`、
    `cs.codexModelOverride = tab?.modelOverride || null`、`cs.claudeEffortOverride = tab?.effortOverride || null`。
  - `setTabModelOverride(projectId, tabId, {modelOverride, effortOverride})`（line 263）：
    PATCH 路由调用，**同时**更新 live claude cs 和 codex cs，下一轮立即生效，无需 WS 重连。
  - 所有 driver 读取点改成 `cs.claudeModelOverride || store.getSetting('claude_model')`
    （claude-session-controller.js line 566/755、claude-tmux-driver.js line 371-372/521-522、
    claude-sdk-driver.js line 402/606、codex-sdk-driver.js line 117）。
- **`terminal/codex-sdk-driver.js:117`**：`const codexModel = cs.codexModelOverride || store.getSetting('codex_model') || ''`。
  **无白名单**——`gpt-5.6-sol` 或任何模型名原样透传到 `threadOptions.model`（line 146）。

### Cut 2：新 PATCH 路由 + server `/model` handler 改写 tab

- **`terminal/routes.js:471`** 新增 `PATCH /api/projects/:id/tabs/:tabId/model`：
  - body `{ modelOverride?, effortOverride? }`，trim 后 `'' → null`（清回全局）。
  - 校验 tab 类型必须是 `claude` 或 `codex`（否则 400）。
  - `store.updateTabMetadata` 持久化 → `sessionController.setTabModelOverride` 更新 live cs →
    `broadcastTabs` 推 `tabs:update`。
- **`terminal/claude-session-controller.js:1354`** server `/model` handler：
  原写全局 `claude_model` → 改为 `store.updateTabMetadata(projectId, tabId, {modelOverride: newModel})`
  + `cs.claudeModelOverride = newModel` 原地更新；bare `/model` 读 `cs.claudeModelOverride || global`。

### Cut 3：前端 codex `/model` 拦截 + picker PATCH tab

- **`public/js/terminal-view.js`**：
  - `showModelPicker` / `applyModelAndEffort`：从 `activeTab.modelOverride || global` 读当前模型；
    PATCH `/api/projects/${pid}/${tabId}/model` 替代 `PUT /api/settings`。
  - `applyCodexModel` / `showCodexModelPicker`（line 1755/1782）：codex tab 的 `/model` 拾取器，
    PATCH tab model 替代写全局 `codex_model`。**自由输入无白名单**——`gpt-5.6-sol` 任意未来模型名都能填。
  - `sendInput` codex 分支：`isCodexTab` 时 `^\/model\s+(\S.*)$` → `applyCodexModel`；
    `^\/model\s*$` → `showCodexModelPicker()`。
- **`public/js/tab-manager.js:569`**：tab chip 上加 `tab-chip-model` 徽章，显示 `tab.modelOverride`，
  tooltip "model override: X (others follow global default)"。
- **`public/style.css:2480`**：`.tab-chip-model` 样式。
- **`public/js/app.js:618`**：修正误导注释。

### Cut 4（沿用前提交）：SDK driver 默认指向用户级 CLI

`terminal/codex-sdk-driver.js` override 解析三段优先级（line 125-133）：
**显式 `codex_path_override`（永远赢）> 用户级 CLI `~/.local/lib/npm-global/bin/codex`
（`existsSync` 为真时）> bundled 退回**。退回 bundled 时 `onBundledCodexFallback(cs)`
每会话只警告一次。**此部分在前一提交 `33dd386` 已落地，本次保留不动。**

## 文件变更清单（commit `393acc7`）

| 文件 | 变更 |
|---|---|
| `server/store.js` | `updateTabMetadata` 白名单 +`modelOverride`/`effortOverride`（+1 行） |
| `terminal/claude-session-controller.js` | cs 创建 populate override；`setTabModelOverride`；所有 driver 读取点 `cs.*Override \|\| global`；server `/model` handler 写 tab（+47/-12） |
| `terminal/codex-sdk-driver.js` | line 117 读 `cs.codexModelOverride \|\| codex_model`（+4/-1） |
| `terminal/claude-tmux-driver.js` | line 371-372/521-522 读 `cs.claudeModelOverride \|\| global`（+4/-4） |
| `terminal/routes.js` | +`PATCH /api/projects/:id/tabs/:tabId/model` 路由（+43） |
| `public/js/terminal-view.js` | codex `/model` 拦截 + picker PATCH tab；claude picker 读 tab override（+78/-33） |
| `public/js/tab-manager.js` | +`tab-chip-model` 徽章（+12） |
| `public/style.css` | +`.tab-chip-model` 样式（+19） |
| `public/js/app.js` | 修正注释（+5/-3） |
| `server/tests/tab-model-override.test.js` | **新测试文件**：store round-trip、cross-tab 隔离、codex+claude driver override 优先级、gpt-5.6-sol 透传、PATCH 路由 200/400/404+broadcast（+410 新） |

**diffstat**: 12 files changed, 795 insertions(+), 48 deletions(-)

## 验证证据

### 单元测试（新增 `server/tests/tab-model-override.test.js`，4 个新 suite）

```
ok 106 - tab model override (cross-tab /model isolation)        (3 subtests)
ok 107 - codex sdk driver honors tab model override             (3 subtests)
ok 108 - claude sdk driver honors tab model/effort override     (2 subtests)
ok 109 - PATCH /api/projects/:id/tabs/:tabId/model              (4 subtests)
```

覆盖：
- **store round-trip**：`updateTabMetadata` 持久化 `modelOverride`/`effortOverride`，`getTab`/`listTabs` 读回；`null` 清除；两个 tab 各自独立不串扰。
- **codex driver override 优先**：`cs.codexModelOverride='gpt-5.6-sol'` → `threadOptions.model==='gpt-5.6-sol'`（赢过全局 `codex_model='gpt-5-codex'`）；`null` → 退回全局；**gpt-5.6-sol 透传无白名单**。
- **claude driver override 优先**：`cs.claudeModelOverride='claude-sonnet-4-6'` + `cs.claudeEffortOverride='low'` → `options.model/effort` 用 override；`null` → 退回全局。
- **PATCH 路由**：PATCH tab A 不影响 sibling B（B 的 `modelOverride` 仍 `undefined`）；非 claude/codex tab → 400；未知 tab → 404；PATCH 后 `tabs:update` 广播携带新 `modelOverride`。

### 全量回归

```
# tests 685  # suites 152  # pass 685  # fail 0  # cancelled 0  # skipped 0  # todo 0
# duration_ms 3337.601862
```

基线 673（merge 后）+ 12 新（4 suite × 3/3/2/4 subtest，但 suite 级计为 4）= 685。

### grep 自查（防假过）

```
$ rg -c "^not ok" run_nano_codex_model56.log
0
$ rg "^# fail" run_nano_codex_model56.log
# fail 0
```

`run_nano_codex_model56.log` 是 `npm test 2>&1 | tee` 完整原始输出，`^not ok` 0 条，`# fail 0`。

### fork/main 推送（fast-forward，无 force）

```
$ git push fork HEAD:main
12d17aa..393acc7  HEAD -> main   (exit 0)
$ git log --oneline fork/main..HEAD   # 空
$ git log --oneline HEAD..fork/main   # 空
```

`fork/main` == `HEAD` == `393acc7`，零 drift、零 unpushed。**纯 fast-forward，无 force-push，未破坏任何提交**。

## 部署说明（secretary 执行）

9476 运行时是 `~/.nanocode-9476-runtime`（git checkout，branch `main`，当前停在 `6283d88`）。
同步 + 重启：

```bash
# 1) 同步本修复到 9476 运行时（fast-forward）
git -C ~/.nanocode-9476-runtime fetch fork
git -C ~/.nanocode-9476-runtime merge --ff-only fork/main   # 6283d88 -> 393acc7

# 2) 重启 9476（当前 pid 118213，PORT=9476，cwd=~/.nanocode-9476-runtime）
kill 118213 2>/dev/null; sleep 2; kill -9 118213 2>/dev/null; sleep 1
cd ~/.nanocode-9476-runtime
PORT=9476 nohup node server/index.js >> ~/codex_work/server9476.log 2>&1 &
# 3) 健康检查
for i in $(seq 1 40); do sleep 1; curl -sf -o /dev/null http://localhost:9476/ && { echo "9476 healthy"; break; }; done
```

重启后验证：
1. **codex tab** 输入 `/model gpt-5.6-sol` → 应见 picker 确认 → 下一条消息走 gpt-5.6-sol（driver 读 `cs.codexModelOverride`）。tab chip 上应显示 `gpt-5.6-sol` 徽章。
2. **cross-tab 隔离**：开两个 claude tab，A 切 opus、B 切 sonnet → 两个 tab chip 各显各的模型，互不串扰。
3. 若用户级 CLI 缺失会先看到 bundled 退回警告。

**红线**：9475 全程未碰。9476 重启由 secretary 执行（worker 不重启）。

## 边界与限制

- `/model` 切换对**下一轮** turn 生效（driver 每轮读 override），不在当前 turn 中途切。
- `setTabModelOverride` 只更新**当前 live** cs；若 tab 未 attach（无 cs），仅持久化在 tab 元数据，下次 attach 时 cs 从 tab populate。
- codex `/model` picker 是自由输入（无白名单），拼写错误的模型名也会被接受并透传——SDK 侧返回 model_not_found，前端不预校验（与 claude picker 有限白名单不同，因 codex 模型名演进快）。
- `effortOverride` 只对 claude driver 生效（codex effort 是独立 `codex_effort` 设置，未做 tab 级）。

## anti-fake-pass 裁决

- **file-exists PASS**：12 个改动文件均在 worktree + commit `393acc7`，`git show --stat 393acc7` 实证 795+/48-。
- **source provenance PASS**：`393acc7` 已在 fork/main（`git log 12d17aa..fork/main` 实证 `393acc7`）；runtime 确认为 git checkout 可 fast-forward。
- **test PASS**：`npm test` 实跑 685/685 pass / 0 fail，`run_nano_codex_model56.log` `^not ok` 0 条；新增 4 suite 全绿（106-109）。
- **HTTP N/A**：PATCH 路由用 `router.handle` harness 测了 200/400/404 + WS broadcast；live HTTP 由 secretary 重启 9476 后验证。
- **裁决：REAL**。
