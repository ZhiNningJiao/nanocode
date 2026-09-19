#!/usr/bin/env bash
# Tests for workflow/scripts/dispatch/akari_dispatch.sh (env-ized shim).
# All real dependencies replaced by stubs; never touches ports 9481/9475 or
# any production process. Run: bash tests/run_tests.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="$HERE/../akari_dispatch.sh"
PASS=0; FAIL=0
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

CW="$T/codex_work"; mkdir -p "$CW/akari_wf"
REPO="$T/repo"; git -q init "$REPO" 2>/dev/null
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init 2>/dev/null
PF="$T/prompt.md"; echo "task body" > "$PF"
FLAG="$T/flag_done"; LOG="$T/dispatch.log"
touch "$T/team2.sh" "$T/runloop.sh" "$T/header.md"

BASE_ENV=(
  AKARI_CLI="$T/cli.ts"
  CW_DIR_OVERRIDE="$CW"
  TEAM2_START_SCRIPT="$T/team2.sh"
  RUN_LOOP_SCRIPT="$T/runloop.sh"
  DISPATCH_HEADER_FILE="$T/header.md"
  AKARI_PORT=59999
)
make_tmux_stub() {
  local n="$1" path="$T/tmux_stub_$1.sh"
  { echo '#!/usr/bin/env bash'
    echo 'if [ "$1" = "list-sessions" ]; then'
    for i in $(seq 1 "$n"); do echo "  echo loop-s$i"; done
    echo '  exit 0; fi; exit 0'
  } > "$path"; chmod +x "$path"; echo "$path"
}

ok()  { if eval "$2"; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi; }
rc_is() { [ "$1" -eq "$2" ]; }
contains() { printf '%s' "$OUT" | grep -q "$1"; }
not_contains() { ! printf '%s' "$OUT" | grep -q "$1"; }

# a) missing required env -> rc=2, all missing vars listed
OUT="$(env -u AKARI_CLI -u TEAM2_START_SCRIPT -u DISPATCH_HEADER_FILE \
  bash "$DISPATCH" --dry-run T1 "$REPO" "$FLAG" "$PF" "$LOG" 2>&1)"; rc=$?
ok "a1: missing required env exits rc=2" "rc_is $rc 2"
ok "a2: lists AKARI_CLI" "contains AKARI_CLI"
ok "a3: lists TEAM2_START_SCRIPT" "contains TEAM2_START_SCRIPT"
ok "a4: lists DISPATCH_HEADER_FILE" "contains DISPATCH_HEADER_FILE"

# b) non-git WD -> run_loop fallback decision (dry-run)
OUT="$(env "${BASE_ENV[@]}" bash "$DISPATCH" --dry-run T2 "$CW" "$FLAG" "$PF" "$LOG" 2>&1)"; rc=$?
ok "b1: non-git WD dry-run rc=0" "rc_is $rc 0"
ok "b2: decision is run_loop fallback" "contains 'run_loop-fallback'"
ok "b3: mentions fallback script path" "contains \"$T/runloop.sh\""

# c) MODEL=opus -> claude-tmux decision (dry-run)
OUT="$(env "${BASE_ENV[@]}" bash "$DISPATCH" --dry-run T3 "$REPO" "$FLAG" "$PF" "$LOG" opus 2>&1)"; rc=$?
ok "c1: opus dry-run rc=0" "rc_is $rc 0"
ok "c2: decision is claude-tmux" "contains 'route: claude-tmux'"
ok "c3: uses TEAM2_START_SCRIPT" "contains \"$T/team2.sh\""

# d) concurrency >= 32 -> warn only, still proceeds
STUB32="$(make_tmux_stub 32)"
OUT="$(env "${BASE_ENV[@]}" TMUX_BIN="$STUB32" bash "$DISPATCH" --dry-run T4 "$REPO" "$FLAG" "$PF" "$LOG" 2>&1)"; rc=$?
ok "d1: 32 active sessions still rc=0" "rc_is $rc 0"
ok "d2: concurrency warn printed" "contains 'active=32'"
STUB3="$(make_tmux_stub 3)"
OUT="$(env "${BASE_ENV[@]}" TMUX_BIN="$STUB3" bash "$DISPATCH" --dry-run T4b "$REPO" "$FLAG" "$PF" "$LOG" 2>&1)"
ok "d3: 3 active sessions no warn" "not_contains 'CONCURRENCY'"

# e) dry-run zero side effects: no files created in CW or temp dir
CW2="$T/cw2"; mkdir -p "$CW2"
snap_before="$(find "$T" -type f | sort)"
OUT="$(env AKARI_CLI="$T/cli.ts" CW_DIR_OVERRIDE="$CW2" \
  TEAM2_START_SCRIPT="$T/team2.sh" RUN_LOOP_SCRIPT="$T/runloop.sh" \
  DISPATCH_HEADER_FILE="$T/header.md" AKARI_PORT=59999 \
  bash "$DISPATCH" --dry-run T5 "$CW2" "$T/flag5" "$PF" "$T/log5" 2>&1)"; rc=$?
ok "e1: dry-run rc=0" "rc_is $rc 0"
newfiles="$(comm -13 <(echo "$snap_before") <(find "$T" -type f | sort) | grep -cv -e '/tmux_stub_' -e '/prompt.md' -e '/flag_done' -e '/dispatch.log' -e '/cli.ts' -e '/team2.sh' -e '/runloop.sh' -e '/header.md')"
ok "e2: no new files created by dry-run" "[ \"$newfiles\" -eq 0 ]"
ok "e3: no akari_wf dir created" "[ ! -d \"$CW2/akari_wf\" ]"
ok "e4: no log file written" "[ ! -f \"$T/log5\" ]"
ok "e5: no FAILSIG/FALLBACK/manifest written" "[ -z \"$(find "$CW2" -type f)\" ]"

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
