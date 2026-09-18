# DISPATCH_RULES_v0 — 派工资源规则（T86，2026-09-18 初版）

原则：GLM 疯狂并行（免费，有活就派）、Opus 攻坚、Fable 兜底；任何失败必须分类处置，禁止原样空转（re-loop 同一输入重跑同一种错误=烧钱不产出）。

## 1. 路由决策树（进入 akari_dispatch.sh 后）

```
活来了（有 TASK + tag）
├─ 算法攻坚/数学硬骨头？ → MODEL=opus（Team2，gpt-5.5 仅限并行/限额替补）
├─ 工具/模板/批量小活？  → MODEL 留空 → GLM（akari fleet/default）
├─ opus 限额秒败（"hit your session limit"）？
│   ├─ 活可拆 → 拆小换 GLM 并行
│   └─ 活不可拆 → Fable(5-1) 兜底；仍限额 → NEEDSIG 等 5h 窗口，不空转
├─ akari 探活失败 → fail-loud FAILSIG + 自动 run_loop_k3 兜底（现状保留）
└─ 仓未注册/分离 HEAD → FAILSIG akari_gate（现状保留），不静默降级
```

## 2. 每车预算默认值

| 车型 | MAX_SECONDS | 备注 |
|---|---|---|
| GLM (akari fleet/default) | 5400 (1.5h) | 并行主力，可多车同发 |
| Opus (claude-tmux) | 14400 (4h) | 攻坚，同一时刻 ≤2 台防烧满 T2 池 |
| Fable | 10800 (3h) | Opus 限额兜底 |
| run_loop 兜底 | 3600 (1h) | incident 才走 |

## 3. 并发背压阈值

- GLM fleet 同仓并行 lane ≤4（超过 lane 抢占反而降吞吐）；全 fleet 在跑 ≤12。
- Opus 在跑 ≤2；出现 2 台同 tag 重试循环立即降 Fable。
- 触顶时新活排队（登记 manifest+board「在跑」），**不派即不算空转**；超过 15min 无空闲 slot 则 NEEDSIG。

## 4. 失败四分类 → 自动动作（依据最近 48h FAILSIG 样本）

| 分类 | 识别特征 | 动作 |
|---|---|---|
| A 额度/配额 | "session limit" / 429 / FASTFAIL dur<60s 连发 | 立即停重试，换池或 NEEDSIG 等窗口重置（FAILSIG_marw1calib/mage/bind_error_impl_0917 全为此类） |
| B 网络/环境 | 探活失败 / timeout / KILLED(rc=124,137,143) | FAILSIG 大字告警+自动兜底路径（现状）；3 连 KILLED → NEEDSIG |
| C 代码/任务错误 | dur 长、rc=0 但 NO_FLAG_FROM_WORKER / DEADLINE_KILLED | **不原样重派**：把 last error 摘要附进新任务书再派，或打回 owner（写 NEEDSIG 选择题） |
| D 信号/协议 | rc=0 但未 touch FLAG / WRONG FLAG 路径 | 查 FLAG 绝对路径；dispatch 层绝不补旗（现状保留） |

## 5. "空转"判定与自动处置

**判定**（满足任一）：同 tag 连续 ≥3 次 FASTFAIL（<60s）且错误文本相同；或 2 轮 retry 输出 stderr 逐字相同（md5 对比）。
**处置**：runner 检测到即 `touch SPIN_<tag>`（run_team2 已有 fastfail-3 机制，推广到 run_loop 与 akari inner）、停 loop、写 FAILSIG 前缀 `SPIN`、dispatch 层把新 prompt 换分类 A/C 对应动作，绝不原样重发。

## 6. 附加铁条

- dispatch 收工必留「下一段可续派的活」≥1 条，秘书秒续派（owner 0918 令）。
- 所有计数/时间以 `date` 与日志 grep 为准，禁止手抄估算。
