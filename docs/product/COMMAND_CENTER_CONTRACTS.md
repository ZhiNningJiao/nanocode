# 指挥舱数据契约（第二期：等你 / 额度）

> 三个来源都是**文件**，指挥舱服务端只读。各自缺失 / 损坏只影响自己那一块（PRD P0-8）。
> 路径都写在本地配置 `config/command-center.local.json`（不进 git），样例见 `config/command-center.example.json`。

## 1. 车的「等你」信号 —— 导出文件里的 `waiting` 段

导出脚本 `tools/command-center/export-cars.mjs` 加 `--signals-dir <目录>` 后，在同一个导出文件（`nanocc-cars-export/v1` 信封）里多写一段 `waiting`。不加这个参数时 `waiting` 为 `null`，面板显示「导出脚本没接入等你」。

信号文件约定（都在 `--signals-dir` 目录的顶层）：

| 文件名 | 含义 | 谁在等、等谁 |
|---|---|---|
| `NEEDSIG_<车>` 或 `NEEDSIG_<车><非字母数字的后缀>`（如 `_login`、`.txt`） | 车卡住了，要信息 / 权限 / 凭据 / 资产；文件内容写缺什么 | 车在等，主控来解卡 |
| `FLAG_<车>`（文件名里没有 `.`） | 车交付了，还没验收 | 车在等，主控来收车 |
| `FLAG_<车>.<任意后缀>`（如 `.accepted-2032`） | 已验收 | 不算 |

- `FLAG_*` 只认导出窗口里确实存在的车（trace 编号完全相等）；其他没验收的旗（定时任务等）只计数（`skipped_flags`），不当车显示。车列表拿不到时这一轮不判断旗（`flags_checked:false`）。
- `NEEDSIG_*` 的车按「最长的已知车编号 + 边界」匹配；匹配不上就只显示文件里的标签，不猜挂到哪辆车。
- 每轮只 `readdir` 一次，只对命中的文件 `stat` / 读前 2 KB。

```json
"waiting": {
  "schema": "nanocc-waiting-signals/v1",
  "scanned_at": "2026-01-01T03:00:00.000Z",
  "ok": true,
  "error": null,
  "flags_checked": true,
  "skipped_flags": 12,
  "items": [
    { "kind": "needsig", "tag": "car_a_login", "file": "NEEDSIG_car_a_login", "trace_id": "car_a", "since": "2026-01-01T01:00:00.000Z", "text": "缺什么（≤600 字）" },
    { "kind": "flag", "tag": "car_b", "file": "FLAG_car_b", "trace_id": "car_b", "since": "2026-01-01T02:00:00.000Z", "text": null }
  ]
}
```

- `since` = 文件修改时间。扫描失败时 `ok:false` + `error`，`items` 为空。
- 导出文件整体过期（超过 `carsExport.staleSeconds`）时，等你的车那部分也按「来源不可达」显示。
- 本地配置 `waiting.ignoreTagPrefixes`（字符串数组）可以隐藏某些前缀的车（例如每天跑、旗从不改名的定时任务）；被隐藏的条数会在面板上写明，不静默丢。

## 2. 负责人的待批清单 —— `owner_pending.json`（主控维护）

本地配置 `ownerPending.path` 指向它。**文件不存在 = 面板显示「未接入」**，不是「没有待批」。整份写完再原子替换（写临时文件 + rename），避免读到半个文件。

```json
{
  "schema": "nanocc-owner-pending/v1",
  "updated_at": "2026-01-01T09:30:00+08:00",
  "items": [
    {
      "id": "pr-42-merge",
      "title": "要不要合 PR 42？",
      "summary": "一句话：为什么要你定、定了会怎样。",
      "url": "https://github.example/org/repo/pull/42",
      "since": "2026-01-01T08:10:00+08:00",
      "recommendation": "建议合：风险低，回退就是一次 revert。",
      "options": ["合", "先不合"],
      "waiter": "主控",
      "trace_id": "exporter_retry_0800",
      "deadline": "2026-01-01T18:00:00+08:00"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema` | 是 | 固定 `nanocc-owner-pending/v1`；不对整份按「来源不可达」处理 |
| `updated_at` | 否 | 清单最后更新时间，面板显示「拍板清单更新于 N 分钟前」 |
| `items[].id` | 是 | 稳定编号（同一件事一直用同一个） |
| `items[].title` | 是 | 要定的事，一行（≤200 字） |
| `items[].since` | 是 | 开始等的时间（ISO 8601）；排序按它，等得最久的在前 |
| `items[].summary` | 否 | 一句话背景（≤600 字） |
| `items[].url` | 否 | 只认 `http(s)`；其他协议丢弃 |
| `items[].recommendation` | 否 | 推荐做法（≤600 字） |
| `items[].options` | 否 | 选项，最多 6 个，每个 ≤80 字（只显示，面板上不能点选） |
| `items[].waiter` | 否 | 谁在等（默认不显示） |
| `items[].trace_id` | 否 | 相关的车 |
| `items[].deadline` | 否 | 最晚什么时候要定 |

缺 `id` / `title` / 合法 `since` 的条目跳过，并在面板上写「有 N 条格式不对」。样例：`config/owner-pending.example.json`。

## 3. 额度读数 —— 每个池一个 JSON 的目录

本地配置 `quota.dir` 指向目录，`quota.staleSeconds`（默认 900 = 15 分钟）。指挥舱只读这个目录，**不为面板调模型接口**；目录由已经在和模型接口打交道的程序顺手写。每个 `*.json` 文件一个池：

```json
{ "pool": "P1", "fetched_at": "2026-01-01 13:29:14+08:00",
  "util_5h": 0.03, "reset_5h_bjt": "2026-01-01 14:00:00+08:00",
  "util_7d": 0.97, "reset_7d_bjt": "2026-01-02 02:00:00+08:00",
  "status": "allowed_warning", "overage_status": "rejected", "error": null }
```

- `util_*` 是已用比例（0–1），面板显示成百分比；不是数字就显示「没有读数」，不猜。
- 读出时判断（存储不改）：`fetched_at` 超过 `staleSeconds` → 标「旧」（数字照常显示）；当前时间过了某个窗口的重置时间 → 这个窗口「已重置，旧读数作废」，不显示百分比。
- 是否登录：`error` 里是 401 / unauthorized / not logged in 一类 → 没登录；没有 `error` 且有读数 → 已登录；其他 → 不明。
- 顶栏「最紧」= 没出错、没作废的窗口里百分比最高的 1–2 个池。
- 某个文件坏了只那个池显示错误；目录读不到 = 整块「来源不可达 + 最后成功时间」。

借鉴（只借思路，没拷代码）：Claude-Code-Usage-Monitor `read_official_limits()`（MIT，官方数优先、过了重置时间作废、超时标 stale）；agent-deck `MarkExpired()`（MIT，读出时才判断过期）；vibe-kanban `ApprovalInfo`（Apache-2.0，「等你」一条记录的形状）。
