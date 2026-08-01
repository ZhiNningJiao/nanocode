#!/bin/bash
# 每30min快照四池(T1/T2/T3/T4)官方用量端点，抓滞后结算跳变。零 LLM 成本。
# 2026-07-31 主人令：扩到四池 + 报恢复时间(5h reset)。
OUT=/jfs/home/zhiningjiao/codex_work/usage_snap.log
# 探测一池(D-3修复 2026-07-31 secmig_audit)：HTTP 码分诊 AUTH_EXPIRED/API_DOWN/HTTP_xxx，
# 200 时防御性解析(非用量 JSON 出 API_BADSHAPE，不再 KeyError 静默成无诊断 SNAP_ERR)
probe_pool() {
  local _resp _code _body
  _resp=$(curl -s -m 10 -w "\n%{http_code}" "https://api.anthropic.com/api/oauth/usage" -H "Authorization: Bearer $1" -H "anthropic-beta: oauth-2025-04-20")
  _code=$(printf '%s' "$_resp" | tail -n1)
  _body=$(printf '%s' "$_resp" | sed '$d')
  case "$_code" in
    401|403) echo "AUTH_EXPIRED" ;;   # token 过期 → 该池需重登/等 CC 刷新，重试无用
    5*|000)  echo "API_DOWN" ;;       # 宕/超时 → 值得重试
    200) printf '%s' "$_body" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: print('ERR'); raise SystemExit
fh=d.get('five_hour'); sd=d.get('seven_day'); eu=d.get('extra_usage')
if not (fh and sd and eu): print('API_BADSHAPE'); raise SystemExit
# 2026-07-23 主人令: Fable 周池(weekly_scoped)单独统计进报告
fable='?'; fbreset=''
for l in (d.get('limits') or []):
    sc=l.get('scope') or {}
    if l.get('kind')=='weekly_scoped' and (sc.get('model') or {}).get('display_name')=='Fable':
        fable=f\"{l.get('percent')}%\"; fbreset=l.get('resets_at') or ''
import datetime
def _hm(x):
    try: return datetime.datetime.fromisoformat(x).astimezone().strftime('%m-%dT%H:%M')
    except: return ''
r5=_hm(fh.get('resets_at') or ''); rfb=_hm(fbreset)
print(f\"5h={fh['utilization']}% 7d={sd['utilization']}% fable={fable} reset5h={r5} resetfb={rfb} extra={eu.get('used_credits')}\")" 2>/dev/null ;;
    *) echo "HTTP_${_code}" ;;
  esac
}

for cfg in /jfs/home/zhiningjiao/.claude /jfs/home/zhiningjiao/.claude-team2 /jfs/home/zhiningjiao/.claude-team3 /jfs/home/zhiningjiao/.claude-team4; do
  tok=$(python3 -c "import json;print(json.load(open('$cfg/.credentials.json'))['claudeAiOauth']['accessToken'])" 2>/dev/null)
  if [ -z "$tok" ]; then
    echo "$(date '+%m-%d %H:%M') $(basename $cfg): NOT_LOGGED_IN" >> "$OUT"
    continue
  fi
  snap=$(probe_pool "$tok")
  # 重试一次：仅对瞬时类(空/ERR/API_DOWN/429限流)；AUTH_EXPIRED 重试无用不重试(D-3)
  if [ -z "$snap" ] || [ "$snap" = "ERR" ] || [ "$snap" = "API_DOWN" ] || [ "$snap" = "HTTP_429" ]; then
    sleep 5
    snap=$(probe_pool "$tok")
    [ -z "$snap" ] && snap="SNAP_ERR"
  fi
  echo "$(date '+%m-%d %H:%M') $(basename $cfg): $snap" >> "$OUT"
done

# 2026-07-30 主人令：85% 阈值主动报警+搬家（T2F 爆池无交接事故复盘）。
# 当值秘书池(5h 或 fable周池) >=85 → 飞书报警 + 注入搬家指令。冷却 45min 防刷。
ALERT_THRESHOLD=85
COOLDOWN_FILE=/jfs/home/zhiningjiao/codex_work/.usage_alert_cooldown
. /jfs/home/zhiningjiao/code/secretary-home.env 2>/dev/null
CUR_CFG=$(basename "${SECRETARY_CONFIG_DIR:-/jfs/home/zhiningjiao/.claude}")
line=$(grep "$CUR_CFG:" "$OUT" | tail -1)
h5=$(echo "$line" | grep -o '5h=[0-9.]*' | cut -d= -f2 | cut -d. -f1)
fb=$(echo "$line" | grep -o 'fable=[0-9.]*' | cut -d= -f2 | cut -d. -f1)
breach=""
[ -n "$h5" ] && [ "$h5" -ge "$ALERT_THRESHOLD" ] && breach="5h=${h5}%"
[ -n "$fb" ] && [ "$fb" -ge "$ALERT_THRESHOLD" ] && breach="$breach fable=${fb}%"
if [ -n "$breach" ]; then
  now=$(date +%s); last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge 2700 ]; then
    echo "$now" > "$COOLDOWN_FILE"
    /jfs/home/zhiningjiao/.local/lib/npm-global/bin/lark-cli im +messages-send \
      --chat-id «FEISHU_CHAT_ID» --as bot --format json \
      --text "【史官85%报警】当值秘书($SECRETARY_TEAM tab ${WAKE_TAB}) 额度越线: $breach — 已注入搬家指令，秘书将按迁移SOP切到额度安全梯。" >/dev/null 2>&1
    NANO_PORT="${WAKE_PORT:-9475}" NANO_MATCH="$WAKE_TAB" SEND_NOW=1 \
      bash /jfs/home/zhiningjiao/code/wake-secretary.sh \
      "[史官85%报警] 你的池已 $breach（阈值85%），立即启动搬家：读 usage_snap.log 尾部做全池预检 → 按 ~/code/worker-core/SECRETARY_MIGRATION.md v3 + 复活梯度(T1F→T2F→Codex→T1O→T2O)选额度最安全梯 → 写 HANDOFF 交接包 → 建新tab注入接班 → 改 secretary-home.env+汇报cron+飞书桥 → 新秘书飞书报四要素。别等爆池。用 ~/code/secretary-takeover.sh 一键切换（幂等、四证合一，废除手动四处改）。" \
      >> /jfs/home/zhiningjiao/codex_work/report_cron.log 2>&1
  fi
fi
