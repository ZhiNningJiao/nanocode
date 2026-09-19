# DISPATCH_RESOURCES — 派工资源规则（T86 沉淀）

> 来源：owner 想法板 T86 原话（2026-09-19 沉淀）+ `akari_dispatch.sh` 头部
> rules32 段 + `workflow/dispatch/DISPATCH_RULES_v0.md` + `worker-core/` 选模脚本。
> **本卡仅记录规则，未改路由器**（T86 原文）；派单合同正文见 `workflow/DISPATCH.md`
> （参数表/三路由/信号协议/rules32 均已沉淀，本文只引用不重复）。

## 1. 模型路由三档

| 档 | 模型 | 用途 |
|---|---|---|
| 主力 | GLM（当前 `litellm/SGLang-GLM-5.3-Flash`，AIGW 免费池） | 常规任务疯狂并行，活不落地 |
| 攻坚 | Opus（Team2 claude-tmux 路由） | 复杂后端/算法/关键决策活 |
| 兜底 | Fable | Opus 额度秒败时同任务书换席重派一次 |

- 免费池内部优先级与动态发现：`workflow/scripts/dispatch/pick-free-model.sh`
  （1-token 预飞探活，谁活用谁，全死 exit 1）。
- 三级选模梯（免费池 → Claude 池降级 → NEEDSIG）：`workflow/scripts/dispatch/pick-worker-model.sh`。
- Opus 额度秒败（"session limit"/"hit your"）→ 换 Fable 席重派一次
  （`RULES32_FABLE_RETRY=1` 防回环）；二次仍败 → FAILSIG + NEEDSIG，绝不空转
  （owner 2026-09-18 rules32 裁决，合同见 `DISPATCH.md` §4）。
- **为什么**：免费池不可靠是常态（owner 2026-08-30 令），认准一个模型拼命调
  会整批假失败（owner 2026-08-28 令）；额度重置窗口不可控，硬等=空转。

## 2. 预飞探活

每次发车前对候选模型发 1-token 实测请求，200 才用；候选全死则动态发现网关上
任何同系免费模型再探；仍全死 → 空输出 + 显式报警，**禁止盲发后靠失败分类学**。
**为什么**：网关上模型随时上下线，不探活的车整批 FASTFAIL 烧额度与工时。

## 3. 上下文与输出预算建议

- 任务书给时间预算的严格照办；没给的，单步超过 15 分钟无产出 = 大概率走错路，
  停下写 NEEDSIG，绝不闷头造。
- 常规 worker 派单 wall-clock 默认 10800s（3h），run_loop 兜底 3600s（见
  `DISPATCH.md` §1 与 `dispatch/DISPATCH_RULES_v0.md` §2）。
- 长任务先 compact 保留上下文再续（不 /clear 全清）；任务书要求
  `2>&1 | tee run.log` 留完整原始输出，验收直接 grep。
- **为什么**：大模型输出/上下文溢出是 FASTFAIL 与截断假交付的主因之一
  （时间戳纪律 2026-09-18 三车连犯后立）；不留 run.log 的声明无法验收。

## 4. 任务拆分

- 小 scope、单仓、可独立验收：一个任务书只打一个目标，写明 FLAG/REPORT 绝对
  路径与验收命令。
- 跨仓/跨模块耦合点抽成 CONTRACT（接口/产物契约）先行，再拆执行任务书；
  产物契约参照仓内三件套交付契约的写法（定义产物 + 定义失败态）。
- 每份任务书自带验收判据（跑什么命令、看什么输出），不靠 worker 自评。
- **为什么**：大杂烩任务书是 NO_FLAG_FROM_WORKER 与 deadline kill 的主来源；
  契约先行使并行车不互相踩。

## 5. 并发背压 32 与排队登记

- `MAX_CONCURRENT=32`：统计 tmux `loop-*` / `akari_wf_*` 在跑数，`>=32` 只
  warn + 板登记「排队」，**绝不阻塞派单**（owner 2026-09-18 裁决）。
- 辅助阈值（`dispatch/DISPATCH_RULES_v0.md` §3）：GLM fleet 同仓并行 lane ≤4，
  全 fleet ≤12；Opus 在跑 ≤2。触顶排队=不派不算空转；超 15min 无 slot → NEEDSIG。
- **为什么**：并发上限是护栏不是闸门——阻塞派单会让活堆积在秘书手里；登记
  排队让吞吐可见、可续派。

## 6. 失败四分类及各自动作

FAILSIG 首行统一落 `CLASS=`，判据与动作表**以 `DISPATCH.md` §4 与
`dispatch/DISPATCH_RULES_v0.md` §4 为准**（此处只存摘要，不重复正文）：

| 分类 | 一句话动作 |
|---|---|
| QUOTA（额度/配额） | 停重试，换池（Opus→Fable）或 NEEDSIG 等窗口 |
| NETENV（网络/环境） | 走兜底路径；3 连 KILLED → NEEDSIG |
| TASKCODE（代码/任务错误） | **不原样重派**：附错误摘要再派或打回 owner |
| SIGNAL（协议/信号层） | 查 FLAG 绝对路径等协议问题；dispatch 层绝不补旗 |

**为什么**：四类失败的最佳动作互斥（额度重试=烧额度，任务错重派=空转）；
统一落 `CLASS=` 让秘书不用读全日志即可秒分类（2026-09-18 复盘 48h FAILSIG
样本归纳）。

## 7. 禁止原样空转：具体判据

**判据（满足任一即算空转，必须介入）**：

1. 同 tag 连续 ≥3 次 FASTFAIL（dur<60s）且错误文本相同；
2. 连续 2 轮 retry 输出 stderr 逐字相同（md5 对比）；
3. worker 连续 2 iter 零产物（无新文件/无 log 增长/未推进任务书目标）。

**介入动作**：runner 检测到即 `touch SPIN_<tag>`、停 loop、FAILSIG 前缀 `SPIN`；
dispatch 层换分类对应动作（QUOTA 换池 / TASKCODE 换任务书），**绝不原样重发
同一 prompt**。
**为什么**：原样重派同样的输入必然得到同样的失败（DISPATCH_RULES_v0 §5
原文）；空转烧掉的是整个车位的 wall-clock 与额度，且挤占 32 并发名额。

## 相关文档

- 派单合同正文（参数/路由/信号协议）：`workflow/DISPATCH.md`
- 派工规则原始草案（四分类详表/背压阈值）：`workflow/dispatch/DISPATCH_RULES_v0.md`
- 选模脚本正本：`workflow/scripts/dispatch/`（登记见 `workflow/scripts/INDEX.md`）
