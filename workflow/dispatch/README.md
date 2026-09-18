# dispatch/ — 派单流程一页

**流程**：想法板取活 → memq 查前人决策 → 写任务书（本目录模板）→ `akari_dispatch.sh` 派车
（武器库段=DISPATCH_HEADER.md 自动前置注入，勿在任务书重复）→ 旗哨/史官盯 FLAG → 验收。

## 任务书模板（复制后填）

```markdown
# TASK_<tag> — <一句话标题>
depends_on: [tag...]   # 纸面 DAG；秘书发车前 grep 校验被依赖 tag 已 .accepted

## 背景（owner 原话/出处）
<原文引用，不转述>

## 目标 / 非目标
- 做：<…>
- 不做：<…>

## 输入（只读资产，绝对路径）
<…>

## 产出（绝对路径合同）
REPORT: ~/codex_work/REPORT_<tag>.md
FLAG:   ~/codex_work/FLAG_<tag>   # 仅当 <完成定义> 满足才 touch

## 完成定义（可机械验收）
- 每条断言带 (证据: 文件:行号 | 文件:"grep串" | 文件)
- `cmd 2>&1 | tee run_<tag>.log`；grep -nE "FAIL|Error|NaN" 循环到零命中
- 收工报告末尾列「下一段可续派的活」≥1 条

## 红线
不碰 main / 8770 / 他人仓；过程产物不入库；时间用 date 真实输出；
缺信息=REPORT 顶部 NEEDSIG 段+落旗退出，不空转；scope 白名单=<…>

## 模型/预算
<pick-worker-model.sh 选；MAX_SECONDS 按 DISPATCH_RULES_v0 默认值>
```

## 开工三查（写进每个任务书，worker 第一批动作）
① `bash ~/codex_work/memory_pilot/memq.sh "<任务关键词>"`（前人决策/雷区）
② `cd ~/codex_work/ckg_race/distill && python3 query.py text "<关键词>" --repo <仓名>`（代码地形）
③ 读 `~/code/worker-core/ARSENAL_INDEX.md` 相关段（禁重造轮子）

## 模型路由
见本目录 `DISPATCH_RULES_v0.md`（决策树+预算+失败四分类）。选模一律
`pick-worker-model.sh`（三级梯：免费池→Claude 降级池→NEEDSIG），别手写模型名。
