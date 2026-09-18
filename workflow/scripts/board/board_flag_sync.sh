#!/usr/bin/env bash
# board_flag_sync.sh — 旗哨: 按信号文件机械改 Owner想法追踪板的机器状态
#                      (owner 2026-09-14 直令 / MES-15907, cron */10)
#
# owner 原话:「感觉还是得有一种机械的方式, 能去改它的执行人或者是什么那个 flag,
#              秘书还是会因为上下文的问题忘了这茬儿」
# → 板状态跟着 ~/codex_work 的旗文件走, 与秘书记忆彻底解耦。
#   本脚本只做「扫目录 → 定状态 → 调 board_upsert.sh」; 板写入逻辑一行不复制
#   (荣耻篇 §三 一种能力一份实现)。
#
# 信号 → 状态 映射表 (唯一权威, 改档位只改这张表):
#   FLAG_<tag>                      (无后缀)          -> 候验
#   FLAG_<tag>.accepted* / .noted*                    -> 已收
#   FLAG_<tag>.r<N>_partial                           -> 打回续派
#   FAILSIG_<tag> / SPIN_<tag>      (无 .resolved)    -> 失败 (备注附首行前 100 字)
#   FAILSIG_<tag>.resolved* / SPIN_<tag>.resolved*    -> 忽略 (已解决标记, 不是失败)
#   FAILSIG_akari_gate_<tag>                          -> 失败, 真 TAG 剥掉 akari_gate_ 前缀
#                                                        (akari_dispatch.sh 硬闸的已知产物)
#   其余未知后缀                                       -> 忽略 + 记 log (fail-loud, 绝不猜)
#   同一 TAG 多个信号 -> 取 mtime 最新的那个 (并列时按文件名定序取末位, 结果确定)
#
# 幂等三保 (防每 10min 空写):
#   ① 先 board_upsert.sh --dump 一次读板, 目标状态 == 现状态的 TAG 直接跳过, 零 API 写;
#   ② 备注行用「信号文件 mtime」而非 now(), 同一信号重复扫到生成同一行文字;
#   ③ board_upsert.sh 自身同值跳过 (末行同值也跳过)。
#
# 只处理 mtime 近 BOARD_SYNC_DAYS 天的信号文件 (防 473 个历史旗一次性刷屏)。
# 日志写本地盘 /var/tmp (红线: 绝不写 JFS 日志)。
#
# 用法:
#   board_flag_sync.sh                 正常一轮 (cron 用)
#   BOARD_SYNC_DRYRUN=1 ...            只打印计划不写板 (单测/回填预演的测试缝)
#   BOARD_SYNC_CREATE=0 ...            只对齐板上既有行, 不建新行 (存量回填用)
#   BOARD_SIGNAL_DIR=/tmp/fake ...     改扫描目录 (单测用)

set -u

BOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=board_env.sh
. "$BOARD_DIR/board_env.sh"

BOARD_SIGNAL_DIR="${BOARD_SIGNAL_DIR:-$HOME/codex_work}"
BOARD_SYNC_LOG="${BOARD_SYNC_LOG:-/var/tmp/board_flag_sync.log}"
BOARD_SYNC_DAYS="${BOARD_SYNC_DAYS:-7}"
BOARD_SYNC_CREATE="${BOARD_SYNC_CREATE:-0}"  # 默认0（只更新绝不建行）——0914两次建行事故后根修：建行只许人工显式 CREATE=1
BOARD_SYNC_DRYRUN="${BOARD_SYNC_DRYRUN:-0}"
BOARD_SYNC_LOG_MAX="${BOARD_SYNC_LOG_MAX:-5000000}"   # 超过即滚存一份 .1
# 日常 cron 产物不进 owner 的想法板 (paper_crawl/optscan 每天几条, 会把板刷成作业流水)。
# 这些 TAG 若板上已有行仍会被更新, 只是不自动建新行。
BOARD_SYNC_NOCREATE_RE="${BOARD_SYNC_NOCREATE_RE:-^(paper_crawl_|optscan_)}"
# FAILSIG/SPIN 的「已解决」后缀判据。默认只认规范里的 resolved (保守, 绝不替 owner 猜)。
# 野外实测还存在 .fixed-pushed / .adjudicated / .noverdict 等方言 —— 本轮一律按未知
# 后缀 fail-loud 记 log 不处理; owner 认可后把它们加进这个正则即可, 不必改代码。
BOARD_RESOLVED_RE="${BOARD_RESOLVED_RE:-^resolved}"

UPSERT="$BOARD_DIR/board_upsert.sh"
[ -x "$UPSERT" ] || { echo "board_flag_sync: 缺 $UPSERT" >&2; exit 2; }

# ── 日志滚存 (本地盘) ──
if [ -f "$BOARD_SYNC_LOG" ] && [ "$(stat -c%s "$BOARD_SYNC_LOG" 2>/dev/null || echo 0)" -gt "$BOARD_SYNC_LOG_MAX" ]; then
  mv -f "$BOARD_SYNC_LOG" "$BOARD_SYNC_LOG.1"
fi
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$BOARD_SYNC_LOG"; }

RUN_ID="$(date '+%F %T')"
log "=== board_flag_sync start dir=$BOARD_SIGNAL_DIR days=$BOARD_SYNC_DAYS create=$BOARD_SYNC_CREATE dryrun=$BOARD_SYNC_DRYRUN base=$BOARD_BASE_TOKEN table=$BOARD_TABLE_ID ==="

# ── ① 一次读板: TAG -> 现状态 ──
DUMP_FILE="$(mktemp /tmp/board_sync_dump_XXXXXX.tsv)"
if ! "$UPSERT" --dump > "$DUMP_FILE" 2>>"$BOARD_SYNC_LOG"; then
  log "FATAL 读板失败 (board_upsert.sh --dump 非零) — 本轮放弃, 不做任何写入"
  rm -f "$DUMP_FILE"
  exit 4
fi
log "板上已有机器TAG 行数: $(wc -l < "$DUMP_FILE")"

# ── ② 扫信号文件 → 计划表 (纯计算, 不碰网络; 喂假目录即可单测) ──
PLAN_FILE="$(mktemp /tmp/board_sync_plan_XXXXXX.tsv)"
find "$BOARD_SIGNAL_DIR" -maxdepth 1 -type f \
     \( -name 'FLAG_*' -o -name 'FAILSIG_*' -o -name 'SPIN_*' -o -name 'NEEDSIG_*' \) \
     -mtime "-${BOARD_SYNC_DAYS}" -printf '%T@\t%f\n' 2>/dev/null \
  | BM_DIR="$BOARD_SIGNAL_DIR" \
    BM_PENDING="$BOARD_ST_PENDING" BM_ACCEPTED="$BOARD_ST_ACCEPTED" \
    BM_FAILED="$BOARD_ST_FAILED" BM_PARTIAL="$BOARD_ST_PARTIAL" BM_ASSIST="$BOARD_ST_ASSIST" \
    BM_RESOLVED_RE="$BOARD_RESOLVED_RE" \
    python3 -c '
import os, re, sys

d        = os.environ["BM_DIR"]
PENDING  = os.environ["BM_PENDING"]
ACCEPTED = os.environ["BM_ACCEPTED"]
FAILED   = os.environ["BM_FAILED"]
PARTIAL  = os.environ["BM_PARTIAL"]
ASSIST   = os.environ["BM_ASSIST"]

PARTIAL_RE  = re.compile(r"^r[0-9]*_partial$")
RESOLVED_RE = re.compile(os.environ.get("BM_RESOLVED_RE", "^resolved"))
best = {}          # tag -> (mtime, fname, state)
unknown = []

for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    mt_s, _, fname = line.partition("\t")
    try:
        mt = float(mt_s)
    except ValueError:
        continue

    prefix, _, rest = fname.partition("_")
    if prefix not in ("FLAG", "FAILSIG", "SPIN", "NEEDSIG") or not rest:
        continue
    tag, _, suffix = rest.partition(".")

    if prefix == "NEEDSIG":
        # owner 0914 补令: 车求援 -> 需要协助; 已核销(answered/handled/granted)不算
        if suffix == "":
            state = ASSIST
        else:
            continue                        # answered/handled/granted 等核销态, 忽略
    elif prefix == "FLAG":
        if suffix == "":
            state = PENDING
        elif suffix.startswith("accepted") or suffix.startswith("noted"):
            state = ACCEPTED
        elif PARTIAL_RE.match(suffix):
            state = PARTIAL
        else:
            unknown.append(fname); continue
    else:                                   # FAILSIG / SPIN
        if RESOLVED_RE.match(suffix):
            continue                        # 已解决标记, 不是失败态
        if suffix not in ("",):
            unknown.append(fname); continue
        # akari_dispatch.sh 硬闸产物 FAILSIG_akari_gate_<tag>: 剥前缀还原真 TAG
        if tag.startswith("akari_gate_"):
            tag = tag[len("akari_gate_"):]
            if not tag:
                unknown.append(fname); continue
        state = FAILED

    key = (mt, fname)
    if tag not in best or key > (best[tag][0], best[tag][1]):
        best[tag] = (mt, fname, state)

import datetime
for tag in sorted(best):
    mt, fname, state = best[tag]
    ts = datetime.datetime.fromtimestamp(mt).strftime("%F %H:%M")
    note = "旗哨 %s %s -> %s" % (ts, fname, state)
    if state == FAILED:
        try:
            with open(os.path.join(d, fname), encoding="utf-8", errors="replace") as fh:
                head = fh.readline().strip()
            if head:
                note += " | " + head[:100]
        except OSError:
            pass
    print("%s\t%s\t%s\t%s" % (tag, state, note, fname))

for f in sorted(set(unknown)):
    print("UNKNOWN\t\t\t%s" % f, file=sys.stderr)
' > "$PLAN_FILE" 2>>"$BOARD_SYNC_LOG"

log "信号文件解析出 $(wc -l < "$PLAN_FILE") 个 TAG"

# ── ③ 逐 TAG 比对现状 → 只对有变化的发写 ──
CHANGED=0; SKIPPED=0; CREATED=0; FAILEDW=0
while IFS="$(printf '\t')" read -r TAG STATE NOTE SRC; do
  [ -n "$TAG" ] || continue
  CUR="$(awk -F'\t' -v t="$TAG" '$1==t {print $2; exit}' "$DUMP_FILE")"
  ON_BOARD=0
  grep -qP "^\Q$TAG\E\t" "$DUMP_FILE" 2>/dev/null && ON_BOARD=1

  if [ "$ON_BOARD" = "1" ] && [ "$CUR" = "$STATE" ]; then
    SKIPPED=$((SKIPPED+1))
    continue
  fi
  # owner 0914 补令:「待决策」是秘书人工态, 机器不得覆盖 —— 除非出现终态旗(已收/失败)
  if [ "$CUR" = "$BOARD_ST_DECISION" ] && [ "$STATE" != "$BOARD_ST_ACCEPTED" ] && [ "$STATE" != "$BOARD_ST_FAILED" ]; then
    log "HOLD tag=$TAG 板上=待决策(人工态) 目标=$STATE 非终态 -> 不覆盖"
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  NOCREATE=0
  if [ "$ON_BOARD" = "0" ]; then
    if [ "$BOARD_SYNC_CREATE" != "1" ]; then
      NOCREATE=1
    elif printf '%s' "$TAG" | grep -qE "$BOARD_SYNC_NOCREATE_RE"; then
      NOCREATE=1
      log "SKIP-CREATE tag=$TAG (匹配 BOARD_SYNC_NOCREATE_RE, 日常 cron 产物不建新行)"
    fi
  fi

  DIFF_LINE="DIFF tag=$TAG 板上=${CUR:-<无此行>} -> 目标=$STATE  src=$SRC"
  log "$DIFF_LINE"

  # 先判不建行再判 dryrun — 否则预演计数与真跑不符, 预演就等于说谎
  if [ "$NOCREATE" = "1" ] && [ "$ON_BOARD" = "0" ]; then
    SKIPPED=$((SKIPPED+1))
    continue
  fi
  if [ "$BOARD_SYNC_DRYRUN" = "1" ]; then
    CHANGED=$((CHANGED+1))
    continue
  fi

  set -- "$BOARD_STATE_FIELD=$STATE" "$BOARD_NOTE_FIELD+=$NOTE"
  if [ "$ON_BOARD" = "0" ]; then
    # ① 发车钩子被跳过的兜底建行: 执行人不知道就写 unknown, 绝不瞎猜
    set -- "$@" "$BOARD_EXEC_FIELD=unknown"
  fi
  if OUT="$("$UPSERT" "$TAG" "$@" 2>&1)"; then
    log "OK   tag=$TAG $(printf '%s' "$OUT" | head -c 300)"
    CHANGED=$((CHANGED+1))
    [ "$ON_BOARD" = "0" ] && CREATED=$((CREATED+1))
  else
    log "FAIL tag=$TAG $(printf '%s' "$OUT" | tr -d '\n' | head -c 300)"
    FAILEDW=$((FAILEDW+1))
  fi
done < "$PLAN_FILE"

log "=== board_flag_sync end changed=$CHANGED created=$CREATED skipped=$SKIPPED write_failed=$FAILEDW (run $RUN_ID) ==="
echo "board_flag_sync: changed=$CHANGED created=$CREATED skipped=$SKIPPED write_failed=$FAILEDW log=$BOARD_SYNC_LOG"
rm -f "$DUMP_FILE" "$PLAN_FILE"
exit 0
