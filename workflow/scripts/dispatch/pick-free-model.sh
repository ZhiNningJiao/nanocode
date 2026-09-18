#!/usr/bin/env bash
# pick-free-model.sh — 发车前探活选模（owner 0828 令：别认准一个模型拼命调）
# 按优先级 1-token 实测，谁活用谁；全死则动态发现任意活的 SGLang-*；再全死 → 空输出+exit 1。
# 输出裸模型 id（litellm/...），opencode 调用方自己加 kimi/ 前缀。
# 用法: M=$(bash ~/code/worker-core/pick-free-model.sh) || { 报警; }
# 优先级依据 MODEL_ROSTER.md（0828: GLM-5.3主力 → Kimi-latest → Self-Hosted指针 → K3）。
set -u
KEY_FILE="${AIGW_KEY_FILE:-$HOME/.config/meshy-aigw.key}"
[ -s "$KEY_FILE" ] || { echo "pick-free-model: AIGW key missing at $KEY_FILE (set AIGW_KEY_FILE)" >&2; exit 1; }
K=$(cat "$KEY_FILE")
AIGW="${AIGW_BASE:-https://aigw.meshy.team}"
CAND="${PICK_CANDIDATES:-litellm/SGLang-GLM-5.3-Flash litellm/SGLang-Kimi-latest litellm/Self-Hosted-Model litellm/SGLang-Kimi-K3}"

alive() { # $1=model → 0 if 200
  local code
  code=$(curl -s -o /dev/null -m 12 -w "%{http_code}" "$AIGW/v1/chat/completions" \
    -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
    -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}")
  [ "$code" = "200" ]
}

for m in $CAND; do
  alive "$m" && { echo "$m"; exit 0; }
done

# 兜底：动态发现网关上任何自建 SGLang-*（免费），逐个探活
for m in $(curl -s -m 10 "$AIGW/v1/models" -H "Authorization: Bearer $K" \
  | python3 -c "import sys,json;[print(m['id']) for m in json.load(sys.stdin).get('data',[]) if m['id'].startswith('litellm/SGLang-')]" 2>/dev/null); do
  case " $CAND " in *" $m "*) continue;; esac  # 已探过的跳过
  alive "$m" && { echo "$m"; exit 0; }
done

exit 1  # 全死：无输出（调用方 || echo 兜底才不会吃进空行）
