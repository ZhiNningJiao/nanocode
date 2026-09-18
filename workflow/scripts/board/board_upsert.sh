#!/usr/bin/env bash
# board_upsert.sh — Owner想法追踪板「机器列」唯一写入口 (owner 2026-09-14 直令 / MES-15907)
#
# owner 原话:「感觉还是得有一种机械的方式, 能去改它的执行人或者是什么那个 flag,
#              秘书还是会因为上下文的问题忘了这茬儿」
# → 板的执行态与秘书记忆解耦。发车钩子 (akari_dispatch.sh) 与旗哨 (board_flag_sync.sh)
#   都只调本脚本, 板写入逻辑全仓仅此一份 (荣耻篇 §一 内聚 / §三 一种能力一份实现)。
#
# 列所有权边界 (红线: 绝不改既有列 / 绝不删既有行列 / 绝不另起视图 vewRjuMWzh):
#   人列 (owner/秘书手写, 本脚本永不触碰):
#     编号 父项编号 想法 状态 主线 Owner评论 秘书回应 下一步 最新进展 负责车或人 出处 父记录
#   机器列 (本脚本独占写):
#     机器TAG(text, join key) / 机器状态(select) / 机器执行人(text) / 机器备注(text)
#
#   为何不复用既有「状态」列: 其选项域是想法生命周期 (未启动/在飞/候主人决策/已交付/搁置),
#     与执行态 (在跑/候验/已收/失败/打回续派/停滞) 是两个语义域; 塞进同一列即荣耻篇 §五
#     点名的「同名两义」雷, 且扩选项 = 改既有列 (触红线)。两列并排, 分歧恰好暴露
#     owner 抱怨的「秘书忘了改」。
#   为何不复用「负责车或人」: 该列是人写的自由文本 (如「owner审合(秘书绝不自合)」),
#     机械覆写 = 毁人写数据 (触红线 绝不删)。
#   为何不用「编号」列做 join key: 编号是 T 系短号 (T01..T60, max_length=3), 不含派单 TAG。
#
# 用法:
#   board_upsert.sh TAG FIELD=VALUE [FIELD+=VALUE ...]
#       FIELD=VALUE    覆写该列; 现值已等于目标值则跳过不写 (幂等, 防 cron 每 10min 空写)
#       FIELD+=VALUE   向该列追加一行; 末行已是同一行则跳过
#   board_upsert.sh --get TAG
#       打印命中行现值 (record_id=... 及 FIELD=... 每行一条); 未命中 rc=3
#   board_upsert.sh --dump
#       打印全表快照, 每行 "<机器TAG>\t<机器状态>"; 供旗哨一次读板、只对有变化的 TAG 发写
#
# 退出码: 0=写入成功或幂等跳过 | 2=参数/环境错 | 3=未命中(--get 或 NO_CREATE=1) | 4=lark 失败
#   调用方 (akari_dispatch.sh) 一律 best-effort 忽略非零, 绝不因板不可达阻塞派单。
#
# 板坐标与机器列名的唯一权威 = board_env.sh (荣耻篇 §五: 同一语义一个来源)
BOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=board_env.sh
. "$BOARD_DIR/board_env.sh"
BOARD_UPSERT_NO_CREATE="${BOARD_UPSERT_NO_CREATE:-0}"    # 1=只更新既有行, 板上无该 TAG 则 rc=3

set -u

LARK_BIN="${LARK_BIN:-lark-cli}"
command -v "$LARK_BIN" >/dev/null 2>&1 || { echo "board_upsert: lark-cli 不在 PATH" >&2; exit 2; }

MODE="upsert"
case "${1:-}" in
  --get)  MODE="get";  shift ;;
  --dump) MODE="dump"; shift; set -- "__dump__" ;;   # 全表 TAG->状态 快照, 供旗哨一次读板
esac
TAG="${1:-}"
[ -n "$TAG" ] || { echo "board_upsert: 缺 TAG。用法见脚本头。" >&2; exit 2; }
shift

# ── 读全表一次: 同时供 行命中 / 幂等比对 / 追加取现值 三用 (一次调用, 绝不读两遍) ──
# record-list --format json 契约 (实测 lark-cli 1.0.88):
#   data.fields=列名数组 / data.field_type_list=类型数组 / data.record_id_list / data.data=值矩阵
RECS_JSON="$(timeout "$BOARD_LARK_TIMEOUT" "$LARK_BIN" base +record-list \
              --base-token "$BOARD_BASE_TOKEN" --table-id "$BOARD_TABLE_ID" \
              --as "$BOARD_AS" --format json 2>/dev/null)"
if [ -z "$RECS_JSON" ]; then
  echo "board_upsert[$TAG]: record-list 无响应 (板不可达 / lark 未登录), 放弃本次写入" >&2
  exit 4
fi

# 参数逐个写进临时文件, 一行一个 — 避免 shell 引号地狱 (纪律: 复杂引号绝不内嵌)
ARGS_FILE="$(mktemp /tmp/board_upsert_args_XXXXXX.txt)"
for a in "$@"; do printf '%s\n' "$a" >> "$ARGS_FILE"; done

# ── 解析 + 决策: python 只做纯计算, 不碰网络 (荣耻篇 §二 壳是壳芯是芯) ──
PLAN="$(printf '%s' "$RECS_JSON" | \
  BM_TAG="$TAG" BM_TAGFIELD="$BOARD_TAG_FIELD" BM_MODE="$MODE" \
  BM_KEEP="$BOARD_NOTE_KEEP_LINES" BM_NOCREATE="$BOARD_UPSERT_NO_CREATE" \
  BM_STATEFIELD="$BOARD_STATE_FIELD" BM_ARGSFILE="$ARGS_FILE" \
  python3 "$(dirname "$0")/board_plan.py")"
rm -f "$ARGS_FILE"

KIND="$(printf '%s\n' "$PLAN" | head -1 | cut -f1)"
BODY="$(printf '%s\n' "$PLAN" | head -1 | cut -f2-)"

case "$KIND" in
  ERR)
    echo "board_upsert[$TAG]: $BODY" >&2
    exit 4 ;;
  MISS)
    if [ "$MODE" = "get" ]; then
      echo "board_upsert[$TAG]: 板上无此 TAG 行" >&2
    else
      echo "board_upsert[$TAG]: 板上无此 TAG 行且 NO_CREATE=1, 按令不建行" >&2
    fi
    exit 3 ;;
  HIT)
    echo "record_id=$BODY"
    printf '%s\n' "$PLAN" | tail -n +2 | cut -f2-
    exit 0 ;;
  DUMP)
    printf '%s\n' "$PLAN" | tail -n +2 | cut -f2-
    exit 0 ;;
  SKIP)
    echo "board_upsert[$TAG]: $BODY"
    exit 0 ;;
  WRITE)
    FIELDS_FILE="$(mktemp board_upsert_fields_XXXXXX.json)"   # lark-cli 坑: --json @file 必须 cwd 相对路径
    RID="$(printf '%s' "$BODY" | BM_OUT="$FIELDS_FILE" python3 -c 'import json,os,sys
p=json.load(sys.stdin)
open(os.environ["BM_OUT"],"w").write(json.dumps(p["fields"],ensure_ascii=False))
print(p["record_id"])')"
    if [ -n "$RID" ]; then
      OUT="$(timeout "$BOARD_LARK_TIMEOUT" "$LARK_BIN" base +record-upsert \
              --base-token "$BOARD_BASE_TOKEN" --table-id "$BOARD_TABLE_ID" \
              --record-id "$RID" --json "@$FIELDS_FILE" --as "$BOARD_AS" 2>&1)"
      ACT="update rec=$RID"
    else
      OUT="$(timeout "$BOARD_LARK_TIMEOUT" "$LARK_BIN" base +record-upsert \
              --base-token "$BOARD_BASE_TOKEN" --table-id "$BOARD_TABLE_ID" \
              --json "@$FIELDS_FILE" --as "$BOARD_AS" 2>&1)"
      ACT="create"
    fi
    rm -f "$FIELDS_FILE"
    if printf '%s' "$OUT" | grep -q '"ok": *true'; then
      echo "board_upsert[$TAG]: OK $ACT $(printf '%s' "$BODY" | head -c 300)"
      exit 0
    fi
    echo "board_upsert[$TAG]: 写入失败 ($ACT): $(printf '%s' "$OUT" | tr -d '\n' | head -c 400)" >&2
    exit 4 ;;
  *)
    echo "board_upsert[$TAG]: 解析异常 plan=$(printf '%s' "$PLAN" | head -c 400)" >&2
    exit 4 ;;
esac
