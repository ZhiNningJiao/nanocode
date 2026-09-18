#!/usr/bin/env bash
# pick-worker-model.sh — 三级选模梯（owner 0830 令：免费池不可靠是常态，探活→降级→回切）
# 移植自 ~/code/worker-core/pick-worker-model.sh（scripts_resume_2241）：
# 所有本机路径改为显式环境变量（默认 HOME 相对），无硬编码绝对路径、无凭据入仓。
# 输出两种形制（调用方按第一个词分支）：
#   OPENCODE kimi/<model>          ← 免费池有活的（走 opencode runner）
#   CLAUDE <config_dir> <model>    ← 免费池全死，降级 Claude 池（走 claude runner）
# 全死且 Claude 池也无可用 → 空输出 + exit 1（调用方落 NEEDSIG）。
# 降级触发时写状态文件并唤秘书一次（幂等：已 degraded 不重复唤）。
#
# 依赖（显式声明）：pick-free-model.sh（同目录）、jq、python3、curl。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CODEX_WORK="${CODEX_WORK_DIR:-$HOME/codex_work}"
WORKER_CORE="${WORKER_CORE_DIR:-$HERE}"
STATE="$CODEX_WORK/.model_failover_state"
PICK_FREE="${PICK_FREE_MODEL:-$WORKER_CORE/pick-free-model.sh}"
USAGE_SNAP="${USAGE_SNAP_FILE:-$CODEX_WORK/usage_snap.log}"
DUTY_STATUS="${DUTY_STATUS_FILE:-$CODEX_WORK/duty-status.json}"   # 上级目录常挂 $HOME/code
WAKE_SECRETARY="${WAKE_SECRETARY:-$HOME/code/wake-secretary.sh}"
FALLBACK_MODEL="${FALLBACK_MODEL:-claude-sonnet-5}"

# ── 一级：免费池探活（复用现有优先级探测）──
M=$(bash "$PICK_FREE" 2>/dev/null) && [ -n "$M" ] && {
  # 曾降级过则自动翻回 ok（恢复哨兵也会翻，这里兜底）
  if [ -f "$STATE" ] && /usr/bin/grep -q degraded "$STATE" 2>/dev/null; then
    echo "ok $(date '+%F %T') recovered-inline" > "$STATE"
  fi
  echo "OPENCODE kimi/$M"; exit 0
}

# ── 二级：免费池全死 → 选 Claude 池（从 usage_snap.log 最新一轮取各池 5h 用量，选最低）──
SNAP=$(tail -8 "$USAGE_SNAP" 2>/dev/null | /usr/bin/grep -a "claude" )
# 排除当值秘书自己的池（先保秘书额度铁律）
DUTY=$(jq -r '.config_dir // empty' "$DUTY_STATUS" 2>/dev/null | /usr/bin/grep -aoE "\.claude[a-z0-9-]*")
BEST="" ; BEST5H=101
while IFS= read -r line; do
  dir=$(echo "$line" | /usr/bin/grep -aoE "\.claude[a-z0-9-]*" | head -1)
  # 只认独立的" 5h="字段(r5h=复位时间也含5h=,必须锚定前导空格),且只取第一个匹配
  h5=$(echo "$line" | /usr/bin/grep -aoE " 5h=[0-9.]+" | head -1 | cut -d= -f2 | cut -d. -f1)
  [ -n "$dir" ] && [ -n "$h5" ] || continue
  [ -n "$DUTY" ] && [ "$dir" = "$DUTY" ] && continue
  if [ "$h5" -lt "$BEST5H" ]; then BEST5H=$h5; BEST=$dir; fi
done <<< "$SNAP"
[ -n "$BEST" ] || { echo ""; exit 1; }

# 首次进入降级态：记状态+唤秘书（幂等）
if ! /usr/bin/grep -q degraded "$STATE" 2>/dev/null; then
  echo "degraded $(date '+%F %T') fallback=$BEST sonnet" > "$STATE"
  bash "$WAKE_SECRETARY" "⚠模型容灾降级: 免费池全死, 新派单临时走 $BEST $FALLBACK_MODEL (owner 0830 预授权); 恢复哨兵每30min探测" >/dev/null 2>&1 || true
fi
echo "CLAUDE $HOME/$BEST $FALLBACK_MODEL"
exit 0
