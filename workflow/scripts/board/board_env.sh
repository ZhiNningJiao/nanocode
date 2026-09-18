#!/usr/bin/env bash
# board_env.sh — Owner想法追踪板机械流转:配置唯一权威（scripts_resume_2241 移植版）
#
# 三个消费者 source 本文件（board_upsert.sh / board_flag_sync.sh / akari_dispatch.sh），
# 板 token / 表 / 机器列名 / 状态档位全仓只此一处定义（荣耻篇 §五 范式统一）。
#
# 板坐标（base token / table id / as 身份）属于每台机器的部署配置，**不入仓**：
# 按序读取 —— ① 已导出的环境变量优先；② `BOARD_ENV_FILE`（默认
# `$HOME/.config/nanocode-board.env`）source 之。坐标缺失 → fail-loud exit 2
# （绝不静默降级、绝不猜；铁律 4）。模板见同目录 board_env.sh.example。
# 列名/档位/超时等非敏感默认值在下方集中收口，env 可覆盖。

# ── ① env 文件（可选）──
_BOARD_ENV_FILE="${BOARD_ENV_FILE:-$HOME/.config/nanocode-board.env}"
if [ -f "$_BOARD_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$_BOARD_ENV_FILE"
fi

# ── ② 板坐标（fail-loud 必填, 显式 rc=2）──
_missing=0
for _v in BOARD_BASE_TOKEN BOARD_TABLE_ID BOARD_AS; do
  [ -n "${!_v}" ] || { echo "board_env: $_v missing (env or $_BOARD_ENV_FILE)" >&2; _missing=1; }
done
[ "$_missing" = "0" ] || exit 2

# ── 机器列名（本机制独占写; 人列一个不碰, 理由见 board_upsert.sh 头）──
BOARD_TAG_FIELD="${BOARD_TAG_FIELD:-机器TAG}"        # join key: 派单 TAG 精确相等
BOARD_STATE_FIELD="${BOARD_STATE_FIELD:-机器状态}"   # 单选, 档位见下
BOARD_EXEC_FIELD="${BOARD_EXEC_FIELD:-机器执行人}"   # 文本 <model>@<pool目录名>
BOARD_NOTE_FIELD="${BOARD_NOTE_FIELD:-机器备注}"     # 文本, 追加式

# ── 状态档位（五档 + 停滞/待决策/需要协助）──
BOARD_ST_RUNNING="${BOARD_ST_RUNNING:-在跑}"
BOARD_ST_PENDING="${BOARD_ST_PENDING:-候验}"
BOARD_ST_ACCEPTED="${BOARD_ST_ACCEPTED:-已收}"
BOARD_ST_FAILED="${BOARD_ST_FAILED:-失败}"
BOARD_ST_PARTIAL="${BOARD_ST_PARTIAL:-打回续派}"
BOARD_ST_STALLED="${BOARD_ST_STALLED:-停滞}"
BOARD_ST_DECISION="${BOARD_ST_DECISION:-待决策}"   # 人工态: 秘书置, 旗哨绝不覆盖(终态旗除外) owner 0914 补令
BOARD_ST_ASSIST="${BOARD_ST_ASSIST:-需要协助}"     # NEEDSIG_<tag> -> 此态 owner 0914 补令

# ── 运行参数 ──
BOARD_LARK_TIMEOUT="${BOARD_LARK_TIMEOUT:-25}"
BOARD_NOTE_KEEP_LINES="${BOARD_NOTE_KEEP_LINES:-20}"

# ── PATH 兜底（2026-09-14 T3 修）──
# cron 环境 PATH 无 npm-global，lark-cli 找不到 → 板同步空转半天（owner 两次催板根因）。
# 修在唯一权威处：三个消费者 source 本文件即获得。
case ":$PATH:" in
  *":$HOME/.local/lib/npm-global/bin:"*) ;;
  *) export PATH="$HOME/.local/lib/npm-global/bin:$PATH" ;;
esac
