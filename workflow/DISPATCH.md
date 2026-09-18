# DISPATCH — 派单唯一入口合同（akari_dispatch.sh）

> 本文沉淀派单正门的**合同**（参数 / 路由 / 信号协议 / 失败分类 / 并发规则）。
> 脚本本体不迁入本仓（511 行，深耦合 tmux 会话命名、lane 注册表、任务书模板、
> board 钩子、AIGW key 路径，见 `MIGRATION.md` 第二批与 `SHIM_PLAN.md`）。
> 来源：本机 `akari_dispatch.sh` 头部注释 + `worker-core/DISPATCH_HEADER.md`（只读沉淀）。

## 0. 一句话

派单只有一条命令：`akari_dispatch.sh`（owner 0907 令「派单收敛到本文件一条命令，
绝不直调 run_loop_*」）。akari 优先；仅当 akari 死 / 不承接时按路由规则显式降级，
**绝不静默降级**。

## 1. 参数表

```
akari_dispatch.sh TAG WORKDIR FLAG PROMPTFILE LOG [MODEL] [MAX_SECONDS]
```

| 参数 | 含义 | 备注 |
|---|---|---|
| `TAG` | 任务标签 | 信号文件名后缀（`FLAG_<TAG>` 等），全大写惯例 |
| `WORKDIR` | worker 工作目录 | 必须是 git 仓内路径（非仓面走 run_loop 兜底） |
| `FLAG` | 完成旗绝对路径 | 先 `realpath -m` 归一；派单前必须 `rm` 旧 FLAG |
| `PROMPTFILE` | 任务书路径 | 派单正门自动前置注入武器库段（勿在任务书里重复） |
| `LOG` | 运行日志绝对路径 | 缺省落 `<PATH_CODEX_WORK>/akari_dispatch_<TAG>.log` |
| `MODEL` | 可选模型 | `opus/fable/sonnet/haiku` → claude-tmux 路由；空或非 claude 系 → akari 路由 |
| `MAX_SECONDS` | wall-clock deadline | 默认 10800（3h） |

环境变量（env 化清单，落地 shim 时逐个接 `:?` 必填或默认）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `HOME` | 固定指向 owner home（生产）；shim 化后须 env 化 | 定位 codex_work / akari CLI |
| `CW_DIR_OVERRIDE` | `<PATH_CODEX_WORK>` | 沙箱测试可覆盖 codex_work 根，生产不设 |
| `AKARI_PORT` | `9481` | akari-server 端口 |
| `MAX_CONCURRENT` | `32` | 并发上限（见 §4） |
| `QUOTA_WATCH_TIMEOUT` / `QUOTA_WATCH_INTERVAL` | `600` / `5` | 额度观察窗时长 / 轮询间隔 |
| `WORKER_CLAUDE_CONFIG_DIR` / `WORKER_CLAUDE_EFFORT` | 透传 | claude-tmux 路由的 worker 配置 |
| `RULES32_FABLE_RETRY` | 内部 | 防 Fable 兜底重派回环 |

## 2. 三条路由

### 路由 0：claude-tmux（MODEL ∈ {opus,fable,sonnet,haiku}，先于 akari 判断）

借 akari 健康探活做路由入口（akari 死 = 报错，**不降级**；模型意图不可替换，
硬闸只保留给 claude 系路由）。实际执行经 `start_team2_observable.sh` →
`run_team2_observable.sh` 起 claude CLI 车（tmux 承载）。WORKDIR 全可见，
含未 commit 改动。

### 路由 1：akari（MODEL 空或非 claude 系）

1. 探活：`/api/health` 须 200 且 `ok:true`，否则显式失败（`[AKARI_GATE_FAIL]`
   + FAILSIG + exit 非零；0902 令废止一切自动降级）。
2. `WORKDIR` 无 `.git`（codex_work 等非仓面）→ 显式降级（fail-loud，by design）。
3. 由 LIVE 项目注册表（`GET /api/projects`）按 git common-dir 同源解析 WORKDIR
   所属仓根 → project_id：
   - 命中非 default project → **fleet 路由**：生成 workflow
     `meta.project=<id>` + `meta.base=<WORKDIR 当前分支>`，`parallel([agent()])`
     走 `runFleet(sourceRepo=仓根, baseRef=分支)`——lane 从仓根@分支现场克隆
     （含本地未推 commit；**未 commit 改动不可见**），阻塞直至完成，CLI rc=0
     且 worker 自写 FLAG 时确认完工。
   - 仅命中 default 池（单基仓）→ **single 路由**：单 `agent()` 默认 lane 池。
4. 仓根不在注册表 / 分离 HEAD 无分支名 → 显式降级（FAILSIG + exit 非零）。

**两路由可见性差异（调用方须按需选择）**：fleet lane 只含已 commit 内容；
claude-tmux 直坐 WORKDIR 全可见。需要 lane 隔离走 fleet，需要脏文件可见走 claude-tmux。

### 路由 2：run_loop 兜底（akari 不承接时的 tmux 承载）

akari 死 / 不承接（非仓面等 incident）时走 run_loop 兜底：tmux 承载、大字告警
留痕、绝不静默。与 run_loop_glm.sh 同形参透传。三态终局契约与 akari 路由一致：
rc=0 但 worker 未写 FLAG → `NO_FLAG_FROM_WORKER` FAILSIG，dispatch 层**绝不补旗**；
被 deadline 打死 → `DEADLINE_KILLED`，绝不 touch FLAG。

## 3. 信号文件协议

信号文件一律落 `<PATH_CODEX_WORK>/` 顶层（绝对路径合同，落错 = 调度看不见 = 白干）：

| 信号 | 写者 | 含义 | 消费者动作 |
|---|---|---|---|
| `FLAG_<tag>` | worker | 全部验收项过了才 touch；**待证命题**，先独立验收再谈完成 | 验收人复算抽证 |
| `FAILSIG_<tag>` | runner/dispatch | 失败旗；首行统一落 `CLASS=<四分类之一>`（rules32） | 秘书按分类处理 |
| `NEEDSIG_<tag>` | worker/观察窗 | block 级即时求援（缺信息/权限/凭据/资产），一行说清 | 秘书即时救，解除后 worker 自删 |
| `SPIN_<tag>` | runner | 秒挂熔断空转（连续 3 次快败） | 秘书立即介入 |

**幂等护栏**：派单前 FLAG 已存在 = 任务已完成，exit 0 拒绝重跑烧额度。

**墓碑（tombstone）机制**：失败/中间态信号带细粒度前缀——`FASTFAIL`
（dur<60s）、`KILLED(rc=N)`（rc∈{124,137,143}）、`[BLOCKER]`（其他真失败）、
`DEADLINE_KILLED`。额度观察窗二次失败时 `mv <sig> <sig>.quota_seen_<tag>`
清理墓碑交给 Fable 轮重判。已处理信号统一归档进 `<PATH_CODEX_WORK>/_signals_handled/`
（避免扫描器重复消费；消费方移动而非删除，保留审计）。

## 4. rules32 并发与失败分类（owner 2026-09-18 裁决）

1. **MAX_CONCURRENT=32**：统计 tmux `loop-*` / `akari_wf_*` 在跑数，`>=32` 只
   warn + board 登记「排队」，**绝不阻塞派单**。
2. **失败四分类** `classify_fail`（依据 `workflow/dispatch/DISPATCH_RULES_v0.md` §4），
   FAILSIG 首行统一落 `CLASS=`，供秘书秒分类：

| 分类 | 判据（日志特征） | 秘书动作 |
|---|---|---|
| `QUOTA` | 额度/配额特征（session limit / hit your） | 停重试，换池或 NEEDSIG 等窗口 |
| `NETENV` | 网络/环境特征 | 兜底路径；3 连 KILLED → NEEDSIG |
| `TASKCODE` | `NO_FLAG_FROM_WORKER` / `DEADLINE_KILLED` | 不原样重派，附错误摘要再派或打回 |
| `SIGNAL` | 其他（协议/信号层） | 查 FLAG 绝对路径等协议问题 |

3. **Opus 额度秒败换 Fable 一次**：派单后观察窗（默认 600s）内出现额度特征 →
   同任务书自动换 Fable 席重派一次（复用 claude-tmux 路由，`RULES32_FABLE_RETRY=1`
   防回环）；二次仍额度败 → FAILSIG 保留 + `NEEDSIG_<tag>`，绝不空转。

## 5. 派单成功后的机械登记

三条成功路径（claude-tmux / akari fleet|default / run_loop 兜底）各执行一次
`board_mark_dispatched`：把执行人 + 在跑状态机械写进想法板（best-effort：
板不可达绝不阻塞派单）。watchdog-manifest 自动注册（fleet + claude-tmux 两路由均覆盖）。

## 6. 武器库段（PROMPTFILE 自动前置）

派单正门在任务书前自动注入「开工必读三件」：CodeKG 速查入口、武器库索引、
决策/历史考古入口；另含时间戳纪律、派单铁律、进程红线。正本见本仓
`workflow/dispatch/DISPATCH_HEADER.md`。任务书里**不要**重复这段。
