# ⚙️ 武器库段（派单正门自动前置，akari_dispatch.sh 注入；勿在任务书里重复）

**开工前必读三件，禁止重复造轮子（owner 0829 令，0903 焊死进正门）：**

1. **查代码先 CodeKG 速查**（省 80% token，比全文 grep 快一个量级）：
   ```
   cd /jfs/home/zhiningjiao/codex_work/ckg_race/distill
   python3 query.py text "<关键词>" --limit 10     # 语义/名称检索
   python3 query.py like "%<子串>%" --limit 10     # 模糊匹配
   ```
   覆盖仓：dcc(meshy-dcc-pipeline)/meshyd/serving/libmeshy 等后端算法侧。
   ⚠webapp 前端未入索引——前端问题直接在工区 grep。
   速查命中后再精读原文件核实行号，禁止只凭索引下结论。
2. **武器库索引**：`/jfs/home/zhiningjiao/code/worker-core/ARSENAL_INDEX.md`
   （现成脚本/模板/查询库全在册，动手写工具前先查有没有现成的）。
3. **决策/历史考古**：`bash /jfs/home/zhiningjiao/codex_work/memory_pilot/memq.sh "<问题>"`。

**纪律**：第一轮必须有工具调用（读文件/速查），禁止只吐思考；产物按任务书指定路径落盘；
完工必写 FLAG；缺信息/权限=REPORT 顶部 NEEDSIG 段+落旗退出，不空转。

---

**时间戳纪律（秘书T1 2026-09-18 加，三车连犯）**：报告里的开工/收工/里程碑时间**必须**来自 `date '+%F %T'` 的真实输出（开工第一条命令就打一次 date 并原样抄进报告），禁止估算或凑整；计数（PASS/FAIL/测试数）以日志 grep 结果为准，不手抄。

**秘书派单铁律（owner 2026-09-18）**：有活即派、GLM 疯狂并行、活不落地；worker 收工报告末尾必须列「下一段可续派的活」≥1 条（或写明为何到此为止），让秘书能秒续派。

**查代码优先壳（秘书T1 2026-09-18 加，复盘根因#3：31% 动手在手工 grep）**：`bash /jfs/home/zhiningjiao/code/ckg-first-1355/bin/ckg-first.sh <关键词> [--repo 仓名]` 先查 CodeKG 命中 file:line，零命中才按它打印的 grep 建议手查。
