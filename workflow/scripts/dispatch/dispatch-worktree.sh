#!/usr/bin/env bash
# dispatch-worktree.sh — worktree-per-worker 派单助手（owner 0830 批：调研强推③，抄 claude-squad 机制）
# 一个任务 = 一棵 worktree + 一条本地分支，多 worker 并行绝不同工区互踩（0830 lintfix 双wrap覆写事故的止血药）。
# 移植自 ~/code/worker-core/dispatch-worktree.sh（scripts_resume_2241）：
# worktree 根目录由 DISPATCH_WORKTREE_ROOT 显式给出（fail-loud，不猜）。
# 用法: dispatch-worktree.sh <repo_dir> <tag> [<base_ref>]   （base_ref 默认=origin/HEAD 当前指向）
# 输出三行 KEY=VALUE 供派单脚本 source/记录进任务书:
#   WORKTREE=<root>/<tag>
#   BRANCH=wt/<tag>
#   BASE_SHA=<sha>
# 幂等：worktree 已存在且分支匹配 → 原样输出（续做）；存在但分支不匹配 → 报错 exit 2（防串）。
set -eu
REPO="$1"; TAG="$2"; BASE_REF="${3:-}"
[ -n "${DISPATCH_WORKTREE_ROOT:-}" ] || {
  echo "ERROR: set DISPATCH_WORKTREE_ROOT (worktree root dir) >&2"; exit 2; }
ROOT="$DISPATCH_WORKTREE_ROOT"
WT="$ROOT/$TAG"; BR="wt/$TAG"
cd "$REPO"
if [ -z "$BASE_REF" ]; then
  BASE_REF=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||') || BASE_REF=origin/main
fi
if [ -d "$WT" ]; then
  CUR=$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  if [ "$CUR" = "$BR" ]; then
    echo "WORKTREE=$WT"; echo "BRANCH=$BR"; echo "BASE_SHA=$(git -C "$WT" merge-base HEAD "$BASE_REF" 2>/dev/null || git -C "$WT" rev-parse HEAD)"
    exit 0
  fi
  echo "ERROR: $WT 已存在但分支=$CUR≠$BR，拒绝复用（防串仓）" >&2; exit 2
fi
mkdir -p "$ROOT"
if git remote get-url origin >/dev/null 2>&1; then
  git fetch origin --quiet
fi
BASE_SHA=$(git rev-parse "$BASE_REF")
git worktree add "$WT" "$BASE_REF" -b "$BR" >/dev/null
echo "WORKTREE=$WT"; echo "BRANCH=$BR"; echo "BASE_SHA=$BASE_SHA"
