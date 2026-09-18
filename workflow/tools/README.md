# workflow/tools/ — taskid-trace（按 task id 追日志 + 抓资产）

> Owner 2026-09-18 原话：「通过 task id 去追查 log，抓资产的东西，也沉淀在我的 nanocode 里。」
> 入口：`./taskid-trace.sh <TASK_ID> [--env prod|staging] [--since 24h] [--assets]`
> 一条命令 = ①task 摘要（phase/status/parent/args 的白名单字段）②Loki 三段日志拉取落盘
> ③可选 `--assets` 下载 `output/` 到独立新目录 ④生成 `TIMELINE.md`。
> 产物目录默认 `/tmp/taskid-trace/<TASK_ID>-<时间戳>/`（`TASKID_TRACE_OUT` 可改）。

## 前置条件

1. **prod（默认）**：官方 CLI `msctl` + 已登录的 auth 目录。
   - `MSCTL_BIN`（默认 `/jfs/home/zhiningjiao/code/task-asset-fetch-0918/bin/msctl`）
   - `MSCTL_AUTH_DIR`（默认 `.../task-asset-fetch-0918/auth-prod`，**目录本体不上仓**；
     仅 msctl 子进程读它，本工具不读、不提取凭据）
   - 兼容上游 `task_asset_msctl.py` 契约：`--config-dir` 必须绝对路径、显式 profile。
2. **staging（scripts_resume_2241 统一入口）**：与 prod **同一条 msctl 适配链**，
   仅 profile 不同——`MSCTL_AUTH_DIR` 里的 `config.toml` 同时携带
   `[profiles.prod]` 与 `[profiles.stg]`，既有 msctl 会话直接复用
   （`--profile stg`，profile 名可用 `MSCTL_STG_PROFILE` 覆盖）。
   **不再要求 `MESHY_TASK_TOKEN`**；绝不导出浏览器 token、绝不索要新登录。
   （实测：伪 task id 经 stg profile 返回 404 "Task not found" = 已认证可达，
   非鉴权失败。）`lib/task_asset_fetch.py` 保留：它是 `task_asset_msctl.py` 的
   import 依赖，也可作直连 web/v2 API 的独立客户端。
3. **Loki（fix_1615 起）**：默认走 **AIGW MCP 传输**（与本机
   `code/bin/loki_mcp_query.sh` 同一真实接口：initialize → initialized →
   `tools/call Grafana_Cloud_SRE-query_loki_logs`，datasource `grafanacloud-logs`）。
   **AIGW key 是硬前置**，只从以下位置读取（按序，绝不打印/拷贝/落日志）：
   1. env `AIGW_KEY`
   2. env `AIGW_KEY_FILE` 指向的文件
   3. `~/.config/meshy-aigw.key`（默认路径）
   key 缺失/401 → fail-loud `{"state":"missing_credentials"|"auth"}` rc=2，
   不静默、不猜凭据。
   仅当显式设 `LOKI_URL` 时改走集群内 Loki HTTP API（可选 `LOKI_TOKEN`）。
4. 依赖：Python 3.10+（stdlib only）、bash、coreutils。无第三方包。

## lib/ 说明（源码副本 policy）

- `lib/task_asset_fetch.py`、`lib/task_asset_msctl.py`：**verbatim 源码副本**，
  上游 `/jfs/home/zhiningjiao/code/task-asset-fetch-0918/`，文件头保留 provenance
  注释（上游路径 + 拷贝日期 + 上游 sha256）。上游更新时重拷并更新头部 sha。
- `lib/loki.py`：AIGW MCP 传输实现（行为对齐本机 `bin/loki_mcp_query.sh`）。
  ⚠ 任务书原定 verbatim 迁移 `~/codex_work/retab/loki.py`——该文件在本机不可达
  （两轮全盘搜索确认，fix_1615 报告有据），verbatim+sha256 硬门本轮无法满足，
  以接口等价实现顶替；原版可达后请以其副本替换并核对 sha256。
- 不入库：msctl 二进制、auth-prod 目录、任何 token/config/key。

## --assets 解析（fix_1615）

`msctl tasks ls <task>/output/` 的真实行格式是
`2026-09-17 08:55:31    4454524 Character_output.fbx`
（行首是**时间戳+大小**，不是 `output/` 前缀）。解析按「末列名字」取 key 再加
`output/` 前缀。listing 子进程 stderr 落 `assets-listing.stderr` 且不吞；
returncode 非零 → `{"state":"listing_failed","rc":N}` 退出非零（fail-loud）；
listing 成功但零 key → `{"state":"no_keys"}` 退出 0（与失败可区分）。

## 干跑记录

- 2026-09-18（1410 轮）：prod info-only `01a0ae93-…` 成功（见
  `REPORT_taskid_tools_nanocode_1410.md`）。
- 2026-09-18（fix_1615 轮）：--assets 真拉 ≥1 件、loki 失败 fail-loud JSON、
  反例 N1-N4，见 `REPORT_taskid_tools_fix_1615.md` 干跑节（以日志 grep 计数为准）。
