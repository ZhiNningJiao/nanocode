# Secretary Toolchain (archived from ~/code/, 2026-08-01)

**归档声明**：本目录是 zhiningjiao 机器（ai-2x4090-02）上 **现场运行中** 的秘书值守工具链的
逐字节归档（md5 已与在线原件核对一致）。脚本内的硬编码路径（`/jfs/home/zhiningjiao/...`）、
tmux session 名、cron 契约一律保持原样——**这是归档不是移植**；要在别的机器跑需先改路径。

## 一、各脚本一句话职责

| 文件 | 职责 |
|---|---|
| `secretary-takeover.sh` | **秘书交接唯一入口**（v5，owner 2026-07-31 令）：单参数（T1/T2/T3/T4/CODEX），原子链改住址 env→cron NANO_MATCH→飞书桥 unit→重启史官→compact 旧秘书→落 duty-status.json→飞书通报→Noa 核验单。 |
| `switch-secretary.sh` | **已废弃薄壳**：与 takeover 功能重叠，参数原样转发到 `secretary-takeover.sh`，仅为旧文档/肌肉记忆保留。 |
| `secretary_resurrect.py` | **秘书梯度复活模块**（v4 两段式）：消费判死信号 `~/codex_work/SECRETARY_DOWN`；stage-1 先发复活单给 Noa（k3-resident tmux 契约，默认 300s 超时），Noa 不接 → stage-2 史官按四池实时用量动态选池自动复活。 |
| `usage-snap.sh` | 每 30min 快照四池（T1~T4）官方用量端点到 `~/codex_work/usage_snap.log`，HTTP 码分诊（AUTH_EXPIRED/API_DOWN），零 LLM 成本——其余组件的选池数据源。 |
| `wake-secretary.sh` | **唤醒注入通道**：对 idle/卡死的当值秘书 session 经 localhost-only `POST /api/sessions/:id/inject` 投一条用户消息，与秘书亲手输入不可区分（经 crontab 触发，抗 --watch 重启）。 |
| `waker.sh` | 史官（waker）bash 入口（保 crontab/tmux 契约），逻辑全委托 `waker_core.py`；默认 DRY-RUN，须 `WAKE_LIVE=1` 才真注入。 |
| `waker_core.py` | **史官核心 V4 全量巡查**：每 tick 对覆盖清单逐任务读 think-chain 尾（loop log / tmux pane）→ 一行判活（分钟数/末态/疑卡标记）→ 汇总简报经 wake-secretary.sh 注入秘书；含 busy-gate / 限频 / 判死产 SECRETARY_DOWN。 |
| `noa-keeper.sh` | Noa 容灾第二层（cron 每 5min）：保 `k3-resident` 与 `noa-bridge` 两个常驻 tmux 活着（pane 进程树级判活），tmux server 全灭也能拉回——秘书复活兜底链，绝对不许删除。 |
| `waker-keeper.sh` | 史官容灾（cron 每 5min）：只在 `waker` tmux 整 session 消失时 ensure 型拉回（绝不 kill 活着的，不与 takeover 的 kill+new 打架）——看门人的看门人。 |
| `quota-watchdog.sh` | 2min 级当值池额度探针（`secretary-home.env` → 当值 token）：5h 或 fable 周池任一 ≥85% → 三路（飞书 Yuka + 注入秘书搬家 + Noa 核验单）；连续 5 次 SNAP_ERR → 飞书警告；15min 冷却。 |
| `noa-patrol.sh` | Noa 保底第二眼（cron 每 10min）：仅当「史官主链哑 + 秘书疑死 + 活还在地上」三条全中才叫醒 Noa 执行复活；宁缺勿滥，30min 连发冷却。 |

## 二、依赖关系图（cron → keeper → 史官 → Noa）

```
crontab（机器级底火，唯一可信心跳）
├── usage-snap.sh        30min ─┐
├── quota-watchdog.sh    2min   │ 数据源：usage_snap.log + duty-status.json（当值池/token）
│                               ↓
│   quota-watchdog ≥85% → 飞书 + 注入秘书搬家 + Noa 核验单 ──────────┐
├── waker-keeper.sh      5min   保 "waker" tmux 在（史官的看门人）    │
├── noa-keeper.sh        5min   保 "k3-resident"/"noa-bridge" tmux 在（Noa 的看门人）
└── noa-patrol.sh        10min  主链哑+秘书疑死+活在地 三全中 → 叫醒 Noa ─┐
                                                                        ▼
waker tmux：waker.sh → waker_core.py（史官 V4 每 tick 全量巡查）      Noa（k3-resident）
   │                                                                    ▲
   ├─ wake-secretary.sh ── 注入唤醒当值秘书（nanocode :9475 inject）      │
   │                                                                    │
   └─ 判死 → ~/codex_work/SECRETARY_DOWN → secretary_resurrect.py ──────┘
                                               stage-1 Noa 接单（≤300s）
                                               stage-2 史官自动梯度复活（usage_snap 选最闲 Fable 池）

秘书切换（人工/授权）：secretary-takeover.sh <T1..CODEX>
   ⑤ 原子写 ~/code/duty-status.json（tmp+rename）——值班状态公共位
     消费者：Noa、史官、quota-watchdog、resurrect、nanocode GET /api/duty（只读镜像）
switch-secretary.sh = 废弃转发壳 → secretary-takeover.sh
```

层级铁则：**cron 是唯一外部心跳；keeper 只 ensure 不 kill；史官=主巡检判死；
Noa=复活执行首选，史官=兜底；一切跨层状态走文件契约（duty-status.json /
SECRETARY_DOWN / usage_snap.log），不走 IPC。**

## 三、duty-status.json 契约

**写入方**：`secretary-takeover.sh` 步骤⑤，`tmp+rename` 原子写 `~/code/duty-status.json`，
写后 `json.load` 回验。**读取方** 必须容忍文件缺失（=值班状态未知，fail-loud，不得臆造）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `team` | string | 当值池：`T1`/`T2`/`T3`/`T4`/`CODEX` |
| `prev_team` | string | 上一班池 |
| `since` | string(ISO) | 本次切换生效时刻 |
| `last_verify` | string(ISO) | 最近核验时刻（写文件时刻） |
| `config_dir` | string | 当值池 `CLAUDE_CONFIG_DIR`（token 所在目录路径） |
| `model` | string | 秘书模型 id，如 `claude-fable-5` |
| `port` | number | 秘书 session 所在 nanocode 端口语义（9475） |
| `tab` | string | nanocode tab 短 id |
| `project` | string | nanocode project UUID |
| `session` | string | Claude session UUID |
| `switched_by` | object `{host, pid}` | 执行切换的机器与进程 |
| `usage_snap` | string | usage-snap.sh 行格式快照：`5h=` `7d=` `fable=` 用量% + `reset5h=`/`resetfb=` 恢复时刻 + `extra=` |

读取示例：nanocode `GET /api/duty`（server/index.js，read-only）→
`{ ok:true, duty:<本文件>, age_seconds:<now-mtime> }`；文件缺失/非法 JSON → HTTP 503 +
`{ ok:false, error }`。
