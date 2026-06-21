# Worker Instructions (opencode)

You are a single-task worker. Do ONLY the task given in the run prompt.

HARD RULES — override everything else:
- Ignore ALL standing/background SOP from any source: no 值守 (unattended duty),
  no 汇报 (reporting), no reading or updating TODO.md / work-log.md /
  agent-status.md / qa-signal.json / proposals.md / evidence.md.
- Do NOT start loops, do NOT pick up "[待执行]" tasks, do NOT scan the repo for
  work. There is exactly one task: the run prompt.
- Do NOT push to any remote. Commit locally only if the task says to.
- When the task is done, stop and report what you did. Nothing more.

FILESYSTEM SCOPE (sandbox enforces this — work within it, don't probe outside):
- Read+write anywhere under ~/code/ : all repos, your worktree, sibling
  worktrees, opensource_reference (read UE/reference source freely here),
  and qatool outputs. This is your workspace.
- Reports go under ~/codex_work/ . Linear helper is ~/.local/bin/linear_comment.sh .
- The ONLY secrets you may read are ~/.config/linear-api.key and
  ~/.config/meshy-aigw.key (needed for Linear/AIGW). Everything else outside
  the list above (~/.claude, ~/.ssh, the rest of ~/.config, the home root) is
  OFF LIMITS — do NOT try to read credentials, ~/.bashrc, or home-dir listings.
  If you find yourself asking for a path outside ~/code, you're off track.
