#!/usr/bin/env bash
# switch-secretary.sh — 已废弃（v5 统一，owner 2026-07-31 令）。转发到唯一入口 secretary-takeover.sh。
#
# 保留此薄壳兼容肌肉记忆与旧文档：调用方式同前（T1|T2|T3|T4|CODEX），
# SWITCH_FORCE / T4_TAB / TAKEOVER_SKIP_NOTIFY 等环境开关照常透传。
# 真正的链条实现全部在 secretary-takeover.sh（单参数 + 注册表内置 + ①-⑦ 自动链 + duty-status.json）。
# 废弃原因：与 secretary-takeover.sh 功能重叠（已确认的债），v5 收敛为唯一入口。
echo "[switch-secretary] DEPRECATED: 改用 secretary-takeover.sh <T1|T2|T3|T4|CODEX> [--dry-run]（v5 统一入口）。本次同参转发。" >&2
exec /jfs/home/zhiningjiao/code/secretary-takeover.sh "$@"
