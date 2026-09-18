# 验收门（防假过）

来源：`~/code/worker-core/ARSENAL_INDEX.md` 0830/0831 节 + CLAUDE.md 完成声明验收法（2026-09-18 前后持续强化）。

- worker 的 FLAG / REPORT PASS / ACCEPT 只是**待证命题**，秘书必须独立审计。
- **FLAG 只触发收件，不直接当验收**（owner 2026-09-18）：FLAG 的含义是「worker 声称
  收工，请派收件/验收」，不是「已完成」。终态必须落到结果 / 阻塞原因 / 接替任务关联
  三者之一——已被新任务接替的旧 FLAG 不再计在跑，避免旧信号反复算活。
  （对应甘特板 end_source 归位：见 `gantt-map.md`。）
- **证据契约**：REPORT 每条完成/数字断言必须带 `(证据: 文件:行号 | 文件:"grep串" | 文件)`。
- **机械门**：`python3 ~/code/worker-core/qa_gate_mechanical.py REPORT.md`，exit≠0=自动打回；裸断言=违例。
- **语义门**：`~/codex_work/ragas-gate/qa_gate_semantic.py <REPORT.md>`——抓「证据存在但不支持断言」；验收序=先机械后语义。
- 严格分级：`代码候选 → 单组件通过 → 集成通过 → E2E通过 → 已部署实测`，禁止跨级拔高。
- REPORT 标题 PASS 但正文含 BLOCKED/remaining/out-of-scope，或测试用 mock/echo 代替全链，或放宽断言迁就产品 bug → 一律退回。
- 退回保留已证明的局部成果，明确哪些不重做、哪些硬门仍缺。
- **验证按风险分层**（owner 2026-09-18）：只有任务书「阻断项」命中的失败才卡发布；
  可假设项以结果反证后回滚为准，不机械每单双腿多轮重验。分层字段在任务书
  「可假设项/必须实测项/阻断项/非阻断后续」节（见 `dispatch/README.md` 模板）。
- **有限时间 checkpoint**（owner 2026-09-18）：到任务书 checkpoint 时限（如 5 分钟/
  15 分钟）必须交出已有结果（含未完成部分+原因），禁止无限重试空转。
- **视觉关**：数字过 ≠ 视觉过。渲染 PNG/GIF → Sonnet headless 文字裁决（worker/秘书绝不 Read 图片）；给 Sonnet 看 GIF，给 owner 看 viewer 短链（全链接，≤4 资产/链，>4 用 suite）。给链接前两验：curl 探活 + playwright 真渲截图。
- 最终交付 = 单 GLB 多 animation track（多动作合一）。
