# 交接协议（薄）

模板=本目录 `HANDOFF_TEMPLATE.md`（候选 v2 副本；生效版以秘书实际使用的 HANDOFF_SECRETARY.md 为准）。

要点（来源：v2 候选稿刷新纪律 + handover-failsafe 机制）：
1. 本文件只答「现在在飞什么、下一步等谁」；规则去 workflow/rules/，绝不重复。
2. **宁频勿旧**：每次向 owner 汇报节奏时同步刷新；重大状态随手更新。你猝死时这份文档就是继任者的全部记忆。
3. **只保留当前一屏**：交班时把上一班在飞段整段移入 `HANDOFF_ARCHIVE_<日期>.md`（逐字搬不删）。
4. 时间戳只取 `date '+%F %T'`；owner 决策入 Linear MES-15907 台账，本文只引用日期。
5. 兜底：秘书猝死（额度/登录态/心跳三证）时 `handover-failsafe.sh`（cron */5）自动 `secretary-takeover.sh AUTO` 切最健康池；新秘书第一动作读 HANDOFF。
6. 交接配套：接管手册 `~/code/secretary-takeover.sh`；三常驻秘书 tab 由 `switch-secretary.sh T1|T2|CODEX` 切换（改 secretary-home.env+重启史官+ntfy）。
