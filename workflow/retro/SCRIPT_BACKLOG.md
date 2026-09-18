# SCRIPT_BACKLOG — 应脚本化清单（Astra 0917 班次复盘产物）

> 前置纪律：本清单**先查后立**。已核对 `~/code/worker-core/ARSENAL_INDEX.md`（164 行）、
> `~/code/*.sh`（90 个）、`~/code/worker-core/*.sh`（6 个）、`crontab -l`（38 条有效行）。
> **每条都写明「复用哪个现有脚本」**；标 `新建` 的，已在上述三处 grep 确认无同类。
> 结论前置：**本班次的病不是脚本少（90 个 .sh + 38 条 cron 一直在跑），
> 是没有守卫在看守卫**——`grep -l "UNCONFIRMED" ~/code/*.sh ~/code/worker-core/*.sh` 零命中。
> 所以下面 **S1/S2 是止血，其余是提效**，顺序不要颠倒。

---

## Top 3（可直接派单，一句话 spec 附后）

### S1 — `waker-inject-health.sh`｜优先级 **P0**
- **触发场景**：waker 向 codex 席注入后拿不到提交证据，payload 被隔离丢弃，且无人知情。
  本班次 283 次注入 **279 次 UNCONFIRMED（98.6%）**，最后一次成功 `2026-09-17 15:07:14`
  → 下一次成功 `2026-09-18 13:08:07`，**静默 21h59m**。
- **输入**：`~/codex_work/waker.log` 尾部 N 分钟（默认 30）。
- **输出**：①`/var/tmp/waker_health.json`（窗口内 `LIVE inject rc=0 ok=True` 计数 /
  `inject UNCONFIRMED` 计数 / 确认率 / 最后一次确认的时间戳与距今分钟数）；
  ②确认率 < 50% **或** 距上次确认 > 30 min → **走飞书降级通道**把告警直推 owner
  （飞书通道本班次 `INJECT_OK` 117 / `INJECT_FAIL` 12 = **91% 可用**，是现成的可靠备份路径）。
- **复用现有**：`~/code/waker-keeper.sh`（现 **10 行**，只做进程保活，**不读日志、不判确认率**——
  本脚本是它缺失的另一半，可直接并入或同 cron 位挂载）；降级推送复用
  `~/code/feishu-secretary-bridge.sh` 的现成发送路径；告警落盘沿用
  `~/code/watchdog-monitor.sh` 的纯 bash + cron 形态（不依赖任何模型额度）。
- **预估省时**：直接回收根因 1 的 **~11h/班次**（本班 ≥30min 空档 936min 中 615min 落在
  零确认注入区间）。**全清单投入产出比最高的一条。**

### S2 — `shift-throughput-selfcheck.sh`｜优先级 **P0**
- **触发场景**：班次内出现 ≥30 min 无任何 `FLAG_/FAILSIG_/NEEDSIG_/SPIN_` 落盘时，
  当班秘书自己无感。本班 7 段这样的空档，最长 **268.6 min**，全程无人报警。
- **输入**：`~/codex_work/{FLAG,FAILSIG,NEEDSIG,SPIN}_*` 的 mtime + 当前班次起点
  （取自 `~/codex_work/takeover_history.log` 最后一行 `TAKEOVER … -> <SEAT>`）。
- **输出**：①`/var/tmp/shift_throughput.json`（班次时长 / 信号数 / 信号每小时 /
  当前静默分钟数 / ≥30min 空档累计占比）；②静默 > 30 min → 向当班席位注入
  「你已 N 分钟无产出，请报当前在做什么或立即派车」；③静默 > 90 min → 升级飞书推 owner。
- **复用现有**：`~/code/board_flag_sync.sh`（cron `*/10`，已在扫同一批旗标文件，
  **扫描逻辑直接复用，只加聚合与判阈**）；注入路径复用 waker 现有 inject；
  升级路径复用 S1 的飞书降级通道。
- **预估省时**：把「空档被发现」的延迟从**数小时**压到 **30 min 上限**。
  按本班 756 min 非预期空档、假设半数能被 30min 阈值早期拦截计，**~6h/班次**。

### S3 — `ckg-first.sh`（代码检索强制导流）｜优先级 **P1**
- **触发场景**：秘书/worker 要查代码时直接裸 `grep -r`。本班 1775 次动手中
  **552 次（31.1%）是 grep/find/rg/awk/sed 检索**，`akari_dispatch` 派单仅 44 次（2.5%）。
  ARSENAL_INDEX.md:138-145 已把 CodeKG 定为「查代码第一动作，省 80% token」，
  owner 0831 令「代码考古禁裸 grep 单干」——**规矩在册，执行为零**。
- **输入**：关键词 + 可选仓库名。
- **输出**：先跑 `~/codex_work/ckg_race/distill/query.py text "<kw>" --limit 10`，
  命中则输出 `file:line` 候选并提示「精读原文件核实行号」；
  **零命中或仓库属 webapp 前端（CodeKG 未索引，ARSENAL_INDEX 明载）才回落裸 grep**，
  并在回落时打印一行 `[ckg-miss] 已回落裸检索，原因=<未索引|零命中>`。
- **复用现有**：`~/codex_work/ckg_race/distill/query.py`（**已存在，7 仓 90,108 defs，
  探针 10/10**，不重造）；`~/code/ckg_maint_daily.sh`（cron `17 4 * * *`，索引维护已就绪）。
  本脚本只是一层 **~30 行的 wrapper + 回落策略**，不是新能力。
- **预估省时**：552 次检索 × 估 60% 可替代率（webapp 未索引部分扣除）× 每次省 ~12s
  ≈ **~1.1h/班次**，token 侧收益更大（ARSENAL_INDEX 称省 80%）。

---

## 其余清单（P1–P2）

| # | 名称 | 触发场景 | 输入 → 输出 | 复用现有 | 预估省时 | 优先级 |
|---|---|---|---|---|---|---|
| S4 | `hourly-plan-append.sh` | 班次内每小时该写进度却漏写。`PLAN_hourly_0917.md` 标题写着 hourly，**首条记录在 21:51**，班次前 12.6h（45%）零条目 | 当前小时的信号增量 + 派车增量 + owner 消息数 → 追加一段固定模板到 `PLAN_hourly_<date>.md`，缺口处留 `<待秘书补:在做什么>` 占位 | `~/code/glm-reporter.sh`（已有免费模型写文书能力）；模板可复用 `board_upsert.sh` 的落盘形态 | ~0.5h/班次（真正价值是**让根因 2/4 下次可自证据**） | P1 |
| S5 | `dispatch-contract-lint.sh` | 派单书证据契约不全 → 首轮必被打回。本班返工件 **26/133 = 19.5%**，每主题平均 **5.78 轮**（23 族），最长 `quad_solver` 5 轮 | `TASK_*.md` 路径 → 检查必含：产物绝对路径 / FLAG 路径 / NEEDSIG 兜底 / run.log 契约 / 禁 mock 声明；缺项拒发车 | **`~/code/worker-core/`+`ARSENAL_INDEX.md:91` 的 `qa_gate_mechanical.py` 已做「验收侧」机械门——本脚本是它的「发车侧」镜像**，规则表直接复用，勿另立标准 | 按可预防返工估 ~1.5h/班次（置信度中） | P1 |
| S6 | `seat-channel-probe.sh` | 不知道当前席位的注入链路通不通，只能事后从日志看。本班 codex 席注入链 1.4% 可用而飞书链 91% 可用，**两条链健康度从未被并排量过** | 无 → 对 waker-inject / feishu-bridge / tmux send-keys 三条链各发一次 no-op 探针，输出三元健康表 | `~/code/codex-seat-probe.sh`（**已存在**，扩展其输出即可，不新建）；`~/code/liveness-check.sh` | 切席/接管时省 ~15min 摸黑，且是 S1 的补集 | P1 |
| S7 | `script-fleet-health.sh` | 38 条 cron、90 个 .sh，**没有任何一张表说哪个还在正常产出**。本班 `waker-keeper.sh` 名义在跑（cron `*/5`），实际守护的链路 98.6% 失败 | `crontab -l` + 各脚本约定日志路径 → 输出「脚本 / 最后成功产出时间 / 距今 / 状态」总表，超期标红 | `~/code/watchdog-monitor.sh`（纯 bash + cron 形态，不吃额度）；`~/code/zhining_status.sh`；`~/code/akari-status.sh` | 防下一次「静默 22h」；**这是假设 A 修正后的真正答案** | P1 |
| S8 | `handoff-pack.sh` | 交接时人肉拼班次摘要。本班交接产出 `HANDOFF_20260918_1305_ASTRA_TO_T1.md`（9,604 B）靠手写 | 班次起止 → 自动生成信号表 / 空档表 / 返工表 / 未收口 NEEDSIG 列表 | `~/code/handover-failsafe.sh`（cron `*/5` 已存在）；本次复盘用的 gap 分析逻辑可直接内化 | ~20min/次交接 | P2 |
| S9 | `owner-turn-budget.sh` | 对话回合吃掉派车回合而无感（根因 2）。本班 owner 在线 21h 均 3.90 信号/h vs 静默 6h 均 8.50 信号/h | 滚动 1h 内 owner 消息数 vs 派车数 → 比值失衡（如 owner ≥6 且派车 =0）时提醒秘书「先发车再回话」 | `feishu-secretary-bridge.log` 解析 + S2 的信号计数，**两者都已有** | 估 ~1h/班次，但**机制为推断，建议 S1/S2 落地后再评估是否需要** | P2 |

---

## 可直接派单的一句话 spec（Top 3）

- **S1**：写 `~/code/waker-inject-health.sh`——每 5 分钟读 `~/codex_work/waker.log` 最近 30 分钟，
  统计 `LIVE inject rc=0 ok=True` 与 `inject UNCONFIRMED` 条数算确认率，
  落 `/var/tmp/waker_health.json`；确认率 <50% 或距上次确认 >30min 时，
  复用 `~/code/feishu-secretary-bridge.sh` 的发送路径直推 owner 告警；
  纯 bash、不吃模型额度、挂 crontab `*/5`，并把现有 10 行的 `waker-keeper.sh` 保活逻辑保留不动。

- **S2**：写 `~/code/shift-throughput-selfcheck.sh`——从 `~/codex_work/takeover_history.log`
  末行取当前班次起点，扫 `~/codex_work/{FLAG,FAILSIG,NEEDSIG,SPIN}_*` 的 mtime，
  算班次信号数/每小时/当前静默分钟数并落 `/var/tmp/shift_throughput.json`；
  静默 >30min 向当班席位注入追问、>90min 升级飞书；
  扫描逻辑复用 `~/code/board_flag_sync.sh` 的现成实现，挂 crontab `*/10`。

- **S3**：写 `~/code/ckg-first.sh <关键词> [仓名]`——先调
  `~/codex_work/ckg_race/distill/query.py text "<关键词>" --limit 10` 输出 `file:line` 候选，
  零命中或仓名属 webapp 前端时才回落裸 `grep -rn` 并打印 `[ckg-miss] 原因=<…>`；
  约 30 行 wrapper，不改 query.py，随后把 `ARSENAL_INDEX.md` 与派单书武器库段的
  「查代码先速查」改为点名调用本脚本（**改文档需 owner 批，本车不动**）。

---

## 反例检查（防止本清单本身变成「再造轮子」）

1. **「是不是已经有人做过 S1？」** `grep -l "UNCONFIRMED" ~/code/*.sh ~/code/worker-core/*.sh`
   **零命中**；`waker-keeper.sh` 仅 10 行且无日志解析。**确认无同类。**
2. **「S2 会不会和 `auto-qa-dispatcher.sh`（cron `*/5`）重叠？」** 后者是「有 QA 信号就派验收车」，
   本脚本是「**没有**信号就报警」——互补面，不重叠。
3. **「S3 是不是多此一举，秘书自觉用速查就行？」** 本班实测自觉率 **0/552**，
   且规矩已在册（ARSENAL_INDEX:138-145 + owner 0831 令）仍未执行 → **靠自觉已被证伪**，需要 wrapper。
4. **「S7 会不会变成又一个没人看的看板？」** 这是真实风险。缓解：S7 的输出必须并入
   S1 的飞书告警通道（唯一可靠链路，91%），**不新增任何需要人主动去看的面板**。
5. **本清单不含任何「重写 waker/重构派单系统」的条目**——本班证据支持的是
   「给现有链路加体检」，不支持推倒重来；推倒重来的成本与风险本车未评估，不提议。
