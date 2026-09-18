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
2. **staging**：web/v2 管理 API token，经环境变量 `MESHY_TASK_TOKEN`
   （可用 `TASKID_TRACE_TOKEN_ENV` 换名）。凭据只从 env 读，绝不写进仓/日志/报告。
3. **Loki**：`LOKI_URL`、`LOKI_TOKEN`（缺省 URL 为集群内 `loki.monitoring.svc:3100`）。
4. 依赖：Python 3.10+（stdlib only）、bash、coreutils。无第三方包。

## lib/ 说明（源码副本 policy）

- `lib/task_asset_fetch.py`、`lib/task_asset_msctl.py`：**verbatim 源码副本**，
  上游 `/jfs/home/zhiningjiao/code/task-asset-fetch-0918/`，文件头保留 provenance
  注释（上游路径 + 拷贝日期 + 上游 sha256）。上游更新时重拷并更新头部 sha。
- `lib/loki.py`：**临时适配器**（stdlib HTTP range query，三段 selector）。
  任务书原定迁移 `~/codex_work/retab/loki.py`，该文件在本 lane 不可达（NEEDSIG 已打）；
  原 loki.py 可达后请以其副本替换本文件（保持 `query_range()` 入口），并删除本临时版。
- 不入库：msctl 二进制、auth-prod 目录、任何 token/config。

## 干跑记录（2026-09-18）

- prod info-only：`01a0ae93-c6dc-7770-8737-8988db5dfc7c`（本机 auth-prod 凭据），
  结果与失败态见 `REPORT_taskid_tools_nanocode_1410.md` 的干跑节。
