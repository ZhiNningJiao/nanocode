# Linear 纪律

来源：`~/code/worker-core/WORKER_CORE.md`（W-Linear 2026-08-13）+ memory CURRENT_WORKFLOW.md。

- **只读 head+5**：`linear_read.sh <ISSUE-KEY> 5`（描述+最近5条评论），绝不 all。
- 一 Linear = 一分支 = 一 workspace，一一对应；合并后关票+清 worktree+删分支。
- worker 自己直写评论（不经协调方转发）：领单/里程碑/收工三节点，用 `linear_comment.sh`。
- **中性措辞**：无称呼、无语气词、无人设、无 emoji、无内部称谓；单号必带关键词括号（如 MES-13693(纯数学retarget)）。
- 评论宁少而精：每 iter 一行滚动更新（linear_progress.sh 自动维护单条评论，超14行裁最旧），绝不逐 iter 新开评论刷屏。
- 机器纯文字评论 >5 条 → `linear_compact.sh --apply` 压缩；保留人类评论与含资产链接的评论。
- 决策台账：owner 决策一律入 Linear MES-15907（唯一权威），其他文档只引用不复制。
