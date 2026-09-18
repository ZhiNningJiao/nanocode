# 验收门（防假过）

来源：`~/code/worker-core/ARSENAL_INDEX.md` 0830/0831 节 + CLAUDE.md 完成声明验收法（2026-09-18 前后持续强化）。

- worker 的 FLAG / REPORT PASS / ACCEPT 只是**待证命题**，秘书必须独立审计。
- **证据契约**：REPORT 每条完成/数字断言必须带 `(证据: 文件:行号 | 文件:"grep串" | 文件)`。
- **机械门**：`python3 ~/code/worker-core/qa_gate_mechanical.py REPORT.md`，exit≠0=自动打回；裸断言=违例。
- **语义门**：`~/codex_work/ragas-gate/qa_gate_semantic.py <REPORT.md>`——抓「证据存在但不支持断言」；验收序=先机械后语义。
- 严格分级：`代码候选 → 单组件通过 → 集成通过 → E2E通过 → 已部署实测`，禁止跨级拔高。
- REPORT 标题 PASS 但正文含 BLOCKED/remaining/out-of-scope，或测试用 mock/echo 代替全链，或放宽断言迁就产品 bug → 一律退回。
- 退回保留已证明的局部成果，明确哪些不重做、哪些硬门仍缺。
- **视觉关**：数字过 ≠ 视觉过。渲染 PNG/GIF → Sonnet headless 文字裁决（worker/秘书绝不 Read 图片）；给 Sonnet 看 GIF，给 owner 看 viewer 短链（全链接，≤4 资产/链，>4 用 suite）。给链接前两验：curl 探活 + playwright 真渲截图。
- 最终交付 = 单 GLB 多 animation track（多动作合一）。
