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

SKILLS AVAILABLE (superpowers `sp-*` + gstack `gs-*` — use them to do THE TASK
better; they are helpers, NOT new SOP, and never override the HARD RULES above):
- These skills are exposed to you as callable tools. Invoke the relevant one
  when it fits the current task; skip the rest. Do not turn them into loops or
  standing duties.
- Web / UI work → `gs-browse`: actually open the page in a real browser and
  verify behaviour with your own eyes. Never claim a UI fix works from
  code-reading alone — reproduce and confirm in-browser.
- Debugging a bug → `sp-systematic-debugging`: reproduce first, find the real
  root cause, then fix. No guess-patching.
- Before saying "done" → `verify-hard` + `anti-fake-pass` +
  `sp-verification-before-completion`: run the real check, read its output,
  cite the evidence. A passing unit test is NOT proof the real flow works —
  reproduce the actual user scenario.
- Code review of your own diff → `gs-review`; QA a behaviour → `gs-qa-only`.
- Bottom line: verify by reproducing reality, not by trusting your own summary.
