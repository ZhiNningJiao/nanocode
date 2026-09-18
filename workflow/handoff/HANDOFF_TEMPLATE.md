# HANDOFF_SECRETARY.md — 秘书交接活文档（v2 候选稿 · 未生效）

> **用途（owner 2026-08-13 立令）**：秘书交接的唯一正文。两条消费路径：
> ① 正常交接：`secretary-takeover.sh` 上任令注入时指向本文档；
> ② **史官兜底强制交接**：当值秘书猝死（额度／登录态／心跳三证）且无人接手时，
>    `handover-failsafe.sh`（cron */5）自动 `secretary-takeover.sh AUTO` 切最健康池，
>    新秘书第一动作读本文档。
>
> **本文件只答一个问题：「现在在飞什么、下一步等谁」。**
> 规则（派单／验收／汇报／红线／工具）一律不在这里重复——去
> `~/.claude/projects/-jfs-home-zhiningjiao/memory/CURRENT_WORKFLOW.md`（v2 候选：
> `~/code/workflow-docs-tidy-1335/candidates/CURRENT_WORKFLOW.v2.md`）。
> 历史班次流水已迁 `HANDOFF_ARCHIVE_20260918.md`（逐字保留），更早的在 `HANDOFF_ARCHIVE.md`。

---

## 刷新纪律（当值秘书义务）

- 每次向 owner 飞书汇报节奏时**同步刷新**下面「在飞状态」；重大状态变化（新 loop／新 NEEDSIG／
  owner 新决策）随手更新。**宁频勿旧——你猝死时这份文档就是继任者的全部记忆。**
- **只保留当前一屏**：交班时把上一班的在飞段整段移入 `HANDOFF_ARCHIVE_<日期>.md`（逐字搬，不删），
  本文件永远只有「最新一屏 + 模板」。历史堆叠是本次瘦身要治的病，别再往回堆。
- 时间戳只取 `date '+%F %T'` 或日志，禁估算凑整。owner 决策一律同日追加进
  **Linear MES-15907（决策台账，唯一权威）**，本文件只引用台账行日期，不复制决策正文。
- 本文件与工作流 v2 冲突时：**规则以工作流为准，在飞事实以本文件为准**。

---

## 在飞状态（模板 · 交班时整段覆盖）

> 最后刷新：`<YYYY-MM-DD HH:MM CST> by <席位>@<sessionId 前 8 位>`

**A. 我是谁 / 通信**
- duty-status：`<T1|T2|T3|T4|CODEX>@<id>`；`secretary-takeover.sh --verify` 四处（env／cron／bridge／duty）是否一致：`<OK|差异>`
- 飞书到岗回执 message_id：`<om_...>`（bot 署名【秘书<TEAM>】）

**B. 在跑车（每辆一行）**

| tag | 池/模型 | 发车时间 | 窗口 | 真实日志（mtime） | TASK / REPORT / FLAG | 工区·分支 | 下一步等谁 |
|---|---|---|---|---|---|---|---|
| `<tag>` | `<T2 Opus / 免费 GLM53…>` | `<HH:MM>` | `<秒>` | `loop_*.log <HH:MM>` | `TASK_<tag>.md` / `REPORT_<tag>.md` / `FLAG_<tag>` | `<路径>@`<分支>` | `<owner/worker/秘书>` |

**C. 待验 / 待处置信号**
- FLAG：`<名单 + 是否已 LOOP_DONE>`（未 LOOP_DONE 不改名，防复活重跑）
- NEEDSIG：`<名单 + 缺什么>`（block 级，即时处理）
- FAILSIG / SPIN / BLOCKED：`<名单 + 已分诊结论>`（旧熔断墓碑要标明「非本轮失败」）

**D. 已验收 / 已交付（附证据位置）**
- `<tag>`：结论 `<PASS/REQUEST_CHANGES>`，证据 `<ACCEPT_*.md / run.log / 链接>`，是否已告知 owner `<回执 id>`

**E. 候 owner / 候外部**
- 候 owner 裁决：`<一句话 + A/B 选项 + 秘书推荐>`
- 候外部：`<人名/团队 + 事项 + 已催时间>`

**F. 池况 / 哨面**
- 池读数（取数时间）：`<T1/T2/T3/T4 + 重置时间>`；临期池 = `<哪个>`
- 现役哨兵 / cron：`<名单>`；已退役：`<名单>`（退役的不重启）

**G. 明确不要做的事（本班约束）**
- `<例：不杀在飞车／不自动部署／不恢复逐小时推送／某 PR 永不合>`

---

## 接班第一动作

按 `CURRENT_WORKFLOW.v2.md` §1「接班 10 步」执行（duty-status → MES-15907 台账 → 工作流 v2 →
本文件在飞状态 + work-log 最近 5 条 → 扫信号 → 扫在跑车 → 池况 → 设巡检 → 飞书到岗 → 三问自测）。
**本文件不再复制那 10 步**，避免两处走样。
