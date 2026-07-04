# 需求15 — Fable5(opencode) 体验全对齐 Claude tab：盘点表

> 状态：**盘点表先行（本轮 deliverable）**。实现待秘书批后按优先级小步做。
> 主人 2026-07-04 要求 Fable5(opencode) tab 全体验对齐原生 Claude tab。需求11 已做 Block 渲染
> （block UI 复用 ✓，11-D 已验 9 类 block 全渲染），但 Block 之外的「壳」(resume / queue /
> interrupt / badge / persona / usage) 多处被 `isClaudeTab` 门控排除 opencode，且 opencode driver
> 自带一套与 claude 不同源的队列/中断/历史机制。逐项盘点如下，每项含 现状 / 差距 / 实现点 / 成本 /
> 优先级，并附建议实现顺序。

## 根因 keystone：`isClaudeTab` 门控（`public/js/terminal-view.js:618`）

`isClaudeTab = tabType === 'claude'`。stop 按钮(636)、model 徽章(776)、thinking UI(636/703)、
`/model` 命令(1470)、队列 tray(525/757)、send 路径(1485/1618/1633) 全部以 `isClaudeTab` 为前提 →
fable5/opencode block tab（虽复用 `ClaudeBlockRenderer`，`public/js/tab-manager.js:388`）一律拿不到
这些壳。**把 `isClaudeTab` 放开为「claude 或 block-mode fable5/opencode」是 item 3/4（及部分 2）的
公共前置，最高杠杆。**

> 注：block-mode fable5/opencode 的判定已存在于前端（`tab-manager.js:381-384` 的 `useClaudeRenderer`），
> 可复用同一条件，避免散落三处判 `renderMode`。

## 盘点表

| # | 项 | 现状 | 差距 | 实现点 | 成本 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | 会话续聊 / AutoResume | claude 新建 tab 弹 resume picker 列最近 5 条 jsonl 对话（`tab-manager.js:542/599`；`GET /recent-conversations` 扫 claude jsonl）。opencode/fable5 新建 tab 直走 `newTab(type)`（`tab-manager.js:546`）**无 picker**；已有 tab 重开靠 `tab.opencodeSessionId` 走 `opencode export` 回放（`terminal/routes.js:366/391`，✓ 工作） | 无「列最近 opencode 会话供选择」入口；新建 fable5 tab 永远 fresh，不能续旧会话 | 后端新增 `GET /api/opencode/sessions?cwd=` 调 `opencode session list`（11-A 已确认 CLI 存在，REPORT:628）→ 前端 fable5/opencode 新建 tab 也弹 picker（复用 `_showClaudeResumePicker` 的壳，数据源换 opencode）；「继续」= 建带 `opencodeSessionId` 的 tab（driver 已支持 `--session`） | M | 中 |
| 2 | 服务端消息队列（需求9 覆盖 opencode） | claude：client `_pendingQueue` + keepalive `PUT /queue` → `tab.pendingQueue` 持久化 + driver finally drain（`terminal-view.js:487`；`routes.js:1079`；`store.js:191`）。opencode：driver 自带**内存** `cs.queue`（`opencode-block-driver.js:96-105/219-234`），**不**落 `tab.pendingQueue`；client `_pendingQueue` 持久化被 `isClaudeTab` 门控不生效 | 手机 busy 入队 → 切后台/关页：消息只在 driver 内存 `cs.queue`（页面关能活，server 重启丢）；WS 未发完即关页则全丢。比 claude（需求9 服务端持久化）脆弱一档 | (a) opencode driver queue 改读写 `tab.pendingQueue`（store 持久化）+ exit 时 drain（对齐 claude finally）；(b) 前端 `_persistQueueNow` 对 block-mode fable5/opencode 也生效（放开 `isClaudeTab` 门控或新增 `isBlockTab`，依赖 keystone）；(c) 回执刷新 UI（queued→delivered） | M | 高 |
| 3 | 打断 / interrupt | opencode driver 有 SIGINT handle（`opencode-block-driver.js:75-82`，`cs.currentProc.kill`）。但 (a) 前端 stop 按钮 `isClaudeTab && isClaudeThinking` 才显示（`terminal-view.js:636`）→ opencode **看不到** stop；(b) 后端 `handleInterrupt` 只查 `claudeSessions`/`codexSessions`（`claude-session-controller.js:1240-1244`）**不查 `opencodeBlockSessions`**（key 还不同：`<pid>:opencode-block:<tid>`，`controller:1180`）→ `/interrupt` 对 opencode 返 404 | **stop 按钮对 fable5 完全不可用**：既不显示、显示后也 404。用户无法打断失控 opencode 轮次 | (a) 后端 `handleInterrupt` 增 `opencodeBlockSessions` 分支（用 `opencodeBlockSessionKeyFor` 取 cs → `cs.currentProc.kill('SIGINT')`）；(b) 前端 `isClaudeTab` 放开覆盖 block-mode fable5/opencode → stop 按钮显示 + click 调 `/interrupt`（依赖 keystone） | S | 高 |
| 4 | 状态徽章（IDLE / BUSY / 模型名） | claude：model 徽章 `_modelByTab` + `nanocode:claude-model`（`terminal-view.js:773/787`，renderer `claude-block-renderer.js:1415` dispatch `message.model`）；busy/thinking UI 同 stop 按钮门控。opencode：adapter `makeAssistantEvent` 设 `message.model=modelID`（`opencode-adapter.js:170`）→ renderer 也会 dispatch，但 `_updateModelBadge` 读 `_modelByTab.get(activeId)` 仅当 `isClaudeTab`（`terminal-view.js:776`）→ **opencode 取 null/隐藏**；busy/thinking UI 同样不显示 | fable5 tab 无模型徽章、无 IDLE/BUSY 指示——用户看不出 tab 在忙/闲/用哪个模型 | keystone 放开 `isClaudeTab` → model 徽章 + thinking UI 自动对 block-mode opencode 生效（renderer 已 dispatch、`_modelByTab` 已 set，只差读出门控）；必要时 opencode model 名缩短显示对齐 claude | S | 高 |
| 5 | 人格载入（需求8）对 fable5 生效 | claude：`tab.persona` → `cs.personaPrompt` → SDK `systemPrompt.append`（`claude-sdk-driver.js:396/580`）/ tmux `--append-system-prompt`（`claude-tmux-driver.js:156/368`）/ CLI flag（`controller:416/602`）。opencode：`buildEnv` 只注 `MESHY_AIGW_KEY` + `OPENCODE_CONFIG_CONTENT`（`opencode-block-driver.js:44-66`）**无 persona**；fable5 新建也不经 claude resume picker（无 persona 下拉） | 选了人格对 fable5 tab 不生效；fable5 新建无 persona 选择入口 | 调研 opencode 注入面：`OPENCODE_CONFIG_CONTENT` 的 agent `systemPrompt` 字段（若支持）或首条消息前置人格指令（标注机制局限）。driver `buildEnv` 注入；前端 fable5 新建面板加 persona 选择（对齐 item1 的 picker） | M | 中 |
| 6 | 用量（opencode token 并入用量插件） | `usage.js` 只扫 claude jsonl（`usage.js:5-7`）；AIGW 成本仅一次性 probe（`usage.js:324/364`，明确标注 opencode 流量不经 nanocode 代理）。opencode SQLite `session` 表**有** `tokens_{input,output,reasoning,cache_read,cache_write}`+`cost`（11-A 已解剖，REPORT:606） | opencode 会话 token 不在用量面板——诚实展示缺一整块（数据其实存在 SQLite） | 新增数据源：读 opencode SQLite `session` 表聚合 tokens/cost（或调 `opencode export`/`opencode session list` 取 token 字段）→ 用量插件加 opencode 区块，诚实标注来源；与需求1「拿不到的源诚实标注」一致 | M | 中 |
| 7 | Block 渲染 live 增量查漏（工具 / 错误块） | 11-D 已验 9 类 block 全渲染含 tool/tool-result/usage（REPORT:683）。adapter 处理 text/reasoning/tool/step-finish，错误经 `isToolError`(metadata.error/success=false/status/output 前缀) + `makeResultEvent`(error_max_turns)（`opencode-adapter.js:65-75/187-198`）。live = driver 逐 stdout 行 `messageToEvents`（part 级，非 char delta） | 基本完成。查漏点：(a) 工具错误块是否走 error/红样式与 claude 一致；(b) part 级 live 在快流下是否去重（`makeId` 用 callID/id 可去重，需实测）；(c) stderr 崩溃信息是否进 error block（driver 206-211 已走 `result.error`） | 实测对比 claude tab 工具/错误块观感，补齐样式/去重差异（小修） | S | 低 |

## 建议实现顺序（秘书批后执行）

1. **keystone（item3 + item4 共用）** — 放开 `isClaudeTab` 覆盖 block-mode fable5/opencode
   + `handleInterrupt` 增 `opencodeBlockSessions` 分支 → 一次性解锁 stop 按钮 + 模型徽章 +
   busy/thinking UI + `/model`。**最高杠杆，先做。**
2. **item2（队列持久化）** — opencode queue 落 `tab.pendingQueue` + drain + 前端持久化放开 →
   修数据丢失级 bug（同需求9 class）。
3. **item1（resume picker）** — `opencode session list` → picker → 续会话。
4. **item5（persona）** — 调研 opencode 注入面 + driver `buildEnv` 注入 + 前端选择器。
5. **item6（用量）** — SQLite `session` tokens 聚合进用量插件。
6. **item7（block polish）** — 实测补齐工具/错误块观感差异。

## 验收口径（需求15 末尾）

并排双 tab（Claude Code tab vs Fable5 tab）操作同一流程截图组：resume / 发消息 / 打断 / 徽章；
手机端（家规，390×844）Block 模式可读可滚动。

## 数据源参考（来自需求11-A 调研，REPORT:601-665）

- opencode 会话存储 = SQLite (`$XDG_DATA_HOME/opencode/opencode.db`)，非 jsonl。
- `session` 表：`id, directory, title, model, cost, tokens_{input,output,reasoning,cache_read,cache_write},
  time_{created,updated}` → item1（列会话）+ item6（用量）的数据源。
- CLI：`opencode session list`（列会话，只读）/ `opencode export [id]`（导出 JSON，已用于 history）/ 
  `opencode run --session <id>`（续会话，driver 已用）/ `opencode serve`（HTTP+SSE，11-A 备选）。
