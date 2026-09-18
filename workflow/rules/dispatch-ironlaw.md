# 派单铁律：有活即派 + 空转四分类

来源：owner 2026-09-18（秘书派单铁律）+ `~/code/dispatch-resource-rules-1340/DISPATCH_RULES_v0.md`（T86）。

## 有活即派
- 有活即派、GLM 疯狂并行、活不落地；免费 GLM 并发不设死限，按机器 load 调度不按进程数死卡。
- worker 收工报告末尾必须列「下一段可续派的活」≥1 条（或写明为何到此为止），让秘书秒续派。
- 派单姿势：worker loop 一律 tmux new-session 承载，绝不 setsid 直发（秘书进程重启会整体收割）。

## 路由决策树
- 算法攻坚/硬数学 → Opus（Team2，同一时刻 ≤2 台）；工具/批量小活 → GLM（akari fleet）；
- Opus 限额秒败 → 可拆则拆小换 GLM，不可拆 → Fable 兜底；仍限额 → NEEDSIG 等窗口，不空转。
- GLM 连续多轮打回的硬骨头才升级，升级前报 owner。

## 失败四分类（禁止原样重派）
| 类 | 特征 | 动作 |
|---|---|---|
| A 额度/配额 | session limit / 429 / <60s 连发 | 停重试，换池或 NEEDSIG 等窗口 |
| B 网络/环境 | 探活失败 / KILLED(124,137,143) | 兜底路径；3 连 KILLED → NEEDSIG |
| C 代码/任务错误 | dur 长 rc=0 无 FLAG | 不原样重派：last error 摘要附进新任务书再派，或打回 owner |
| D 信号/协议 | rc=0 未 touch FLAG | 查 FLAG 绝对路径；dispatch 层绝不补旗 |

空转判定：同 tag ≥3 次 FASTFAIL 同错误文本，或 2 轮 retry stderr 逐字相同 → touch SPIN_<tag> 停 loop。

## 预算默认值
GLM 5400s（可多车同发）／Opus 14400s（≤2 台）／Fable 10800s／run_loop 兜底 3600s。
