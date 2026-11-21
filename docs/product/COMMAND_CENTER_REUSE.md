# 指挥舱：可复用的外部源码清单（COMMAND_CENTER_REUSE）

> 配套 [COMMAND_CENTER_PRD.md](COMMAND_CENTER_PRD.md)（需求）和 [COMMAND_CENTER_RESEARCH.md](COMMAND_CENTER_RESEARCH.md)（27 仓调研）。
> 本文回答：PRD 里每一项功能，**别人哪个仓库、哪个 commit、哪个文件哪一行、哪个函数**已经做过；能不能直接借代码；怎么借。
> 所有行号都钉在下表的 commit 上（读的是那个 commit 的原文件，不是 README）。仓库更新后行号会漂移，以 commit 为准。

## 0. 怎么读这份清单

**许可证规则**

| 许可证 | 能做什么 | 要做什么 |
|---|---|---|
| MIT / BSD | 可以直接拷代码、改代码 | 在拷过来的文件头写「来源仓库 + commit + 原文件路径」，原版权声明 + 许可证全文放进 `THIRD_PARTY_NOTICES.md` |
| Apache-2.0 | 可以直接拷代码、改代码 | 同上，另外：原仓有 `NOTICE` 的要带上；改过的文件要注明「已修改」 |
| GPL / AGPL | **只借思路**，不拷一行代码，也不照着逐行翻译 | 文档里写清楚「思路来自 X」即可 |
| Elastic License 2.0、FSL 等源码可见但非开源 | **只借思路** | 同上 |
| 没写许可证 | **不碰**（连思路都不照搬细节） | — |

> 注意：本仓库目前没有 `LICENSE` 文件。第一次真正拷外部代码进来的那个 PR，必须同时新建 `THIRD_PARTY_NOTICES.md`，把来源和原许可证写进去。本文是纯文档，没有拷任何代码。

**引用格式**：`仓库@commit前8位:文件:行号 函数名`。完整 commit 见 §9 来源表。

**结论先说（每块最值得借的一个）**

| 块 | 最值得借 | 许可证 | 一句话 |
|---|---|---|---|
| 甘特 / 时间轴 | langfuse `web/src/features/traces/fns/timeline/layout.ts` 的 `layout()` | MIT（非 ee 目录） | 一个纯函数算出全部坐标，宽度必须显式传、零时长不出 NaN、所有东西夹在框内 |
| 会话回放 / 思考链 | vibe-kanban `crates/executors/src/logs/mod.rs` 的 `NormalizedEntry` / `NormalizedEntryType` / `ToolStatus` | Apache-2.0 | 把不同智能体的日志归一成一种条目，思考、工具、等批准都有类型 |
| 事件分组与折叠 | uptime-kuma `server/monitor-types/group.js` 的 `GroupMonitorType.check()` + gatus `web/app/src/views/Home.vue` 的折叠记忆 | MIT / Apache-2.0 | 组状态 = 子项里最差的那个；默认全折叠，只记「展开了哪些」 |
| 外部任务系统同步 | openai/symphony `elixir/lib/symphony_elixir/orchestrator.ex` 的 `reconcile_issue_state/4` + `tracker.ex` 的 behaviour | Apache-2.0 | 每轮按单号批量取单，按「终态 / 不再归我 / 活跃 / 其他」四分支对账 |
| 「等你」队列 | vibe-kanban `crates/services/src/services/approvals.rs` 的 `Approvals` | Apache-2.0 | 待批准表（创建时间 + 超时时间）+ 「先发快照再发增量」的推送流 |
| 用量 / 额度 | Claude-Code-Usage-Monitor `src/claude_monitor/output/official.py` 的 `read_official_limits()` | MIT | 读官方 5 小时 / 7 天额度，过了重置时间就作废，超时未刷新标 stale，脏数据丢掉不显示 |
| 模块开关 / 插件 | uptime-kuma `server/uptime-kuma-server.ts` 的 `monitorTypeList` 注册表 | MIT | 一种能力一个文件、一行注册；正好对上本仓现有 `public/js/plugins-registry.js` |

---

## 1. 甘特 / 时间轴视图（PRD P1-1）

### 1.1 langfuse —— 时间轴布局纯函数 + 空闲段压缩（MIT，ee 目录以外）

| 文件:行 | 函数 / 类型 | 做法 |
|---|---|---|
| `langfuse@4afc7797:web/src/features/traces/fns/timeline/layout.ts:1-40`（文件头）、`:245` | `prepareTimeline()` | 走一遍树，产出要画的行；按「树 + 折叠集合」做缓存，不进缩放 / 平移循环 |
| 同文件 `:330` | `layout(tree, view, box, density)` | **唯一**算坐标的函数。文件头写了三条约束：①`box`（宽度）必须传，没有默认 900px；②零时长、没有结束时间的条也出有限坐标，不出 NaN / Infinity；③条、标签、刻度全部夹在 `[0, box.width]` 里，看不到的条标 `offscreen`，靠缩放 / 平移去看，不靠横向滚动 |
| 同文件 `:385` `positionRow()`、`:507` `buildTicks()`、`:579` `buildGapMarkers()` | — | 每行定位、刻度、压缩段标记 |
| `langfuse@4afc7797:web/src/features/traces/fns/timeline/timeCompression.ts:21-26`、`:68` | `buildTimeCompression()` | **空闲段压缩**：没有任何条在跑、且长于总时长 5% 的空档，压成固定 28px 的标记，忙的地方拿到像素。压缩是画之前的坐标重映射，刻度文字再用 `toRealMs` 换回真实时间 |
| `langfuse@4afc7797:web/src/features/traces/types/treeNode.ts:18-60` | `TreeNode` | 节点带 `startTimeSinceTrace`、`depth`、`childrenDepth`、`subtreeWallClockDurationMs`（子树最早开始到最晚结束），子节点晚于父节点结束时也能显示真实耗时 |

**能不能借**：`layout.ts`、`treeNode.ts` 是 MIT，可以拷。`timeCompression.ts` 文件头自述「移植自 Sentry 的 traceTimeCompression」，Sentry 主仓不是 MIT（具体许可证本次未核实），**这一个文件建议只借思路、自己重写**（逻辑就是「合并忙区间 → 找长空档 → 分段线性映射」，几十行），或请负责人定。

**怎么复用**：车的 trace 恰好是「大段等待 + 一阵忙」（等模型、等人、等测试），不压缩的话一根 2 小时的条里全是空白。P1-1 甘特直接用这个 `layout()` 的形状：输入是 §8 的甘特 JSON，`box` 由容器量出来传入，手机竖屏（PRD P0-9）同样走它，不会出横向滚动条。

### 1.2 frappe/gantt —— 最小可用甘特库（MIT，© 2024 Frappe Technologies）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `gantt@5c83708d:src/index.js:140-221` | `setup_tasks()` | 任务 `{id, name, start, end|duration, progress, dependencies, custom_class}`；没开始 / 结束时间、开始晚于结束、超过 10 年的任务**打 console.error 并丢掉** |
| 同文件 `:223` | `setup_dependencies()` | 依赖表 `dependency_map[被依赖] = [依赖它的]`，画箭头用 |
| `gantt@5c83708d:src/bar.js:587` `compute_x()`、`:622` `compute_y()` | — | x = (开始 − 图起点) / 刻度步长 × 列宽；y = 表头高 + 行号 × (条高 + 间距)，**一个任务固定占一行** |
| `gantt@5c83708d:src/bar.js:575` | `compute_expected_progress()` | 「按时间应该到哪」的预期进度条（today − start）/ 时长，可用来画「现在线 vs 预计完成」 |
| `gantt@5c83708d:src/defaults.js:15-60` | `DEFAULT_VIEW_MODES` | 视图档位最细是 `Hour`（步长 1 小时）；`readonly` 开关在 `:152` |

**能不能借**：MIT，可以整库依赖或拷代码。

**为什么不直接当 P1-1 的实现**：①一个任务一行，没有「按大事件分泳道」；②最细一档是 1 小时，车的里程碑常常隔几分钟；③偏编辑（拖拽改日期 / 进度）；④`setup_tasks()` 里有一条「结束时间是整点 00:00:00 就当成全天、自动加 24 小时」的规则（`index.js` 同函数内 `task_end_values` 那段），车正好在午夜收工时条会被拉长一天。
**建议**：P1-1 自己写轻量 SVG 渲染（坐标用 1.1 的 `layout()` 形状），只借 frappe 的两样东西：`compute_x/compute_y` 的换算公式、`compute_expected_progress()` 的预期进度画法。真要先出一个能看的版本，可以用 frappe 的 `readonly: true` + 每个状态一个 `custom_class` 顶一周，但要先绕开上面的午夜规则。

### 1.3 只借思路的

- `hoangsonww/Claude-Code-Agent-Monitor@ee72edaf:client/src/components/workflows/ConcurrencyTimeline.tsx:432` `ConcurrencyTimeline()`（MIT）：画的是「各类智能体的平均起止比例」，是统计图，不是逐车时间条；只借它的「左边 140px 标签列 + 右边条 + 悬停浮层夹在窗口内」（`:445-468` 浮层定位）。
- `makeplane/plane@da21a8ff:apps/web/components/gantt-chart/`（AGPL-3.0）：完整的项目甘特（侧栏 + 块行 + 拖拽），**只看交互，不碰代码**。
- `Arize-ai/phoenix@e783d1db:js/app/src/components/timeline/TimelineBar.tsx`（Elastic License 2.0）：**只借思路**。

---

## 2. 会话回放 / 思考链查看（PRD P1-4、P0-6）

### 2.1 vibe-kanban —— 多智能体日志归一化（Apache-2.0）

| 文件:行 | 类型 / 函数 | 做法 |
|---|---|---|
| `vibe-kanban@3f095f01:crates/executors/src/logs/mod.rs:119-125` | `NormalizedEntry { timestamp, entry_type, content, metadata }` | 不管底下是哪家智能体，回放只认这一种条目 |
| 同文件 `:73-100` | `NormalizedEntryType` | `UserMessage / UserFeedback / AssistantMessage / ToolUse{…} / SystemMessage / ErrorMessage / Thinking / Loading / NextAction / TokenUsageInfo / UserAnsweredQuestions` |
| 同文件 `:129-141` | `ToolStatus` | `Created / Success / Failed / Denied{reason} / PendingApproval{approval_id} / TimedOut`——**等批准是工具调用的一种状态**，回放里能直接看到卡在哪个调用上 |
| 同文件 `:174-217` | `ActionType` | `FileRead / FileEdit / CommandRun / Search / WebFetch / Tool / TaskCreate / PlanPresentation / TodoManagement / AskUserQuestion` |
| `crates/executors/src/executors/claude.rs`、`codex/normalize_logs.rs`、`opencode/normalize_logs.rs` | 各家的归一化器 | 一家一个文件，产出同一种 `NormalizedEntry` |
| `vibe-kanban@3f095f01:packages/ui/src/components/ChatCollapsedThinking.tsx:33` | `ChatCollapsedThinking()` | 连续的思考条目合成一块，默认收起只显示「Thinking」，点开看全部 |

**能不能借**：Apache-2.0，可以拷类型定义（Rust → JS 要重写，但字段和枚举照抄并注明出处）。
**怎么复用**：P1-4「车的转录尾巴」和 §8「点开看思考链」用同一套条目类型。本仓已有 `terminal/claude-history.js` 的 `parseJsonlHistory()`（`:68`）/ `parseJsonlHistoryTail()`（`:276`）在读 Claude 的 JSONL；建议在它的输出外面加一层「转成 `NormalizedEntry`」，前端只认归一后的条目；思考块照 `ChatCollapsedThinking` 默认折叠。

### 2.2 Claude-Code-Agent-Monitor —— 增量读转录 + 自动起标题（MIT，© 2026 Son Nguyen）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `Claude-Code-Agent-Monitor@ee72edaf:server/lib/transcript-cache.js:134`、`:147-200` | `TranscriptCache.extract()` | 缓存键 = 路径，值带 `mtimeMs / size / bytesRead`。文件没变 → 直接返回；**变短了或第一次** → 全量读；**变长了** → 只从 `bytesRead` 读到新结尾（`_streamRange`，`:290`），再 `_merge`（`:715`）进旧结果 |
| `client/src/lib/event-grouping.ts:707` | `buildEventTitle()` | 每条事件的标题**按结构算出来**，不维护「工具名 → 标题」对照表：MCP 名按 `mcp__<server>__<tool>` 拆（`:463` `parseMcpToolName`），shell 命令取子命令（`:575` `parseShellHeadline`），未知工具取参数里第一个短字符串 |
| 同文件 `:334` | `statusFromEventType()` | 生命周期事件 → `working / waiting / completed / error` 四态；未知事件类型落到 `waiting`，不抛错 |

**能不能借**：MIT，可以拷。
**怎么复用**：P1-3 运行监控、P1-4 转录尾巴都要反复读正在增长的 JSONL，直接照 `TranscriptCache.extract()` 的「mtime + size + 偏移」三段式做增量读（本仓 `terminal/usage.js` 的 `aggregateJsonlUsage()`（`:118`）目前是按字节上限截读，可以改成这个）。思考链里每一步的标题用 `buildEventTitle()` 的思路生成。

### 2.3 只借思路的

- langfuse `web/src/features/sessions/components/ConnectedModernSessionBodyTimeline/…/SessionTimelineCollapsibleRow.tsx`（MIT）：会话按轮次折叠成行；可借，但 2.1 / 2.2 已够用，P1 再看。

---

## 3. 事件分组与折叠（PRD P0-1、P0-2）

### 3.1 uptime-kuma —— 组状态 = 子项最差状态（MIT）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `uptime-kuma@b0cd0f1d:server/monitor-types/group.js:12-60` | `GroupMonitorType.check()` | 没有子项 → `PENDING`「Group empty」；暂停的子项跳过；任一子项 `DOWN` → 组 `DOWN`；否则任一 `PENDING` 或还没心跳 → 组 `PENDING`；全 `UP` 才 `UP`。同时把「哪些子项挂了 / 在等」的名字列进消息 |

**能不能借**：MIT，可以拷。
**怎么复用**：P0-1「大事件」的状态和「等你」标记，就是对下面的车做这个「取最差」：任一车 `waiting_human / blocked` → 大事件标「等你」；任一车 `failed / timeout` → 大事件标红；没有车 → 显示「没有车」而不是「完成」。严重度顺序要写进 PRD §6.3 的状态词表里（一份，不在各处各写一遍）。

### 3.2 gatus —— 默认全折叠，只记「展开了哪些」（Apache-2.0）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `gatus@655e6f0d:web/app/src/views/Home.vue:319-340` | `groupedEndpoints`（computed） | 按 `group` 字段分组，没有组的放「No Group」并排最后 |
| 同文件 `:54-76` | 组头模板 | 组头上直接显示「这组里有几个不健康」的红色数字 |
| 同文件 `:508-531` | `toggleGroupCollapse()` / `initializeCollapsedGroups()` | 本地存的是「**展开了**的组」集合（`gatus:uncollapsed-groups`）；没存过 = 全折叠；存的东西坏了就删掉、回到全折叠 |

**能不能借**：Apache-2.0，可以拷。
**怎么复用**：P0-1 / P0-2 直接照这个：大事件默认折叠，组头显示「等你 N / 失败 N」；没挂单的车放「未归类」组并排最后（对应 gatus 的「No Group」）。PRD 要求「全绿且无人等待时默认折叠」，在这个基础上加一条：有「等你」或失败的大事件**不受记忆影响，强制展开**。

### 3.3 langfuse —— 迭代建树 + 自下而上汇总（MIT）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `langfuse@4afc7797:web/src/features/traces/fns/treeBuilding.ts:1-20`（文件头）、`:418` | `buildTraceTree()` | 按开始时间排序 → Map 建父子 → 从叶子开始拓扑排序自下而上建节点；全程不递归，深树不爆栈 |
| 同文件 `:253` | `buildTreeNodesBottomUp()` | 建节点时顺手把花费、子树最早开始 / 最晚结束汇总到父节点 |
| 同文件 `:667` | `removeHiddenNodes()` | 过滤（如隐藏调试级）放在显示层后处理，不在建树时做 |

**怎么复用**：大事件 → 车 → 里程碑只有三层，用不上防爆栈；借的是「**汇总在建树时一次算好**」：大事件的总花费、最早开始、最晚结束、车数，在适配器层一次算出，前端不再各自累加。

### 3.4 opik —— 搜索时保留祖先（Apache-2.0，只作参考）

`comet-ml/opik@02a29b86:apps/opik-frontend/src/v2/pages-shared/traces/TraceDetailsPanel/TraceTreeViewer/TraceTreeViewer.tsx:50-61`：过滤 / 搜索命中一个子节点时，把它的所有父节点一起留下（`addAllParentIds`）。对应：搜到一辆车，它所属的大事件组头必须一起显示，不能出现「孤儿车」。`treeConfig.ts:1-19` 的「树上每行显示哪些小块（耗时 / token / 花费 / 模型）+ 默认值 + 本地存储键」可以作为车那一行显示字段的开关样板。

---

## 4. 外部任务系统同步（PRD P0-3 / §5）

### 4.1 openai/symphony —— 任务系统是唯一来源，每轮对账（Apache-2.0，NOTICE：Copyright 2025 OpenAI）

| 文件:行 | 函数 / 类型 | 做法 |
|---|---|---|
| `symphony@be10a1b7:elixir/lib/symphony_elixir/tracker.ex:22-27` | `@callback` 六个 | 适配器只需实现：`fetch_issues_by_states/1`、`fetch_issues_by_ids/1`、`agent_tool_specs/0`、`execute_agent_tool/3`、`secret_environment_names/1`、`validate_config/1`；同目录 linear / github / gitlab / jira / asana 各一个 `adapter.ex` |
| `elixir/lib/symphony_elixir/tracker/issue.ex:12-28` | `%Issue{}` | `id, native_ref, identifier, title, description, priority, state, branch_name, url, assignee_id, blocked_by, labels, dispatchable, created_at, updated_at`——跨任务系统的统一单结构 |
| `elixir/lib/symphony_elixir/orchestrator.ex:310-333` | `reconcile_running_issues/1` | 先处理卡死的（`:581` `reconcile_stalled_running_issues`，超过 `stall_timeout_ms` 没动静就重启），再**按单号批量取单**；取单失败 → 只记日志、**保持现有车不动** |
| 同文件 `:421-443` | `reconcile_issue_state/4` | 四分支：单进终态 → 停车并清工作区；单不再分给我 → 停车不清；单还活跃 → 刷新本地状态；其他非活跃状态 → 停车 |

**能不能借**：Apache-2.0，可以借结构（Elixir → JS 需要重写，照抄接口形状并注明出处、带上 NOTICE）。
**怎么复用 / 和 PRD 的差别**：PRD §5.9 的任务系统适配器接口直接对齐 `tracker.ex` 的前两个回调（按状态取、按单号批量取）+ `validate_config`；`%Issue{}` 字段作为 §5.2「单」的字段表起点。**不照抄的地方**：symphony 单进终态就停车；PRD §5.7 定的是「单被关了不自动停车，进『等你』」——对账分支照搬，动作换成「标记 + 进等你队列」。

### 4.2 cyrus —— 进度写回单上，「临时」活动可被下一条替换（Apache-2.0）

| 文件:行 | 函数 / 类型 | 做法 |
|---|---|---|
| `cyrus@4e2e5135:packages/edge-worker/src/sinks/IActivitySink.ts`（全文件） | `IActivitySink { id; postActivity(sessionId, activity, options); createAgentSession(issueId) }`；`ActivityPostOptions { ephemeral?, signal?, signalMetadata? }` | 写回目标抽象成「活动接收器」，一个任务系统工作区一个；`ephemeral` = 这条会被下一条替换（适合「正在做 X」），非临时的留档 |
| `packages/edge-worker/src/sinks/LinearActivitySink.ts:39`、`:61` | `LinearActivitySink`、`mapSignal()` | 通用信号 `auth / select / stop / continue` 映射到具体任务系统的枚举 |
| `packages/edge-worker/src/ActivityPoster.ts:48`、`:374` | `postThoughtActivity()`、`postComment()` | 找不到对应工作区的接收器 → 打 warn、不写；思考 / 动作 / 评论分开写 |
| `packages/edge-worker/src/sinks/NoopActivitySink.ts` | `NoopActivitySink` | 不连任务系统时用的空实现 |

**能不能借**：Apache-2.0，可以拷接口。
**怎么复用**：PRD §5「同步器统一写」的写口就用 `IActivitySink` 这个形状：里程碑摘要 = 非临时评论；「当前在做什么」= 临时活动（PRD 要克制，默认关）；没配任务系统时挂 `NoopActivitySink`，但界面要明说「未连接任务系统」，不能装作写成功了。

### 4.3 gatus —— 出事自动开单、恢复自动关单（Apache-2.0）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `gatus@655e6f0d:alerting/provider/github/github.go:105-142` | `AlertProvider.Send(ep, alert, result, resolved)` | 没恢复 → 建单，标题 `alert(gatus): <名字>`；恢复 → 列出自己开的、还开着的单，**按标题相同**找到并关掉 |
| `gatus@655e6f0d:watchdog/alerting.go:27`、`:83` | `handleAlertsToTrigger()` / `handleAlertsToResolve()` | 连续失败数 ≥ `FailureThreshold` 才触发；连续成功数 ≥ `SuccessThreshold` 才算恢复（`alerting/alert/alert.go:35-39`，失败阈值默认 3，`:77-78`） |

**能不能借**：Apache-2.0。
**怎么复用**：PRD P1-6 容灾面板 / P1-7 提醒如果要「自动开单」，照这个；**但不要照搬「按标题去重」**——标题一改就关不掉、两个同名会误关。去重键用 PRD §5.5 的显式键（来源 + 对象 id），存在单的隐藏字段或评论里。

### 4.4 emdash —— 任务系统接入按插件、账号解析失败就拒绝（Apache-2.0，Copyright 2026 General Action）

`emdash@ae7df312:apps/emdash-desktop/src/core/features/integrations/api/node/plugin-issue-provider.ts:37` `createPluginIssueProvider()`：每个任务系统是一个插件，包装成统一的 `IssueProvider`；`:51-57` 注释写明：项目没指定账号用默认账号，指定了就用指定的，「指定为空」或「指定的账号不存在」→ **直接失败并返回 `account_unavailable`**，不偷偷换成别的账号。对应 PRD P2-5 多任务系统：凭据解析照这个，宁可失败也不用错账号写错单。

---

## 5. 「等你」提醒队列（PRD P0-4）

### 5.1 vibe-kanban —— 待批准表 + 快照加增量推送（Apache-2.0）

| 文件:行 | 函数 / 类型 | 做法 |
|---|---|---|
| `vibe-kanban@3f095f01:crates/services/src/services/approvals.rs:40-47` | `ApprovalInfo { approval_id, tool_name, execution_process_id, is_question, created_at, timeout_at }` | 一条「等你」= 哪个进程、卡在哪个工具、是不是提问、什么时候开始等、什么时候超时 |
| 同文件 `:50-54`、`:86` | `Approvals { pending, completed, patches_tx }`、`create_with_waiter()` | 待处理表 + 已完成表；没人回应时默认结果是 `TimedOut`，不是「同意」 |
| 同文件 `:143` | `respond()` | 回应；已完成的再回应返回 `AlreadyCompleted` |
| 同文件 `:233` | `patch_stream()` | **先发一份当前全部待处理的快照，再接实时增量**——前端刷新 / 重连不会丢「等你」 |
| 同文件 `:257` | `get_pending_execution_process_ids()` | 给一组进程，返回其中有待处理的那些——列表页一次查出「哪几辆车在等你」 |

**能不能借**：Apache-2.0。
**怎么复用**：P0-4 队列的数据结构 = `ApprovalInfo` 加上 PRD 要的「卡在什么、有哪几个选项」；排序按 `created_at`（等待时长）；顶栏徽章用 `patch_stream` 的快照 + 增量。PRD P2-2 受控操作之前，指挥舱只读，不调用 `respond`。

### 5.2 agent-deck —— 状态防抖，避免假「等你」（MIT，© 2025 Ashesh Goplani）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `agent-deck@80494e52:internal/session/instance_status.go:140-158` | `debounceFlipFromRunning()` | 从「跑中」翻到「等待 / 出错」时，**第一次采样先不信，等下一次确认**；进程确实没了、钩子报 dead 的不防抖。纯函数，好测 |
| 同文件 `:160-168` 注释 | `SeedLiveStatusPrior()` | 长驻进程每轮重载时要带上上一轮的判断，否则防抖失效、一帧误读就推一次「等你」（作者 2026-09-23 审计发现的真问题） |
| `internal/session/wait_timer.go:1-40`（文件头） | `WaitTimer` | 「等了多久」从**第一次看到这个提问**算起；提问内容变了、离开等待状态就重新计时 |

**能不能借**：MIT，可以拷。
**怎么复用**：P0-4 的「等你」判定和 P1-7「车进入等你」推送都先过 `debounceFlipFromRunning` 这一道，否则长时间工具调用会被误报。等待时长按 `wait_timer` 的口径算。**不借**的是 `wait_timer` 的「超时自动选推荐项」——那是替人拍板，和 PRD「界面不替人做决定」冲突。

### 5.3 只借思路的

- `Claude-Code-Agent-Monitor@ee72edaf:client/src/lib/event-grouping.ts:334` `statusFromEventType()`（MIT，可借）：用钩子事件类型判状态，未知类型落到 `waiting`。注意它把「工具返回」也算 `waiting`，和我们的「等人」不是一个意思，借映射表要改名。
- `smtg-ai/claude-squad@070eb938:session/tmux/tmux.go:206-266` `HasUpdated()`（AGPL-3.0，**只借思路**）：对终端输出取哈希，和上一帧比判断有没有在动；再在输出里找几句固定的权限提示文字判断「在等批准」。思路：没有钩子的智能体也能靠「输出不动 + 出现提示」判等你，但要配 5.2 的防抖。

---

## 6. 用量 / 额度视图（PRD P0-5、P1-3）

### 6.1 Claude-Code-Usage-Monitor —— 官方额度优先，标来源（MIT）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `Claude-Code-Usage-Monitor@c59a83bf:src/claude_monitor/output/official.py:1-12`（文件头） | — | 智能体 CLI 的状态栏输入里带 `rate_limits.{five_hour, seven_day}` 的官方 `used_percentage` 和 `resets_at`；抓下来存一份，读出时标 `confidence="official"`，而不是本地估算 |
| 同文件 `:50` | `_clean_pct()` | 不是数、NaN、负数 → 丢掉；略超 100（≤101）→ 记 100；远超 100（把时间戳误当百分比的已知 bug）→ 丢掉，**宁可显示未知也不显示假的 100%** |
| 同文件 `:68` | `_window()` | 当前时间过了 `resets_at` → 这一窗的百分比作废（置空） |
| 同文件 `:80` | `read_official_limits()` | 返回 `{five_hour, seven_day, captured_at_epoch, stale}`；抓取时间超过 TTL → `stale: true` |
| `src/claude_monitor/core/p90_calculator.py:31` | `_calculate_p90_from_blocks()` | 拿不到官方上限时，用历史已结束的 5 小时块里「接近常见上限」的那些取 P90 当估计上限 |

**能不能借**：MIT，可以拷。
**怎么复用**：P0-5 每个额度池的 `provenance: official|estimate|unknown`（PRD §7）直接照这个分：有官方 → official；只能靠日志推 → estimate（P90 / 6.3 的块）；都没有 → unknown。`_clean_pct` + `_window` 原样搬进额度适配器。本仓 `terminal/usage.js` 已经有 `fetchClaudeOAuthUsage()`（`:892`）在拿官方数，缺的是这两道清洗和「过重置即作废 / 超时标 stale」。

### 6.2 agent-deck —— 「为什么是未知」也要说出来（MIT）

| 文件:行 | 类型 / 函数 | 做法 |
|---|---|---|
| `agent-deck@80494e52:internal/statedb/claude_statusline.go:40-66` | `ClaudeStatuslineLimits`、`MarkExpired()` | 存下来的永远是最后一次官方值；**读出时**才按 `resets_at` 标 `expired`，所以存储不改、显示不骗人 |
| `internal/session/account_usage.go:40-72` | `AccountUsage { Known, UnknownReason, HasUpdatedAt, UpdatedAt, FiveHour, SevenDay }` | `Known=false` 时必须带原因：`no_feed`（没接数据源）/ `no_data`（接了还没数据）/ `unreadable`（文件坏了）；注释原话「Never a guess at percentages」 |
| 同文件 `:74` | `AccountUsageStale()` | 从没更新过的一律算过期，不当新鲜数据 |

**怎么复用**：P0-5 额度卡片在「未知」时显示具体原因（三选一），P0-8「数据源分段降级」的「不可达 + 最后成功时间」也用同一套字段。

### 6.3 ccusage —— 5 小时块 + 消耗速度 + 预测（MIT）

| 文件:行 | 函数 | 做法 |
|---|---|---|
| `ccusage@4d7b518f:rust/adapters/claude/src/blocks.rs:20-32` | `SessionBlock` | `start_time, end_time, actual_end_time, is_active, is_gap, token_counts, cost_usd, models, usage_limit_reset_time` |
| 同文件 `:34-85`、`:87` | `identify_session_blocks()`、`starts_fresh_block()` | 按时间排序；块起点向下取整到整点；离块起点超过 5 小时、或两条记录之间空了超过 5 小时 → 开新块，中间插一个「空档块」 |
| `rust/adapters/claude/src/blocks/projection.rs:26` | `calculate_burn_rate()` | 每分钟 token、每小时花费（首尾两条之间的时长做分母） |
| 同文件 `:48` | `project_block_usage()` | 活跃块：当前用量 + 速度 × 剩余分钟 = 预计到块结束的用量 |
| 同文件 `:8`、`:73` | `limit_status()` | 预计 > 上限 → `exceeds`；> 80% → `warning`；否则 `ok` |

**怎么复用**：拿不到官方额度的池（PRD「estimate」）用这套算「这 5 小时块还剩多少、照现在的速度会不会撞上限」；P1-3 每辆车的花费估算用 `calculate_burn_rate` 的口径。块切分规则和官方窗口不一定完全对齐，界面必须标「估算」。

---

## 7. 模块开关 / 插件（PRD P0-7、P1-10）

### 7.1 本仓已有的（优先复用，不重造）

`public/js/plugins-registry.js`：`PLUGIN_GROUPS = ['work', 'monitor']`（`:20`）、`validateManifest()`（`:22`，校验 `{name, version, apiVersion, group, tab, permissions}`）、`BUILTIN_PLUGINS`（`:70`）、`builtinPlugin()`（`:285`）。PRD 的「模块」就是一种插件清单，**不另起一套注册表**。

### 7.2 uptime-kuma —— 一种能力一个文件 + 一行注册（MIT）

| 文件:行 | 做法 |
|---|---|
| `uptime-kuma@b0cd0f1d:server/monitor-types/monitor-type.js:1-33` | 基类 `MonitorType { name; supportsConditions; conditionVariables; async check(monitor, heartbeat, server) }` |
| `server/uptime-kuma-server.ts:56`、`:114-137` | `static monitorTypeList`；启动时每种探活一行 `monitorTypeList["dns"] = new DnsMonitorType()` |
| `server/monitor-types/*.js` | dns / grpc / mqtt / mysql / group … 一种一个文件 |

**怎么复用**：PRD §7「加一个来源 = 加一个适配器文件 + 登记一行」的样板就是这个。指挥舱的数据源适配器（事件 / 车 / 额度 / 探活 / 容灾）各自一个文件、实现同一个接口，在 `plugins-registry.js` 的清单里登记一行。

### 7.3 emdash —— 查不到插件就报错（Apache-2.0）

`emdash@ae7df312:apps/emdash-desktop/src/core/features/agents/api/node/plugin-registry.ts:9-33`：`getPlugin(id)` / `getPluginMetadata(id)` 找不到就 `throw`；`isValidProviderId()` 用「注册表里有没有」判断合法性，不维护第二份白名单。**怎么复用**：模块开关的设置里存了一个已经不存在的模块 id 时，设置页要明确显示「未知模块，已忽略」，不能静默当成「关」。

### 7.4 开关的持久化写法（参考）

- `Claude-Code-Agent-Monitor@ee72edaf:client/src/hooks/useNotifications.ts:192-245` `loadPrefs()`（MIT）：读本地存储，**合并到默认值上**（`{...defaults, ...JSON.parse(raw)}`），解析失败回默认值；总开关默认关。新增一个模块时，老用户的设置里没有这个键，自动取默认值。
- `comet-ml/opik@02a29b86:…/TraceDetailsPanel/treeConfig.ts:6-19`（Apache-2.0）：一个存储键 + 一份默认值表，同一模式。
- PRD P0-7 要求「刷新后保持」且跨设备：存到服务端个人配置（本仓已有个人配置接口），浏览器本地存储只做缓存，合并顺序 = 默认值 ← 服务端 ← 本地未同步的改动。

---

## 8. 甘特 ↔ trace 强绑定

> 负责人原话：「甘特图应该和车的 trace 强绑定，这样人也可以追踪，AI 自己也可以追踪。」

### 8.1 原则

1. **一根条 = 一辆车的 trace**。条不是另画的一套数据，就是 trace 库按时间窗吐出来的那条记录；没进 trace 库的车不出现在甘特上（会出现在「数据源不可达 / 未登记」提示里）。
2. **人和 AI 读同一份 JSON**。界面画的、主控智能体查的、IM 机器人播报的，都是同一个甘特接口的输出（PRD P1-8 快照接口里带上它）。不给 AI 另做一份「摘要版」，防止两边说法不一致。
3. **条上的点只画「事」，不画流水**：派出、里程碑、交付、完成标记、收车、失败、卡住、重派、协调者批注、卡死。每个点带 `source`（这个点是从哪个事实来源读出来的），点不出来源的不画。
4. **所属大事件 = 任务单号**。条按 `issue` 分泳道（PRD §5「事件 = 单」）；没有单号的进「未归类」泳道，明着露出来（PRD P0-2）。`issue` 带 `issue_source`，说明单号是派车时显式登记的，还是事后从文本里认出来的。后者界面要标「推断」（PRD P2-4：猜测不冒充事实）。
5. **点开条 = 看思考链**。条上带 `think.sessions[]`（这辆车每一轮会话的起止），点开后在服务端读对应会话日志、转成 §2.1 的 `NormalizedEntry` 返回；前端拿不到日志文件路径。

### 8.2 数据契约（对齐车 trace 库的 `trace gantt` 输出）

**对齐状态**：车 trace 库那边正在开发，命令 `trace gantt --from FROM --to TO [--compact]` 已经有了，schema 名 `car-trace-gantt/v1`；它说要写的契约文档（`GANTT_CONTRACT.md`）**写本文时还没落盘**。下表按它的实现代码快照（本文提交当天）整理，**待它的契约文档定稿后逐字段核对**；有出入以它的契约为准，本节跟着改。

顶层：

```jsonc
{
  "schema": "car-trace-gantt/v1",
  "generated_at": "ISO 时间",
  "from": "ISO", "to": "ISO",          // 查询窗口
  "n_bars": 12,
  "groups": [ { "issue": "单号 或 _none", "trace_ids": ["…"] } ],   // 泳道 = 大事件
  "bars": [ Bar, … ]
}
```

每根条 `Bar`：

| 字段 | 含义 | 甘特上怎么用 |
|---|---|---|
| `trace_id` | 车的唯一 id | 条的 key |
| `issue`, `issue_source` | 所属大事件单号；单号来源（显式登记 / 推断） | 分泳道；推断的标「推断」 |
| `parent`, `parent_source` | 父车（返工 / 拆分时） | 画条之间的依赖线（frappe `setup_dependencies` 那种） |
| `title` | 车的一句话任务 | 条上文字 |
| `start`, `end`, `end_open` | 起止；`end_open=true` 表示还没结束 | 没结束的条画到「现在」并加虚线尾巴；有预计完成的再画一段预期（frappe `compute_expected_progress` 的画法） |
| `status` | 车状态（见 8.3 映射） | 条的颜色 |
| `verdict`, `plain` | 完成报告的结论、大白话摘要 | 悬停浮层 |
| `model`, `pool`, `effort`, `route` | 模型、额度池、推理强度、派车路线 | 浮层 + 筛选；`pool` 关联 §6 的额度卡片 |
| `points[]`: `{t, kind, label, source}` | 条上的点 | 打点；`kind` 决定图标 |
| `last_event` | 最近一条事件 | 列表视图里的「最近进度」 |
| `think`: `{cmd, sessions[{iter, session_id, start_t, end_t, …}]}` | 思考链入口 | 点开条；`sessions` 每段还可以在条内画成浅色分段（一轮会话一段） |
| `links`: `{task, step, report, prs, branches, boards}` | 任务书、进度、报告、PR、分支、看板 | 浮层里的链接 |

**建议对方在定稿时一起改的 4 处（待对齐）**：

1. `think.sessions[]` 里现在带了宿主机上的日志文件路径。这些路径**只在服务端用**，甘特接口对外（尤其快照接口）应该只给 `session_id`，加一个服务端解析的 `think_url`；路径不出服务端。
2. `points[].kind` 里，协调者批注那一类现在用的是内部角色名，建议改成中性的 `coordinator_note`；`kind` 的取值表写进契约，前端按表画图标，表外的值画成「其他」并在控制台报一次，不静默丢。
3. 加 `eta`（预计完成）和 `eta_source`（来自里程碑估计 / 单上截止日期 / 推算），PRD §6.2 要用。
4. 加 `max_seconds`（派车时登记的时间上限，登记命令里已有这个参数），用于判定 `timeout`（见 8.3）。

### 8.3 状态映射（trace 库 → PRD §6.3 统一状态词表）

| trace 库 `status` | 来源（据实现代码） | PRD 状态 | 说明 |
|---|---|---|---|
| `running` | 最近有写入 | `running` | |
| `stale` | 超过 N 小时没新写入、也没收尾 | `unknown`，原因 = 「N 小时无动静」 | 不猜成「跑中」也不猜成「卡死」；P1-7 可以对它发提醒 |
| `blocked` | 车落了「需要人给信息 / 权限」的信号 | `waiting_human` | 是「等你」，不是技术上卡住 |
| `delivered` | 有完成报告 + 完成标记 | `delivered` | |
| `accepted` | 协调者已收车 | `done` | |
| `failed` | 车落了失败信号 | `failed` | |
| `ended_noflag` | 有报告但没完成标记 | `unknown`，原因 = 「有报告、无完成标记」 | 不当成交付 |
| （无） | — | `queued` | trace 库目前派出即开始，没有排队态；需要的话由派车服务补 |
| （无，建议加） | `end_open` 且 `now − start > max_seconds` | `timeout` | 依赖 8.2 第 4 条 |

这张表应该只存在一份：放在甘特适配器里，列表视图、甘特、节点图、「等你」队列、快照接口都从这里拿状态，不各写一遍。

### 8.4 渲染与交互（落到 §1 的复用）

- 坐标：照 §1.1 `layout()` 的三条约束写一个纯函数：输入甘特 JSON + 容器宽度 + 视图窗口，输出每根条 / 每个点的坐标。
- 空档压缩：一根条内部「两轮会话之间的空白」、整张图里「没有任何车在跑的时段」，照 §1.1 的空闲段压缩思路折成固定宽度的标记（自己重写，见 §1.1 许可证说明）。
- 泳道：按 `groups[]` 分；泳道头显示 §3.1 的「最差状态」+「等你 N」；默认折叠规则照 §3.2，有「等你」或失败的泳道强制展开。
- 点开条：右侧抽屉，上半是条的元信息和 `links`，下半是思考链（§2.1 条目类型，思考块默认折叠）。
- AI 侧：主控智能体回答「这件事现在到哪了」「哪辆车卡着」时，读同一个接口的 `--compact` 输出；回答里引用 `trace_id` 和点的 `t`，人在甘特上能点到同一个位置。

---

## 9. 来源表（commit 钉死）

| 仓库 | commit | 许可证 | 本文用到的块 |
|---|---|---|---|
| langfuse/langfuse | `4afc77978b844de865398c8e4f5af93c4b53e301` | MIT（`ee/` 等目录除外；本文引用的文件都不在这些目录） | 1、3 |
| frappe/gantt | `5c83708d300a99d9142edea0d4d52f421e3a2e68` | MIT | 1 |
| hoangsonww/Claude-Code-Agent-Monitor | `ee72edaf837421f0792b6ac920bc3f712ed86c26` | MIT | 1、2、5、7 |
| makeplane/plane | `da21a8ff8b4b0a1d7bfcca72eb184a13233bb143` | AGPL-3.0（只借思路） | 1 |
| Arize-ai/phoenix | `e783d1dbc4034b735fc700de31a26e0012ee8243` | Elastic License 2.0（只借思路） | 1 |
| BloopAI/vibe-kanban | `3f095f0186f6e68d67143d38b02da2238f6524d8` | Apache-2.0 | 2、5 |
| louislam/uptime-kuma | `b0cd0f1daf708a6c04f074c925a20e0229e80258` | MIT | 3、7 |
| TwiN/gatus | `655e6f0dc0aca8de5b5018e8e521912fffc2c576` | Apache-2.0 | 3、4 |
| comet-ml/opik | `02a29b86abd630e99edb248a2c2b39659170668e` | Apache-2.0 | 3、7 |
| openai/symphony | `be10a1b79df723d6d7612b5651c8522704dafb2e` | Apache-2.0（有 NOTICE） | 4 |
| cyrusagents/cyrus | `4e2e513599fd4774ddcdbb6d6da2bbbde18e3517` | Apache-2.0 | 4 |
| generalaction/emdash | `ae7df31237e3d615a357469800ff6d158dfd11cd` | Apache-2.0 | 4、7 |
| asheshgoplani/agent-deck | `80494e527393b7ead00da30018e6ee7e60e9d7a0` | MIT | 5、6 |
| smtg-ai/claude-squad | `070eb9387cda2be2e64aa1a32ee81be160c457a1` | AGPL-3.0（只借思路） | 5 |
| Maciek-roboblog/Claude-Code-Usage-Monitor | `c59a83bf943f329f0e61f1a29c760353ee1860a5` | MIT | 6 |
| ccusage/ccusage | `4d7b518ff6049c93c132aee87ab9fb7338b2946c` | MIT | 6 |

永久链接格式：`https://github.com/<仓库>/blob/<commit>/<文件>#L<行>`。

**看了但这几块没用上的**：stravu/crystal、ParadevAI/Paradev、mixpeek/amux、upptime/upptime（开单 / 关单逻辑在另一个仓 upptime/uptime-monitor，本次没下载；做法与 §4.3 gatus 同类）。

## 10. 按 PRD 功能编号的速查

| PRD 项 | 主借 | 辅借 / 只借思路 |
|---|---|---|
| P0-1 大事件总览 | §3.1 uptime-kuma `GroupMonitorType.check()` | §3.2 gatus 组头不健康计数 |
| P0-2 车折叠 | §3.2 gatus `initializeCollapsedGroups()` | §3.3 langfuse 建树时汇总；§3.4 opik 搜索保留祖先 |
| P0-3 事件 ↔ 任务系统 | §4.1 symphony `tracker.ex` + `reconcile_issue_state/4` | §4.2 cyrus `IActivitySink`；§4.4 emdash 账号解析失败即拒绝；§4.3 gatus（去重键不照搬） |
| P0-4 等你队列 | §5.1 vibe-kanban `Approvals` | §5.2 agent-deck `debounceFlipFromRunning()`；§5.3 claude-squad（思路） |
| P0-5 额度模块 | §6.1 Usage-Monitor `read_official_limits()` | §6.2 agent-deck `UnknownReason`；§6.3 ccusage 块与预测（估算） |
| P0-6 对话抽屉 | 本仓现有智能体会话 | §2.1 `ChatCollapsedThinking` 思考折叠 |
| P0-7 模块开关 | §7.1 本仓 `plugins-registry.js` | §7.4 `loadPrefs()` 合并默认值；§7.3 emdash 未知 id 报错 |
| P0-8 分段降级 | §6.2 agent-deck `Known / UnknownReason / Stale` | §4.1 symphony「取单失败保持现状 + 记日志」 |
| P0-9 手机竖屏 | §1.1 `layout()`（不出横向滚动） | — |
| P1-1 泳道甘特 | §1.1 langfuse `layout()` + §8 | §1.2 frappe 换算公式与预期进度 |
| P1-3 运行监控 | §2.2 `TranscriptCache.extract()` 增量读 | §6.3 ccusage `calculate_burn_rate()` |
| P1-4 转录尾巴 | §2.1 vibe-kanban `NormalizedEntry` | §2.2 `buildEventTitle()` |
| P1-5 探活 | §7.2 uptime-kuma `MonitorType` | §4.3 gatus 连续失败 / 成功阈值 |
| P1-7 提醒规则 | `Claude-Code-Agent-Monitor@ee72edaf:server/lib/alerts.js:262` `sweepTimeRules()`（无动静 N 分钟、卡在某状态 N 分钟两类定时规则）+ `:111` `fireAlert()`（按规则 × 车做冷却去重，MIT） | §5.2 防抖；§4.3 gatus 阈值 |
| P1-8 快照接口 | §8.2 甘特 JSON 并入快照 | §5.1 `patch_stream()` 快照加增量 |
| P1-10 插件模块 | §7.1 + §7.2 | §7.3 |
