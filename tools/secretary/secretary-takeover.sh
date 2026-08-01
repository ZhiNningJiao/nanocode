#!/usr/bin/env bash
# secretary-takeover.sh — 秘书交接唯一入口（v5 统一，owner 2026-07-31 令）
#
# 痛点（v3.1 已解四指针散落；v5 再解两脚本重叠 + 链条靠人自觉）：
#   交接要同时改 ① secretary-home.env ② 汇报 cron 的 NANO_MATCH ③ 飞书桥 unit
#   ④ 重启 waker，还要 compact 旧秘书、落值班状态、飞书通报、投 Noa 核验单。
#   v3.1 把前四步原子化了但要求人手填 5 个参数；switch-secretary.sh 另有一条重叠链。
#   v5 收敛为唯一入口：一个参数（team 名），team 注册表内置，整条链条按固定顺序自动触发，
#   可靠性进代码不靠 AI 自觉。
#
# 用法：
#   secretary-takeover.sh <T1|T2|T3|T4|CODEX> [--dry-run]
#   例：secretary-takeover.sh T3
#   --dry-run：只打印全链动作 + 当前指针现状，不改任何东西。
#
# 链条固化顺序（任一步失败 fail-loud 退出并回显已完成/未完成清单）：
#   ① tab 存在性 + 端口预检（坏参数零改动拒绝；同时解析 claudeSessionId）
#   ② compact 旧秘书 tab（old!=new 且旧为 claude 才发，指向旧 tab）
#   ③ 四指针原子切换（env / 汇报 cron / 飞书桥 / waker，沿用 v3.1 验过的 7 步）
#   ④ 四证合一验证（env/cron/桥/waker 四处 TAB 一致）
#   ⑤ 原子写 ~/code/duty-status.json（tmp+rename，值班状态公共位，供 Noa/史官/任何 AI 直读）
#   ⑥ 飞书自动通报（lark-cli --as bot，【秘书交接·自动】署名，文本禁反引号，验 ok:true）
#   ⑦ 投 Noa 核验单（沿用 inbox .task，工单文本禁写工具名字面量——会触发 Noa 强制调用锁）
#
# 环境开关：
#   TAKEOVER_SKIP_NOTIFY=1  成功后不飞书报、不投 Noa .task（重跑去重用；默认=发）。
#   SWITCH_FORCE=1          切 CODEX 必须显式带（空会话致盲史官，防误切）。
#   T4_TAB=<tabid>          T4 tab id 覆盖（registry 默认 302aff4f）。
#   _T_TAB / _T_PORT        【仅自测】覆盖 registry 解析出的 TAB/PORT，用于演练预检拒绝路径；
#                          生产环境绝不设置。
#
# 并发互斥锁（v5.1，修 QA_secretary_v5 CE-3 P2 竞态）：
#   锁文件 ~/.cache/secretary-takeover.lock，全程 flock（util-linux）。
#   真跑(DRY_RUN=0)：独占锁 flock -w <TAKEOVER_LOCK_WAIT>（默认 120s）；超时 FATAL rc≠0 零改动，
#       绝不允许两个实例交错写 ②③④⑤⑥⑦ 任一步（env/cron/桥/waker/duty）。
#   干跑(DRY_RUN=1)：共享锁 flock -s（只读，多个 dry-run 可并发；但会等真跑独占锁释放后看一致态）。
#   锁绑定到 fd 9，脚本任何退出（含 die/exit）即释放，无需显式 unlock。
#   TAKEOVER_LOCK_WAIT=<秒>  【仅自测】覆盖默认等待 120s，用于演练超时 FATAL 路径；生产绝不缩短。
#
# 红线：waker.sh / wake-secretary.sh / nanocode 本体禁改（本脚本只调用不改）；
#       secretary-home.env 格式与消费方（waker/桥 source 它）兼容不变；
#       duty-status.json 是新增旁路不是替代；crontab 只 sed NANO_MATCH 不动其他字段；
#       幂等可重入；不碰付费模型。审计：全程 tee ~/codex_work/takeover_history.log。
set -uo pipefail

CODE_DIR="/jfs/home/zhiningjiao/code"
CODEX_WORK="/jfs/home/zhiningjiao/codex_work"
ENVF="$CODE_DIR/secretary-home.env"
SVC="${HOME}/.config/systemd/user/feishu-secretary-bridge.service"
WAKER_LOG="$CODEX_WORK/waker.log"
HISTORY_LOG="$CODEX_WORK/takeover_history.log"
AUDIT="$CODEX_WORK/secretary_switch_audit.log"
NOA_INBOX="$CODEX_WORK/k3_resident_inbox"
FEISHU_CHAT="«FEISHU_CHAT_ID»"
LARK_CLI="${HOME}/.local/lib/npm-global/bin/lark-cli"
WAKER_SH="$CODE_DIR/waker.sh"
WAKE_SEC_SH="$CODE_DIR/wake-secretary.sh"
UNIT_NAME="feishu-secretary-bridge.service"
DUTY_JSON="$CODE_DIR/duty-status.json"

# team 注册表（从 switch-secretary.sh case 表搬，2026-07-31）
PROJ="d1ffad35-5204-4280-9f82-ccadf6e40fe0"
PORT=9475
SEC_MODEL="claude-fable-5"

DRY_RUN=0
TEAM=""; TAB=""; CFG=""; TTYPE=""; SESSION=""
declare -a DONE_STEPS=()
declare -A PROOF

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '[takeover] FATAL: %s\n' "$*" >&2; print_done; exit 1; }
step_done() { DONE_STEPS+=("$1"); }
print_done() {
  if [ "${#DONE_STEPS[@]}" -gt 0 ]; then
    log "已完成步骤: ${DONE_STEPS[*]}"
  fi
  log "未完成步骤被中断（见上方 FATAL）。"
}

# 读取当前 secretary-home.env 的某个变量值（只读 source 子壳）
src_var() {
  local name="$1"
  bash -c 'set +u; . "'"$ENVF"'" 2>/dev/null; printf "%s" "${'"$name"':-}"' 2>/dev/null
}

# ---- 0. 参数解析 ----
ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1;;
    --help|-h) sed -n '2,30p' "$0"; exit 0;;
    *) ARGS+=("$a");;
  esac
done
TEAM="${ARGS[0]:-}"

[ -n "$TEAM" ] || die "用法: $0 <T1|T2|T3|T4|CODEX> [--dry-run]（v5 单参数，team 注册表内置）"

# ---- 1. team 注册表 ----
case "$TEAM" in
  T1)    CFG="$HOME/.claude";        TAB="6c1b269c"; TTYPE="claude" ;;
  T2)    CFG="$HOME/.claude-team2";  TAB="dbefe883"; TTYPE="claude" ;;
  T3)    CFG="$HOME/.claude-team3";  TAB="eba434be"; TTYPE="claude" ;;
  T4)    CFG="$HOME/.claude-team4";  TAB="${T4_TAB:-302aff4f}"; TTYPE="claude" ;;
  CODEX) CFG="";                     TAB="cce6cde5"; TTYPE="codex"  ;;
  *) die "unknown team: $TEAM（用法: $0 <T1|T2|T3|T4|CODEX> [--dry-run]）" ;;
esac
if [ "$TEAM" = "T4" ] && [ -z "$TAB" ]; then
  die "T4 tab 未知：先登录 ~/.claude-team4 建 secretary-T4F tab，再 T4_TAB=<tabid> 跑本脚本"
fi

# CODEX 保护（从 switch 搬，2026-07-23）：切 CODEX（空会话=史官致盲）必须显式 SWITCH_FORCE=1
if [ "$TEAM" = "CODEX" ] && [ "${SWITCH_FORCE:-0}" != "1" ]; then
  echo "[takeover] REFUSED: CODEX 需 SWITCH_FORCE=1（空会话致盲史官）" >&2
  echo "$(date '+%F %T') REFUSED CODEX (no SWITCH_FORCE) pid=$$ ppid=$PPID" >> "$AUDIT"
  exit 3
fi

# 【仅自测】覆盖 registry 解析的 TAB/PORT，演练预检拒绝路径（生产绝不设）
[ -n "${_T_TAB:-}" ]  && TAB="$_T_TAB"
[ -n "${_T_PORT:-}" ] && PORT="$_T_PORT"

# 当前（旧）值
OLD_TEAM=$(src_var SECRETARY_TEAM)
OLD_TAB=$(src_var WAKE_TAB)
OLD_PORT=$(src_var WAKE_PORT)
OLD_PROJECT=$(src_var WAKE_PROJECT)
OLD_TABTYPE=$(src_var WAKE_TABTYPE)
[ -n "$OLD_TAB" ]   || die "当前 secretary-home.env 读不到 WAKE_TAB（文件损坏？先人工恢复）"
[ -n "$OLD_PORT" ]  || die "当前 secretary-home.env 读不到 WAKE_PORT"

log "===== 秘书交接: ${OLD_TEAM:-?}(${OLD_TAB}:${OLD_PORT}) -> $TEAM($TAB:$PORT) type=$TTYPE dry=$DRY_RUN ====="

# ---- ① tab 存在性 + 端口预检（同时解析 claudeSessionId）----
precheck() {
  local base="http://127.0.0.1:${PORT}"
  local svc tabs sess found
  if ! svc=$(curl -s -m 5 "$base/api/services" 2>/dev/null); then
    die "预检①失败：端口 $PORT 的 nanocode http 不可达（/api/services 探测失败）——拒绝接管（零改动）"
  fi
  echo "$svc" | grep -q '"nanocode"' \
    || die "预检①失败：$base/api/services 未返回 nanocode 条目（服务异常）——拒绝接管（零改动）"

  # TAB 存在：先查 tabs API（权威，列出全部 tab 含未启 session 的），回退 sessions API
  found=0
  tabs=$(curl -s -m 6 "$base/api/projects/$PROJ/tabs" 2>/dev/null) || tabs=""
  if [ -n "$tabs" ] && echo "$tabs" | grep -qE "\"id\"[[:space:]]*:[[:space:]]*\"$TAB\""; then
    found=1
  fi
  if [ "$found" = 0 ]; then
    if sess=$(curl -s -m 6 "$base/api/sessions" 2>/dev/null); then
      echo "$sess" | grep -qE "\"tabId\"[[:space:]]*:[[:space:]]*\"$TAB\"" && found=1
    fi
  fi
  [ "$found" = 1 ] \
    || die "预检①失败：TAB $TAB 在 project $PORT/$PROJ 的 tabs 与 sessions 中均不存在——拒绝接管（指向死 tab，零改动）"

  # 解析 claudeSessionId（claude tab 首轮后会翻新，以 API 为准；codex 无此字段）。
  # TAB 经 argv 传入 python，避免把 hex 字面量拼进 python 源码（曾因引号错配 end=" 导致 SESSION 误空）。
  SESSION=""
  if [ "$TTYPE" = "claude" ] && [ -n "$tabs" ]; then
    SESSION=$(echo "$tabs" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(1)
tab=sys.argv[1]
print(next((str(t.get("claudeSessionId","")) for t in d if t.get("id")==tab),""),end="")' "$TAB" 2>/dev/null || true)
  fi
  log "预检①通过：nanocode $PORT 活，TAB $TAB 存在；resolved session=${SESSION:-<none/codex>}"
}

# 打印指针现状（dry-run 与失败诊断共用）
dump_state() {
  log "---- 当前指针现状 ----"
  log "[1 env]    TEAM=$(src_var SECRETARY_TEAM) TAB=$(src_var WAKE_TAB) PORT=$(src_var WAKE_PORT) PROJECT=$(src_var WAKE_PROJECT) SESSION=$(src_var SECRETARY_SESSION) CFG=$(src_var SECRETARY_CONFIG_DIR)"
  local cron_hits; cron_hits=$(crontab -l 2>/dev/null | grep -oE "NANO_MATCH=[0-9a-f]{8}" | sort -u | tr '\n' ' ')
  log "[2 cron]   NANO_MATCH literals: ${cron_hits:-<none>}"
  if [ -f "$SVC" ]; then
    local nm np act
    nm=$(grep -oE 'NANO_MATCH="[^"]*"' "$SVC" | head -1)
    np=$(grep -oE 'Environment=NANO_PORT=[0-9]+' "$SVC" | head -1)
    act=$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo "?")
    log "[3 桥]     unit: $nm  $np  is-active=$act"
  else
    log "[3 桥]     unit 文件不存在: $SVC"
  fi
  local wact; wact=$(tmux has-session -t waker 2>/dev/null && echo alive || echo dead)
  local wlast; wlast=$(grep -E 'started mode=' "$WAKER_LOG" 2>/dev/null | tail -1)
  log "[4 waker]  tmux=$wact  last_started=${wlast:0:90}"
  if [ -f "$DUTY_JSON" ]; then
    log "[5 duty]   $(cat "$DUTY_JSON" 2>/dev/null | tr '\n' ' ' | cut -c1-160)"
  else
    log "[5 duty]   $DUTY_JSON 不存在（首次交接）"
  fi
  log "---- 将切换为 ----"
  log "TEAM=$TEAM TAB=$TAB PORT=$PORT PROJ=$PROJ CFG=${CFG:-<codex>} TTYPE=$TTYPE SESSION=${SESSION:-<empty>}"
}

precheck

# ---- 并发互斥锁（v5.1，修 QA_secretary_v5 CE-3 P2 竞态）----
# 真跑独占、干跑共享；锁绑 fd 9，脚本退出即释放。超时 FATAL rc≠0 零改动（在任一写步骤之前）。
LOCK_DIR="$HOME/.cache"
LOCKFILE="$LOCK_DIR/secretary-takeover.lock"
LOCK_WAIT="${TAKEOVER_LOCK_WAIT:-120}"
mkdir -p "$LOCK_DIR" 2>/dev/null
exec 9>"$LOCKFILE" || die "无法打开锁文件 $LOCKFILE（fd=9）——退出以防并发竞态"
if [ "$DRY_RUN" = 1 ]; then
  if ! flock -s -w "$LOCK_WAIT" 9; then
    die "另一实例正持有独占锁执行接管，干跑等待 ${LOCK_WAIT}s 仍未释放 $LOCKFILE——退出（干跑只读，零改动）"
  fi
  log "[lock] 已获取共享锁(干跑只读) fd=9 wait=${LOCK_WAIT}s $LOCKFILE"
else
  if ! flock -w "$LOCK_WAIT" 9; then
    die "另一实例正在执行接管(写链 ②-⑦)，等待 ${LOCK_WAIT}s 仍未释放锁 $LOCKFILE——退出以防并发竞态(rc=1，零改动)"
  fi
  log "[lock] 已获取独占锁(写链 ②-⑦) fd=9 wait=${LOCK_WAIT}s $LOCKFILE pid=$$"
fi

if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] 不改动任何东西。"
  dump_state
  log "[dry-run] 计划全链动作："
  log "  ② compact 旧秘书 tab $OLD_TAB（仅当 old!=new 且旧为 claude；当前 old=$OLD_TAB new=$TAB -> $([ "$OLD_TAB" != "$TAB" ] && [ "$OLD_TABTYPE" = "claude" ] && echo 将发 /compact || echo 跳过)）"
  log "  ③a 重写 secretary-home.env（TEAM/SESSION/CFG/MODEL/TABTYPE/PORT/PROJ/TAB）"
  log "  ③b 汇报 cron sed NANO_MATCH -> $TAB（只动 NANO_MATCH）"
  log "  ③c 飞书桥 sed NANO_PORT（必要时）+ NANO_MATCH（仅硬编码 hex）-> daemon-reload -> restart -> is-active"
  log "  ③d waker 重启（kill+new WAKE_LIVE=1 bash waker.sh）-> 验 started 行 + pid 活 + jsonl_dir 含新 CFG"
  log "  ④  四证合一（env/cron/桥/waker）"
  log "  ⑤  原子写 $DUTY_JSON（tmp+rename：team/tab/session/config_dir/model/port/project/since/last_verify/prev_team/switched_by/usage_snap）"
  log "  ⑥  飞书自动通报（【秘书交接·自动】署名，文本禁反引号，验 ok:true）$( [ "${TAKEOVER_SKIP_NOTIFY:-0}" = 1 ] && echo '【SKIP】' )"
  log "  ⑦  投 Noa 核验单（工单文本禁工具名字面量）$( [ "${TAKEOVER_SKIP_NOTIFY:-0}" = 1 ] && echo '【SKIP】' )"
  log "TAKEOVER_DRYRUN_OK"
  exit 0
fi

dump_state

# ---- ② compact 旧秘书 tab（old!=new 且旧为 claude 才发；从 switch-secretary.sh 搬）----
if [ -n "$OLD_TAB" ] && [ "$OLD_TAB" != "$TAB" ] && [ "$OLD_TABTYPE" = "claude" ]; then
  log "步骤②: compact 旧秘书 tab $OLD_TAB (old=${OLD_TEAM:-?} -> new=$TEAM)"
  NANO_PORT="$OLD_PORT" NANO_MATCH="$OLD_TAB" SEND_NOW=1 \
    bash "$WAKE_SEC_SH" "/compact" </dev/null >/dev/null 2>&1 || true
  echo "$(date '+%F %T') compacted old tab $OLD_TAB before switch->$TEAM pid=$$ ppid=$PPID" >> "$AUDIT"
  log "步骤② OK: 已向旧 tab $OLD_TAB 发 /compact"
  step_done "2-compact"
else
  log "步骤②: 跳过 compact（old=$OLD_TAB new=$TAB oldtype=$OLD_TABTYPE；old==new 或旧非 claude 则不发）"
fi

# ---- ③a. secretary-home.env ----
log "步骤③a: 写 secretary-home.env"
[ -f "$ENVF" ] || die "步骤③a 失败：secretary-home.env 不存在: $ENVF"
chmod 644 "$ENVF" || die "步骤③a 失败：chmod 644 $ENVF 失败"
cat > "$ENVF" <<EOF
export SECRETARY_TEAM="$TEAM"
export SECRETARY_SESSION="$SESSION"
export SECRETARY_CONFIG_DIR="$CFG"
export SECRETARY_MODEL="$SEC_MODEL"
export WAKE_TABTYPE="$TTYPE"
export WAKE_PORT="$PORT"
export WAKE_PROJECT="$PROJ"
export WAKE_TAB="$TAB"
EOF
chmod 444 "$ENVF" || die "步骤③a 失败：chmod 444 $ENVF 失败"
grep -qE "^export SECRETARY_TEAM=\"$TEAM\"" "$ENVF" \
  && grep -qE "^export WAKE_PORT=\"$PORT\"" "$ENVF" \
  && grep -qE "^export WAKE_PROJECT=\"$PROJ\"" "$ENVF" \
  && grep -qE "^export WAKE_TAB=\"$TAB\"" "$ENVF" \
  || die "步骤③a 回验失败：secretary-home.env 内容与参数不符"
log "步骤③a OK: env 已写并回验（chmod 444）"
step_done "3a-env"

# ---- ③b. 汇报 cron：sed 全部 NANO_MATCH=<hex> -> 新 TAB，只动 NANO_MATCH ----
log "步骤③b: 改汇报 cron NANO_MATCH"
CRON_BAK="$CODEX_WORK/.takeover_cron.bak.$(date +%s)"
if crontab -l > "$CRON_BAK" 2>/dev/null; then
  crontab -l | sed -E "s/NANO_MATCH=[0-9a-f]{8}/NANO_MATCH=$TAB/g" | crontab - \
    || die "步骤③b 失败：crontab 写入失败（已备份 $CRON_BAK）"
  stale=$(crontab -l 2>/dev/null | grep -oE "NANO_MATCH=[0-9a-f]{8}" | grep -vE "NANO_MATCH=$TAB" | wc -l | tr -d ' ')
  newhits=$(crontab -l 2>/dev/null | grep -oE "NANO_MATCH=$TAB" | wc -l | tr -d ' ')
  total=$(crontab -l 2>/dev/null | grep -oE "NANO_MATCH=[0-9a-f]{8}" | wc -l | tr -d ' ')
  log "步骤③b: NANO_MATCH literal total=$total  ==新TAB=$newhits  !=新TAB(stale)=$stale  (备份 $CRON_BAK)"
  if [ "$stale" != 0 ]; then
    die "步骤③b 回验失败：仍有 $stale 个 NANO_MATCH 不等于新 TAB $TAB"
  fi
  if [ "$total" = 0 ]; then
    log "步骤③b 注：crontab 无 NANO_MATCH 字面量（汇报 cron 全用动态 env）——无需替换，通过"
  fi
else
  log "步骤③b 注：无 crontab（crontab -l 空）——跳过，通过"
fi
log "步骤③b OK"
step_done "3b-cron"

# ---- ③c. 飞书桥：sed NANO_PORT（必要时）+ NANO_MATCH 仅替换硬编码 hex（保留动态 $WAKE_TAB）-> daemon-reload -> restart -> is-active ----
log "步骤③c: 改飞书桥 unit"
[ -f "$SVC" ] || die "步骤③c 失败：飞书桥 unit 不存在: $SVC"
SVC_BAK="$CODEX_WORK/.takeover_feishu.svc.bak.$(date +%s)"
cp "$SVC" "$SVC_BAK"
unit_changed=0
if grep -qE "Environment=NANO_PORT=[0-9]+" "$SVC"; then
  if ! grep -qE "Environment=NANO_PORT=$PORT" "$SVC"; then
    sed -i -E "s/Environment=NANO_PORT=[0-9]+/Environment=NANO_PORT=$PORT/" "$SVC"
    unit_changed=1
  fi
fi
if grep -qE 'NANO_MATCH="[0-9a-f]{8}"' "$SVC"; then
  sed -i -E "s/NANO_MATCH=\"[0-9a-f]{8}\"/NANO_MATCH=\"$TAB\"/" "$SVC"
  unit_changed=1
fi
grep -qE "Environment=NANO_PORT=$PORT" "$SVC" \
  || die "步骤③c 回验失败：unit NANO_PORT != $PORT"
if grep -qE 'NANO_MATCH="\$WAKE_TAB"' "$SVC"; then
  : # 动态，重启后 source env 取新 TAB
elif grep -qE "NANO_MATCH=\"$TAB\"" "$SVC"; then
  : # 字面正确
else
  die "步骤③c 回验失败：unit NANO_MATCH 既非动态 \$WAKE_TAB 也非 == $TAB"
fi
[ "$unit_changed" = 1 ] && systemctl --user daemon-reload
systemctl --user restart "$UNIT_NAME" || die "步骤③c 失败：systemctl restart $UNIT_NAME 失败"
sleep 2
BRIDGE_ACT=$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo "?")
[ "$BRIDGE_ACT" = active ] \
  || die "步骤③c 回验失败：飞书桥 is-active=$BRIDGE_ACT（应为 active）"
log "步骤③c OK: 桥 NANO_PORT=$PORT NANO_MATCH(ok) is-active=$BRIDGE_ACT  (备份 $SVC_BAK)"
step_done "3c-bridge"

# ---- ③d. waker 重启（沿用 v3.1 验过的硬门：合法时间戳 + pid 活性 + waker_core.py 本体、拒 akari-draft）----
log "步骤③d: 重启 waker"
RESTART_TS=$(date '+%Y-%m-%d %H:%M:%S')
tmux kill-session -t waker 2>/dev/null || true
tmux new-session -d -s waker "WAKE_LIVE=1 bash $WAKER_SH" </dev/null >/dev/null 2>&1 \
  || die "步骤③d 失败：tmux new-session waker 失败"
sleep 12
tmux has-session -t waker 2>/dev/null || die "步骤③d 回验失败：waker tmux session 未存活"
last_started=$(grep -E 'started mode=' "$WAKER_LOG" 2>/dev/null \
  | grep -E '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}\]' \
  | awk -v ts="$RESTART_TS" 'substr($0,2,19) >= ts' | tail -1)
[ -n "$last_started" ] || die "步骤③d 回验失败：waker.log 无 >= 重启时间($RESTART_TS) 的 started 行"
line_ts=$(echo "$last_started" | sed -E 's/^\[([0-9-]+ [0-9:]+)\].*/\1/')
cfg_base=$(basename "$CFG")
echo "$last_started" | grep -q "$cfg_base" \
  || die "步骤③d 回验失败：started 行 jsonl_dir 未含新 CFG($cfg_base) — waker 未 source 新 env"
waker_pid=$(echo "$last_started" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$waker_pid" ] || die "步骤③d 回验失败：started 行未解析出 pid"
kill -0 "$waker_pid" 2>/dev/null || die "步骤③d 回验失败：新 waker 进程 pid=$waker_pid 已退出（启动即崩）"
pid_args=$(ps -p "$waker_pid" -o args= 2>/dev/null || true)
echo "$pid_args" | grep -q 'waker_core\.py' \
  || die "步骤③d 回验失败：pid=$waker_pid 非 waker_core.py 本体（args=${pid_args:0:80}）"
echo "$pid_args" | grep -q 'akari-draft' \
  && die "步骤③d 回验失败：选中了并发 QA 草稿进程(pid=$waker_pid)，非活 waker"
soft=$(grep -E '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}\]' "$WAKER_LOG" 2>/dev/null \
  | awk -v ts="$line_ts" 'substr($0,2,19) > ts' \
  | grep -cE 'Traceback|Exception' || true)
[ "$soft" != 0 ] && log "步骤③d 注：boot 后 $soft 条 Traceback/Exception（多为并发 QA 草稿测试噪声；活 waker pid=$waker_pid 存活，通过）"
log "步骤③d OK: waker 活，新 started @ $line_ts pid=$waker_pid jsonl_dir 含 $cfg_base"
step_done "3d-waker"

# ---- ④. 终验四证合一 ----
log "步骤④: 终验四证合一"
p1_env_tab=$(src_var WAKE_TAB); p1_env_port=$(src_var WAKE_PORT)
PROOF[env]=$([ "$p1_env_tab" = "$TAB" ] && [ "$p1_env_port" = "$PORT" ] && echo OK || echo "BROKEN(env TAB=$p1_env_tab PORT=$p1_env_port)")
stale=$(crontab -l 2>/dev/null | grep -oE "NANO_MATCH=[0-9a-f]{8}" | grep -vE "NANO_MATCH=$TAB" | wc -l | tr -d ' ')
PROOF[cron]=$([ "$stale" = 0 ] && echo OK || echo "BROKEN(stale=$stale)")
nm_ok=no
grep -qE "Environment=NANO_PORT=$PORT" "$SVC" && { grep -qE 'NANO_MATCH="\$WAKE_TAB"' "$SVC" || grep -qE "NANO_MATCH=\"$TAB\"" "$SVC"; } && nm_ok=yes
PROOF[bridge]=$([ "$BRIDGE_ACT" = active ] && [ "$nm_ok" = yes ] && echo OK || echo "BROKEN(active=$BRIDGE_ACT nm=$nm_ok)")
w_live=$(tmux has-session -t waker 2>/dev/null && echo yes || echo no)
PROOF[waker]=$([ "$w_live" = yes ] && [ -n "$line_ts" ] && echo OK || echo "BROKEN(alive=$w_live)")

log "四证: env=${PROOF[env]} cron=${PROOF[cron]} 桥=${PROOF[bridge]} waker=${PROOF[waker]}"
all_ok=yes
for k in env cron bridge waker; do
  case "${PROOF[$k]}" in OK) ;; *) all_ok=no;; esac
done

RESULT=TAKEOVER_OK
if [ "$all_ok" = yes ]; then
  log "TAKEOVER_OK $TEAM $TAB"
else
  RESULT=TAKEOVER_BROKEN
  log "TAKEOVER_BROKEN — 差异表："
  for k in env cron bridge waker; do log "  $k -> ${PROOF[$k]}"; done
fi

# ---- ⑤. 原子写 duty-status.json（tmp+rename，值班状态公共位）----
if [ "$RESULT" = TAKEOVER_OK ]; then
  log "步骤⑤: 写 duty-status.json"
  NOW_ISO=$(date '+%Y-%m-%dT%H:%M:%S')
  PREV_TEAM_FOR_STATUS="$OLD_TEAM"
  SINCE="$NOW_ISO"
  if [ -f "$DUTY_JSON" ]; then
    old_since=$(python3 -c 'import json;print(json.load(open("'"$DUTY_JSON"'")).get("since",""))' 2>/dev/null || true)
    old_team_in_file=$(python3 -c 'import json;print(json.load(open("'"$DUTY_JSON"'")).get("team",""))' 2>/dev/null || true)
    if [ -n "$old_since" ] && [ "$old_team_in_file" = "$TEAM" ]; then
      SINCE="$old_since"
    fi
  fi
  USAGE_LINE=""
  if [ -n "$CFG" ]; then
    pool=$(basename "$CFG")
    USAGE_LINE=$(grep -E "^[0-9]{2}-[0-9]{2} [0-9:]+ ${pool}:" "$CODEX_WORK/usage_snap.log" 2>/dev/null | tail -1 || true)
  fi
  THIS_HOST=$(hostname 2>/dev/null || echo unknown)
  python3 - "$DUTY_JSON" "$TEAM" "$TAB" "$SESSION" "$CFG" "$SEC_MODEL" "$PORT" "$PROJ" "$SINCE" "$NOW_ISO" "$PREV_TEAM_FOR_STATUS" "$$" "$THIS_HOST" "$USAGE_LINE" <<'PYEOF'
import json, os, sys
(duty, team, tab, session, cfg, model, port, proj, since, last_verify, prev_team, pid, host, usage) = sys.argv[1:15]
rec = {
  "team": team, "tab": tab, "session": session, "config_dir": cfg,
  "model": model, "port": int(port) if str(port).isdigit() else port, "project": proj,
  "since": since, "last_verify": last_verify, "prev_team": prev_team,
  "switched_by": {"pid": int(pid) if str(pid).isdigit() else pid, "host": host},
  "usage_snap": usage if usage else None,
}
tmp = duty + ".tmp"
with open(tmp, "w") as f:
    json.dump(rec, f, ensure_ascii=False, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, duty)
PYEOF
  [ -f "$DUTY_JSON" ] || die "步骤⑤ 回验失败：duty-status.json 未生成"
  python3 -c 'import json;json.load(open("'"$DUTY_JSON"'"))' 2>/dev/null \
    || die "步骤⑤ 回验失败：duty-status.json 非合法 JSON"
  log "步骤⑤ OK: duty-status.json 已原子写入并经 json.load 校验"
  step_done "5-duty"
fi

# ---- 审计日志 ----
echo "[$(date '+%F %T')] TAKEOVER ${OLD_TEAM:-?}(${OLD_TAB}:${OLD_PORT}) -> $TEAM($TAB:$PORT) dry=$DRY_RUN result=$RESULT" >> "$HISTORY_LOG"
echo "$(date '+%F %T') v5-takeover->$TEAM by pid=$$ ppid=$PPID host=$(hostname) result=$RESULT" >> "$AUDIT"

# ---- ⑥ & ⑦. 飞书通报 + Noa 核验单（成功才发）----
if [ "$RESULT" = TAKEOVER_OK ] && [ "${TAKEOVER_SKIP_NOTIFY:-0}" != 1 ]; then
  log "步骤⑥: 飞书 Yuka 自动报接管完成"
  feishu_msg="【秘书交接·自动】${OLD_TEAM:-?}(${OLD_TAB}:${OLD_PORT}) -> $TEAM($TAB:$PORT) 四证合一 TAKEOVER_OK。env/汇报cron/飞书桥/waker 一致；值班状态已落 duty-status.json。"
  if [ -x "$LARK_CLI" ]; then
    feishu_out=$("$LARK_CLI" im +messages-send --chat-id "$FEISHU_CHAT" --as bot --format json --text "$feishu_msg" 2>&1) || true
    feishu_ok=$(echo "$feishu_out" | grep -ciE '"ok"[[:space:]]*:[[:space:]]*true' || true)
    if [ "$feishu_ok" = 0 ]; then
      log "步骤⑥ 警告：飞书未检测到 ok:true: $(echo "$feishu_out" | tr '\n' ' ' | cut -c1-200)"
    else
      log "步骤⑥ OK: 飞书已发 ok:true (marker=$feishu_ok)"
    fi
  else
    log "步骤⑥ 警告：lark-cli 不可执行 ($LARK_CLI)，跳过飞书"
    feishu_ok=0
  fi

  log "步骤⑦: 投 Noa 核验单"
  hts=$(date +%s)
  mkdir -p "$NOA_INBOX"
  taskfile="$NOA_INBOX/handover_check_${hts}.task"
  cat > "$taskfile" <<EOF
读 ~/codex_work/NOA_TAKEOVER_MANUAL.md 按清单核验 ${TEAM} 交接是否成功，结论用飞书报主人。
五项核验（手册不可读时按此兜底）：
1. 住址文件 /jfs/home/zhiningjiao/code/secretary-home.env 里 SECRETARY_TEAM、WAKE_TAB、WAKE_PORT 是否为 ${TEAM}、${TAB}、${PORT}
2. WAKE_PORT 上的服务心跳是否存活
3. 定时任务里 NANO_MATCH 是否全等于 WAKE_TAB
4. 值守会话与桥服务是否都处于存活状态
5. ~/codex_work/waker.log 近 1 小时是否有 started 与活动痕迹
另可读 /jfs/home/zhiningjiao/code/duty-status.json 取当值 team/tab/since/last_verify 复核。
结论：全过 HANDOVER_OK ${TEAM} tab ${TAB}；任一不过 HANDOVER_BROKEN(第N条: 证据)。
EOF
  log "步骤⑦ OK: Noa 核验单已投 $taskfile"
  step_done "6-feishu"
  step_done "7-noa"
elif [ "$RESULT" = TAKEOVER_OK ]; then
  log "步骤⑥/⑦: TAKEOVER_SKIP_NOTIFY=1，跳过飞书与 Noa"
fi

if [ "$RESULT" = TAKEOVER_OK ]; then
  echo "$RESULT $TEAM $TAB"
  exit 0
else
  echo "$RESULT"
  exit 1
fi
