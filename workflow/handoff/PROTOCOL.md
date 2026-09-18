# 交接协议（薄）

模板=本目录 `HANDOFF_TEMPLATE.md`（候选 v2 副本；生效版以秘书实际使用的 HANDOFF_SECRETARY.md 为准）。

要点（来源：v2 候选稿刷新纪律 + handover-failsafe 机制）：
1. 本文件只答「现在在飞什么、下一步等谁」；规则去 workflow/rules/，绝不重复。
2. **宁频勿旧**：每次向 owner 汇报节奏时同步刷新；重大状态随手更新。你猝死时这份文档就是继任者的全部记忆。
3. **只保留当前一屏**：交班时把上一班在飞段整段移入 `HANDOFF_ARCHIVE_<日期>.md`（逐字搬不删）。
4. 时间戳只取 `date '+%F %T'`；owner 决策入 Linear MES-15907 台账，本文只引用日期。
5. 兜底：秘书猝死（额度/登录态/心跳三证）时 `handover-failsafe.sh`（cron */5）自动 `secretary-takeover.sh AUTO` 切最健康池；新秘书第一动作读 HANDOFF。
6. 交接配套：接管手册 `~/code/secretary-takeover.sh`；三常驻秘书 tab 由 `switch-secretary.sh T1|T2|CODEX` 切换（改 secretary-home.env+重启史官+ntfy）。

## 原子切换原则（owner 2026-09-18）

- 秘书是**多 agent 协调中枢**：开发/验证 worker 天然并行；秘书资源允许一主一备，
  但**对外发送者只有一个**（Linear 回写/飞书通知/ntfy 唯一出口，双秘书同时发=重复打扰 owner）。
- **切换顺序必须是原子的**：新任 ready（读完 HANDOFF + 答全在飞线三问）→ 路由/发送权
  提交（switch-secretary.sh 改指针 + 重启桥/史官）→ **然后**旧任退出。禁止先卸任再交接
  导致无人值守窗口。
- **失败保留旧任**：新任接管中途失败（读不懂状态、桥切不动、健康池探测失败）时，
  路由指针回滚、旧任继续在岗；绝不出现「旧的已停、新的没接上」的空档。
- 本节仅为规则模板；当前生产切换脚本与指针不在本仓维护范围。
