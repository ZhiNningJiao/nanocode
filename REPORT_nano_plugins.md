# REPORT — nano_plugins: Codex / Claude Code 桌面端特性调研 → nanocode 插件设计 (MES-14031)

> 主人原话：「抄 codex，claude code 桌面端到 nanocode 插件，也可以 glm 安排上。」

分支 `zhining/nano-plugin-proto` · worktree `~/code/wt-nano-plugins` · 原型 commit `2076aeb`
验证日志 `run_nano_plugins.log` · 成功旗 `FLAG_nano_plugins`

---

## 0. 执行摘要（TL;DR）

1. **调研**：本机 `codex` CLI 0.144.3（`codex --help` / `codex features list` / `codex plugin --help` / `@openai/codex-sdk` 结构化事件）+ Claude Code 桌面端公开文档（interactive-mode / checkpointing / sub-agents / sessions / skills）。
2. **"值得抄"清单**：12 项，每项含 *特性说明 / nanocode 现状差距 / 用户价值 / 移植难度*。表见 §2。
3. **移植设计**：按 nanocode 插件形态（`nano-personal-config` 注入模式 + `plugins-registry` 清单 + `right-panel` 懒加载分发 + `routes.js` 数据源 + document CustomEvent 事件总线）给出插件边界 / 事件挂点 / UI 面。见 §3。
4. **原型（本轮最高价值项 = S1 会话浏览器）**：把 `codex resume`（picker）+ `codex fork` + `claude --resume --fork-session` 移植成 nanocode 右栏 `work` 组 `sessions` 插件。跨源发现本机所有 Codex + Claude Code 历史会话 → 预览末尾几轮 → 一键 fork 进新 tab。10 文件 / 1219 行。
5. **验证（防假过）**：临时 9478 端口真跑服务器，真实发现 **231 个 codex + 1326 个 claude 会话**，预览返回 119 轮，面板 JS 与 manifest 均正常服务；`npm test` **545 pass / 0 fail**，无回归。证据见 §5 + `run_nano_plugins.log`。

为什么选 S1 作为本轮原型：nanocode 的产品定位就是"多项目多 agent 的终端工作区"，**会话的发现与恢复正是它的核心痛点**；而 `codex resume/fork` 是 codex CLI 的旗舰会话命令，"抄 codex"最直接、最合身；且移植边界干净（只读发现 + 复用既有 tab 创建 + 一个 CustomEvent），可在单轮内做到真·可用、真·验证。其余高价值项（Checkpoint/Rewind S2、Diff 审阅 S3）列为后续优先级。

---

## 1. 调研素材

### 1.1 本机 Codex CLI（`codex` 0.144.3，`/usr/bin/codex`）

`codex --help` 子命令与 `codex features list` 输出（摘录）：

| 子命令 | 说明 | 与 nanocode 的关系 |
|---|---|---|
| `codex resume [--last]` | picker 选历史会话恢复 | ★ 旗舰会话恢复 → S1 |
| `codex fork [--last]` | fork 一个历史会话（分支） | ★ 旗舰会话分支 → S1 |
| `codex apply` | 把 agent 最近 diff 当 `git apply` 打到工作树 | diff 审阅/apply → S3 |
| `codex review` | 非交互 code review | diff 审阅 → S3 |
| `codex exec` | 非交互执行 | 已有：nanocode codex tab |
| `codex plugin add/list/remove/marketplace` | 插件市场安装/分发 | 插件市场 → S10 |
| `codex features list/enable/disable` | 细粒度特性开关 | 特性开关 → S9 |
| `codex doctor` | 诊断安装/配置/鉴权/运行时健康 | 自检 → S11 |
| `codex cloud` | 浏览 Codex Cloud 任务并本地 apply | 云任务 → 远期 |
| `-p <profile>` / `-c key=value` | 配置 profile 叠加 / 键覆盖 | 配置 profile → S12 |
| `codex mcp / mcp-server` | MCP 管理 / 作为 MCP server | 已有 MCP 体系 |

`codex features list` 稳定特性（节选）：`hooks` · `multi_agent` · `goals` · `guardian_approval` · `tool_suggest` · `browser_use` / `in_app_browser` · `image_generation` · `personality` · `shell_snapshot` · `remote_compaction_v2`；实验/开发中：`chronicle`（会话编年史）· `memories` · `prevent_idle_sleep` · `token_budget`。

**codex SDK 结构化事件经验**（`terminal/codex-sdk-driver.js`，nanocode 已用 `@openai/codex-sdk` 0.137）：`thread.runStreamed()` 产出结构化事件——
`thread.started`(thread_id) / `item.started` / `item.completed` / `agent_message_content_delta` / `item.updated` / `turn.completed` / `turn.failed` / `error`。
**关键**：`item.type === 'file_change'` 携带 `changes:[{kind, path}]`（`codex-sdk-driver.js:10-14, 19-27`）——这是现成的"agent 改了哪些文件"结构化信号，是 S2(checkpoint)/S3(diff 审阅) 的事件挂点来源。driver 还支持 `client.resumeThread(threadId, opts)`（`codex-sdk-driver.js:119`），为 S1 的 codex 真分支 fork 留了入口。

### 1.2 Claude Code 桌面端公开特性（官方文档）

| 特性 | 触发 | 要点 |
|---|---|---|
| **Checkpointing / Rewind** | `/rewind` 或空输入 `Esc Esc` | 每次用户 prompt 前自动捕获代码快照；保留最近 100 个；rewind 菜单：恢复代码+对话 / 仅恢复对话 / 仅恢复代码 / 从此处摘要 / 摘要到此处；快照随会话保存（resume 后仍可 rewind）。**限制**：仅追踪 file-editing 工具，bash 改动不追踪；非版本控制替代 |
| **Background tasks** | `Ctrl+B` / `/tasks` | Bash 命令/agent 后台化，返回 task id，输出写文件可 Read；5GB 上限；内存压力自动回收 |
| **Task list / checklist** | `Ctrl+T` | Claude 自建的多步 checklist，跨 compact 持久；区别于后台任务视图 |
| **Transcript viewer** | `Ctrl+O` | 详细工具使用 + 每条 assistant 的时间戳/模型 |
| **Side questions `/btw`** | `/btw …` | 不入历史的旁问（只读当前上下文、无工具），可 `f` fork 成正式会话 |
| **Session recap** | 自动 / `/recap` | 离开回来一行回顾（≥3 分钟、≥3 轮触发） |
| **PR review status** | footer | 可点 PR 链 + 颜色态（approved/pending/changes/draft），60s 刷新 |
| **Skills** | `/` | bundled + user + plugin/MCP 贡献的命令/技能 |
| **Shell mode** | `!cmd` | 直接跑 shell，输出进上下文 |
| **Prompt suggestions** | 灰字建议 | 基于 git 历史 / 对话续写 |
| **Reverse search** | `Ctrl+R` | 历史搜索 + scope 切换 |
| **Fork session** | `claude --continue --fork-session` | 分支会话 |
| **Model / thinking / fast mode** | `Alt+P` / `Alt+T` / `Alt+O` | 已有：nanocode team-model 面板 |

---

## 2. "值得抄"清单

每项：**特性说明 · nanocode 现状差距 · 用户价值 · 移植难度 · 是否本轮原型**。

| # | 特性 | 说明 | nanocode 现状差距 | 价值 | 难度 | 本轮 |
|---|---|---|---|---|---|---|
| **S1** | **会话浏览器 resume/fork** | 跨源(codex+claude)统一 picker，预览末轮，一键 fork 进新 tab（抄 `codex resume/fork` + `claude --resume --fork-session`） | 仅有单项目 `recent-conversations` / `claude-history.js`（只读重放），**无跨源统一 picker、无 fork 进新 tab** | **H** | M | ✅ |
| **S2** | **Checkpoint / Rewind** | 每 prompt 前自动捕获代码快照，rewind 菜单恢复代码/对话/摘要 | **完全没有**；agent 误改只能手动 `git checkout/stash` | **H** | H | — |
| **S3** | **Diff 审阅 / apply** | per-turn / 会话级 diff 审阅 + 一键 apply/revert（抄 `codex apply/review`） | `compare` 插件是**分支级**，无会话/turn 级 diff + 一键回退 | **H** | M | — |
| S4 | 后台任务面板 | 统一"运行中 shell + subagent"视图（抄 `/tasks` + `Ctrl+B`） | 有 `agent-health`（idle/active），但无统一后台任务清单 | M | M | — |
| S5 | 任务清单 / TODO | 会话内 agent 自建 checklist 可视化（抄 `Ctrl+T`） | 有 `TODO.md` 文化，但无会话内 checklist 面板 | M | M | — |
| S6 | `/btw` 旁问 | 不污染主上下文的快速旁问 | 无；旁支问题只能新 tab | M | M | — |
| S7 | 会话 recap | 离开回来一行回顾 | 无；回来不知 agent 干了啥 | M | L | — |
| S8 | PR 审阅状态 | footer PR badge + 颜色态 | 无 | M | L | — |
| S9 | 特性开关 | 细粒度 feature flag（抄 `codex features`） | 插件仅 enable/disable，无细粒度 flag | L-M | L | — |
| S10 | 插件市场 | 外部插件安装/分发（抄 `codex plugin marketplace`） | 插件全 builtin，无外部安装 | L(单用户) | H | — |
| S11 | doctor 自检 | 统一安装/配置/鉴权健康诊断 | 无统一自检 | L | L | — |
| S12 | 配置 profile 叠加 | 情境 profile 叠加（抄 `-p profile`） | 有 `personal.json` + team config dir，无"情境 profile" | L | M | — |

**最高价值选型论证**：S1 最合 nanocode 的身（多会话工作区 = 会话发现/恢复是核心痛点），最直接呼应"抄 codex"（resume/fork 是 codex 旗舰命令），且边界干净、单轮可做到真·可用真·验证。S2/S3 价值同样高但难度更高（S2 要做文件快照+恢复语义，S3 要侵入 block renderer 发 `nanocode:diff` 事件），列为下一轮优先级。

---

## 3. 移植设计（nanocode 插件形态）

### 3.1 插件边界（对齐 `nano-personal-config` 注入模式）

nanocode 插件 = **清单(manifest) + 懒加载渲染器 + 纯数据源 + 路由 + i18n + 测试**，6 处增量、零侵入核心：

| 层 | 文件 | 增量 | 参考 |
|---|---|---|---|
| 清单 | `public/js/plugins-registry.js` | `BUILTIN_PLUGINS` 加一项 `{name,version,apiVersion:'1.0',group,tab,permissions,settings,descriptionKey,builtin}` | `plugins-registry.js:132-147` |
| 分发 | `public/js/right-panel.js` | `LAZY_PLUGINS[name]={key,imp,render,reset}` | `right-panel.js:74-76` |
| 渲染器 | `public/js/<name>-panel.js` | 导出 `render<Name>Pane(pane,plugin)` + `reset<Name>LoadState()`（render core，无 DOM 框架） | `sessions-panel.js` |
| 数据源 | `terminal/<name>.js` | 纯模块函数（不依赖 Express），路由 handler 调它 | `sessions-browser.js` |
| 路由 | `terminal/routes.js` | `router.get('/api/<name>/...')`，try/catch 不抛、降级 `{error}` | `routes.js:1146-1175` |
| i18n | `public/js/i18n.js` | `plugin.<name>.label/desc` + UI 串，**en + zh 双块** | `i18n.js:358-359, 771-772` |
| 测试 | `server/tests/plugins-registry.test.js` + `server/tests/<name>.test.js` | manifest 契约 + 数据源纯函数测试 | `sessions-browser.test.js` |

**`nano-personal-config` 权限门**（`terminal/personal-config.js`）：插件 manifest 在 `permissions` 声明 `personal.*`，才经 `projectForPlugin`（前端脱敏 `hasKey`+masked）或 `resolvePluginSecrets`（服务端真值，绝不进浏览器）拿到对应字段。**S1 不需要任何 `personal.*`**——它读的是用户自己的会话文件（`~/.codex/sessions`、`~/.claude/projects`），无密钥，`permissions:['fs.read']` 足矣。设计上为后续插件留好接口：例如一个"云任务"插件会声明 `personal.aigw` 并用 `resolvePluginSecrets` 服务端取 key。

**`group` 归属**：`work`（操作当前 agent + 其产物） vs `monitor`（监视外部资源）。S1 会话属"操作历史 agent 产物"→ `work`，与 compare 同组。

### 3.2 事件挂点

nanocode 已有 **document CustomEvent 总线** + **`/ws/notify` WebSocket** 两条通道：

- **S1 用 CustomEvent（pull 型，零服务端改动）**：面板 fork 时 `document.dispatchEvent(new CustomEvent('nanocode:fork-session',{detail:{source,id,cwd,cmd},cancelable:true}))`（`sessions-panel.js:381`）。`terminal-view.js:232` 监听器对 **claude** 会话 `preventDefault()` 并真造新 claude tab（预载 `claudeSessionId` = resume/fork，`terminal-view.js:280-294`）；对 **codex** 会话**故意不** `preventDefault`，面板降级显示 `codex resume <id>` 命令（诚实退化——codex SDK driver 暂无"造 tab 时预置 thread id"路径，见 §6 改进项）。
- **未来 push 型插件**可加服务端 `broadcastNotify({type:'...'})` + `app.js initNotifyWs` 转 `nanocode:<event>` CustomEvent，面板 `document.addEventListener` 订阅（模板见 `services-panel.js` 的 `_wireStatusListener`）。S4 后台任务面板可直接订阅既有 `agent_health` 流；S7 recap 可建在既有 `nanocode:turn-complete`（`claude-block-renderer.js:2028`）+ jsonl 之上。
- **S2/S3 的事件源**：codex 已有 `file_change` 结构化事件（`codex-sdk-driver.js:19-27`）；claude 侧 block renderer 处理 file-edit `tool_use` 但**未**发 `nanocode:diff`——S3 需在此处加发事件（一处侵入），或服务端按 turn 算 diff（复用 `terminal/compare.js`/`git-compare.js`，避免重写 diff）。

### 3.3 UI 面

右栏 `work` 组一个 `sessions` 子 tab（`tab:{id:'sessions'}`，`refreshOnActivate:true` 每次拉开刷新）：
- **控件行**：源过滤器（全部/codex/claude）+ 条数(20/50/100/200，存 localStorage) + 刷新。
- **会话卡片**：源 badge + 时间 + cwd + 首条真实用户消息(≤200 字) + meta(model·cli·turns)。≥44px 触控。
- **预览面板**：末尾 6 轮 user/assistant 文本（👤🤖 角色标），返回按钮。
- **Fork**：卡片按钮 + 预览栏按钮。
- **诚实退化**：空/错态显式文案；codex fork 显式命令回退（防假过——不假装能 fork）。
- CSS：`.ses-*` 系列新增于 `public/style.css:1719+`，移动端可用。

---

## 4. 原型：Sessions 浏览器插件（S1）

**数据流**：

```
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ┐
   (line1 = session_meta {id,timestamp,cwd,cli_version,model}) │  terminal/sessions-browser.js
~/.claude/projects/<slug>/<uuid>.jsonl        ┘   listSessions() / previewSession()
   (首条 type:user 文本)                            ↓ 30s 缓存
   GET /api/sessions/list?source=&limit=   →  {sessions:[{id,source,cwd,timestamp,cliVersion,model,firstMessage,turns,lines,file}], total}
   GET /api/sessions/preview?source=&id=&file= → {turns:[{role,text}], totalTurns, ...}
                                                   ↓
   public/js/sessions-panel.js  ──render→ 右栏 sessions tab
                   └ fork button ──dispatchEvent→ nanocode:fork-session
                                                   ↓
   public/js/terminal-view.js:232  listener
        claude → POST /api/projects/:id/tabs {type:'claude',claudeSessionId:<id>} → 新 tab resume
        codex  → 不 preventDefault → 面板显示 `codex resume <id>` 命令
```

**改动清单**（commit `2076aeb`，10 文件 / +1219 行）：

| 文件 | 增量 |
|---|---|
| `public/js/plugins-registry.js` | +17 manifest 项（`name:'sessions'`, `group:'work'`, `permissions:['fs.read']`, `settings:{defaultLimit:50}`, `refreshOnActivate:true`） |
| `public/js/right-panel.js` | +5 `LAZY_PLUGINS['sessions']` 分发 |
| `public/js/sessions-panel.js` | +418 渲染器（list/preview/fork + 诚实退化） |
| `terminal/sessions-browser.js` | +346 纯数据源（codex+claude 发现/预览，只读不写、不抛、30s 缓存、head 64KB 列表优化） |
| `terminal/routes.js` | +34 `/api/sessions/list` + `/api/sessions/preview` |
| `public/js/terminal-view.js` | +77 `nanocode:fork-session` 监听（claude 真造 tab / codex 降级） |
| `public/js/i18n.js` | +50 en+zh 串 |
| `public/style.css` | +190 `.ses-*` |
| `server/tests/plugins-registry.test.js` | +15 manifest 契约 |
| `server/tests/sessions-browser.test.js` | +67 数据源纯函数测试 |

**设计要点（防假过）**：
- 只读：从不写会话文件，从不 mutate 用户数据。
- 不抛：所有 I/O 包 try/catch，错误降级为 `{error}`。
- 列表只读 head 64KB（`session_meta` 可达 15KB+），预览才整文件读、且限 4000 行。
- 首条消息过滤系统包装（`<environment_context>`/`<permissions`/`<system_`）。
- fork 用 `cancelable` CustomEvent + `preventDefault` 信令，无监听器则显式命令回退——不假装成功。

---

## 5. 验证（防假过，证据见 `run_nano_plugins.log`）

**未重启 9475/9476**；临时起 9478 烟测：

```
PORT=9478 node server/index.js  → /api/health OK
GET /api/sessions/list?source=codex&limit=3  → total 231, sessions 3（真实 cwd/首消息/时间）
GET /api/sessions/list?source=claude&limit=3 → total 1326, sessions 3
GET /api/sessions/preview?source=codex&id=…  → totalTurns 119, 预览 6 轮, err (none)
GET /js/sessions-panel.js                     → 面板模块正常服务
GET /js/plugins-registry.js | rg -c "name: 'sessions'" → 1（manifest 已入清单）
```

**单元 + 全量**：
```
node --test server/tests/sessions-browser.test.js server/tests/plugins-registry.test.js → 31 pass
npm test（全量 server/tests/*.test.js） → tests 545, pass 545, fail 0
```

**run_nano_plugins.log 自检**：`rg "fail|not found"` 仅命中 commit subject 中的 "failover" 与 `# fail 0`；无真实失败/NaN/NOT FOUND。

---

## 6. 后续优先级与改进项

1. **S2 Checkpoint/Rewind**（下一轮最高）：钩 `nanocode:turn-complete`（或新加 turn-start）每轮用 `git stash create` 捕获工作树快照 SHA + dirty 文件清单，右栏 tab 列时间线，"恢复代码"=`git restore --source=<sha>`。复用 `compare.js` 的 git exec 模式；语义对齐 Claude Code（仅追踪 file-edit，bash 改动不追踪，非版本控制替代）。
2. **S3 Diff 审阅/apply**：在 `claude-block-renderer.js` file-edit `tool_use` 处发 `nanocode:diff`（一处侵入），叠加 codex 既有 `file_change` 事件，右栏按 turn 展示 diff + 一键 revert/`codex apply`。diff 计算复用 `git-compare.js`/`repos-routes.js`，不重写。
3. **S1 改进——codex 真分支 fork**：`codex-sdk-driver.js` 已支持 `client.resumeThread(threadId)`（`:119`）。给 codex tab 创建路径加 `codexThreadId` 预置（仿 claude `claudeSessionId`），让 codex fork 也 `preventDefault` 真造 tab，取代命令回退。
4. **S7 会话 recap / S8 PR 状态**：低难度，建在 `turn-complete` + jsonl / `gh` 之上，可快速跟进。
5. **GLM 安排上**：主人提到"也可以 glm 安排上"。S1 已与 AIGW 自建 Kimi 网关解耦——插件本身不依赖模型；后续 S6 `/btw`、S7 recap 这类需要"小模型总结"的插件，可经 `personal.aigw` 权限门 + `resolvePluginSecrets` 调 `litellm/SGLang-Kimi-K2.7-Code` 实现（设计已为其留好接口，见 §3.1）。

---

## 7. 交付清单

- [x] 调研：codex CLI 0.144.3 + Claude Code 桌面端文档（§1）
- [x] "值得抄"清单 12 项（§2）
- [x] 移植设计：插件边界 / 事件挂点 / UI 面（§3）
- [x] 原型 S1 会话浏览器（§4，commit `2076aeb`）
- [x] 验证：9478 真跑 + 545 测试 pass（§5，`run_nano_plugins.log`）
- [x] `FLAG_nano_plugins`（成功旗）
- [x] Linear MES-14031 自报
- [x] push fork 分支 `zhining/nano-plugin-proto`（不开 PR）
- [ ] self compact（本会话末尾）
