#!/usr/bin/env bash
# waker-keeper.sh — 史官容灾（外部 cron，每 5 分钟）。看门人也要有人看门（主人 2026-07-31 双保险定纲）。
# 只在 waker tmux session 整个消失时按标准命令拉回（ensure 型，绝不 kill/respawn 活着的——
# 不与 switch-secretary.sh 的 kill+new 打架：切换窗口期内 session 短暂缺席也只是多一次幂等 new，无害）。
set -u
LOG_PREFIX="[$(date '+%F %T')] waker-keeper:"
if ! tmux has-session -t waker 2>/dev/null; then
  echo "$LOG_PREFIX waker session missing — recreate"
  tmux new-session -d -s waker 'WAKE_LIVE=1 bash ~/code/waker.sh 2>>/jfs/home/zhiningjiao/codex_work/waker_stderr.log'
fi
