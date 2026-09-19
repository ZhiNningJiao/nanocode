# scripts/ — 脚本目录（登记 + 已迁正本）

> 维护原则：本目录**不复制脚本本体**，只登记「名 / 一句话 / 位置 / 触发方式」。
> 标 ⭐ 的建议后续真迁入仓（见 MIGRATION.md）。来源盘点：`~/code/*.sh`（90 个）+
> `~/codex_work` + `~/code/worker-core/*.sh`（盘点日 2026-09-18）。

## 已迁入本仓的脚本正本（scripts_resume_2241 落地，可执行、显式依赖、凭据零入仓）

| 位置 | 脚本 | 干什么 | 移植要点 |
|---|---|---|---|
| `dispatch/` | pick-free-model.sh | 免费模型探活选模 | `AIGW_KEY_FILE`/`AIGW_BASE` 可配，key 缺失 fail-loud |
| `dispatch/` | pick-worker-model.sh | 三级选模梯（免费→Claude 降级→NEEDSIG） | 全部本机路径 env 化（CODEX_WORK_DIR/WORKER_CORE_DIR 等） |
| `dispatch/` | dispatch-worktree.sh | worktree-per-worker 隔离，出三元组 | `DISPATCH_WORKTREE_ROOT` 必填；无 origin 远端也可用 |
| `gates/` | qa_gate_mechanical.py | 机械验收门（裸断言=打回） | verbatim（本就 stdlib-only 可移植） |
| `board/` | board_upsert.sh / board_plan.py / board_flag_sync.sh / board_env.sh(.example) | 想法板机械流转三件+纯决策芯 | 板坐标改经 `BOARD_ENV_FILE`（默认 `~/.config/nanocode-board.env`）读取，缺失 fail-loud rc=2；坐标/凭据不入仓 |
| `observability/` | start_team2_observable.sh + run_team2_observable.sh | Team2 tmux 启动器 + stream-json 循环 runner | `CODEX_WORK_DIR`/`WORKER_CORE_DIR`/`AKARI_PORT` 可配；去硬编码 HOME |
| `aigw/` | aigw-errors.sh / aigw-free-health.sh | AIGW 排障第一站 / 免费模型探活看板 | `SLACK_TOKEN_FILE`/`AIGW_KEY_FILE`/`AIGW_HEALTH_MODELS` 等显式可配，凭据不入仓 |

**明确未迁**（仍在本机，见 MIGRATION.md 第二批）：akari_dispatch.sh、auto-qa-dispatcher.sh、
feishu-secretary-bridge.sh、史官/交接/复活链（`tools/secretary/` 仅为 0801 逐字节归档，非移植）。
三者各自的「入口 shim 落地方案」（env 化清单 / 耦合点 / 最小改动路径 / 验证命令）已沉淀于
`../SHIM_PLAN.md`（workflow-docs-2258）；shim 落地前不得声称已切换到仓内运行。

## 工作流文档（协议正文，非脚本）

| 文档 | 干什么 |
|---|---|
| `../DISPATCH.md` | 派单唯一入口合同：参数表 / 三条路由 / 信号文件协议 / 失败四分类 / rules32 |
| `../ACCEPTANCE.md` | 完成声明验收法：成熟度五级 / 退回规则 / 独立抽证清单 |
| `../HANDOFF.md` | 秘书交接协议：duty-status 四证 / 上任卸任六步 / 薄指引定位 / 在飞刷新纪律 |
| `../SHIM_PLAN.md` | 三份不迁脚本的 shim 落地方案与切换声明纪律 |
| `../ARCHIVE_AND_HANDOFF_RULES.md` | 归档判据与公开交接规则（T85，含每条规则出处） |
| `../DISPATCH_RESOURCES.md` | 派工资源规则：模型三档/预飞/预算/拆分/背压/空转判据（T86） |

## 调度 / 派单

| 脚本 | 干什么 | 位置 | 触发 |
|---|---|---|---|
| ⭐ akari_dispatch.sh | 派单正门：选池、注入武器库段、起 worker | `~/code/akari_dispatch.sh` | 手动（秘书派车） |
| dispatch-worktree.sh | worktree-per-worker 隔离，出 WORKTREE/BRANCH/BASE_SHA 三元组 | `~/code/worker-core/`（0830 新增） | 改代码类派单前 |
| pick-worker-model.sh | 三级选模梯（免费池→Claude 降级→NEEDSIG） | `~/code/worker-core/` | 派单选模 |
| pick-free-model.sh（新版） | 免费模型探活选模 | `~/code/worker-core/`（⚠~/codex_work/pick_free_model.sh 是旧版勿用） | runner 内/手动 |
| auto-qa-dispatcher.sh | FLAG→自动双审 QA（k3/dsv4 两腿），幂等去重 | `~/code/auto-qa-dispatcher.sh` | cron */5 |
| start-watch.sh | 一键起 4 个无人值守 agent（watchdog tmux） | `~/code/start-watch.sh` | 手动（值守） |

## 循环 runner（worker 承载）

| 脚本 | 干什么 | 位置 |
|---|---|---|
| run_loop_glm.sh | 免费池 opencode 循环 runner（护栏 1-6，XDG 隔离，秒挂熔断） | `~/codex_work/run_loop_glm.sh` |
| run_loop_k3.sh / run_loop.sh / run_loop_sonnet.sh 等 | 各模型 runner 族 | `~/codex_work/` |
| run_loop_team2_opus.sh | Team2 Opus runner（stream-json 可观测） | `~/code/worker-core/` |
| start_team2_observable.sh | Team2 tmux PTY 启动器（防 143） | `~/code/worker-core/run/` |
| watch_template.sh v3 | 监工模板：sed 换 tag 生成 watcher（120s 查旗+停滞 30min 唤秘书） | `~/codex_work/watch_template.sh` |

## 史官 / 唤醒 / 交接

| 脚本 | 干什么 | 位置 | 触发 |
|---|---|---|---|
| ⭐ waker.sh + waker_core.py | 史官：全量巡查+简报注入（v6 三 Enter 提交 codex；预滤） | `~/code/waker.sh` | tmux waker + crontab 自愈 |
| waker-keeper.sh | waker 保险丝 | `~/code/waker-keeper.sh` | cron */5 |
| wake-secretary.sh / .py | HTTP/WS 注入唤醒秘书（sendNow 原子打断） | `~/code/wake-secretary.sh` | waker / 手动 |
| secretary-takeover.sh | 秘书接管（写 HANDOFF 指路+注入接班指令） | `~/code/secretary-takeover.sh` | 手动 / failsafe AUTO |
| handover-failsafe.sh | 秘书猝死自动切最健康池 | `~/code/handover-failsafe.sh` | cron */5 |
| switch-secretary.sh | 三常驻秘书 tab 切换（env+重启史官+ntfy） | `~/code/switch-secretary.sh` | 手动 |
| secretary-watchdog.sh / secretary-patrol.sh | 秘书守卫/巡检 | `~/code/` | cron |

## 飞书 / 想法板

| 脚本 | 干什么 | 位置 |
|---|---|---|
| ⭐ feishu-secretary-bridge.sh | 飞书双向桥（Yuka 私聊→注入，双回执） | `~/code/feishu-secretary-bridge.sh`（systemd --user） |
| board_upsert.sh | 想法板发车钩子（状态七档） | `~/code/board_upsert.sh` |
| board_flag_sync.sh | 旗哨：FLAG/FAILSIG→板机器态 | `~/code/board_flag_sync.sh`（cron） |
| board_env.sh | 板环境/凭据装配 | `~/code/board_env.sh` |

## 速查 / 考古

| 工具 | 干什么 | 位置 |
|---|---|---|
| ⭐ query.py | CodeKG 速查（7 仓 9 万 defs 蒸馏 fts） | `~/codex_work/ckg_race/distill/query.py` |
| ckg-first.sh | 查代码优先壳（先 CodeKG 后 grep） | `~/code/ckg-first-1355/bin/ckg-first.sh` |
| ⭐ memq.sh | memhub 决策/历史考古（dual 检索） | `~/codex_work/memory_pilot/memq.sh` |
| linear_comment.sh / linear_progress.sh / linear_compact.sh / linear_read.sh | Linear 工具族 | `~/.local/bin/`（read: `~/code/worker-core/`） |

## 验收 / 质量门

| 工具 | 干什么 | 位置 |
|---|---|---|
| ⭐ qa_gate_mechanical.py | 机械验收门（裸断言=打回） | `~/code/worker-core/` |
| qa_gate_semantic.py | 语义验收门（证据不支持断言=打回） | `~/codex_work/ragas-gate/`（stdlib-only 手作） |
| rapid_dispatch.sh | 1 分钟级带引用粗调研车 | `~/codex_work/rapid-agent/` |
| receipt_draft.sh / task_draft.sh | GLM53 预嚼回执/任务书草稿（秘书只改签） | `~/codex_work/reporter_template/` |

## 运维杂项（按需）

usage-snap.sh（30min 四池用量快照）/ quota-watchdog.sh（秘书额度探针）/ aigw-errors.sh（AIGW 排障第一站，
Slack DM 摘要）/ aigw-free-health.sh（免费模型探活看板）/ resource-guard.sh / lane-rebuild-watch.sh /
swimlane-auth-poll.sh / nightly：paper-crawl-0700.sh、daily-adjudication-0700.sh、memhub-daily.sh、
ckg_maint_daily.sh、doc_maint_daily.sh（均 `~/code/`，cron 挂载）。
