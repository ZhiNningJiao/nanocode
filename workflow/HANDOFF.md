# HANDOFF — 秘书交接协议

> 归档与公开交接规则见 `workflow/ARCHIVE_AND_HANDOFF_RULES.md`（板为唯一业务台账、
> 结案=已验收∧已通知、未结案永不隐藏、3 天窗口）。

> 沉淀秘书交接的机械链条。正本运行体 `secretary-takeover.sh` 不迁仓（现场配置：
> tab 注册表、secretary-home.env、systemd 桥——见 `MIGRATION.md` 第二批与
> `SHIM_PLAN.md`）。来源：本机 `codex_work/HANDOFF_SECRETARY.md` +
> `secretary-takeover.sh` 头部注释（只读沉淀）。

## 1. 唯一入口

交接统一走 `secretary-takeover.sh`，一个参数选席位：

```
secretary-takeover.sh <T1|T2|T3|T4|TnO|CODEX|ASTRA|AUTO> [--dry-run] [--verify]
```

- 无参 = `AUTO`：读用量快照尾部，按梯度自动定席位（第一梯队空闲健康 Fable 池 →
  第二梯队同池 Opus 备用秘书 → 末梯 CODEX），理由打印并落档。
- `--dry-run`：零改动全链演习——打印每步动作与目标值 + 缴械文本 + duty-status 预览。
- `--verify`：漂移自检（只输出不修复）：四处指向一致 exit 0；漂移 exit 3 + 差异表，
  供只读巡检。

## 2. duty-status.json 四证

`duty-status.json` 是当前值守秘书身份的**唯一权威快照**，仅在**四证全过**后
tmp+rename 原子写入（`.tmp` 残留 = 上次写入瞬间被中断，开头上报）：

| 证 | 检查内容 |
|---|---|
| ① env | 秘书席 env（`secretary-home.env`）指向新 tab/池 |
| ② 汇报 cron | cron 注入关键字（NANO_MATCH 类）全指向新 tab |
| ③ 飞书桥进程 | systemd --user 服务 active，且 `/proc/<pid>/environ` 中会话关键字 = 新 tab |
| ④ waker | 史官 tmux 活且有新 started 行 |

四证不一致 → `TAKEOVER_BROKEN` + 差异表，exit 1，零改动回滚。

## 3. 上任令 / 卸任令六步链条（fail-loud，任一步失败退出并回显已完成/未完成清单）

1. **预检**：tab 存在性 + 端口预检 + 活 session 预检（HTTP 建 tab 只能建出收不到
   上任令的哑 tab = 静默半成功，违 fail-loud，故无活 session 直接拒绝）。
2. **compact 旧席**：等旧会话空闲 → 注入 /compact → 验 jsonl compact_boundary
   增量 → 写真实 verdict（异步 detached，失败落 FAILSIG）。
3. **②s 缴械（卸任令）**：四指针切换之前向旧 tab 注入标准卸任令——停止飞书汇报 /
   撤定时唤醒 / 停监工 / 删 session cron / 在飞产物移交新任（防双声道：外部指针切了
   但旧 session 内残留自恢复）。注入失败不阻塞主流程，WARN + 记 duty-status notes。
4. **四指针原子切换**：env / 汇报 cron / 飞书桥 / waker 四处指向新席。
5. **四证合一验证**（§2）→ 通过后原子写 `duty-status.json`
   （含 stand_down_sent / notes / auto_select 等字段）。
6. **上任令注入 + 飞书到岗**：向新席注入标准上任令（读交接薄指引 + duty-status
   确认身份 → 按第一动作清单接管），飞书自报到岗。

## 4. 交接薄指引定位（HANDOFF_SECRETARY.md）

交接薄是**薄指引**，不是业务台账：

- 只留四件事：①怎么确认自己是谁（duty-status.json + workflow memory）②去哪读业务
  ③怎么判快照新不新 ④出事找哪个入口。
- **红线：业务事项一律记想法板，不在薄指引上开第二本账。** 业务描述可能过期，
  冲突以板为准。
- 维护纪律：只在**规则/入口变化**时改；业务进展改板。快照由脚本自动重出，
  **绝不手改快照文件**（派生数据）。
- 历史交接正文整本归档（archive 文件只增不删），薄指引不堆历史。
- 每次交接后只刷新薄指引顶部「在飞状态」一行时间戳与「板外未入账」两处。

### 新任第一动作清单（上任令注入后按序执行）

1. 验身：读 `duty-status.json` + 当前工作流 memory（防假过铁律/团队路由）。
2. 读业务：先判只读快照新鲜度，再读快照的「需人工动作」「未结案」（未结案项永不因
   年龄隐藏）「冲突/待核」三桶（机器态与人类态打架的一律不当已结案）。
3. 回板核实：板是唯一可编辑台账（链接装配自 env，token 绝不抄进文档/日志/报告；
   绝不新建视图、绝不改分组）。
4. 读决策台账：owner 方向性决策的唯一权威（只读 head+5）。
5. 扫信号：`ls -t <PATH_CODEX_WORK> | grep -E '^(FLAG|NEEDSIG|FAILSIG|SPIN)_'`——
   NEEDSIG = block 级即时处理；FLAG = **待证命题**，先独立验收再谈完成。
6. 扫在跑车：`ls -t <PATH_CODEX_WORK>/loop_*.log`——判活只看 log 文件新鲜度，
   **绝不 pgrep**。
7. 看池况用量快照尾部。
8. 飞书自报到岗（署名秘书席别，绝不冒用 owner）。
9. 刷新薄指引顶部时间戳。

## 5. 在飞状态刷新纪律

- 交接正文是**事实包**：新任必须先读最新一份交接包文件，旧快照条目是历史，不是现态，
  **不把旧快照当完成度**。
- 在飞车（收旗即验即报）、哨、owner 待决策项、fleet 沙箱边界（fleet 车读不到
  codex_work，spec 内嵌进 prompt）逐条显式移交。
- 接班若发现旧板快照缺失/过期：恢复全量业务板核对，**不能声称全板已核完**。
- 兜底链：`handover-failsafe.sh`（cron 定期）在秘书猝死时自动切最健康池，新任第一
  动作同样读薄指引。

## 6. 红线速览（交接期间同样生效）

- worker 完成声明 = 待证命题，批判独立验收（见 `workflow/ACCEPTANCE.md`）。
- 板只读快照是派生数据：绝不在快照上记事、绝不手改快照。
- 凭据只落 env 文件（owner home, chmod 600），绝不进日志/报告/文档。
- kill-by-pid 绝不 pkill 模式匹配；不碰共享服务进程。
- 时间戳只取日志/系统钟真实输出。
