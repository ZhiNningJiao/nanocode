# REPORT: Codex Block-Mode `/model` Switch to gpt-5.6-sol (双根因根治)

> **Task**: 诊断并修复 nanocode codex block 模式下 `/model` 命令无法切换到 `gpt-5.6-sol` 的问题。
> **Date**: 2026-07-18
> **Branch**: `zhining/nano-9476-integ-0716`
> **Commit**: `33dd386` (fix) + `12d17aa` (merge onto fork/main)
> **Remote**: 推到 `fork` (ZhiNingJiao/nanocode) 的 `main`，非 fast-forward 不需要 force。
> **Red line**: 9475 未碰。9476 重启由 secretary 执行（见末尾部署说明）。

---

## 问题根因

Codex block 模式（SDK driver，renderMode='block'）下 `/model gpt-5.6-sol` 无效，存在**两个独立根因**：

### 根因 (a)：前端 `/model` 拦截只对 claude tab 生效，codex tab 从未拦截

`public/js/terminal-view.js` 的 `sendInput()` 里 `/model` 拾取器被 `isClaudeTab` 守卫包住（原 `if (isClaudeTab && text.trim().match(/^\/model\s*$/))`），codex tab 走不进这个分支。

**后果**：codex tab 里输入 `/model gpt-5.6-sol` 被原样作为 prompt 发给模型。关键在于 **codex SDK driver 走的是 `thread.runStreamed()` 直接 API 调用，绕过 codex CLI 的 REPL**——所以字面 `/model <name>` 对模型来说只是普通文本，**永远不会切换模型**。这和 claude tab 不同（claude block 模式的 `/model` 是前端拦截→写设置）。

`public/js/app.js:618` 的注释 `"Codex model save handler removed — model is now set via /model command"` 当时是**误导**——codex 的 `/model` 从未真正接线，这句承诺一直没兑现。

### 根因 (b)：SDK driver 默认用 bundled 0.137 codex，跑不了 gpt-5.6-sol

`terminal/codex-sdk-driver.js` 读 `codex_path_override` 设置；**未设置时直接传空 override**，SDK 于是用自己的 bundled `@openai/codex-sdk` 0.137 codex 二进制。该版本对 `gpt-5.6-sol` 返回 **400 "requires a newer version of Codex"**。

主人已重装用户级 CLI：`~/.local/lib/npm-global/bin/codex`（codex-cli **0.144.5**，gpt-5.6-sol smoke-tested OK），但 driver 不会自动用它——`/usr/bin/codex` 是旧 symlink（已废弃），driver 也不该默认指向它。

## 修复方案

### Cut 1（前端，根因 a）：codex tab 拦截 `/model` 写 `codex_model` 设置

`public/js/terminal-view.js` 新增两段（`sendInput` 之前插入）：

- **`applyCodexModel(model)`**（line 1755）：`PUT /api/settings { key:'codex_model', value }`，成功时在 CBR scroll 里插一条 `cbr-model-picker-confirm` 提示（"Codex model set to X. Takes effect on next message."），失败时插 error 提示。空字符串 = 清回 CLI default。
- **`showCodexModelPicker()`**（line 1782）：裸 `/model` 在 codex tab 弹出的内联 picker。并发拉 `/api/settings`（当前 `codex_model`）+ `/api/codex/config`（config.toml 的 model）展示 "Current: X · config.toml: Y"，一个自由输入框（**无白名单**——`gpt-5.6-sol` 或任何未来模型名都能填），Set / Use CLI default / Cancel 三按钮，复用既有 `cbr-model-picker-*` / `rp-input` CSS。
- **`sendInput` codex 分支**（line 1888-1905）：`isCodexTab` 时 `^\/model\s+(\S.*)$` → `applyCodexModel(<arg>)`；`^\/model\s*$` → `showCodexModelPicker()`。

机制闭环：driver 每轮读 `store.getSetting('codex_model')`（`codex-sdk-driver.js:113`）作为 `threadOptions.model`（line 142）传给 SDK。前端写设置 → 下一轮 SDK turn 生效。

### Cut 2（后端，根因 b）：默认指向用户级 CLI，缺失才退回 bundled 并警告

`terminal/codex-sdk-driver.js`：

- 新增 `userInstalledCodexPath(home)`（line 13）→ `~/.local/lib/npm-global/bin/codex`（`home || homedir()` 兜底）。
- `createCodexSdkDriver` 新增 `home` + `onBundledCodexFallback = () => {}` 参数（line 95-96）。
- override 解析（line 125-133）优先级：**显式 `codex_path_override`（永远赢）> 用户级 CLI（`existsSync` 为真时）> bundled 退回**。退回 bundled 时通过 `onBundledCodexFallback(cs)` **每会话只警告一次**（`cs._codexBundledFallbackWarned` 守卫）。

`terminal/claude-session-controller.js`（line 451-490）：把 `home` 和 `onBundledCodexFallback` 传给 `createCodexSdkDriver`。回调里 `codexBroadcast` 一条修复指引："falling back to bundled SDK codex 0.137, which cannot run gpt-5.6-sol. Install codex 0.144+ ... or set codex_path_override"。

### 附带：修正误导注释

`public/js/app.js:618` 改为如实说明 codex `/model` 经 `terminal-view.js → applyCodexModel → PUT /api/settings` 持久化 `codex_model`，driver 下一轮读取。

## 文件变更清单

| 文件 | 状态 | 变更 |
|---|---|---|
| `terminal/codex-sdk-driver.js` | 修改 | +`existsSync`/`homedir`/`join` 导入；+`userInstalledCodexPath(home)`；+`home`/`onBundledCodexFallback` 参数；override 解析三段优先级；bundled 退回一次性警告（+30 行） |
| `terminal/claude-session-controller.js` | 修改 | 传 `home` + `onBundledCodexFallback` 给 driver，回调 `codexBroadcast` 修复指引（+13 行） |
| `public/js/terminal-view.js` | 修改 | +`applyCodexModel`、+`showCodexModelPicker`、`sendInput` codex `/model` 分支（+145 行） |
| `public/js/app.js` | 修改 | 修正 line 618 误导注释（+5/-1 行） |
| `server/tests/codex-sdk-driver.test.js` | 修改 | +3 个新测试覆盖 override 解析 & 模型传递（+124 行） |

## 验证证据

### 单元测试（新增 3 例，`server/tests/codex-sdk-driver.test.js`）

```
ok 5 - defaults codexPathOverride to the user-installed CLI and passes codex_model through
ok 6 - falls back to bundled codex and warns exactly once when the user-installed CLI is missing
ok 7 - honors an explicit codex_path_override even when the user CLI exists
ok 37 - codex sdk driver  (suite, 7 subtests: 4 原有 + 3 新)
```

- 用 `mkdtempSync` 造临时 home，构造/缺省 `~/.local/lib/npm-global/bin/codex` 文件，验证：用户 CLI 存在→`codexPathOverride` 指向它 & `threadOptions.model='gpt-5.6-sol'` 透传；缺失→`onBundledCodexFallback` 恰好调用一次 & 无 override & 第二轮不再警告；显式 override 存在即使用户 CLI 也在→显式赢 & 不触发警告。

### 全量回归

```
# 修复合并前：# tests 666  # pass 666  # fail 0
# 修复合并后：# tests 673  # pass 673  # fail 0  # cancelled 0  # skipped 0
```

合并带入 fork/main 的 `6283d88`（cross-project twin guard，+7 测试），与我的改动在 `claude-session-controller.js` 不同区段（它在 line 27/149 加 ownership helpers，我在 line 451/482 加 driver 接线），git `ort` 策略**自动合并零冲突**。

### grep 自查（防假过）

```
$ grep -c "^not ok" run_nano_codex_model56.log
0
$ grep -n "^# fail" run_nano_codex_model56.log | tail
# fail 0
```

`run_nano_codex_model56.log` 是 `npm test 2>&1 | tee` 的完整原始输出（含合并前 + 合并后两轮），`^not ok` 0 条，`# fail 0`。

### fork/main 推送（非 force，fast-forward）

```
$ git push fork HEAD:main
6283d88..12d17aa  HEAD -> main   (exit 0)
$ git merge-base --is-ancestor fork/main HEAD && echo identical   # fork/main == HEAD
```

先 `git merge fork/main` 把 `6283d88` 并入我的分支（使 fork/main 成为祖先），再 `push HEAD:main`——**纯 fast-forward，无 force-push，未破坏任何提交**。fork/main 现携带 `33dd386`（本修复）+ `12d17aa`（merge）。

## 部署说明（secretary 执行）

9476 运行时是 `~/.nanocode-9476-runtime`（git checkout，branch `main`，当前停在 `6283d88`，有 `fork` remote）。同步 + 重启：

```bash
# 1) 同步本修复到 9476 运行时（fast-forward，无需 force）
git -C ~/.nanocode-9476-runtime fetch fork
git -C ~/.nanocode-9476-runtime merge --ff-only fork/main      # 6283d88 -> 12d17aa

# 2) 重启 9476（当前 pid 118213，PORT=9476，cwd=~/.nanocode-9476-runtime）
kill 118213 2>/dev/null; sleep 2; kill -9 118213 2>/dev/null; sleep 1
cd ~/.nanocode-9476-runtime
PORT=9476 nohup node server/index.js >> ~/codex_work/server9476.log 2>&1 &
# 3) 健康检查
for i in $(seq 1 40); do sleep 1; curl -sf -o /dev/null http://localhost:9476/ && { echo "9476 healthy"; break; }; done
```

重启后验证 `/model` 切换：codex tab 输入 `/model gpt-5.6-sol` → 应见 "Codex model set to gpt-5.6-sol" 提示 → 下一条消息走 gpt-5.6-sol（driver 读 `codex_model` 设置）。若用户级 CLI 缺失会先看到 bundled 退回警告。

**红线**：9475 全程未碰。9476 重启由 secretary 执行（worker 不重启）。

## 边界与限制

- `/model` 切换对**下一轮** SDK turn 生效（driver 每轮读设置），不在当前 turn 中途切。
- bundled 0.137 退回警告每会话一次（`cs._codexBundledFallbackWarned`），刷新页面/新 tab 会重置。
- codex tab 的 `/model` picker 是自由输入（无白名单），拼写错误的模型名也会被接受并透传——SDK 侧会返回 model_not_found，前端不预校验（与 claude picker 的有限白名单不同，因 codex 模型名演进快）。

## anti-fake-pass 裁决

- **file-exists PASS**：5 个改动文件均在 worktree 中，`git show --stat 33dd386` 确认 316+/2-。
- **source provenance PASS**：`33dd386` + `12d17aa` 已在 fork/main（`git log 6283d88..fork/main` 实证）；runtime 确认为 git checkout 可 fast-forward。
- **test PASS**：`npm test` 实跑 673/673 pass / 0 fail（post-merge），`run_nano_codex_model56.log` `^not ok` 0 条。
- **HTTP N/A**：本任务为代码修复，未做 live HTTP 验证（9476 重启后由 secretary 验证 `/model` 切换）。
- **裁决：REAL**。
