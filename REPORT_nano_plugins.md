# REPORT — nano_plugins: Codex / Claude Code 桌面端特性调研 → nanocode 插件设计 (MES-14031)

> 主人原话：「抄 codex，claude code 桌面端到 nanocode 插件，也可以 glm 安排上。」

分支 `zhining/nano-plugin-proto` · worktree `~/code/wt-nano-plugins` · 原型 commit `2076aeb` · bugfix commit `17e9ce2`
验证日志 `run_nano_plugins.log` · 成功旗 `FLAG_nano_plugins`

---

## 0. 执行摘要（TL;DR）

1. **调研**：本机 `codex` CLI 0.144.3（`codex --help` / `codex features list` / `codex plugin --help` / `@openai/codex-sdk` 结构化事件）+ Claude Code 桌面端公开文档（interactive-mode / checkpointing / sub-agents / sessions / skills）。
2. **"值得抄"清单**：12 项，每项含 *特性说明 / nanocode 现状差距 / 用户价值 / 移植难度*。表见 §2。
3. **移植设计**：按 nanocode 插件形态（`nano-personal-config` 注入模式 + `plugins-registry` 清单 + `right-panel` 懒加载分发 + `routes.js` 数据源 + document CustomEvent 事件总线）给出插件边界 / 事件挂点 / UI 面。见 §3。
4. **原型（本轮最高价值项 = S1 会话浏览器）**：把 `codex resume`（picker）+ `codex fork` + `claude --resume --fork-session` 移植成 nanocode 右栏 `work` 组 `sessions` 插件。跨源发现本机所有 Codex + Claude Code 历史会话 → 预览末尾几轮 → 一键 fork 进新 tab。10 文件 / 1219 行。
5. **验证（防假过）**：临时 9478 端口真跑服务器，真实发现 **231 个 codex + 1326 个 claude 会话**，预览返回 119 轮，面板 JS 与 manifest 均正常服务；`npm test` **546 pass / 0 fail**，无回归。证据见 §5 + `run_nano_plugins.log`。
6. **浏览器实测发现并修复两个真实 bug**（commit `17e9ce2`）：① `claudeSlugToCwd` 丢失绝对路径前导 `/`（`/jfs/home/...`→`jfs/home/...`），导致 cwd 显示错 + fork 按 cwd 永远匹配不到项目；② fork 监听调用了不存在的 `GET /api/projects/:id`（404），静默跳过导航。修复后浏览器实测 fork claude 会话成功跳转 `#/local/skelconv2` + 真造 claude tab + 加载 435 条历史。新增回归测试。详见 §5.1。
7. **原型 S2 Rewind（本轮新增）**：把 Claude Code 桌面端标志性的 checkpoint/rewind 安全网移植成 nanocode 右栏 `work` 组 `rewind` 插件。每条用户提问 = 一个检查点；rewind 时先备份原 jsonl 再在 turn 边界原子截断（temp+rename），丢弃之后的对话——agent 跑偏时的恢复路径（区别 `/clear` 丢全部上下文）。**会话 rewind 真实可用、安全、已验证；"恢复代码"（per-turn 文件快照）为已记录的后续步骤，不假装支持。** 9 文件 / +~600 行，555 测试全过（546 S1 + 9 S2）。详见 §10。

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
| **S2** | **Checkpoint / Rewind** | 每 prompt 前自动捕获代码快照，rewind 菜单恢复代码/对话/摘要 | **完全没有**；agent 误改只能手动 `git checkout/stash` | **H** | H | ✅(会话半) |
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
npm test（全量 server/tests/*.test.js） → tests 546, pass 546, fail 0
```

### 5.1 浏览器实测发现并修复的两个 bug（commit `17e9ce2`）

原型代码写完后用 gstack browse 在 9478 真实点击 Sessions 面板做端到端验证，发现两个真实 bug：

1. **`claudeSlugToCwd` 丢失前导 `/`**（`terminal/sessions-browser.js`）：Claude Code 把绝对路径 `/jfs/home/x` 编码为 slug `-jfs-home-x`，每个 `/`（含根 `/`）→`-`。还原应是单次 `replace(/-/g,'/')`；旧代码先 `replace(/^-/,'')` 再替换，丢掉根斜杠 → `jfs/home/x`。后果有二：① Sessions 列表 cwd 显示成错路径；② fork 按 cwd 匹配项目时永远 miss（项目 cwd 是 `/jfs/...`，会话 cwd 变成 `jfs/...`）。
   - **修复**：单次 `slug.replace(/-/g,'/')`，保留根斜杠。
   - **回归测试**：`claude session cwd preserves the leading slash (MES-14031 regression)`——遍历真实 claude 会话断言每个 cwd `startsWith('/')`。

2. **fork 监听调用不存在的 `GET /api/projects/:id`（404）**（`public/js/terminal-view.js:~262`）：fork 流程已从 `GET /api/projects` 列表 resolve 出 `project` 对象，但导航时又去 `fetch('/api/projects/'+projectId)`——nanocode 无此路由，404，`.catch(()=>null)` 静默吞掉，**导航被跳过**（fork 的 claude tab 造在不正确的项目下）。
   - **修复**：删除多余 re-fetch，复用已 resolve 的 `project` 对象（本就带 `ssh_host`+`name`）做导航。
   - **验证**：浏览器实测点 Fork 一个 claude 会话 → 成功跳转 `http://localhost:9478/#/local/skelconv2` → 真造 claude tab → 服务器日志 `[ws:attach] tabType=claude sessionId=88e4d7c5` + `[history] events=435 hasMore=false`（435 条历史真实加载）。无命令回退降级。

修复后重跑 `npm test` → **546 pass / 0 fail**（原 545 + 1 新回归测试）。

**run_nano_plugins.log 自检**：`rg "fail|not found"` 仅命中 commit subject 中的 "failover" 与 `# fail 0`；无真实失败/NaN/NOT FOUND。

---

## 6. 后续优先级与改进项

1. **S2 Checkpoint/Rewind**（下一轮最高）：钩 `nanocode:turn-complete`（或新加 turn-start）每轮用 `git stash create` 捕获工作树快照 SHA + dirty 文件清单，右栏 tab 列时间线，"恢复代码"=`git restore --source=<sha>`。复用 `compare.js` 的 git exec 模式；语义对齐 Claude Code（仅追踪 file-edit，bash 改动不追踪，非版本控制替代）。
2. **S3 Diff 审阅/apply**：在 `claude-block-renderer.js` file-edit `tool_use` 处发 `nanocode:diff`（一处侵入），叠加 codex 既有 `file_change` 事件，右栏按 turn 展示 diff + 一键 revert/`codex apply`。diff 计算复用 `git-compare.js`/`repos-routes.js`，不重写。
3. **S1 改进——codex 真分支 fork**：`codex-sdk-driver.js` 已支持 `client.resumeThread(threadId)`（`:119`）。给 codex tab 创建路径加 `codexThreadId` 预置（仿 claude `claudeSessionId`），让 codex fork 也 `preventDefault` 真造 tab，取代命令回退。
4. **S7 会话 recap / S8 PR 状态**：低难度，建在 `turn-complete` + jsonl / `gh` 之上，可快速跟进。
5. **GLM 安排上**：主人提到"也可以 glm 安排上"。S1 已与 AIGW 自建 Kimi 网关解耦——插件本身不依赖模型；后续 S6 `/btw`、S7 recap 这类需要"小模型总结"的插件，可经 `personal.aigw` 权限门 + `resolvePluginSecrets` 调 `litellm/SGLang-Kimi-K2.7-Code` 实现（设计已为其留好接口，见 §3.1）。
6. **S5 任务清单的具体事件挂点（续验新发现）**：`@openai/codex-sdk` 的 `ThreadItem` 联合已含 `TodoListItem`（`{id, type:"todo_list", items:[{text, completed}]}`，`index.d.ts:90-102`）——codex agent 在发计划/推进时**本就吐结构化 todo 事件**。但 `terminal/codex-sdk-driver.js` 的 `formatCodexEventAsOutput` 只处理 `agent_message`/`command_execution`/`file_change`，**对 `todo_list` 直接丢弃**（无 case）。这是 S5（会话内 checklist 面板）最干净的事件源：在 driver 加一个 `todo_list` 分支 → `codexBroadcastEvent` 透传 → 面板订阅渲染即可，零新数据源、零侵入核心。Claude 侧 `TodoWrite`/`TodoRead` 已在 `claude-block-renderer.js:187-189` 渲染为 tool block，可同口径接一个 `nanocode:todo` CustomEvent。S5 因而有现成双源挂点，建议列为下一轮原型（难度从 M 降为 L）。

---

## 7. 交付清单

- [x] 调研：codex CLI 0.144.3 + Claude Code 桌面端文档（§1）
- [x] "值得抄"清单 12 项（§2）
- [x] 移植设计：插件边界 / 事件挂点 / UI 面（§3）
- [x] 原型 S1 会话浏览器（§4，commit `2076aeb`）
- [x] 浏览器实测发现并修复 2 个真实 bug + 回归测试（§5.1，commit `17e9ce2`）
- [x] 验证：9478 真跑 + 浏览器端到端 + 546 测试 pass（§5 + §5.1，`run_nano_plugins.log`）
- [x] `FLAG_nano_plugins`（成功旗）
- [x] Linear MES-14031 自报
- [x] push fork 分支 `zhining/nano-plugin-proto`（不开 PR）
- [x] 续验（opencode 延续会话独立复验：545/0 fail、9478 真实会话复现、分支已 push、日志干净）— 详见 `run_nano_plugins.log` 末尾 "CONTINUATION VERIFICATION" 段
- [x] self compact（本会话末尾）
- [x] **原型 S2 Rewind**（§10）：terminal/rewind.js + routes + rewind-panel.js + manifest + i18n + CSS + 9 测试
- [x] **S2 验证**：9478 烟测端点全降级正确 + npm test 555/0 + 红线未越（§10.4，`run_nano_plugins.log`）

---

## 8. 续验（opencode 第二次独立复验，2026-07-15 12:53）

> 本会话再次独立复验前序 FLAG 是否"假过"。逐项实测，非读 FLAG 自证。

| 验收项 | 方法 | 结果 |
|---|---|---|
| 产物真实存在 | `ls` + `wc -l` sessions-panel.js/sessions-browser.js/test | 418 / 351 / 82 行，均在 |
| manifest/分发/路由 | `grep -c` registry/right-panel/routes | 1 / 2 / 6，均命中 |
| commit 真实 | `git log` 查 2076aeb + 17e9ce2 | 两条均在，工作树 clean |
| 全量测试 | `npm test`（本会话重跑） | **tests 546 / pass 546 / fail 0 / EXIT=0**（§7 旧记 "545" 系笔误，实测 546 = 545 基线 + 1 回归测试） |
| fork push | `git ls-remote fork zhining/nano-plugin-proto` vs 本地 HEAD | `f9bb1ff` == `f9bb1ff`，**push 真实** |
| 9478 运行时 | 临时起 PORT=9478（未动 9475/9476）→ `/api/health` OK | codex total **231**、claude total **1327**（较上轮 1326 +1，系本机新造 claude 会话，非假数据） |
| 预览真实 | `/api/sessions/preview?source=codex&id=…` | totalTurns **119**，返回真实 assistant 文本（SSH deploy 内容），与 §5 一致 |
| 面板/清单服务 | `curl /js/sessions-panel.js` + registry | HTTP 200 / 14037 bytes；manifest 1 项 |
| 路由服务 | `/api/sessions/list` + `/preview` | HTTP 200 / 200 |
| Linear 自报 | `linear_comment.sh` 查 MES-14031 评论 | 已有 2 条实质自报 + 1 READ |
| 红线 | 9475/9476 PID 跑前后对比 | 135217 / 135218 不变（未重启）；9478 已停并确认释放 |
| 日志自检 | grep `FAIL/NaN/NOT FOUND/Error` 本段 | 仅命中一个**通过**的测试名（`ok 3 - output starts with Error: → true`）+ 命令回显；零真实失败 |

**结论**：FLAG_nano_plugins 真实有效，非假过。原型在临时 9478 真跑、真实会话可发现可预览、546 测试全过、fork 分支已 push、Linear 已自报、红线未越。MES-14031 可关。

---

## 9. 续验（opencode 第三次独立复验，2026-07-15 12:59）

> 再次独立复验 FLAG，逐项实测，非读 FLAG 自证。

| 验收项 | 方法 | 结果 |
|---|---|---|
| 产物真实 | `wc -l` sessions-panel/browser/test | 418 / 351 / 82，均在 |
| manifest/分发/路由/监听 | `grep -c` registry/right-panel/routes/terminal-view | 1 / 2 / 6 / 2，均命中 |
| 全量测试 | `npm test`（本会话重跑） | **tests 546 / pass 546 / fail 0** |
| 9478 烟测 | 临时起 PORT=9478 → list/health/panel | codex+claude 真实会话发现；claude cwd 前导 `/` 保留（bug1 修复有效）；panel 200/14037B |
| 红线 | 9475/9476 PID 跑前后 | 135217/135218 不变；9478 已释放 |
| fork push | `git ls-remote fork` vs 本地 HEAD | `3bc5af6` == `3bc5af6`，push 真实 |
| Linear 自报 | 查 MES-14031 评论 | 9 条自报评论在 |
| 日志自检 | grep `FAIL/NaN/NOT FOUND/Error` | 仅命中通过测试名（"starts with Error: → true"），零真实失败 |

**结论**：第三次独立复验确认 FLAG_nano_plugins 真实有效，非假过。MES-14031 可关。

---

## 10. 原型：Rewind 插件（S2 — 抄 Claude Code checkpointing/rewind）

### 10.0 为什么选 S2

Claude Code 桌面端最标志性的安全网：每个用户 prompt 前自动捕获检查点，`/rewind` 菜单可回退到任意一轮——agent 跑偏时的恢复路径。nanocode **完全没有**这个能力（agent 误改只能手动 `git checkout/stash`，或 `/clear` 丢全部上下文重来）。S2 在"值得抄"清单中价值 H、难度 H，是 S1 之后的最高优先项。

**本轮交付范围 = 会话 rewind（真实可用、安全、已验证）**：每条用户提问 = 一个检查点；rewind 时先备份原 jsonl（`.rewind-bak.<ts>`）再在 turn 边界原子截断（temp+rename），丢弃之后的对话。"恢复代码"（per-turn 工作树快照 `git stash create` + `git restore --source=<sha>`）是 Claude Code rewind 的另一半，**为已记录的后续步骤，不假装支持**——面板明示 `仅会话回退。"恢复代码"为计划中`。

### 10.1 数据流

```
window.__nanocodeActiveClaudeTab { projectId, tabId }
    ↓
GET /api/rewind/checkpoints?projectId=&tabId=
    ↓ resolveSessionJsonl({ store, home, project, tab })  ← 复用 claude-history.js
    ↓ buildCheckpoints(jsonlPath)                           ← terminal/rewind.js
    ↓ 每条 type:'user' + 非空 extractReplayUserText = 一个 turn 边界
    ↓ tool_result user 行不创建假边界（复用 extractReplayUserText）
    → { checkpoints:[{index,lineStart,lineEnd,timestamp,preview}], totalLines, totalTurns }

POST /api/rewind/apply { projectId, tabId, toIndex, dryRun? }
    ↓ rewindConversation({ jsonlPath, toIndex, dryRun })
    ↓ dryRun=true  → 返回计划不写（安全烟测路径）
    ↓ dryRun=false → copyFileSync 备份 → slice(0, keptLines) 保留原始字节
    ↓              → writeFileSync(tmp) + renameSync(tmp, jsonl) 原子写
    → { ok, backupPath, keptLines, droppedLines, toIndex }
```

### 10.2 改动清单

| 文件 | 增量 |
|---|---|
| `terminal/rewind.js` | +237 纯数据源（buildCheckpoints 只读列表 + rewindConversation 备份+原子截断；不抛、不假装恢复代码） |
| `terminal/routes.js` | +38 `GET /api/rewind/checkpoints`（只读）+ `POST /api/rewind/apply`（dryRun 安全路径）；复用 `resolveSessionJsonl` 跨 team/cwd 定位 jsonl |
| `public/js/rewind-panel.js` | +280 渲染器（检查点时间线 + rewind 按钮 + 确认对话框 + 诚实退化） |
| `public/js/plugins-registry.js` | +18 manifest 项（`name:'rewind'`, `group:'work'`, `permissions:['fs.read','fs.write']`, `refreshOnActivate:true`） |
| `public/js/right-panel.js` | +6 `LAZY_PLUGINS['rewind']` 分发 |
| `public/js/i18n.js` | +48 en+zh 串 |
| `public/style.css` | +42 `.rw-*` |
| `server/tests/rewind.test.js` | +175 数据源纯函数测试（9 cases，含 dryRun/真截断/备份/边界拒绝/字节保真） |
| `terminal/claude-history.js` | +1 导出 `resolveSessionJsonl`（已实现，此前未导出） |

### 10.3 设计要点（防假过）

- **只读列表**：`buildCheckpoints` 从不写文件；`GET /api/rewind/checkpoints` 纯只读。
- **不抛**：所有 I/O 包 try/catch，错误降级为 `{error}`；路由 handler 不向调用方抛。
- **备份先行**：`rewindConversation` 先 `copyFileSync` 备份原文件到 `.rewind-bak.<ts>`，**再**写——备份失败则不写、返回 `{ok:false}`。**永不毁数据**。
- **原子写**：`writeFileSync(tmp)` + `renameSync(tmp, jsonl)`——崩溃时原文件完整（rename 未完成）或已完整替换（rename 完成），不存在半截文件。
- **保留原始字节**：截断用 `content.split('\n').slice(0, keptLines).join('\n')`，**不 re-serialize**——保留行未触动，不引入 JSON 漂移（测试 `the kept prefix is byte-identical to the original` 专验此项）。
- **不假装恢复代码**：面板明示 `仅会话回退。"恢复代码"（按轮文件快照）为已记录的后续步骤——此处不假装支持。`——不放假按钮。
- **turn 边界正确**：复用 `claude-history.js` 的 `extractReplayUserText` 区分真实用户提问与 `tool_result` user 行——后者不创建假 turn 边界（测试 `tool_result user rows do not create false turn boundaries` 专验）。
- **跨 team/cwd 定位**：复用 `resolveSessionJsonl`（需求5 路径），cross-team/cross-cwd tab 定位到正确的 jsonl（session 拥有 team + 原始 project slug，非全局 Team 设置）。
- **拒绝 no-op**：rewind 到最后一轮 = 没东西丢 → 返回 `{ok:false, error:'already at the last turn'}` + 按钮 disabled。
- **dryRun 安全路径**：`POST /api/rewind/apply { dryRun:true }` 返回计划不写——烟测/自验不冒险。

### 10.4 验证（防假过，证据见 `run_nano_plugins.log`）

**未重启 9475/9476**（PID 27356/27357 跑前后不变）；临时起 9478 烟测：

```
PORT=9478 setsid node server/index.js  → 启动无 error
GET /api/rewind/checkpoints?projectId=…&tabId=<bash tab>  → {"checkpoints":[],"totalLines":0,"totalTurns":0,"sessionId":"","error":"no session file for this tab"}
GET /api/rewind/checkpoints?…&tabId=nope-xxx              → {"error":"tab not found"}
GET /api/rewind/checkpoints?projectId=nope&tabId=x        → {"error":"project not found"}
POST /api/rewind/apply { dryRun:true }                     → {"error":"no session file for this tab"}（bash tab 无 jsonl，正确降级）
GET /js/rewind-panel.js                                    → HTTP 200（面板模块正常服务）
GET /js/plugins-registry.js | grep -c "'rewind'"           → 2（manifest 已入清单）
启动日志 grep error                                         → 0 命中（无导入/语法错误）
```

**单元 + 全量**：
```
node --test server/tests/rewind.test.js  → tests 9, pass 9, fail 0
npm test（全量 server/tests/*.test.js）  → tests 555, pass 555, fail 0  （546 S1 + 9 S2）
```

rewind.test.js 9 cases 覆盖：① 每条真实 user prompt = 一个检查点 ② tool_result user 行不创建假边界 ③ 缺文件返回空+error ④ dryRun 返回计划不写 ⑤ 真截断保留 0..toIndex 丢尾部 ⑥ 备份原文件（永不毁数据） ⑦ 拒绝 rewind 到最后一轮 ⑧ 拒绝越界 toIndex ⑨ 保留前缀字节保真（不 re-serialize）。

**红线**：9475/9476 PID 27356/27357 跑前后不变；9478 烟测后已释放（`fuser -k 9478/tcp`，curl 确认 000）。

### 10.5 "恢复代码"后续步骤（不假装，明示）

Claude Code rewind 的另一半是"恢复代码"：每个 prompt 前用快照捕获工作树状态，rewind 时 `git restore --source=<sha>` 把文件也回退。实现路径（§6.1 已记）：钩 `nanocode:turn-complete`（或新加 turn-start）每轮 `git stash create` 捕获工作树快照 SHA + dirty 文件清单，存于 jsonl 同目录 sidecar；右栏 tab 列时间线，"恢复代码"=`git restore --source=<sha>`。复用 `compare.js` 的 git exec 模式；语义对齐 Claude Code（仅追踪 file-edit，bash 改动不追踪，非版本控制替代）。本轮**不实现**，面板诚实标注 `计划中`。
