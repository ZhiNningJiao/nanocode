# 指挥舱调研：GitHub 高星看板的高频功能

> 配套文档：[COMMAND_CENTER_PRD.md](./COMMAND_CENTER_PRD.md)（产品定义引用本文的功能编号）。
> 采集日期：2026-11-21。star 数、许可证取自 GitHub REST API（`GET /repos/{owner}/{repo}`）当日返回值；
> 「高频功能」取自各仓 README 功能列表；「被要最多」取自 `search/issues?q=repo:X is:issue&sort=reactions-+1` 的前几条。
> 许可证 `NOASSERTION` 表示 GitHub 没识别出标准许可证，需要看仓内 LICENSE 原文。

## 1. 选样方法

用 GitHub 搜索 API 按 star 倒序，分 5 类各搜若干关键词（如 `parallel coding agents`、`llm observability`、
`kanban board`、`gantt chart project management`、`status page uptime monitoring`、`claude code usage monitor`、
`agent orchestration dashboard`、`linear claude code agent issues`），去掉教程、合集、无关仓，留下 27 个：

- A 类：多智能体 / 多会话编码看板（10 个）
- B 类：任务系统驱动的智能体编排（2 个，按任务单自动派智能体）
- C 类：智能体可观测 / 用量（7 个）
- D 类：任务看板 / 甘特（5 个）
- E 类：状态 / 运维看板（4 个）

有 3 个 A 类仓 star 不高（agent-deck、Claude-Code-Agent-Monitor、amux），因为形态和本产品最接近，所以也收进来；
另有 2 个仓已停更或改名（openclaw-mission-control 已归档、crystal 已换成后继产品），功能仍计入，只说明市场上有过这种需求。

## 2. 调研表

功能编号见第 3 节。「任务系统连接」一列回答：有没有和外部任务系统（issue / 工单，如 Linear、Jira、GitHub Issues）双向同步，怎么做的。

| # | 仓库 | 类 | star | 许可证 | 定位（一句话） | 高频功能（README） | issue 里被要最多（👍） | 任务系统连接 |
|---|---|---|---:|---|---|---|---|---|
| 1 | louislam/uptime-kuma | E | 94,720 | MIT | 自托管服务探活 + 状态页 | 多协议探活、20 秒间隔、多个状态页、90+ 种通知渠道 | 对外 API（712）、远程探针（415）、多用户（346）、可调心跳条范围 7/30/90/365 天（303） | 无 |
| 2 | grafana/grafana | E | 78,021 | AGPL-3.0 | 通用可视化 + 告警 | 动态仪表盘、指标/日志探索、可视化告警规则、混合数据源、面板插件 | 告警类前 4 名（1208 / 620 / 534 / 434）、按面板变量（413） | 无（告警发到外部渠道） |
| 3 | makeplane/plane | D | 62,877 | AGPL-3.0 | 开源 Jira / Linear 替代 | 工作项、周期 + 燃尽图、模块、保存视图、分析 | GitLab 集成（113）、Gitea 集成（89）、OIDC（66）、自定义字段（62）、工时（57） | README 未写同步细节；最高票需求就是「接代码托管平台」 |
| 4 | langfuse/langfuse | C | 37,684 | NOASSERTION | 大模型应用可观测平台 | trace、提示词管理、评测、AI 网关、成本/延迟仪表盘、全量 API | Python 3.14 兼容（49）、提示词条件渲染（19）、trace 内嵌媒体预览（19）、MCP 走 SSO（17） | 无 |
| 5 | BloopAI/vibe-kanban | A | 28,760 | Apache-2.0 | 编码智能体的看板 + 工作区 | 看板排单、每单一个工作区（分支 + 终端 + 开发服务器）、diff 行内评论回给智能体、10+ 种智能体、开 PR 合并 | 恢复旧界面（33）、自托管 GitLab（26）、保留看板（15 + 15）、循环模式（14） | 只连代码托管（开 PR）；不同步外部任务单 |
| 6 | openai/symphony | B | 28,111 | Apache-2.0 | 按任务单自动派编码智能体的调度规范 + 参考实现 | 轮询任务系统（默认 30 秒）、按单状态决定派不派、每单隔离工作区、并发上限、每轮先对账 | （仓库 issue 量小，略） | **双向**：任务系统是唯一来源；每轮先「对账」，单进了终态就停掉对应运行并清工作区；写单（改状态、评论、PR 链接）由智能体用宿主机上的凭据完成，智能体子进程拿不到原始凭据；成功可停在「待人审」而非「完成」 |
| 7 | mattermost-community/focalboard | D | 26,561 | NOASSERTION | 自托管 Trello / Notion 替代 | 看板、个人桌面版、个人服务器版 | 编译好的桌面包（110）、手机 App（75）、卡片互相链接（40）、无看板的单页（37） | 无 |
| 8 | comet-ml/opik | C | 23,478 | Apache-2.0 | 大模型 / 智能体 trace 与评测 | 多步智能体完整 trace 树、会话日志、评测、生产监控仪表盘、护栏 | 鉴权（9）、n8n 集成（7） | 无 |
| 9 | wekan/wekan | D | 21,174 | MIT | 自托管看板 | 实时界面、模板、从 Trello / Jira / Linear / GitHub 等几十种格式导入 | （issue 区基本清空） | **单向导入**：一次性把外部任务系统的单导成卡片，之后不回写 |
| 10 | ccusage/ccusage | C | 19,530 | MIT | 编码智能体本地日志的用量 / 花费统计 | 日 / 月 / 会话报表、5 小时计费窗口、按模型拆分、JSON 输出、离线价格表 | 新版本跑不起来（45）、数据源迁移后看不到数据（33）、实时用量不准（16） | 无 |
| 11 | upptime/upptime | E | 17,211 | MIT | 用 GitHub Actions 做探活 + 状态页 | 每 5 分钟探活、响应时间写进 git、状态页 | CI 失败类（36 / 17 / 16）、UDP 探活（14） | **单向写 + 自动关**：服务挂了自动开 issue 当事故单，恢复后自动关单 |
| 12 | ParadevAI/Paradev | A | 16,435 | MIT | 多编码智能体并行桌面应用 | 每单一个 worktree、内置 diff / PR、侧栏智能体状态（工作中 / 完成 / 等你）+ 完成提示音、手机 App、定时自动化 | 在 ssh 服务器上用（33）、免登录（23）、一个项目多仓（22）、Linux 支持（16） | **单向读入**：从任务系统的单或 IM 消息一键起工作区 |
| 13 | TwiN/gatus | E | 12,852 | Apache-2.0 | 面向开发者的状态页 + 告警 | 灵活健康条件、几十种告警渠道、指标、徽章、低资源 | 分布式部署（90）、外部端点超时没推送就告警（48）、**全绿时分组自动折叠**（29）、告警分级（24） | **单向写 + 自动关**：告警时在 GitHub / GitLab / Gitea 开 issue，恢复后自动关 |
| 14 | Arize-ai/phoenix | C | 12,366 | NOASSERTION | 大模型 trace 与评测 | OpenTelemetry trace、评测、数据集、实验、Playground、MCP | Bedrock 支持（13）、提示词带文件（13）、**成本表**（10）、鉴权（9） | 无 |
| 15 | smtg-ai/claude-squad | A | 8,843 | AGPL-3.0 | 终端里管理多个编码智能体 | 后台跑任务、一个终端管多个实例、应用前审改动、每单隔离 worktree | 是否停更（16 / 11）、可配 worktree 位置（10） | 无 |
| 16 | Maciek-roboblog/Claude-Code-Usage-Monitor | C | 8,813 | MIT | 编码智能体额度实时监控 | 实时额度进度条、消耗速度、P90 预测、日 / 月视图、数字来源标注（官方 / 本地估算 / 未知） | macOS 黑屏（19）、**周额度和周重置时间**（13）、状态栏（11）、**重置时间不准**（11） | 无 |
| 17 | Helicone/helicone | C | 6,291 | Apache-2.0 | 网关式大模型可观测 | AI 网关、一行接入、会话 trace、成本 / 延迟分析、提示词管理 | 请求打反馈（19）、流式缓存（10）、高层统计（9）、全局搜索（8）、注入告警（8） | 无 |
| 18 | generalaction/emdash | A | 6,288 | Apache-2.0 | 并行编码智能体桌面应用 | 多智能体同跑、每个独立 worktree、从任务系统发单给智能体、diff / CI / 合并、远程 SSH | 远程开发（8）、**等批准时显示专门图标而不是转圈**（4）、看上一轮以来的 diff（4） | **单向读入**：把 Linear / GitHub / Jira / GitLab 等的单发给智能体 |
| 19 | frappe/gantt | D | 6,158 | MIT | 轻量网页甘特库 | 可配视图（时 / 日 / 年）、排除节假日、可配一切 | 高度（11）、加字段列（11）、禁拖拽（10） | 无 |
| 20 | go-vikunja/vikunja | D | 6,125 | AGPL-3.0 | 自托管任务管理 | 列表 / 看板等视图（详见官网功能页） | 自定义字段（18）、预估时间（13）、批量编辑（12）、显示子项目任务（11） | 无 |
| 21 | AgentOps-AI/agentops | C | 5,970 | MIT | 智能体监控 SDK | 会话回放、成本追踪、几十种框架集成 | — | 无 |
| 22 | abhi1693/openclaw-mission-control | A | 4,097 | MIT | 智能体编排仪表盘（已归档） | 管智能体、派任务、多智能体协作 | — | 无 |
| 23 | stravu/crystal | A | 3,129 | MIT | 多会话并行（已由后继产品替代） | worktree 隔离、会话追踪、扩展优先 | — | 无 |
| 24 | asheshgoplani/agent-deck | A | 1,283 | MIT | 编码智能体的终端会话管理器 | 会话分组、搜索、状态、worktree、成本面板 + 额度、手机遥控、MCP / 技能管理 | 终端键位问题（11 / 11）、worktree 支持（9）、自动给会话起名（6） | 无 |
| 25 | hoangsonww/Claude-Code-Agent-Monitor | A | 1,195 | MIT | 本地优先的编码智能体「控制室」 | 统一车队视图（仪表盘 / 会话 / 活动流 / 看板）、完整对话、父子智能体树、成本、插件、告警 / webhook、REST / MCP | 自定义仪表盘布局（1）、看板卡片标题被截断（1） | 无 |
| 26 | cyrusagents/cyrus | B | 909 | Apache-2.0 | 任务系统里的后台编码智能体 | 监听指派给它的单、每单一个 worktree、把智能体活动流写回单、单上下拉选择 / 批准交互 | — | **双向**：读指派给它的单，把活动更新流式写回单，审批也在单上完成 |
| 27 | mixpeek/amux | A | 566 | NOASSERTION | 智能体控制面 | 共享任务板（认领原子化）、智能体互发消息、定时 / 循环、手机遥控、额度用尽后恢复 | — | 自带任务板，不连外部 |

### 2.1 任务系统连接：谁做了、怎么做的

27 个里有 7 个连了外部任务系统，分三种做法：

| 做法 | 代表 | 方向 | 谁写单 | 单被关了怎么办 |
|---|---|---|---|---|
| 任务系统驱动调度 | symphony、cyrus | 双向 | symphony：智能体用宿主机凭据写；cyrus：服务端把活动流写回 | symphony 每轮对账，单进终态就停运行、清工作区 |
| 从单起工作区 | Paradev、emdash | 单向读入 | 不写 | 不处理 |
| 事故自动建单 | upptime、gatus | 单向写 | 服务端写（开单 / 关单） | 恢复后自动关；人手关单不影响探活 |
| 一次性导入 | wekan | 单向导入 | 不写 | 不处理 |

对本产品的启示（PRD §5 照此设计）：

1. **任务系统当唯一来源 + 每轮对账**是最成熟的形态（symphony），能解决「看板和单对不上」的问题。
2. **只写摘要、不写每行日志**：cyrus 把活动流写回单，单很快被刷屏；symphony 把写单的事交给工作流配置，不内置。
   本产品选更克制的做法：只在里程碑写一条评论。
3. **写单的人和干活的人分开**：symphony 已经做到「智能体子进程拿不到原始凭据」；本产品更进一步，智能体完全不写任务系统，
   由同步器统一写，方便限流、去重、审计。
4. **「成功」可以停在「待人审」**（symphony 的 `Human Review`），和本产品「交付待验 ≠ 完成」一致。

## 3. 功能 × 出现次数

按第 2 节的 27 个仓逐个标记（一个仓有这个功能就记 1 次；依据是 README 功能列表或 issue 里的明确需求）。

| 排名 | 编号 | 功能 | 出现次数 / 27 |
|---:|---|---|---:|
| 1 | M | 接多种智能体 / 多种数据源 | 13 |
| 2 | C | 会话转录回放 / 对运行中的会话追问 | 12 |
| 3 | P | 多会话 / 多智能体并行同屏 | 11 |
| 4 | N | 告警 / 通知 / 「需要你」提醒 | 9 |
| 4 | U | 用量 / 花费追踪 | 9 |
| 6 | A | API / 机器可读输出 / MCP | 8 |
| 6 | K | 任务板 / 看板 | 8 |
| 6 | W | 每个任务一个隔离工作区（git worktree / 分支） | 8 |
| 9 | H | 层级分组与折叠（父子任务 / 模块 / 子智能体 / 服务组） | 7 |
| 9 | Y | 连接外部任务系统 / issue（读或写） | 7 |
| 11 | D | 仪表盘 / 分析图表 | 6 |
| 11 | Q | 鉴权 / 多用户 / SSO | 6 |
| 11 | R | 远程 / 手机 / 跨设备 | 6 |
| 11 | T | 时间线 / 甘特 / 燃尽 / trace 树 | 6 |
| 15 | F | 搜索 / 过滤 / 保存视图 | 5 |
| 15 | S | 智能体状态一眼看（工作中 / 完成 / 等你 / 阻塞） | 5 |
| 15 | X | 插件 / 扩展 / 配置可见 | 5 |
| 15 | Z | 定时 / 自动化触发智能体 | 5 |
| 19 | B | diff 审阅 / 开 PR / 合并 | 4 |
| 19 | L | 额度窗口 / 重置时间 / 消耗预测 | 4 |
| 21 | E | 评测（大模型打分 / 数据集） | 3 |
| 21 | G | 状态页 / 事故记录 | 3 |
| 21 | V | 服务探活 / 可用率历史 | 3 |

逐仓标记（可复核）：

| 仓库 | 标记 |
|---|---|
| vibe-kanban | P W K B M C R Z |
| Paradev | P W B S N R Z X M C Y |
| claude-squad | P W B M C |
| emdash | P W B M R S N Y |
| crystal | P W X C |
| agent-deck | P W M S H U L R X F |
| openclaw-mission-control | P K M |
| amux | P K M R Z L S C |
| Claude-Code-Agent-Monitor | P M C H T U K X N A D |
| langfuse | C U D A E Q T |
| opik | C T H U D E Q |
| phoenix | C T E U Q A |
| helicone | C U D A F N |
| agentops | C U M |
| ccusage | U L M A F |
| Claude-Code-Usage-Monitor | U L A N |
| plane | K H T D F Q |
| focalboard | K R H Q |
| wekan | K Y |
| vikunja | K H |
| frappe/gantt | T |
| uptime-kuma | V G N A Q |
| grafana | D N X M F |
| upptime | V G N Y |
| gatus | V G N H A Y |
| symphony | P W M S Z Y |
| cyrus | P W M C Z Y |

## 4. issue 里反复出现的信号（比 README 更能说明用户真要什么）

1. **告警是运维类看板的第一刚需**：grafana 前 4 名高票都是告警；gatus 有「超时没推送就告警」（48）、「告警分级」（24）。
2. **对外 API**：uptime-kuma 第一名（712）。看板的数据要能被别的东西（脚本、机器人、眼镜）读走。
3. **全绿就折叠，出事才展开**：gatus「全绿时分组自动折叠」（29）——和「车折叠在大事件下面」是同一个直觉。
4. **额度的重置时间要准**：Claude-Code-Usage-Monitor「周额度 + 周重置时间」（13）、「重置时间不准」（11）；ccusage「实时用量不准」（16）。
   数字要标明来源（官方 / 估算），这正是 Claude-Code-Usage-Monitor v4 的做法。
5. **手机 / 远程**：focalboard 手机 App（75）、Paradev 在 ssh 服务器上用（33）、emdash 远程开发（8）。
6. **界面别乱改**：vibe-kanban 第一名是「恢复旧界面」（33），第三、四名是「保留看板」（15 + 15）。
   主布局一旦定了要稳，新东西做成可开关的模块。
7. **「等你」要和「在忙」分得清**：emdash「等批准时显示专门图标而不是转圈」（4）；Paradev 侧栏的「等你」状态是招牌功能。
8. **单和代码托管 / 任务系统要连上**：plane 最高票是 GitLab 集成（113），其次 Gitea（89）；vibe-kanban 自托管 GitLab（26）。
