#!/usr/bin/env bash
# Safe launcher for an observable Team2 Claude worker.
# scripts_resume_2241 port of ~/code/worker-core/start_team2_observable.sh:
#   CODEX_WORK_DIR   (default ~/codex_work)  FLAG/loop log/FAILSIG root
#   WORKER_CORE_DIR  (default ~/code/worker-core) runner + preamble doc source
#   AKARI_PORT       (default 9481)          akari health gate
#   FAILSIG_DIR      (default $CODEX_WORK_DIR)
set -euo pipefail

CODEX_WORK_DIR="${CODEX_WORK_DIR:-$HOME/codex_work}"
WORKER_CORE_DIR="${WORKER_CORE_DIR:-$HOME/code/worker-core}"
FAILSIG_DIR="${FAILSIG_DIR:-$CODEX_WORK_DIR}"

# ── [akarigate_r1] owner 0902 硬闸: 起 worker 必须走 akari, 否则硬报错停车 ──
# 放行条件 (满足其一): a) AKARI_WRAPPED=1  b) AKARI_REPAIR=1 且 akari 探活确实失败
# c) AKARI_EXEMPT 非空 (存量机器自动化白名单)
_akari_gate_ok() {
  [ "${AKARI_WRAPPED:-}" = "1" ] && return 0
  if [ "${AKARI_REPAIR:-}" = "1" ]; then
    if curl -sf -m 3 "http://127.0.0.1:${AKARI_PORT:-9481}/api/health" 2>/dev/null \
        | python3 -c 'import json,sys;sys.exit(0 if json.load(sys.stdin).get("ok") else 1)' 2>/dev/null; then
      return 1
    fi
    return 0
  fi
  [ -n "${AKARI_EXEMPT:-}" ] && return 0
  return 1
}
if ! _akari_gate_ok; then
  echo "==============================================================" >&2
  echo "[AKARI_GATE] 起 worker 必须走 akari (owner 0902 令)" >&2
  echo "  调用方应使用 akari_dispatch.sh 或设置 AKARI_EXEMPT" >&2
  echo "==============================================================" >&2
  printf '[AKARI_GATE_FAIL] %s start_team2_observable.sh 被闸拦截\n' "$(date '+%F %T')" \
    >> "$FAILSIG_DIR/FAILSIG_akari_gate_team2_${2:-notag}"
  exit 2
fi

if [ "$#" -lt 4 ] || [ "$#" -gt 6 ]; then
  echo "usage: $0 <tmux-session> <tag> <workdir> <TASK.md> [model=opus] [max_seconds=14400]" >&2
  exit 2
fi

SESSION="$1"
TAG="$2"
WT="$(realpath -m "$3")"
TASK="$(realpath -m "$4")"
MODEL="${5:-opus}"
MAX_SECONDS="${6:-14400}"
FLAG="$CODEX_WORK_DIR/FLAG_$TAG"
LOG="$CODEX_WORK_DIR/loop_team2_$TAG.log"
RUNNER="$WORKER_CORE_DIR/run_team2_observable.sh"

[[ "$SESSION" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "invalid tmux session" >&2; exit 2; }
[[ "$TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "invalid tag" >&2; exit 2; }
[ -d "$WT" ] || { echo "missing workdir: $WT" >&2; exit 2; }
[ -s "$TASK" ] || { echo "missing/empty task: $TASK" >&2; exit 2; }
[[ "$MAX_SECONDS" =~ ^[0-9]+$ ]] || { echo "invalid max_seconds" >&2; exit 2; }

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session already exists: $SESSION" >&2
  exit 3
fi

# tmux server 已在跑时不继承 caller env，池/effort 选择必须嵌进命令串（默认 Team2 不变）
printf -v command 'exec env CODEX_WORK_DIR=%q WORKER_CLAUDE_CONFIG_DIR=%q WORKER_CLAUDE_EFFORT=%q bash %q %q %q %q %q %q %q %q' \
  "$CODEX_WORK_DIR" \
  "${WORKER_CLAUDE_CONFIG_DIR:-$HOME/.claude-team2}" "${WORKER_CLAUDE_EFFORT:-}" \
  "$RUNNER" "$TAG" "$WT" "$FLAG" "$TASK" "$LOG" "$MODEL" "$MAX_SECONDS"
tmux new-session -d -s "$SESSION" "$command"

echo "session=$SESSION"
echo "tag=$TAG"
echo "flag=$FLAG"
echo "loop_log=$LOG"
echo "live: tmux attach -t $SESSION"
echo "trace: $CODEX_WORK_DIR/team2_trace_${TAG}_iter<N>.md"
