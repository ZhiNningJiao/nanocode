# SHIM_PLAN — 三份不迁脚本的入口 shim 落地方案

> 三份脚本因深耦合/含现场配置**不迁本体**（`MIGRATION.md` 第二批），改为「仓内正本 +
> 原位置薄壳转发」或「env 化改造后迁」的路线。本文给每份一份 shim 落地方案。
>
> **铁令：shim 落地（并在生产原位置验证转发成功）之前，不得声称任何脚本已切换到
> 仓内运行。** cron/任务书/肌肉记忆仍指本机原路径期间，切换状态 = 未切换。

## 0. 通用 shim 形状

原位置放 3 行薄壳，cron/调用方路径零改动：

```bash
#!/usr/bin/env bash
exec bash <REPO_PATH>/workflow/scripts/<name>.sh "$@"
```

`<REPO_PATH>` 为仓检出位置（env 化：`NANO_REPO_ROOT`，默认由
`NANO_REPO_ROOT_FILE` 或装配 env 提供）。仓内正本自身再做 env 化改造
（HOME / codex_work / key 路径全部走变量，缺必填即 fail-loud exit 非零，
绝不静默回落本机路径）。验证基线：shim 前后对同一次 dry-run 输出 diff=0。

## 1. akari_dispatch.sh（511 行，派单正门）

**现状耦合点**：`HOME` 硬编码指向 owner home（定位 codex_work 与 akari CLI）；
tmux 会话命名约定（`akari_wf_*`）；akari 项目注册表 live API 依赖；
`DISPATCH_HEADER.md` / 任务书模板 / watchdog-manifest 注册的路径；
board 钩子（`board_mark_dispatched`）与 AIGW key 路径。

**env 化清单**：

| 变量 | 现值 | 说明 |
|---|---|---|
| `CW_DIR_OVERRIDE` | `<PATH_CODEX_WORK>` | 已支持，shim 后默认从装配 env 读 |
| `AKARI_PORT` | `9481` | 已支持 |
| `AKARI_CLI` | `<PATH_HOME>/code/akari/packages/dispatch/src/cli.ts` | 需新增 env |
| `DISPATCH_HEADER_FILE` | `<PATH_WORKER_CORE>/DISPATCH_HEADER.md` | 需新增 env（注入段源） |
| `MODEL_ROSTER_FILE` | `<PATH_WORKER_CORE>/MODEL_ROSTER.md` | 需新增 env |
| `BOARD_MARK_CMD` | `<PATH_CODE>/board_upsert.sh` 一类 | 需新增 env，best-effort 调用 |
| `MAX_CONCURRENT` / `QUOTA_WATCH_*` | 32 / 600 / 5 | 已支持 |

**最小改动路径**：本机原件保持生产正位；在仓内 `workflow/scripts/dispatch/`
落一份 env 化正本（diff 控制在「头部 env 装配块 + 全部字面路径换变量」，路由/信号
逻辑零改动）；原位置改薄壳转发；`--dry-run`/观察窗路径用 `CW_DIR_OVERRIDE`
指向 scratch 做一次沙箱派单对照。

**验证命令**：

```bash
CW_DIR_OVERRIDE=$(mktemp -d) bash <REPO_PATH>/workflow/scripts/dispatch/akari_dispatch.sh \
  SHIMSMOKE <PATH_SOME_REPO> /tmp/nonexistent_flag /tmp/pf.txt /tmp/log.txt
# 预期：进 akari gate 判定路径（探活失败 → [AKARI_GATE_FAIL] + FAILSIG_SHIMSMOKE + rc!=0），
# 全程不碰生产 codex_work；对照本机原件同参输出 diff=0（除时间戳/绝对路径前缀）。
```

## 2. auto-qa-dispatcher.sh（358 行，FLAG→双审 QA 自动派发）

**现状耦合点**：扫描根固定 `~/codex_work`；去重状态文件落 `~/code/`（`.auto_qa_*`）；
AIGW key 读 `<PATH_HOME>/.config/meshy-aigw.key`；QA 任务书模板与 worker-core
runner 族路径；两腿模型名取自 `MODEL_ROSTER.md`。

**env 化清单**（部分已支持，标 ✅）：

| 变量 | 现值 |
|---|---|
| `AUTO_QA_CODEX_WORK` ✅ | `<PATH_CODEX_WORK>` |
| `AUTO_QA_STATE_DIR` ✅ | `<PATH_CODE>`（`.auto_qa_*` 去重文件根） |
| `AIGW_KEY_FILE` | 需新增（现内联 `cat ~/.config/meshy-aigw.key`） |
| `WORKER_CORE_DIR` | 需新增（任务书模板/qa_gate 路径） |
| `MODEL_ROSTER_FILE` | 需新增 |
| `LOOPWRAP_BIN` | 需新增（loopwrap 发射器路径） |

**最小改动路径**：仓内正本落 `workflow/scripts/observability/`（或 dispatch/，
按现有 INDEX 分区）；key 读取改为 `AIGW_KEY_FILE`（缺文件 fail-loud）；
原位置薄壳转发；cron 不动（接口不变）。

**验证命令**：

```bash
AUTO_QA_CODEX_WORK=$(mktemp -d) AUTO_QA_STATE_DIR=$(mktemp -d) \
  AIGW_KEY_FILE=/nonexistent \
  bash <REPO_PATH>/workflow/scripts/<subdir>/auto_qa_dispatcher.sh --dry-run
# 预期：空扫描根 → 0 派发、0 崩溃、审计日志可读；key 缺失 → 显式报错非静默。
# 生产对照：本机原件 --dry-run 与 shim 转发 --dry-run 输出 diff=0。
```

## 3. feishu-secretary-bridge.sh（445 行，飞书→秘书强打断桥）

**现状耦合点**：chat/sender 白名单硬编码（现场秘书配置，owner 令禁止拷贝进仓）；
systemd --user 服务形态；`wake-secretary.sh` 与 lark-cli 路径；dedupe 状态目录
（XDG_STATE_HOME 下）。

**env 化清单**（标 ✅ 的已支持）：

| 变量 | 现值 |
|---|---|
| `CHAT_ID` / `SENDER_ID` | 硬编码——必须改 `FEISHU_CHAT_ID` / `FEISHU_SENDER_ID`（缺即 fail-loud 拒起，**绝不给默认值**） |
| `NANO_MATCH` ✅ | 注入目标秘书会话关键字（REQUIRED） |
| `LARK_CLI` ✅ | lark-cli 路径 |
| `WAKE_CMD` / `WAKE_SECRETARY_BIN` ✅ | 唤醒脚本路径 / 测试桩 |
| `XDG_STATE_HOME` ✅ | dedupe 状态根 |
| `MAX_EVENT_AGE_SECONDS` / `MAX_FUTURE_SKEW_SECONDS` ✅ | 1800 / 30 |
| `NTFY_BIN` / `NTFY_URL` ✅ | 外部告警通道 |

**最小改动路径**：仓内正本落 `workflow/scripts/observability/`，仅做「白名单两值
改 env + 其余保持 verbatim」的最小 diff（投递语义/staleness 守卫/dedupe 迁移
逻辑零改动——这些是事故修出来的，不许重写）；凭据以
`feishu_bridge.env.example` 形态入仓，真值留本机；原位置薄壳转发或直接把
systemd unit 的 ExecStart 指向仓内路径（二选一，推荐后者，少一跳）。

**验证命令**：

```bash
# 拒起验证（fail-loud）：
env -i FEISHU_CHAT_ID= FEISHU_SENDER_ID= NANO_MATCH=t \
  bash <REPO_PATH>/workflow/scripts/<subdir>/feishu_secretary_bridge.sh
# 预期：缺白名单立即退出并报缺哪个变量，绝不带默认值起服务。
# 行为等价验证：现有 pytest/自测桩（WAKE_SECRETARY_BIN=/bin/false 桩注入路径）
# 对原件与仓内正本各跑一遍，断言集合 diff=0。
# 切换验证：systemctl --user 状态 active、/proc/<pid>/environ 指向仓内路径，
# 且一条真实投递走通 seen/failed 双回执语义后才可宣布切换。
```

## 4. 切换声明纪律（重申）

- 每份 shim 落地 = ①仓内正本 + env 化 ②原位置转发/服务指向 ③沙箱对照 diff=0
  ④生产原路径一次真实触发成功，四件齐才可把 `MIGRATION.md` 对应行从「未迁」改
  「已切换」，并在 REPORT 附四件证据。
- 任何一件缺失 = 状态停留在「shim 未落地，仍由本机原件承载」，**不得称已切换**。
