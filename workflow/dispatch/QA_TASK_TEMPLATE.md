# TASK: QA 官独立复核 — __TAG__（自动派单 · IMPL_DONE 待证）

> 本任务书由 `~/code/auto-qa-dispatcher.sh` 于 __GEN_TIME__ 自动生成。
> 免费双审第 `__QA_LEG__` 腿（模型 `__QA_MODEL__`）：另一腿是独立 QA 官，独立 XDG
> session、独立 QA 裁决文件、独立 FLAG——互不可见，别读别等别引用另一腿，各审各的。
> 角色母法：`~/codex_work/QA_OFFICER_CORE.md`（先读）。只测不修，绝不 push。
>
> 被验 worker 已 touch `~/codex_work/FLAG___TAG__`（声称完成）。这是**待证命题**——
> 你是 QA 官，用批判、对抗的方法独立复验，**驳不倒才算 QA_PASS**。worker 的
> REPORT / FLAG / 测试名 / 注释一律只是线索，不是证据。

## 被验对象
- worker 任务书（原始目标 + 验收节 + 红线）：`__PARENT_TASK__` — 先读它还原 owner 要什么。
- worker 声称书（首行应是 IMPL_DONE / PASS 等）：`__REPORT_PATH__`
- 工区 / 仓库（cd 进去复跑测试、查 git 状态）：`__WORKDIR__`
- 完成旗：`~/codex_work/FLAG___TAG__`

## 通用铁律（母法 QA_OFFICER_CORE.md，每单必做）
1. **还原原始目标**：先读 `__PARENT_TASK__` 的目标与验收节，再读 `__REPORT_PATH__`
   对照找缺口；REPORT 标题 PASS 但正文含 `BLOCKED/remaining/out-of-scope` → 直接 QA_FAIL。
2. **独立复跑**：REPORT 声称的所有测试自己重跑一遍（`2>&1 | tee ~/codex_work/qa_run___QA_TAG__.log`），
   `grep -i "fail|error|cancelled|nan|not found"` 必须干净；不许只看 worker 贴的旧日志。
3. **exact 证据**：worktree clean？commit SHA 存在且 diff 覆盖 REPORT 声称的每个文件？测试跑在这个 SHA 上？
4. **parent-red 防假过**：base 上红断言应红（失败），HEAD 上绿（通过）——证明修复真生效，
   不是断言被改松 / 摆设 / mock 顶替。红断言含真回归必 FAIL。
5. **反例优先**：正路径过了不算完，负路径 / 边界（失败分支、非法输入、并发、权限）至少各造一个反例真跑；
   禁止把断言改松迁就 bug。GAP≠你去改代码（只报不修）。
6. **范围红线扫描**：改动面是否收窄到任务范围？任务书外的文件被动过吗？默认行为 / 生产入口 /
   上下游 consumer 是否被意外改动？逐项核实并记录。
7. **红线核查**：`__PARENT_TASK__` 里的红线（端口 / 生产实例 / 禁杀进程 / 禁 push / 禁合 PR 等）
   ⚠「不 push（秘书验后推）」的判定对象是 **worker 在落旗前**的行为：落旗后远端出现被验 commit
   属于秘书验收后按合同推送（查 ~/codex_work/work-log.md 有验收记录即坐实），**不是违规**。
   你的 QA 与秘书的验后推是并发的——见远端已推≠worker 踩线（0819 两次误判教训）。
   逐条验 worker 没踩。
8. **只测不修**：发现 bug 只记录、绝不动手改实现代码；测试脚手架可自己写（放 `~/codex_work/qa_scratch___QA_TAG__/`）。
9. **测试绝不 spawn 真模型消费者**：E2E 用 stub 顶替，禁起真 claude/codex 进程；
   测试起的服务 / 会话 / tmux / 端口，QA 结束必须自清。

## 收工
- 写 `~/codex_work/QA___QA_TAG__.md`：首行 `QA_PASS` 或 `QA_FAIL`
  （有任一 GAP / 红断言含真回归 / 红线被踩即 FAIL）；正文 = 逐项证据（命令 + 退出码 + 关键输出行）
  + 问题清单（P1 阻断 / P2 应修 / P3 建议）。
- touch `~/codex_work/FLAG___QA_TAG__`（PASS / FAIL 都落旗，结论在 QA 文件首行）。
- 绝不 push 远端；绝不改实现代码。
- 3 轮卡死 → 写 `~/codex_work/FAILSIG___QA_TAG__` 别耗死。
