#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# blender_worktree_docker.sh
#
# Per-worktree isolated Blender (bpy) Docker harness for massively-parallel
# agents. Each git worktree gets its OWN throwaway container that bind-mounts
# THAT worktree as /workspace -- so N agents can run bpy validation at once
# without the old "swap branch into shared main repo + git checkout" race.
#
# It reuses the SAME image as the shared container (hou:latest) and the same
# bpy_env python, but:
#   * NEVER touches the shared container `mes12573-blender-8003`
#   * does NOT run server.py and does NOT publish any host port
#     (pure `docker exec` usage)
#   * mounts the given worktree, not the shared main repo
#
# Actions:
#   spin     <worktree_path>          -> create+start container, prints name
#   exec     <container> <script.py>  -> run script with bpy_env python in /workspace
#   shell    <container> <cmd...>     -> run an arbitrary bash command in the container
#   teardown <container>              -> docker rm -f the container
#   list                             -> list harness-managed containers
#
# Examples:
#   c=$(qatool/scripts/blender_worktree_docker.sh spin /path/to/wt)
#   qatool/scripts/blender_worktree_docker.sh exec "$c" qatool/scripts/check.py
#   qatool/scripts/blender_worktree_docker.sh teardown "$c"
#
# Env overrides:
#   IMAGE         (default: hou:latest)      docker image to use
#   BPY_PYTHON    (default: /root/miniforge3/envs/bpy_env/bin/python)
#   WORKDIR       (default: /workspace)      mount point inside container
#   LINK_ASSETS   (default: 0)              if 1, bind-mount the shared main
#                  repo's qatool/output + qatool/input_assets read-only at
#                  /workspace/qatool/output and .../input_assets so big assets
#                  are shared instead of duplicated. Leave 0 for full isolation.
#   SHARED_MAIN_REPO (default: auto)        path to main repo for LINK_ASSETS
# ---------------------------------------------------------------------------
set -euo pipefail

IMAGE="${IMAGE:-hou:latest}"
BPY_PYTHON="${BPY_PYTHON:-/root/miniforge3/envs/bpy_env/bin/python}"
WORKDIR="${WORKDIR:-/workspace}"
LINK_ASSETS="${LINK_ASSETS:-0}"
SHARED_CONTAINER="mes12573-blender-8003"   # protected; harness must never touch
NAME_PREFIX="blender-wt-"

die() { echo "ERROR: $*" >&2; exit 1; }

# Refuse to ever operate on the protected shared container.
guard_shared() {
  if [ "$1" = "$SHARED_CONTAINER" ]; then
    die "refusing to touch protected shared container $SHARED_CONTAINER"
  fi
}

short_hash() {
  # stable short hash of an absolute path
  printf '%s' "$1" | sha1sum | cut -c1-8
}

resolve_main_repo() {
  if [ -n "${SHARED_MAIN_REPO:-}" ]; then echo "$SHARED_MAIN_REPO"; return; fi
  # the harness lives at <repo>/qatool/scripts/, so the main repo is 2 dirs up
  # of this script's real location's git common dir's worktree.
  echo "/storage/home/zhiningjiao/code/meshy-dcc-pipeline"
}

cmd_spin() {
  local wt="${1:-}"
  [ -n "$wt" ] || die "spin needs <worktree_path>"
  [ -d "$wt" ] || die "worktree path does not exist: $wt"
  wt="$(cd "$wt" && pwd)"   # absolutize

  local name="${NAME_PREFIX}$(short_hash "$wt")"
  guard_shared "$name"

  # already running?
  if docker inspect "$name" >/dev/null 2>&1; then
    echo "$name"
    return 0
  fi

  local args=(
    -d --name "$name"
    --label harness=blender-worktree
    --label worktree="$wt"
    -v "${wt}:${WORKDIR}"
    -w "${WORKDIR}"
    --memory-swap -1
  )

  if [ "$LINK_ASSETS" = "1" ]; then
    local main; main="$(resolve_main_repo)"
    if [ -d "${main}/qatool/output" ]; then
      args+=( -v "${main}/qatool/output:${WORKDIR}/qatool/output:ro" )
    fi
    if [ -d "${main}/qatool/input_assets" ]; then
      args+=( -v "${main}/qatool/input_assets:${WORKDIR}/qatool/input_assets:ro" )
    fi
  fi

  # Pure-exec container: just keep it alive. No server.py, no host port.
  docker run "${args[@]}" "$IMAGE" sleep infinity >/dev/null
  echo "$name"
}

cmd_exec() {
  local name="${1:-}"; local script="${2:-}"
  [ -n "$name" ] || die "exec needs <container> <script.py>"
  [ -n "$script" ] || die "exec needs <container> <script.py>"
  guard_shared "$name"
  docker inspect "$name" >/dev/null 2>&1 || die "no such container: $name"
  # script path is relative to /workspace (the worktree)
  docker exec -w "$WORKDIR" "$name" "$BPY_PYTHON" "$script"
}

cmd_shell() {
  local name="${1:-}"; shift || true
  [ -n "$name" ] || die "shell needs <container> <cmd...>"
  guard_shared "$name"
  docker inspect "$name" >/dev/null 2>&1 || die "no such container: $name"
  docker exec -w "$WORKDIR" "$name" bash -lc "$*"
}

cmd_teardown() {
  local name="${1:-}"
  [ -n "$name" ] || die "teardown needs <container>"
  guard_shared "$name"
  docker rm -f "$name" >/dev/null 2>&1 && echo "removed $name" || echo "not present: $name"
}

cmd_list() {
  docker ps -a --filter "label=harness=blender-worktree" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Label "worktree"}}'
}

action="${1:-}"; shift || true
case "$action" in
  spin)     cmd_spin "$@" ;;
  exec)     cmd_exec "$@" ;;
  shell)    cmd_shell "$@" ;;
  teardown) cmd_teardown "$@" ;;
  list)     cmd_list "$@" ;;
  *) cat >&2 <<EOF
usage: $0 <action> [args]
  spin     <worktree_path>          create+start container, prints container name
  exec     <container> <script.py>  run script.py with bpy_env python in /workspace
  shell    <container> <cmd...>     run a bash command in the container
  teardown <container>              remove the container
  list                             list harness-managed containers
EOF
     exit 2 ;;
esac
