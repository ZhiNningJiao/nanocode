#!/bin/bash
# waker.sh — bash entrypoint for the V2 smart waker (preserves the crontab/tmux
# contract `bash ~/code/waker.sh`). Delegates the smart logic to waker_core.py.
#
# V2 behaviour (busy-gate + signal-driven + rate-limited) lives in waker_core.py.
# DEFAULT = DRY-RUN: logs "would inject / why skip" to ~/codex_work/waker.log but
# NEVER sends to the secretary session. Coordinator must read waker.log, confirm,
# then start with  WAKE_LIVE=1  to cut over to real injection.
#
# Lives in tmux session "waker"; crontab self-heal respawns it:
#   */5 * * * * tmux has-session -t waker 2>/dev/null || tmux new-session -d -s waker 'bash ~/code/waker.sh'
#
# Env (all optional): WAKE_INTERVAL(270) WAKE_LIVE(0) WAKE_BUSY_SEC(180)
#   WAKE_HEARTBEAT_SEC(1200) WAKE_MIN_GAP(270) WAKE_HOURLY_CAP(6)
#   V6 节拍制: WAKE_BRIEF_INTERVAL(1200=20min 基拍) WAKE_RETRY_SEC(180=3min 退避)
#   WAKE_CONV_SEC(180=3min 在聊窗口) WAKE_STREAMING_SEC(8)
#
# V4 supplement (double-open prevention): kill any orphaned waker_core.py
# instances before starting a new one. The crontab only creates a new tmux
# session when the old one is gone, but a waker_core.py process may survive
# its parent tmux's death (detached). pkill cleans those up so the new
# instance is the sole one. waker_core.py also holds a flock as a
# belt-and-suspenders safety net.
set -u
# 2026-07-18: 绝对路径 source（tmux 冻结 HOME 老坑——$HOME 可能指旧 /storage 路径导致 env 没加载、简报投错 session）
. /jfs/home/zhiningjiao/code/secretary-home.env 2>/dev/null || [ -f "$HOME/code/secretary-home.env" ] && . "$HOME/code/secretary-home.env"
# 2026-07-31 T3F 修：旧模式 'waker_core\.py' 太宽——GLM worker 的 opencode 命令行嵌着任务书全文
# （含 waker_core.py 字样），每次史官重启把无辜 worker 连坐枪毙（qa_waker_akari_watch 连死 4 次）。
# 锚定：只杀「python3 起头 + waker_core.py 后断词」的真孤儿史官；draft 测试进程(.py.akari-draft)与
# opencode/timeout 包装进程都不再命中。
pkill -f '^python3 [^ ]*waker_core\.py( |$)' 2>/dev/null || true
sleep 1
export WAKE_BRIEF_INTERVAL="${WAKE_BRIEF_INTERVAL:-1800}"
export WAKE_RETRY_SEC="${WAKE_RETRY_SEC:-180}"
export WAKE_SURVIVAL_INTERVAL="${WAKE_SURVIVAL_INTERVAL:-999999999}"  # 空板彻底静默(主人令2026-07-23):任务结束史官停发,有新任务/信号自动恢复
exec python3 "$HOME/code/waker_core.py" "$@"
