#!/bin/bash
# quota-watchdog.sh — 2 分钟级当值秘书额度探针 + 越线三路报警 + Noa 核验单（owner 2026-07-31）
#
# 只探当值秘书池（source ~/code/secretary-home.env → SECRETARY_CONFIG_DIR 对应 token）。
# 探针代码照抄 usage-snap.sh（curl oauth/usage + 解析 5h/fable），不改 usage-snap.sh 本身。
# ≥85%（5h 或 fable 周池任一）→ 三路：飞书 Yuka + 注入当值秘书搬家 + 投 Noa 核验单。冷却 15min。
# 探测连续 5 次 SNAP_ERR（=10min 盲区）→ 飞书警告一次（同冷却机制，绝不静默）。
#
# 自测开关（环境变量）：
#   ALERT_THRESHOLD=N  覆盖阈值（默认 85；自测用 1 强制越线 / 95 强制不越线）
#   DRY_INJECT=1        注入当值秘书改用 echo（不真吵秘书）；飞书仍真发、Noa .task 仍真写
#   SIM_PROBE_FAIL=1   探针直接返回 NO_TOKEN（模拟探测失败，专测 fail-loud；默认关，cron 不受影响）
#
# cron：*/2 * * * * bash /jfs/home/zhiningjiao/code/quota-watchdog.sh >> /jfs/home/zhiningjiao/codex_work/quota_watchdog_cron.log 2>&1
set -u

HOME_DIR=/jfs/home/zhiningjiao
CODE_DIR="$HOME_DIR/code"
CODEX_WORK="$HOME_DIR/codex_work"
LOG="$CODEX_WORK/quota_watchdog.log"                          # 快照追加（自轮转）
COOLDOWN_FILE="$CODEX_WORK/.quota_watchdog_alert_cooldown"   # 报警冷却（独立于 usage-snap）
ERR_COOLDOWN_FILE="$CODEX_WORK/.quota_watchdog_err_cooldown" # 探测失败冷却
ERR_COUNT_FILE="$CODEX_WORK/.quota_watchdog_err_count"       # 连续 SNAP_ERR 计数
INBOX="$CODEX_WORK/k3_resident_inbox"
LARK=/jfs/home/zhiningjiao/.local/lib/npm-global/bin/lark-cli
FEISHU_CHAT=«FEISHU_CHAT_ID»
ALERT_THRESHOLD="${ALERT_THRESHOLD:-85}"
COOLDOWN_SEC=900   # 15min
DRY_INJECT="${DRY_INJECT:-0}"
SIM_PROBE_FAIL="${SIM_PROBE_FAIL:-0}"

# ── 当值秘书住址（脚本运行时是 bash，无 Read 权限限制）──
ENV_FILE="$CODE_DIR/secretary-home.env"
# shellcheck disable=SC1091
. "$ENV_FILE" 2>/dev/null || true
SECRETARY_CONFIG_DIR="${SECRETARY_CONFIG_DIR:-$HOME_DIR/.claude}"
SECRETARY_TEAM="${SECRETARY_TEAM:-UNKNOWN}"
WAKE_PORT="${WAKE_PORT:-9475}"
WAKE_TAB="${WAKE_TAB:-}"
CUR_CFG=$(basename "$SECRETARY_CONFIG_DIR")

# ── 探针：照抄 usage-snap.sh 的 curl oauth/usage + 解析 5h/7d/fable/extra，带一次重试 ──
probe_usage() {
  local cfg="$1" tok snap
  [ "$SIM_PROBE_FAIL" = "1" ] && { echo "NO_TOKEN"; return; }
  tok=$(python3 -c "import json;print(json.load(open('$cfg/.credentials.json'))['claudeAiOauth']['accessToken'])" 2>/dev/null)
  [ -z "$tok" ] && { echo "NO_TOKEN"; return; }
  snap=$(curl -s -m 10 "https://api.anthropic.com/api/oauth/usage" -H "Authorization: Bearer $tok" -H "anthropic-beta: oauth-2025-04-20" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: print('ERR'); raise SystemExit
fable='?'
for l in (d.get('limits') or []):
    sc=l.get('scope') or {}
    if l.get('kind')=='weekly_scoped' and (sc.get('model') or {}).get('display_name')=='Fable':
        fable=f\"{l.get('percent')}%\"
print(f\"5h={d['five_hour']['utilization']}% 7d={d['seven_day']['utilization']}% fable={fable} extra={d['extra_usage']['used_credits']}\")" 2>/dev/null)
  # 空或 ERR 重试一次（瞬态 API 失败 = 报警盲区，照抄 usage-snap.sh）
  if [ -z "$snap" ] || [ "$snap" = "ERR" ]; then
    sleep 5
    snap=$(curl -s -m 10 "https://api.anthropic.com/api/oauth/usage" -H "Authorization: Bearer $tok" -H "anthropic-beta: oauth-2025-04-20" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: print('ERR'); raise SystemExit
fable='?'
for l in (d.get('limits') or []):
    sc=l.get('scope') or {}
    if l.get('kind')=='weekly_scoped' and (sc.get('model') or {}).get('display_name')=='Fable':
        fable=f\"{l.get('percent')}%\"
print(f\"5h={d['five_hour']['utilization']}% 7d={d['seven_day']['utilization']}% fable={fable} extra={d['extra_usage']['used_credits']}\")" 2>/dev/null)
    [ -z "$snap" ] && snap="SNAP_ERR"
  fi
  echo "$snap"
}

# ── 探测 ──
snap=$(probe_usage "$SECRETARY_CONFIG_DIR")
ts=$(date '+%m-%d %H:%M:%S')
echo "$ts $CUR_CFG($SECRETARY_TEAM): $snap" >> "$LOG"

# ── 快照日志自轮转：超 4000 行截一半（防两分钟级刷爆）──
lines=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
if [ -n "$lines" ] && [ "$lines" -gt 4000 ]; then
  half=$((lines / 2))
  tmpf="${LOG}.rot.$$"
  tail -n "$half" "$LOG" > "$tmpf" 2>/dev/null && mv "$tmpf" "$LOG"
fi

# ── 旁路：写 crontab 快照到 codex_work（Noa 的 run_shell_readonly 白名单无 crontab，
#    Noa 核验清单第3步靠 read_file 读这个快照比对 NANO_MATCH）。每次运行覆盖，不增长。
crontab -l > "$CODEX_WORK/crontab_snapshot.txt" 2>/dev/null || true

# ── 探测失败 fail-loud ──
is_err=0
[ "$snap" = "SNAP_ERR" ] || [ "$snap" = "ERR" ] || [ "$snap" = "NO_TOKEN" ] && is_err=1
if [ "$is_err" = "1" ]; then
  cnt=$(cat "$ERR_COUNT_FILE" 2>/dev/null | tr -d ' ')
  [ -z "$cnt" ] && cnt=0
  cnt=$((cnt + 1))
  echo "$cnt" > "$ERR_COUNT_FILE"
  echo "[quota-watchdog] probe FAIL #$cnt: $snap (pool=$CUR_CFG/$SECRETARY_TEAM)"
  if [ "$cnt" -ge 5 ]; then
    now=$(date +%s); last=$(cat "$ERR_COOLDOWN_FILE" 2>/dev/null | tr -d ' ')
    [ -z "$last" ] && last=0
    if [ $((now - last)) -ge $COOLDOWN_SEC ]; then
      echo "$now" > "$ERR_COOLDOWN_FILE"
      feishu_out=$($LARK im +messages-send --chat-id "$FEISHU_CHAT" --as bot --format json \
        --text "【史官2min探测失败】当值秘书($SECRETARY_TEAM $CUR_CFG) 连续 ${cnt} 次探测失败($((cnt*2))min 盲区) — 额度监控失明，请检查 token/网络。$([ "$DRY_INJECT" = "1" ] && echo 【测试】)" 2>&1)
      echo "[quota-watchdog] probe-fail feishu: count=$cnt out=$(echo "$feishu_out" | tr '\n' ' ' | cut -c1-200)"
    else
      echo "[quota-watchdog] probe-fail feishu cooldown (last=$last now=$now)"
    fi
  fi
  exit 0
fi

# ── 探测成功 → 重置失败计数 ──
echo 0 > "$ERR_COUNT_FILE"

# ── 越线判定：5h 或 fable 周池任一 ≥ 阈值 ──
h5=$(echo "$snap" | grep -o '5h=[0-9.]*' | cut -d= -f2 | cut -d. -f1)
fb=$(echo "$snap" | grep -o 'fable=[0-9.]*' | cut -d= -f2 | cut -d. -f1)
breach=""
[ -n "$h5" ] && [ "$h5" -ge "$ALERT_THRESHOLD" ] && breach="5h=${h5}%"
[ -n "$fb" ] && [ "$fb" -ge "$ALERT_THRESHOLD" ] && breach="$breach fable=${fb}%"

if [ -n "$breach" ]; then
  now=$(date +%s); last=$(cat "$COOLDOWN_FILE" 2>/dev/null | tr -d ' ')
  [ -z "$last" ] && last=0
  if [ $((now - last)) -ge $COOLDOWN_SEC ]; then
    echo "$now" > "$COOLDOWN_FILE"
    # 测试标注：自测开关触发时飞书带「测试」字样（DRY_INJECT=1 或 阈值被覆盖）
    TEST_TAG=""
    if [ "$DRY_INJECT" = "1" ] || [ "$ALERT_THRESHOLD" != "85" ]; then TEST_TAG="【测试】"; fi
    # a. 飞书 Yuka（chat oc_...，lark-cli im +messages-send）— fail-loud：捕获返回验证投递
    feishu_out=$($LARK im +messages-send --chat-id "$FEISHU_CHAT" --as bot --format json \
      --text "【史官2min报警】${TEST_TAG}当值秘书($SECRETARY_TEAM tab ${WAKE_TAB:-?}) 额度越线: $breach — 已注入接管指令+投 Noa 核验单，提示接管。" 2>&1)
    feishu_ok=$(echo "$feishu_out" | grep -ciE '"ok"\s*:\s*true|message_id|msg_type|"code"\s*:\s*0' || true)
    echo "[quota-watchdog] ALERT feishu sent: breach=$breach tag=$TEST_TAG ok_marker=$feishu_ok out=$(echo "$feishu_out" | tr '\n' ' ' | cut -c1-200)"
    # b. 注入当值秘书搬家（DRY_INJECT=1 时 echo 护住不真吵秘书）
    TAKEOVER_MSG="[史官2min报警] 你的池已 $breach（阈值${ALERT_THRESHOLD}%），立即启动搬家：读 usage_snap.log 尾部四池实况 → 按 SECRETARY_MIGRATION.md **v4 额度感知梯度**选池（最空闲且未死的 Fable 池优先，都紧比 reset 谁先到；秘书统一 fable，绝不落 Opus；Codex 仅全池皆死兜底）→ 写 HANDOFF 交接包 → bash ~/code/secretary-takeover.sh <TEAM> 一键切换（自动 compact/四指针/duty-status/飞书/Noa 单）→ 向新 tab 注入接班指令 → 新秘书飞书报四要素。别等爆池。"
    if [ "$DRY_INJECT" = "1" ]; then
      echo "[quota-watchdog] DRY_INJECT=1 — NOT injecting secretary (port=$WAKE_PORT tab=$WAKE_TAB): $TAKEOVER_MSG"
    else
      NANO_PORT="$WAKE_PORT" NANO_MATCH="$WAKE_TAB" SEND_NOW=1 \
        bash "$CODE_DIR/wake-secretary.sh" "$TAKEOVER_MSG" \
        >> "$CODEX_WORK/report_cron.log" 2>&1
      echo "[quota-watchdog] secretary injected (port=$WAKE_PORT tab=$WAKE_TAB)"
    fi
    # c. 投 Noa 核验单
    hts=$(date +%s)
    taskfile="$INBOX/handover_check_${hts}.task"
    mkdir -p "$INBOX"
    cat > "$taskfile" <<'EOF'
读 ~/codex_work/NOA_TAKEOVER_MANUAL.md，按清单核验 T1/T2 交接是否成功，结论用 feishu_report 发主人。
EOF
    echo "[quota-watchdog] Noa handover check dropped: $taskfile"
  else
    echo "[quota-watchdog] breach=$breach but cooldown active (last=$last now=$now) — skip"
  fi
else
  echo "[quota-watchdog] ok: $snap (threshold=$ALERT_THRESHOLD) — no breach"
fi
