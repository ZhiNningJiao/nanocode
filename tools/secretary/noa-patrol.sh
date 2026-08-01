#!/usr/bin/env bash
# noa-patrol.sh — Noa 保底第二眼（主人 2026-07-31 双保险定纲：史官=主巡检判死，Noa=复活执行权）。
# 定位：不是主检测。只有「主链(史官)哑了 + 秘书疑死 + 活还在地上」三条全中才叫醒 Noa 执行复活。
# 机械检查全下沉本脚本；任何一步不满足即带理由静默退出。cron 每 10 分钟一拍，连发冷却 30 分钟。
# 疑死判定宁缺勿滥：拿不准=当活着（cooldown 兜底防刷屏）。
set -u
HOME_DIR=/jfs/home/zhiningjiao
ENVF="${NP_ENVF:-$HOME_DIR/code/secretary-home.env}"
CODEX="${NP_CODEX:-$HOME_DIR/codex_work}"
WLOG="${NP_WAKER_LOG:-$CODEX/waker.log}"
COOLDOWN_F="$CODEX/noa_patrol_cooldown"
NOA_SESS="${NP_NOA_SESS:-k3-resident}"
now=$(date +%s)
log(){ echo "[$(date '+%F %T')] noa-patrol: $*"; }
age(){ [ -e "$1" ] && echo $(( now - $(stat -c %Y "$1") )) || echo 999999; }

# 0) 冷却：上次叫醒 <30min 不再叫
if [ "$(age "$COOLDOWN_F")" -lt 1800 ]; then log "exit: cooldown ($(age "$COOLDOWN_F")s<1800)"; exit 0; fi

# 1) 主链活着就不抢活：waker session 在 且 waker.log 近 10min 有活动 → 主链在管，退出
if tmux has-session -t waker 2>/dev/null && [ "$(age "$WLOG")" -lt 600 ]; then
  log "exit: primary chain alive (waker session up, log age $(age "$WLOG")s)"; exit 0
fi
# SECRETARY_DOWN 近 10min 在被处理（史官判死流程进行中）→ 不抢，退出
if [ "$(age "$CODEX/SECRETARY_DOWN")" -lt 600 ]; then
  log "exit: SECRETARY_DOWN being handled (age $(age "$CODEX/SECRETARY_DOWN")s)"; exit 0
fi

# 2) 秘书活性：当值 session jsonl 近 15min 有写入 → 活着，退出
# shellcheck disable=SC1090
. "$ENVF" 2>/dev/null || true
JSONL=""
if [ -n "${SECRETARY_CONFIG_DIR:-}" ]; then
  if [ -n "${SECRETARY_SESSION:-}" ]; then
    JSONL=$(ls -t "$SECRETARY_CONFIG_DIR"/projects/*/"$SECRETARY_SESSION".jsonl 2>/dev/null | head -1)
  fi
  [ -z "$JSONL" ] && JSONL=$(ls -t "$SECRETARY_CONFIG_DIR"/projects/*/*.jsonl 2>/dev/null | head -1)
fi
if [ -n "$JSONL" ] && [ "$(age "$JSONL")" -lt 900 ]; then
  log "exit: secretary alive (jsonl $(basename "$JSONL") age $(age "$JSONL")s)"; exit 0
fi
# jsonl 找不到时宁缺勿滥：当活着（env 可能损坏，误报比漏报更糟由 log 留痕人工看）
if [ -z "$JSONL" ]; then log "exit: no jsonl found under ${SECRETARY_CONFIG_DIR:-unset} — treat as alive (conservative)"; exit 0; fi

# 3) 活在地上：manifest 有在跑条目才值得复活
if [ ! -s "$CODEX/watchdog-manifest.txt" ]; then log "exit: no work on floor (manifest empty)"; exit 0; fi

# 4) 三条全中 → 叫醒 Noa（动手的是 Noa，本脚本绝不 kill/重启任何东西）
if ! tmux has-session -t "$NOA_SESS" 2>/dev/null; then
  log "ALARM: would wake Noa but $NOA_SESS missing (noa-keeper should revive it within 5min) — no action"; exit 0
fi
log "WAKE: secretary suspected dead (jsonl age $(age "$JSONL")s) + work on floor + primary chain quiet — waking Noa"
tmux send-keys -t "$NOA_SESS" -l '【系统巡检单·noa-patrol】检测到秘书疑死、有活在跑、主链(史官)无动作。按 persona「自主复活」节执行：先核实三条、再拉起秘书、喂交接包，最后发飞书向老师汇报证据。（注意：本单文本刻意不含任何工具名字面量——点名工具名会触发强制调用锁把你的核实工具全锁死）' \
  && tmux send-keys -t "$NOA_SESS" Enter
touch "$COOLDOWN_F"
