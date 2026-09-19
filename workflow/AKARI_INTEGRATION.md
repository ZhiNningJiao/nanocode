# AKARI_INTEGRATION — akari 集成进 nanocode：现状 / 差距 / 方案 A 设计稿

> 任务来源：owner 2026-09-19 12:3x「我在想要不要把阿卡丽也直接集成到 nanocode 里面？」
> 本稿只写文档不改代码。结论：推荐方案 A（集成入口不合仓），理由见 §4。
> 内部地址一律写 <AKARI_HOST> / <LENS_HOST> 占位；凭据不入仓。

## 1. 现状盘点

### 1.1 nanocode 已有的 akari 相关能力（fork main=45c3a6c）

| 能力 | 代码位置 | 说明 |
|---|---|---|
| 同源代理 `/api/akari/state` | `server/index.js:664`（路由），实现 `server/akari-proxy.js` `fetchAkariState` | 并行扇出 akari-server 四个只读端点（health / concurrency / workers / lanes），4s 超时，永不 throw，返回 `reachable:false` 结构化降级包 |
| 配置端点 `/api/akari/config` | `server/index.js:659` | 返回 serverUrl + lensUrl（供前端一键跳 lens 按钮） |
| 健康探针 | `server/index.js:623-632` `checkAkariReachable` → `/api/health` | 驱动 services 面板 `akari` 行的状态点，状态迁移广播 `service_status` |
| Port Health 面板 akari 行 | `server/index.js:641-647` 注入 managed entry（`getAkariServiceEntry`），渲染在 `public/js/services-panel.js` | `managed:true` 行无编辑/删除控件，URL 改动即时生效 |
| akari 检察面板（Monitor 插件） | `public/js/akari-panel.js`（531 行）+ `public/js/plugins-registry.js` + `public/js/right-panel.js` 懒加载 | 10s 轮询 `/api/akari/state`，渲染 health/concurrency/workers/lanes 四节，降级为 calm "down" 态；右上「Lens ↗」按钮新开 lens（`public/akari_harness.html` 为早期 harness 页） |
| 配置默认值 | `terminal/personal-config.js:52-53,190-209` | `akari.serverUrl` → `$AKARI_SERVER_URL` → 默认 `http://<AKARI_HOST>:9481`；`akari.lensUrl` 同构指向 9482。非机密，允许默认硬编码 |
| 历史实现记录 | `REPORT_nano_akari.md`（MES-14049，commits c58be29/eeaedd3/af77009/f6a4871） | 字段形状对齐 akari-server 源码（health_handler.rs / small_handlers.rs / lanes_pool.rs），非猜测 |

### 1.2 lens / gantt 现在如何独立运行

- lens 是 akari 仓 `packages/lens`（TS/Vite），`serve.ts` 独立进程监听 9482：
  - 特有端点：`GET /api/instances`（对 canonical daemon `/api/health` 做 singleton fan-in）、
    `/api/external-army`、`/api/external-workers`、`GET /api/dispatch-timeline?window=`（读 tmux/loop 日志推导派单时间线）、`GET /api/dispatch-log/:tag`；
  - 其余 `/api/*` 通用反向代理到 akari-server（9481）。
- 甘特页（gantt-page.tsx / bands-gantt.tsx）浏览器直连 9482，与 nanocode 无任何代码级耦合；
  nanocode 面板里唯一联系是「Lens ↗」外链按钮。
- 现网实测（2026-09-19）：`9481 /api/health` 返回 `{ok,version,build_commit,dispatch_caps,agent_concurrency,providers,token_rate,history[]}`；
  `9482 /api/dispatch-timeline?window=6h` 返回 `{entries:[{tag,route,state,started_epoch,ended_epoch,tmux_session,log_kind,...}]}`。

### 1.3 秘书派单 / 收旗现在靠什么

- 派单唯一入口：`/jfs/home/zhiningjiao/code/akari_dispatch.sh`（头部注释即合同，511 行；
  参数 `TAG WORKDIR FLAG PROMPTFILE LOG [MODEL] [MAX_SECONDS]`；三路由 claude-tmux / akari fleet / run_loop 兜底；
  派单正门自动注入武器库段；rules32 并发 32 上限 + 失败四分类）。
- 合同沉淀：nanocode fork `workflow/DISPATCH.md`（脚本本体不迁仓）。
- 信号协议：`~/codex_work/` 顶层 `FLAG_<TAG>`（完成）/ `FAILSIG_<TAG>`（失败，首行 `CLASS=`）/ `NEEDSIG_<TAG>`（求援）/
  `SPIN_<TAG>`（在跑心跳），已处理信号挪 `_signals_handled/`（tombstone 形态：`ACKED_*` / `*.handled_<epoch>`）。
- 现网实测：`9475 /api/services` 返回扁平 map `{<name>:{status:"up"|"down",checkedAt}}`，akari 行为 up。

## 2. 差距清单（nanocode tab 里四件事）

| # | 目标 | 现状 | 缺什么 |
|---|---|---|---|
| 1 | 一键派单（走 akari_dispatch.sh 合同） | 完全没有。派单只能开终端敲脚本；contract 在 workflow/DISPATCH.md 但无 UI | 缺一个受控派单端点（见 §3 M2）+ 表单 UI（TAG/WORKDIR/模型/任务书内容）+ 派单前 FLAG 冲突检查。关键约束：脚本深耦合 owner HOME / tmux / AIGW key，nanocode 服务进程不能直接替它执行，只能 spawn 或经 akari `/api/agent` |
| 2 | 看甘特（lens 9482） | 只有「Lens ↗」外链新开窗口；浏览器跨端口直连还依赖 lens 无所谓 CORS（同机部署可访问） | 缺内嵌视图或经 nanocode proxy 转发 `/api/dispatch-timeline`、`/api/dispatch-log/:tag`，让甘特数据出现在 nanocode 自己的 tab 里 |
| 3 | 看信号旗（FLAG / NEEDSIG / FAILSIG + tombstone） | 完全没有 UI；秘书靠 shell ls 扫 `~/codex_work/` | 缺一个只读信号目录列点端点（按 mtime 排序、分类着色、区分活动/已归档 tombstone），前端旗列表面板 |
| 4 | 看 worker 输出尾巴（tail -f） | akari 已有 `GET /api/workers/:worker_id/transcript`；nanocode 面板无展示 | 缺 proxy 转发该端点 + 面板点击某 worker 拉最近 N 行 transcript；lens 轮询式即可（akari 无 SSE，`/api/events/:lane` 是按 lane 的事件 feed） |

## 3. 方案 A（推荐）：集成入口不合仓

原则：nanocode 只持 URL 配置（已有 personal-config 机制），通过自身 server 同源代理调
akari-server（9481）与 lens（9482）API；前端加一个 akari 面板（已有，扩节即可）。
两个服务各自独立进程、独立发布，nanocode 零 Rust/bun 构建负担。

### 3.1 接口清单（nanocode server 侧新增/既有 proxy 端点）

鉴权：沿用 nanocode 既有 server 鉴权（无独立 token；若后续加，用 `<NANOCODE_AUTH_PLACEHOLDER>`）。
所有端点 fail-loud 降级：上游不可达时返回 200 + `reachable:false` / `error` 字段，不 500 刷屏（沿用 akari-proxy.js 既有形态）。

| 方法 | 路径（nanocode 同源） | 上游 | 入参 | 出参（形状摘要） | 状态 |
|---|---|---|---|---|---|
| GET | `/api/akari/config` | —（本地配置） | 无 | `{serverUrl, lensUrl}` | 已有，index.js:659 |
| GET | `/api/akari/state` | 9481 ×4 | 无 | `{reachable, fetchedAt, health, concurrency, workers, lanes, errors{}}` | 已有，index.js:664 |
| GET | `/api/akari/gantt?window=6h` | 9482 `/api/dispatch-timeline` | `window`（如 `6h`） | `{entries:[{tag,route,state,started_epoch,ended_epoch,tmux_session,log_kind,last_activity_epoch}]}`，降级 `{reachable:false,error}` | 新增 |
| GET | `/api/akari/dispatch-log/:tag` | 9482 `/api/dispatch-log/<tag>` | `tag` | 派单日志内容（text/json），降级同上 | 新增 |
| GET | `/api/akari/signals` | —（本地文件系统只读） | 可选 `?scope=active\|archived` | `{flags:[{kind:"FLAG"\|"NEEDSIG"\|"FAILSIG"\|"SPIN",tag,path,mtime,age_secs}], tombstones:[同形+handled_epoch]}`，目录不可读时 `{reachable:false,error}` | 新增（读 `~/codex_work/` 顶层 + `_signals_handled/`，路径可配置 `<CODEX_WORK_DIR_PLACEHOLDER>`） |
| GET | `/api/akari/worker/:id/transcript` | 9481 `/api/workers/:worker_id/transcript` | `id`, 可选 `?tail=N` | 最近 N 行 transcript 投影，降级同上 | 新增 |
| GET | `/api/services` | — | 无 | `{<name>:{status,checkedAt}}` 含 managed akari 行 | 已有 |

### 3.2 需要akari 侧新增/暴露的端点

理想情况下零新增（方案 A 全部走既有面）。两个可选增强（非阻塞）：

1. `GET /api/dispatches` 在 router.rs 已注册（line 38），但 lens serve.ts 注释称其在
   live daemon 上 404（uncommitted）。若后续要在 nanocode 画结构化派单表而非解析
   lens 时间线，需 akari 侧把该端点落地；M1 不依赖它。
2. 实时尾巴（M3）若轮询 transcript 延迟不可接受，可考虑 akari 侧加 SSE/WS；
   M3 先用 2-3s 轮询验证需求，不为想象中的实时性提前建抽象。

### 3.3 部署形态

- akari-server（9481）与 lens（9482）进程、构建、发布节奏完全不动，仍归 akari 仓管。
- nanocode（9475/9476）只新增 proxy 路由 + 面板 JS；配置在 personal-config
  （`akari.serverUrl` / `akari.lensUrl`，env 可覆盖），改地址不需重启 nanocode（每次调用重读配置，既有行为）。
- nanocode server 进程需要能读 `~/codex_work/`（信号目录）。生产上 nanocode 已以
  owner 用户跑，无额外权限；若未来 shim 化到独立用户，信号路径改为 env 配置
  `<CODEX_WORK_DIR_PLACEHOLDER>`。

### 3.4 失败降级

- akari-server 不可达：`/api/akari/state` 返回 `reachable:false` + per-section error
  （既有）；面板渲染 calm down 态（灰点 + 「akari unreachable」文案），不弹红错误、
  不 console 刷屏——与 REPORT_nano_akari 的 degraded 形态一致。
- lens 不可达：甘特节显示空态 + error 摘要，「Lens ↗」按钮保留（外链可能仍可用）。
- 信号目录不可读：信号节显示 `reachable:false` 与错误原因（fail-loud，不静默空表）。
- 上游超时统一 4s（沿用 `AKARI_PROXY_TIMEOUT_MS`），轮询 ≥10s 温和节流（既有纪律）。

## 4. 方案 B（合仓）为什么不推荐

把 `crates/*`（Rust/axum）+ `packages/lens`（bun/Vite）搬进 nanocode 的代价：

1. 构建链：nanocode 现为纯 JS（node + 测试 node:test）。合仓引入 cargo 工具链 +
   bun 双链，CI 矩阵翻倍；akari 侧 CI/冒烟（smoke.rs、test_harness.rs）也得跟着迁或双跑。
2. 发布节奏耦合：akari 迭代快（build_commit 每日变，现网 5e3886c13），nanocode 是
   日常工具，二者任何一个发版都要回归另一个；fork 上游同步（ZhiNningJiao fork 追
   上游 nanocode）时 Rust 子树是纯冲突源。
3. 生产实例迁移：现网 9481 已承载 fleet 注册表（/api/projects 四个 project）、lane
   池、在跑 tmux 会话与 transcript 落盘。合仓意味着换二进制/换路径/换工作目录，
   迁移窗口内所有在跑 worker 与秘书派单链（akari_dispatch.sh 硬编码 AKARI_PORT 探活）
   全部受影响——高风险零收益。
4. 荣耻篇视角：能力已经各自内聚（nanocode=面板/代理壳，akari=派单引擎，lens=可视化），
   合仓是「一个模块干三件事」的倒退；方案 A 用 HTTP 边界保持了层次分明。

结论：方案 B 一页写完，否决。

## 5. 分期

### M1 只读面板（健康 / 甘特 / 信号旗）
- 内容：3.1 表中新增 3 个只读 proxy 端点（gantt / signals / dispatch-log）+ akari-panel.js
  扩两节（甘特条带简化版、旗列表）。
- 验收：浏览器实测（gs-browse）——akari up 时三节有数据；`kill <pid>` 9482（仅测试进程，
  绝不动生产 akari-server/lens，用本地替身或沙箱端口）后甘特节降级不报错；信号节与
  `ls ~/codex_work/FLAG_* | wc -l` 计数一致；node:test 覆盖 proxy 降级路径。
- 预计机时：0.5-1 天（3 端点 + 2 节 UI + 测试）。

### M2 派单按钮（走 akari_dispatch.sh 合同）
- 内容：nanocode server 新增 `POST /api/akari/dispatch`，入参 `{tag, workdir, prompt, model?}`,
  server 侧落 PROMPTFILE + spawn `akari_dispatch.sh TAG WORKDIR FLAG PROMPTFILE LOG MODEL`
  （FLAG/LOG 路径按合同规则生成），返回 spawn 结果；面板加派单表单 + 在跑列表（读 SPIN/dispatch-timeline）。
- 前置条件（NEEDSIG 级）：akari_dispatch.sh 的 HOME/codex_work 硬编码需先 env 化 shim
  （workflow/SHIM_PLAN.md 已有规划），否则 nanocode 进程环境无法安全承载。
- 验收：从 nanocode UI 派一个真 TAG 到测试仓，FLAG 落地、dispatch-timeline 出现该条、
  重复派同 TAG 被合同规则拒绝；失败路径（akari 死）返回 [AKARI_GATE_FAIL] 文案。
- 预计机时：1-1.5 天（含 shim env 化与真派单验收）。

### M3 worker 输出实时尾巴
- 内容：面板 worker 表行点击 → 拉 `/api/akari/worker/:id/transcript?tail=100`，
  3s 轮询追加滚动；先轮询，确认需求后再议 SSE。
- 验收：派单后在 nanocode 内看到 worker transcript 尾巴随任务推进增长；worker 结束后
  尾巴定格；transcript 端点 404/超时时尾巴节显示降级态。
- 预计机时：0.5-1 天。

## 6. 风险与红线

1. 绝不 kill/pkill akari-server（9481）、lens（9482）、nanocode（9475/9476）生产进程；
   降级测试只针对测试替身进程。
2. 派单唯一入口仍是 `akari_dispatch.sh`（owner 0907 令）：M2 的按钮只是该脚本的一层
   UI 壳，绝不绕过合同直调 akari `/api/agent` 或 run_loop。
3. 凭据不入仓：AIGW key、Linear key 等只经环境变量/`~/.config`（代码里 `<PLACEHOLDER>`）；
   akari serverUrl 非机密可入 personal-config（既有结论）。
4. 信号目录只读：nanocode 对 `~/codex_work/` 只读列目录，绝不写/移/删信号文件
   （归档 `_signals_handled/` 是秘书的职责）。
5. proxy 降级必须显式（reachable:false + error 字段），禁静默空态冒充正常（荣耻篇铁律 4）。
