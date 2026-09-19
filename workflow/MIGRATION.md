# MIGRATION — 实体迁移建议（哪些真迁进仓、哪些留本机）

> 草案分支 `zhining/workflow-corpus-0918`，不合 main；由秘书按顺序搬运。
> 原则：**规则/模板/索引=迁；凭据/日志/大产物=留本机**。

## 第一批（高价值低风险，本分支已承载草案）

| 实体 | 现位置 | 去向 |
|---|---|---|
| 规则一页集（红线/时间戳/scope/派单铁律/Linear/验收/汇报/归档） | memory + worker-core 散落 | 本仓 `workflow/rules/` ✅草案已落 |
| 派单模板 + DISPATCH_HEADER + QA/PREFLIGHT 模板 | worker-core / dispatch-resource-rules-1340 | 本仓 `workflow/dispatch/` ✅ |
| HANDOFF 模板 + 交接协议 | workflow-docs-tidy-1335/candidates | 本仓 `workflow/handoff/` ✅ |
| Astra 复盘 + 脚本化清单 | astra-retro-rootcause-1335 | 本仓 `workflow/retro/` ✅（全文仍指源文件） |
| CURRENT_WORKFLOW.v2（重排版，不新增规则） | workflow-docs-tidy-1335/candidates | 第二批：待 owner 批 v2 生效后迁 `workflow/workflow-v2.md` |
| 甘特派单板数据关系（akari lens `zhining/akari-gantt-mvp-0918`@`1d029e820` 候选） | REPORT_gantt_ui_r3_1620.md + 双腿 QA | 本仓 `workflow/gantt-map.md` ✅（只沉淀数据关系文档，**不搬 lens UI/dist 进 nanocode**） |

## 第二批（应真迁进仓的脚本）

> **2026-09-18 scripts_resume_2241 进度**：qa_gate_mechanical.py（gates/）、
> pick-free-model.sh / pick-worker-model.sh / dispatch-worktree.sh（dispatch/）、
> board_upsert.sh / board_plan.py / board_flag_sync.sh + board_env.sh（board/）、
> start/run_team2_observable.sh（observability/）、aigw-errors.sh / aigw-free-health.sh
> （aigw/）已迁入 `workflow/scripts/`（env 化可移植配置，凭据/板坐标留本机
> `~/.config/nanocode-board.env`，模板见 board_env.sh.example；shim 未建，
> cron/任务书仍指本机原位，见「迁移方式」）。详见 `scripts/INDEX.md`「已迁入本仓」节。
>
> **仍未迁**（本机运行体，依赖重/含现场配置，逐类记录）：
> - `akari_dispatch.sh`（511 行）：深耦合 tmux 会话命名、lane 注册表、任务书模板、
>   board 钩子、AIGW key 路径——需独立一轮按 env 化改造后迁。
> - `auto-qa-dispatcher.sh`（358 行）：依赖 worker-core runner 族与本机 QA worktree 约定。
> - `feishu-secretary-bridge.sh`（445 行）：**现场秘书配置**（chat 白名单/tmux 注入/
>   systemd unit），owner 令禁止拷贝 live secretary config——不迁。
>
> **2026-09-18 workflow-docs-2258 更新**：三份脚本的「入口 shim 落地方案」（env 化清单/
> 耦合点/最小改动路径/验证命令）已沉淀为本仓 `workflow/SHIM_PLAN.md`；派单合同/验收法/
> 交接协议正文沉淀为 `workflow/DISPATCH.md` / `workflow/ACCEPTANCE.md` /
> `workflow/HANDOFF.md`（纯文档，脚本本体仍未迁）。**shim 落地前，不得声称任何脚本
> 已切换到仓内运行。**
> - 史官链 waker.sh/waker_core.py、secretary-takeover 三件：同上（`tools/secretary/`
>   仅为 2026-08-01 归档，不是移植；现场版更动过，以本机为准）。
> - linear_comment.sh 族、CodeKG/memq 速查：跨机依赖本机索引资产，登记即可。
>
> 其余各类实际依赖：waker 依赖 tmux+feishu 桥与 cron 环境；qa_gate 依赖已解除
> （stdlib-only，已迁）；切换三件依赖 `~/code/secretary-takeover.sh` + secretary-home.env
> （env 留本机，见下节）。搬迁步骤仍按 shim 方案：仓内正本 + 原位置 `exec bash <仓内路径> "$@"
> shim，cron/任务书路径零改动。**在 shim 落地前，不得声称任何脚本已切换到仓内运行。**

## 留本机（绝不进仓）

- **凭据**：`~/.config/linear-api.key`、`meshy-aigw.key`、`onestop-dev-auth.env`、`secretary-home.env`、飞书 chat_id/sender 白名单——env 文件形态，仓内只留 `*.example`。
- **运行时状态**：`~/codex_work/` 全部（TASK/REPORT/FLAG/FAILSIG/run.log 共 4000+ 文件=过程产物）；`waker.log`、`usage_snap.log`、`duty-status.json`。
- **私人记忆**：`~/.claude/projects/.../memory/`（含项目事实/沟通偏好，搬走=上下文税搬家；仓内 rules/ 已提炼可公开部分）。
- **大产物窝**：`~/code/qatool/output`、gold 资产、viewer web 资源。

## 建议顺序

1. 本分支草案落盘（本 commit）→ owner 过目 README 10 分钟读完 → 批准方向。
2. 第二批脚本迁移（一 PR 一类，shim 过渡，cron 不动）。
3. CURRENT_WORKFLOW v2 生效裁决（DIFF 冲突项 owner 拍板）→ 迁 v2 正文，memory 原件改为指路行。
4. 想法板板头 + HANDOFF 头部挂本仓链接（ARCHIVE_RULES v1 第 9 条落点）。

## 状态更新（2026-09-19 rules-docs-1256）

- 规则沉淀新增：`workflow/ARCHIVE_AND_HANDOFF_RULES.md`（T85 归档/交接规则，
  ARCHIVE_RULES v1 完整版）与 `workflow/DISPATCH_RESOURCES.md`（T86 派工资源规则，
  仅记录规则，未改路由器）。均为纯文档；脚本状态不变，shim 仍未落地。
- HANDOFF.md 顶部已加指向归档规则文档的一行（v1 第 9 条落点之一）；
  板头链接仍待 owner/秘书在板侧挂（不在本仓改动范围）。
