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

> 本轮（workflow-refresh-1910）核实：第二批脚本**尚未迁入**，上述路径仍是本机运行体；
> 各类实际依赖：waker 依赖 tmux+feishu 桥与 cron 环境；qa_gate_* 依赖 worker-core/
> ragas-gate 本机文件；切换三件依赖 `~/code/secretary-takeover.sh` + secretary-home.env
> （env 留本机，见下节）。搬迁步骤仍按 shim 方案：仓内正本 + 原位置 `exec bash <仓内路径> "$@"`
> shim，cron/任务书路径零改动。**在 shim 落地前，不得声称任何脚本已迁。**

- `waker.sh` + `waker_core.py`（史官本体，workflow 核心）——迁 `workflow/scripts/historian/`
- `qa_gate_mechanical.py`（验收门）——迁 `workflow/scripts/gates/`
- `secretary-takeover.sh` / `switch-secretary.sh` / `handover-failsafe.sh`（交接三件）——迁 `workflow/scripts/handoff/`
- `akari_dispatch.sh` / `pick-worker-model.sh` / `dispatch-worktree.sh`——迁 `workflow/scripts/dispatch/`
- `board_upsert.sh` / `board_flag_sync.sh`（想法板七档）——迁 `workflow/scripts/board/`
- `linear_comment.sh` 族——迁 `workflow/scripts/linear/`（或 upstream nanocode 已有则注册表引用）
- 迁移方式：复制进仓后在原位置留一行 shim（`exec bash <仓内路径> "$@"`）或软链，cron/任务书路径零改动过渡。

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
