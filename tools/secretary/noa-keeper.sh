#!/usr/bin/env bash
# noa-keeper.sh — Noa 容灾第二层（外部 cron，每 5 分钟）。
# 保证两个常驻 tmux session 活着且 pane 进程树里真实进程活着；tmux server 死 / 机器重启后也能拉回。
# ⭐ k3-resident 与 noa-bridge = 秘书复活兜底链路，绝对不许删除（memory project_k3_resident_slack_reviver）。
set -u
LOG_PREFIX="[$(date '+%F %T')] noa-keeper:"

# pane 进程树里是否有匹配 pattern 的活进程（避免把别处的测试实例当成本体）
pane_has_proc() {
  local sess="$1" pat="$2" pane_pid pids
  pane_pid=$(tmux list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1)
  [ -n "${pane_pid:-}" ] || return 1
  pids=$pane_pid
  for _ in 1 2 3 4; do
    local kids
    kids=$(pgrep -P "${pids// /,}" 2>/dev/null | tr '\n' ' ')
    [ -n "$kids" ] || break
    pids="$pids $kids"
  done
  for p in $pids; do
    ps -o args= -p "$p" 2>/dev/null | grep -qE "$pat" && return 0
  done
  return 1
}

ensure() {
  local sess="$1" procpat="$2" wrap="$3"
  if tmux has-session -t "$sess" 2>/dev/null; then
    if pane_has_proc "$sess" "$procpat"; then
      return 0
    fi
    echo "$LOG_PREFIX $sess alive but '$procpat' not in pane tree — respawn pane"
    tmux respawn-pane -k -t "$sess" "bash $wrap"
  else
    echo "$LOG_PREFIX $sess missing — recreate"
    tmux new-session -d -s "$sess" "bash $wrap"
  fi
}

ensure k3-resident "k3_resident\.mjs|k3_resident_wrap\.sh" /jfs/home/zhiningjiao/codex_work/k3_resident_wrap.sh
ensure noa-bridge  "slack .*A0BM30TU83U|noa_bridge_wrap\.sh" /jfs/home/zhiningjiao/codex_work/noa_bridge_wrap.sh
