#!/usr/bin/env bash
# Team2 Claude loop with live stream-json execution trace.
# Run only inside tmux; use start_team2_observable.sh for normal launches.
# scripts_resume_2241 port: no hardcoded machine paths — override via
# CODEX_WORK_DIR / RENDER_CLAUDE_STREAM / DCC_DESIGN_CODEX; npm-global PATH
# prepended for the claude CLI (same as source).
set -uo pipefail

TAG="${1:-}"
WT="${2:-}"
FLAG="${3:-}"
PF="${4:-}"
LOG="${5:-}"
MODEL="${6:-opus}"
MAX_SECONDS="${7:-14400}"
# opus 别名归一到 Opus 5.0（owner 2026-09-07 令：claude CLI 的 opus 别名解析成 4-6，须显式 5.0）
[ "$MODEL" = "opus" ] && MODEL="claude-opus-5"
# fable 别名钉成显式 id（2026-09-11 5.1 升级窗口别名服务端解析抖动，三连秒败两轮；同 opus 先例）
[ "$MODEL" = "fable" ] && MODEL="claude-fable-5-1"

PF="$(realpath -m "$PF" 2>/dev/null)"
FLAG="$(realpath -m "$FLAG" 2>/dev/null)"
LOG="$(realpath -m "$LOG" 2>/dev/null)"

[ -n "$TAG" ] || { echo "FATAL: missing tag" >&2; exit 2; }
[ -d "$WT" ] || { echo "FATAL[$TAG]: missing workdir: $WT" >&2; exit 2; }
[ -s "$PF" ] || { echo "FATAL[$TAG]: missing/empty task: $PF" >&2; exit 2; }
[[ "$MAX_SECONDS" =~ ^[0-9]+$ ]] || { echo "FATAL[$TAG]: invalid max seconds" >&2; exit 2; }
[ -t 0 ] || { echo "FATAL[$TAG]: Team2 Claude must run in a tmux PTY" >&2; exit 2; }

# npm-global 必须压过 /usr/bin：系统级 root 装的 claude 停在 2.1.80，认不了 fable-5-1
# （2026-09-11 三轮秒败根因：老版对新模型报「may not exist」误导为额度/别名问题）
export PATH="$HOME/.local/lib/npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# 2026-08-03: 参数化池选择（T1 Opus 蹬池等），默认仍 Team2；effort 可选透传
export CLAUDE_CONFIG_DIR="${WORKER_CLAUDE_CONFIG_DIR:-$HOME/.claude-team2}"
WORKER_CLAUDE_EFFORT="${WORKER_CLAUDE_EFFORT:-}"
umask 077

cd "$WT" || exit 2
rm -f "$FLAG"

RENDERER="${RENDER_CLAUDE_STREAM:-$HOME/code/worker-core/render_claude_stream.py}"
END=$(( $(date +%s) + MAX_SECONDS ))
i=0
fastfail=0
echo "=== $TAG TEAM2-$MODEL OBSERVABLE LOOP start $(date) ===" > "$LOG"

while [ ! -f "$FLAG" ] && [ "$(date +%s)" -lt "$END" ]; do
  i=$((i+1))
  echo "=== $TAG iter $i $(date) ===" | tee -a "$LOG"
  t0=$(date +%s)
  RAW="${CODEX_WORK_DIR:-$HOME/codex_work}/team2_trace_${TAG}_iter${i}.jsonl"
  TRACE="${CODEX_WORK_DIR:-$HOME/codex_work}/team2_trace_${TAG}_iter${i}.md"

  # 荣耻篇前置(主人 2026-07-31 令): 每个开发 worker 开工先自己打印设计荣耻母法，日志可查真读没读
  CODEX_DOC="${DCC_DESIGN_CODEX:-$HOME/code/worker-core/DCC_DESIGN_CODEX.md}"
  PREAMBLE=""
  [ -s "$CODEX_DOC" ] && PREAMBLE="【开工必做·第一动作】先执行 cat $CODEX_DOC，把《DCC 设计规范（荣耻篇）》全文打印在你的输出里（证明已读），并按其文头索引确认当日工作流纪律（WORKER_CORE.md / PR_REVIEW_RULES.md / ANIMATION_SOURCE_EXPORT_CONTRACT.md）。之后的所有设计与代码决策必须符合荣耻篇六铁律+七条，违者 PR 直接 FAIL。打印完成后再开始下面的任务书。

"
  EFFORT_ARGS=()
  [ -n "$WORKER_CLAUDE_EFFORT" ] && EFFORT_ARGS=(--effort "$WORKER_CLAUDE_EFFORT")
  claude -p "${PREAMBLE}$(cat "$PF")" \
    --model "$MODEL" "${EFFORT_ARGS[@]}" \
    --output-format stream-json \
    --verbose \
    --include-partial-messages \
    --dangerously-skip-permissions \
    2>&1 \
    | python3 -u "$RENDERER" --jsonl "$RAW" --markdown "$TRACE" \
    | tee -a "$LOG"
  pipe_status=("${PIPESTATUS[@]}")
  rc="${pipe_status[0]}"
  [ "$rc" -eq 0 ] && [ "${pipe_status[1]}" -ne 0 ] && rc="${pipe_status[1]}"
  [ "$rc" -eq 0 ] && [ "${pipe_status[2]}" -ne 0 ] && rc="${pipe_status[2]}"

  dur=$(( $(date +%s) - t0 ))
  echo "=== $TAG iter $i end exit=$rc dur=${dur}s $(date) ===" | tee -a "$LOG"

  if [ "$rc" -ne 0 ]; then
    tail -40 "$LOG" > "${CODEX_WORK_DIR:-$HOME/codex_work}/FAILSIG_$TAG" 2>/dev/null
  else
    rm -f "${CODEX_WORK_DIR:-$HOME/codex_work}/FAILSIG_$TAG"
  fi

  if [ "$rc" -ne 0 ] && [ "$dur" -lt 60 ]; then
    fastfail=$((fastfail+1))
    if [ "$fastfail" -ge 3 ]; then
      echo "FATAL[$TAG]: 3 consecutive fast failures" | tee -a "$LOG"
      touch "${CODEX_WORK_DIR:-$HOME/codex_work}/SPIN_$TAG"
      break
    fi
  else
    fastfail=0
  fi
  sleep 10
done

RESULT=$([ -f "$FLAG" ] && echo MET || echo TIMEOUT)
echo "=== $TAG LOOP_DONE flag=$RESULT iters=$i $(date) ===" | tee -a "$LOG"
curl -s -m 5 -d "worker[$TAG] LOOP_DONE $RESULT iters=$i" \
  http://10.18.8.55/zhiningwork >/dev/null 2>&1
