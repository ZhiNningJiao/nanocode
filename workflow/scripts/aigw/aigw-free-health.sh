#!/bin/bash
# aigw-free-health.sh — 自建/免费模型探活看板（owner 0812 令：史官每天看板 sgl 哪个免费 ai 活着）
# scripts_resume_2241 移植版：key 文件 / 网关 / 模型清单 / 状态文件全部显式可配。
# 输出人读一行/模型；同时原子写 state 供史官简报读取。
# 依赖: curl, awk；AIGW_KEY_FILE（默认 ~/.config/meshy-aigw.key）必须存在，缺失即 fail-loud。
KEY_FILE="${AIGW_KEY_FILE:-$HOME/.config/meshy-aigw.key}"
[ -s "$KEY_FILE" ] || { echo "aigw-free-health: AIGW key missing at $KEY_FILE (set AIGW_KEY_FILE)" >&2; exit 2; }
KEY=$(cat "$KEY_FILE")
AIGW_BASE="${AIGW_BASE:-https://aigw.meshy.team}"
ST="${AIGW_HEALTH_STATE:-$HOME/.local/state/aigw-free-health.txt}"
MODELS="${AIGW_HEALTH_MODELS:-litellm/SGLang-GLM-5.3-Flash litellm/Self-Hosted-Model litellm/SGLang-Kimi-latest}"  # 0828: 主力+兜底双腿全探
SHORT="${AIGW_HEALTH_SHORT:-GLM53 SelfHost KimiL}"
mkdir -p "$(dirname "$ST")"
i=0; parts=()
set -- $SHORT
for M in $MODELS; do
  i=$((i+1)); NAME=$(eval echo \$$i)
  T0=$(date +%s.%N)
  R=$(curl -s -m 75 "$AIGW_BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"max_tokens\":8}" 2>&1)
  DT=$(echo "$(date +%s.%N) $T0" | awk '{printf "%.1f", $1-$2}')
  if echo "$R" | grep -q '"choices"'; then
    echo "ALIVE ${DT}s $M"; parts+=("${NAME}✓${DT}s")
  else
    echo "DEAD  ${DT}s $M"; parts+=("${NAME}✗")
  fi
done
LINE="自建AI: ${parts[*]} ($(date '+%m-%d %H:%M'))"
echo "$LINE" > "$ST.tmp" && mv "$ST.tmp" "$ST"
echo "$LINE"
