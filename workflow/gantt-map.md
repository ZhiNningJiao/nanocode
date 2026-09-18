# 甘特派单板 — 数据关系映射（workflow 文档版）

> 来源：REPORT_gantt_ui_r3_1620.md（2026-09-18）+ 双腿 QA（k3/dsv4 均 QA_PASS）。
> 本页把甘特板已实现的**数据关系**沉淀成可读规则；不是把 akari lens UI 搬进 nanocode。

## 已实现候选 vs 当前部署（分离声明）

- **已实现候选**：akari lens 分支 `zhining/akari-gantt-mvp-0918`
  commit `1d029e8203607a6899477ebc791c053d5c25bb1c`（含 r3 可读性轮，733 tests PASS）。
- **当前部署**：9481/9482 服务跑的 `packages/lens/dist`，由秘书 15:39 构建，
  **不含** r3 轮改动。两者不混称；升级部署是独立派单。

## 数据关系（板子每行怎么来的）

| 数据 | 来源 | 规则 |
|---|---|---|
| 发车时刻 start | `akari_dispatch_* / loop_team2_* / loop_*` 日志（三家并集） | 三级阶梯自报出处，不猜 |
| 终态时刻 end | 根目录信号（`FLAG_*`/`FAILSIG_*`/`NEEDSIG_*`）或 `_signals_handled/` 归档墓碑 | `resolveSignalTime()` 单一裁决；根目录信号 > 归档；墓碑终态=文件 mtime（`handled_<epoch>` 是看守狗的表，不解析） |
| 状态 derive | flag / failsig / timeout / running / loading / empty / error | 无终态信号+会话没了才兜底 timeout（归档墓碑优先，防最新车误判） |
| 路由徽标 route | ①派单器 `ROUTE=` 行（权威）→ ②tmux 会话名 → ③日志家族 | 不认得的路由原样打印，不硬塞已知桶 |
| QA 腿 leg | tag `qa_` 前缀 | 只标「这是一条审计腿」并缩进；**不猜**它审谁（避免启发式冒充输入） |
| 窗口 | 6h / 今天（本地 00:00→now）/ 24h | 同名 tag 重发不继承上一轮归档结局 |

## 与 workflow 语义的挂钩

- **end_source 就是终态分类**：`flag` / `flag-archived` / `failsig` / `failsig-archived` /
  `last-activity` —— 与 `rules/verification.md` 的「FLAG 只触发收件、终态三选一
  （结果/阻塞/接替）」一一对应：收件完成的信号=flag 类，接替/超时归位看 end_source。
- **深链**：每行可带 URL 锚（寻址模块 `gantt-link.ts` 专属）；数据口径变更必须
  同步本页表格，禁止板子行为与文档漂移。
