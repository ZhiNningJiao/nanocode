# ACCEPTANCE — 完成声明验收法

> worker 的 `FLAG`、REPORT 里的 `PASS/COMPLETE` 都只是**待证命题**，不得直接转述为完成。
> 验收以批判、严谨、科学、辩证的独立审计为准：还原 owner 原始目标，主动找反例和旁路，
> 核对真实默认生产入口、上下游 consumer、失败/partial/rollback、exact commit、clean
> worktree、真实资产与部署环境证据。
> 来源：`~/.claude/CLAUDE.md`「完成声明验收法」段 + `worker-core/WORKER_CORE.md`
> 相关段（只读沉淀）。

## 1. 成熟度五级（禁止跨级拔高）

严格区分，报告/验收结论**只能落在已证明的那一级**：

```
代码候选 → 单组件通过 → 集成通过 → E2E 通过 → 已部署实测
```

| 级别 | 定义 | 典型证据 |
|---|---|---|
| 代码候选 | 代码写完、本地跑过，未过独立验证 | commit SHA + diff |
| 单组件通过 | 单模块/单函数按契约独立测试通过 | 组件级 run.log |
| 集成通过 | 多组件按真实生产组装链路跑通（非 direct-call/mock 拼装） | 全链 run.log |
| E2E 通过 | 真实用户场景在真实入口复现成功（真 HTTP/真服务/真浏览器） | 复现命令 + 现场证据 |
| 已部署实测 | 部署环境上真实流量/真实资产验证 | 部署环境日志、产物校验 |

跨级拔高的常见形态（一律打回）：单测过 → 报「功能完成」；mock/echo server 过 →
报「集成通过」；QA 环境过 → 报「已上线可用」。

## 2. 退回规则

出现任一情形，验收结论 = FAIL，退回 worker：

1. REPORT 标题 PASS/COMPLETE，但正文含 `BLOCKED` / `remaining` / `out-of-scope`。
2. 测试用 direct-call / mock / echo server 代替全链路。
3. 放宽断言迁就产品 bug（把缺陷写进期望值）。
4. 缺 provenance 三查（见 §3）。
5. 测试对象 ≠ 已提交对象（commit 未推/工作区脏，验收人拉不到代码）。
6. 产物落错路径、run.log 缺失或被删改截断。

**退回姿势**：保留已证明的局部成果，明确「哪些不重做、哪些硬门仍缺」，再补派
真实下游——不整单推倒。

## 3. 独立抽证清单（每个关键数字至少复算一个）

验收人对 REPORT 逐项过（不信任 worker 自述，全部独立复跑）：

1. **数字复算**：REPORT 声称的每个关键数字（PASS/FAIL 数、测试数、行数、字节数）
   至少抽一个从日志原文复算（`grep -c` 等），以日志 grep 结果为准，不手抄。
2. **provenance 三查**：
   - 真源：非替身/陈货，逐条 `ls` 实证来源路径；
   - 金标准新鲜度：gold 是否最新版（`git merge-base --is-ancestor` 或 md5 对远端），
     显式确认「验完之后底座没变」；
   - e2e 资产出处：每个 clip/模型/资产来源路径逐条写进 REPORT；尺度相关 case
     必须用非 1:1 尺寸资产（证明不是恒等蒙混）。
3. **真入口**：验证走的是真实默认生产入口，不是任务特例分支、旁路脚本或 env flag。
4. **上下游 consumer**：声称的每个公开入口（路由/函数/配置键）grep 得到真实调用方。
5. **失败面**：失败/partial/rollback 路径有测试或现场证据，不是只验 happy path。
6. **exact commit + clean worktree**：报告给出 commit SHA；验的对象 = 已提交对象；
   工作区无未提交改动混入结论。
7. **byte-identical / no-op 契约**：声称无损/不变的路径有独立读取器逐帧 diff=0
   或逐字节 sha 证据（DCC 荣耻篇铁律 6）。
8. **时间戳**：报告里开工/收工/里程碑时间来自 `date '+%F %T'` 真实输出，禁止估算。
9. **产物存在性**：任务书指定的 FLAG/REPORT/产物按绝对路径 `ls` 实证。

## 4. 验收词汇表

- `FLAG` = 全部验收项过了才 touch 的**封口动作**，必须在 commit（+push 义务场景）之后。
- 「完成」的定义 = **可验收**：干到能断言「该 issue 可关」再 FLAG。
- 「做完但没通知到 owner」= 仍未结案；worker 机器完成 ≠ owner 事项已验收。
