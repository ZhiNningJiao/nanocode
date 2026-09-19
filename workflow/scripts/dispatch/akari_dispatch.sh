#!/usr/bin/env bash
# akari_dispatch.sh (env-ized, repo copy) — worker dispatch single entry.
# Fork of <HOST_CODE_DIR>/akari_dispatch.sh (r4+rules32, 511 lines) with:
#   - every machine-specific path/URL/name pulled into env vars (fail-loud rc=2
#     with a per-var report when a required var is unset/empty)
#   - --dry-run: print routing decision, command lines and the manifest/signal
#     files that would be written; spawn nothing, write nothing.
# Route logic, signal-file protocol, MAX_CONCURRENT behaviour, fail-class
# stamping and the Opus->Fable quota retry are byte-for-byte the same policy as
# the original; only the literals became variables. See
# workflow/SHIM_PLAN.md section 1 for the migration contract.
#
# Usage: akari_dispatch.sh [--dry-run] TAG WORKDIR FLAG PROMPTFILE LOG [MODEL] [MAX_SECONDS]
#
# Required env (unset/empty => rc=2, all missing vars listed):
#   AKARI_CLI               path to akari dispatch CLI (cli.ts)
#   CW_DIR_OVERRIDE         codex_work dir (signals, logs, manifests, run_loop script)
#   TEAM2_START_SCRIPT      start_team2_observable.sh (claude-tmux route)
#   RUN_LOOP_SCRIPT         run_loop_glm.sh / run_loop_k3.sh (fallback route)
#   DISPATCH_HEADER_FILE    arsenal header injected before prompt files
#
# Optional env (defaults shown):
#   AKARI_PORT=9481
#   FALLBACK_MODEL=kimi/litellm/SGLang-GLM-5.3-Flash
#   MAX_CONCURRENT=32
#   QUOTA_WATCH_TIMEOUT=600  QUOTA_WATCH_INTERVAL=5
#   FABLE_CLAUDE_CONFIG_DIR=${WORKER_CLAUDE_CONFIG_DIR:-$HOME/.claude-team2}
#   BOARD_UPSERT_SH / BOARD_ENV_SH   (board hook; if unset the hook is skipped)
#   AIGW_KEY_FILE            (key file read inside the fallback tmux session;
#                             required only when the run_loop fallback fires)
#   TMUX_BIN=tmux            (test seam for concurrency counting)
#
# NOTE: unlike the original this copy never exports HOME. The caller's
# environment stays untouched.
set -u

DRY_RUN=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--dry-run" ]; then DRY_RUN=1; else ARGS+=("$a"); fi
done

# ── env assembly + fail-loud required check ──────────────────────────────────
MISSING=""
require() { eval "v=\${$1:-}"; [ -n "$v" ] || MISSING="$MISSING $1"; return 0; }
require AKARI_CLI
require CW_DIR_OVERRIDE
require TEAM2_START_SCRIPT
require RUN_LOOP_SCRIPT
require DISPATCH_HEADER_FILE
if [ -n "$MISSING" ]; then
  echo "[AKARI_DISPATCH_ENV] missing required env var(s):" >&2
  for m in $MISSING; do
    case "$m" in
      AKARI_CLI)             echo "  $m  (akari dispatch cli.ts path)" >&2 ;;
      CW_DIR_OVERRIDE)       echo "  $m  (codex_work dir: signals/logs/manifests)" >&2 ;;
      TEAM2_START_SCRIPT)    echo "  $m  (start_team2_observable.sh, claude-tmux route)" >&2 ;;
      RUN_LOOP_SCRIPT)       echo "  $m  (run_loop_*.sh, fallback route)" >&2 ;;
      DISPATCH_HEADER_FILE)  echo "  $m  (arsenal DISPATCH_HEADER.md)" >&2 ;;
    esac
  done
  echo "[AKARI_DISPATCH_ENV] refusing to guess machine paths (fail-loud, rc=2)" >&2
  exit 2
fi

TAG="${ARGS[0]:-}"; WD="${ARGS[1]:-}"
CW="$CW_DIR_OVERRIDE"
AKARI_PORT="${AKARI_PORT:-9481}"
WF_DIR="$CW/akari_wf"
TMUX_BIN="${TMUX_BIN:-tmux}"

# absolute-path resolution, same contract as run_loop_glm.sh
FLAG="$(realpath -m "${ARGS[2]:-}" 2>/dev/null)"
PF="$(realpath -m "${ARGS[3]:-}" 2>/dev/null)"
LOG="$(realpath -m "${ARGS[4]:-}" 2>/dev/null)"
[ -n "$LOG" ] || LOG="$CW/akari_dispatch_${TAG:-notag}.log"
MODEL="${ARGS[5]:-}"
MAX_SECONDS="${ARGS[6]:-10800}"

MAX_CONCURRENT="${MAX_CONCURRENT:-32}"
FABLE_CLAUDE_CONFIG_DIR="${FABLE_CLAUDE_CONFIG_DIR:-${WORKER_CLAUDE_CONFIG_DIR:-$HOME/.claude-team2}}"
QUOTA_WATCH_TIMEOUT="${QUOTA_WATCH_TIMEOUT:-600}"
QUOTA_WATCH_INTERVAL="${QUOTA_WATCH_INTERVAL:-5}"
FALLBACK_MODEL="${FALLBACK_MODEL:-kimi/litellm/SGLang-GLM-5.3-Flash}"

dry() { echo "[DRY-RUN] $*"; }
dlog() {
  [ "$DRY_RUN" = "1" ] && return 0
  echo "[$(date '+%F %T')] akari_dispatch[$TAG] $*" >> "$LOG"
}

# ── rules32 s1: concurrency = tmux loop-*/akari_wf_* session count ──────────
count_active_workers() {
  "$TMUX_BIN" list-sessions -F '#{session_name}' 2>/dev/null \
    | grep -cE '^(loop-|akari_wf_)' || true
}

concurrency_gate() {
  local n
  n="$(count_active_workers)"
  if [ "$n" -ge "$MAX_CONCURRENT" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      echo "[DRY-RUN] [CONCURRENCY] active $n >= MAX_CONCURRENT=$MAX_CONCURRENT — would warn+queue, never blocks" >&2
    else
      echo "[$(date '+%F %T')] akari_dispatch[$TAG] [CONCURRENCY] active $n >= MAX_CONCURRENT=$MAX_CONCURRENT — warn+queue per owner 0918 ruling, never blocks dispatch" | tee -a "$LOG" >&2
      dlog "CONCURRENCY queued: active=$n max=$MAX_CONCURRENT"
      local up="${BOARD_UPSERT_SH:-}" env_f="${BOARD_ENV_SH:-}"
      if [ -n "$up" ] && [ -x "$up" ] && [ -n "$env_f" ] && [ -f "$env_f" ]; then
        (
          . "$env_f" 2>/dev/null || exit 90
          BOARD_UPSERT_NO_CREATE=0 timeout 30 bash "$up" "$TAG" \
            "$BOARD_NOTE_FIELD+=queued $(date '+%F %H:%M') active=$n/$MAX_CONCURRENT (over limit, not blocking, owner 0918)" 2>&1
        ) >/dev/null 2>&1 || dlog "board queue registration failed (best-effort, ignored)"
      fi
    fi
  else
    dlog "CONCURRENCY ok: active=$n max=$MAX_CONCURRENT"
  fi
  return 0
}

# ── rules32 s2: fail classification (DISPATCH_RULES_v0 s4) ──────────────────
classify_fail() {
  local txt="$1"
  if printf '%s' "$txt" | grep -qiE 'session limit|rate.?limit|429|quota'; then
    echo "QUOTA"
  elif printf '%s' "$txt" | grep -qiE 'timeout|KILL|unreachable|connection'; then
    echo "NETENV"
  elif printf '%s' "$txt" | grep -q 'NO_FLAG_FROM_WORKER\|DEADLINE_KILLED'; then
    echo "TASKCODE"
  else
    echo "SIGNAL"
  fi
}

stamp_fail_class() {
  local sig="$1" ev="${2:-}" cls tmp
  [ -f "$sig" ] || return 0
  [ -n "$ev" ] || ev="$(cat "$sig")"
  cls="$(classify_fail "$ev")"
  case "$(head -1 "$sig")" in
    CLASS=*) return 0 ;;
  esac
  tmp="$(mktemp)"
  { printf 'CLASS=%s\n' "$cls"; cat "$sig"; } > "$tmp" && mv "$tmp" "$sig"
}
export -f classify_fail stamp_fail_class

# ── rules32 s3: Opus quota instant-fail -> Fable seat retry once ────────────
quota_fallback_watch() {
  local tag="$1" flag="$2" pf="$3" wd="$4" max_seconds="$5" log="$6"
  local deadline=$(( $(date +%s) + QUOTA_WATCH_TIMEOUT ))
  local sig="$CW/FAILSIG_${tag}"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$flag" ]; then
      echo "[$(date '+%F %T')] rules32[$tag] FLAG present = done, watch window exits" >> "$log"
      return 0
    fi
    if [ -f "$sig" ]; then
      if grep -qiE 'session limit|hit your' "$sig" 2>/dev/null; then
        stamp_fail_class "$sig"
        if [ "${RULES32_FABLE_RETRY:-0}" = "1" ]; then
          {
            echo "[$(date '+%F %T')] rules32[$tag] second quota instant-fail (after Fable fallback) — FAILSIG kept + NEEDSIG, no further retry"
          } | tee -a "$log" >&2
          printf '%s Opus+Fable double quota instant-fail (session limit) — wait 5h window or split task to GLM, secretary to handle (DISPATCH_RULES_v0 s4-A)\n' \
            "$(date '+%F %T')" > "$CW/NEEDSIG_${tag}"
          return 1
        fi
        {
          echo "[$(date '+%F %T')] rules32[$tag] Opus quota instant-fail detected — auto re-dispatch once on Fable seat (config_dir=$FABLE_CLAUDE_CONFIG_DIR)"
        } | tee -a "$log" >&2
        mv "$sig" "${sig}.quota_seen_${tag}"
        RULES32_FABLE_RETRY=1 \
        RULES32_WATCH_MODE= RULES32_WATCH_ONLY= \
        WORKER_CLAUDE_CONFIG_DIR="$FABLE_CLAUDE_CONFIG_DIR" \
          bash "$0" "$tag" "$wd" "$flag" "$pf" "$log" "fable" "$max_seconds" \
          >> "$log" 2>&1
        local rc=$?
        echo "[$(date '+%F %T')] rules32[$tag] Fable fallback re-dispatch rc=$rc (one shot used, second failure lands NEEDSIG)" >> "$log"
        return $rc
      fi
      echo "[$(date '+%F %T')] rules32[$tag] FAILSIG non-quota ($(classify_fail "$(cat "$sig")")) — watch window exits" >> "$log"
      return 0
    fi
    sleep "$QUOTA_WATCH_INTERVAL"
  done
  echo "[$(date '+%F %T')] rules32[$tag] watch window ${QUOTA_WATCH_TIMEOUT}s expired without quota evidence, exits" >> "$log"
  return 0
}

if [ "${RULES32_WATCH_MODE:-}" = "1" ]; then
  IFS="|" read -r TAG FLAG PF WD MAX_SECONDS LOG <<< "$RULES32_WATCH_ONLY"
  quota_fallback_watch "$TAG" "$FLAG" "$PF" "$WD" "$MAX_SECONDS" "$LOG"
  exit $?
fi

# ── FLAG-already-present contract: refuse to burn quota on a finished task ──
if [ -n "$FLAG" ] && [ -f "$FLAG" ]; then
  dlog "FLAG already present — task complete, exit 0 (no rerun)."
  exit 0
fi

# ── dry-run helper: route decision without side effects ─────────────────────
dry_route_summary() {
  local route="$1" reason="${2:-}"
  dry "config: AKARI_PORT=$AKARI_PORT CW=$CW"
  dry "config: AKARI_CLI=$AKARI_CLI"
  dry "config: TEAM2_START_SCRIPT=$TEAM2_START_SCRIPT"
  dry "config: RUN_LOOP_SCRIPT=$RUN_LOOP_SCRIPT"
  dry "config: DISPATCH_HEADER_FILE=$DISPATCH_HEADER_FILE"
  dry "config: FALLBACK_MODEL=$FALLBACK_MODEL MAX_CONCURRENT=$MAX_CONCURRENT"
  local n; n="$(count_active_workers)"
  dry "concurrency: active=$n max=$MAX_CONCURRENT (>= max would only warn, never block)"
  dry "route: $route${reason:+ (reason: $reason)}"
  dry "sessions: akari_wf_${TAG} / loop-${TAG} (tmux detached)"
  dry "would write manifest: ${CW}/watchdog-manifest.txt entry '${TAG}|${WD}|akari-<mode>'"
  dry "would write signals (on failure only): ${CW}/FAILSIG_${TAG} / ${CW}/FAILSIG_akari_gate_${TAG} / ${CW}/FALLBACK_akari_${TAG}"
  dry "would write FLAG on success (by worker): ${FLAG}"
}

# ── concurrency backpressure (>=32 warn+queue only, never blocks) ───────────
concurrency_gate

# ── arsenal header auto-prepend (fail-open: missing header never blocks) ────
if [ "$DRY_RUN" = "1" ]; then
  if [ -n "$PF" ] && [ -f "$PF" ] && [ -f "$DISPATCH_HEADER_FILE" ] \
     && ! grep -q "武器库段（派单正门自动前置" "$PF" 2>/dev/null; then
    dry "arsenal header would be prepended: $DISPATCH_HEADER_FILE -> $WF_DIR/${TAG:-notag}.prompt.md"
  fi
else
  if [ -f "$DISPATCH_HEADER_FILE" ] && [ -n "$PF" ] && [ -f "$PF" ] \
     && ! grep -q "武器库段（派单正门自动前置" "$PF" 2>/dev/null; then
    mkdir -p "$WF_DIR"
    PF_EFF="$WF_DIR/${TAG:-notag}.prompt.md"
    # PF == PF_EFF collision would truncate the body before reading it (0910 incident)
    PF_TMP=$(mktemp) && cat "$PF" > "$PF_TMP" \
      && cat "$DISPATCH_HEADER_FILE" "$PF_TMP" > "$PF_EFF" && rm -f "$PF_TMP" && PF="$PF_EFF" \
      && dlog "arsenal header prepended -> $PF_EFF" \
      || dlog "arsenal header prepend FAILED, using original PF"
  fi
fi

# ── health probe: /api/health must be 200 AND ok:true ───────────────────────
akari_ok() {
  curl -sf -m 3 "http://127.0.0.1:$AKARI_PORT/api/health" 2>/dev/null \
    | python3 -c 'import json,sys;sys.exit(0 if json.load(sys.stdin).get("ok") else 1)' 2>/dev/null
}

is_claude_model() {
  case "$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    opus|fable|sonnet|haiku) return 0 ;;
    *) return 1 ;;
  esac
}

# ── watchdog-manifest auto-registration (dedup then append) ─────────────────
register_manifest() {
  local tag="$1" wd="$2" mode="$3"
  local mf="$CW/watchdog-manifest.txt"
  grep -qF "${tag}|" "$mf" 2>/dev/null || echo "${tag}|${wd}|akari-${mode}" >> "$mf"
}

# ── board hook (MES-15907): best-effort, never blocks dispatch ──────────────
board_mark_dispatched() {
  local executor="$1"
  local up="${BOARD_UPSERT_SH:-}" env_f="${BOARD_ENV_SH:-}"
  [ -n "$up" ] && [ -x "$up" ] && [ -n "$env_f" ] && [ -f "$env_f" ] \
    || { dlog "board hook skip: BOARD_UPSERT_SH/BOARD_ENV_SH unset or unusable"; return 0; }
  local out rc
  out="$(
    . "$env_f" 2>/dev/null || exit 90
    BOARD_UPSERT_NO_CREATE=0 \
    timeout 30 bash "$up" "$TAG" \
      "$BOARD_STATE_FIELD=$BOARD_ST_RUNNING" \
      "$BOARD_EXEC_FIELD=$executor" \
      "$BOARD_NOTE_FIELD+=dispatched $(date '+%F %H:%M') WD=$WD" 2>&1
  )"; rc=$?
  if [ $rc -eq 0 ]; then
    dlog "board hook OK executor=$executor: $(printf '%s' "$out" | head -c 200)"
  else
    echo "[$(date '+%F %T')] akari_dispatch[$TAG] [BOARD_HOOK_WARN] board upsert failed rc=$rc (non-blocking): $(printf '%s' "$out" | tr -d '\n' | head -c 200)" | tee -a "$LOG" >&2
  fi
  return 0
}

# ── r3 repo-root resolution: git common-dir same-source (sibling worktrees) ─
repo_root_of() {
  local wd="$1" common
  [ -n "$wd" ] && [ -e "$wd/.git" ] || return 1
  common="$(git -C "$wd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  local root="${common%.git}"; root="${root%/}"
  [ -n "$root" ] || return 1
  echo "$root"
}

# ── r3 route table: LIVE registry driven (GET /api/projects, read-only) ─────
resolve_route() {
  local root="$1" projects
  projects="$(curl -sf -m 3 "http://127.0.0.1:$AKARI_PORT/api/projects" 2>/dev/null)" || return 1
  [ -n "$projects" ] || return 1
  printf '%s' "$projects" | REPO_ROOT="$root" python3 -c '
import json, os, sys
root = os.path.realpath(os.environ["REPO_ROOT"])
data = json.load(sys.stdin)
recs = data.get("projects", [])
hit_default = None
hit = None
for r in recs:
    try:
        rr = os.path.realpath(r.get("root", ""))
    except Exception:
        continue
    if rr == root:
        if r.get("is_default"):
            hit_default = r
        elif hit is None:
            hit = r
if hit is not None:
    print("fleet", hit["project_id"])
elif hit_default is not None:
    print("default")
else:
    sys.exit(1)
'
}

# ── claude-tmux route: claude-family MODEL -> start_team2_observable.sh ─────
if is_claude_model "$MODEL"; then
  if [ "$DRY_RUN" = "1" ]; then
    if akari_ok; then
      dry "health: akari /api/health ok (claude-tmux route viable)"
    else
      dry "health: akari /api/health DOWN — real run would take the [AKARI_GATE_FAIL] path (no downgrade)"
    fi
    dry_route_summary "claude-tmux model=$(echo "$MODEL" | tr '[:upper:]' '[:lower:]')"
    dry "command: bash $TEAM2_START_SCRIPT akari_wf_${TAG} $TAG $WD $PF $(echo "$MODEL" | tr '[:upper:]' '[:lower:]') $MAX_SECONDS"
    exit 0
  fi
  if ! akari_ok; then
    REASON="akari /api/health probe failed (127.0.0.1:$AKARI_PORT down or ok:false) — claude-tmux route needs akari alive too"
  else
    SESS="akari_wf_${TAG}"
    _model_lower="$(echo "$MODEL" | tr '[:upper:]' '[:lower:]')"
    echo "[$(date '+%F %T')] akari_dispatch[$TAG] ROUTE=claude-tmux model=${_model_lower} pool=${WORKER_CLAUDE_CONFIG_DIR:-\$HOME/.claude-team2}" | tee -a "$LOG" >&2
    dlog "claude-tmux route: session=$SESS model=${_model_lower} max_seconds=$MAX_SECONDS wd=$WD pf=$PF"
    export AKARI_WRAPPED=1
    if bash "$TEAM2_START_SCRIPT" "$SESS" "$TAG" "$WD" "$PF" "${_model_lower}" "$MAX_SECONDS"; then
      register_manifest "$TAG" "$WD" "claude-tmux"
      board_mark_dispatched "${_model_lower}@$(basename "${WORKER_CLAUDE_CONFIG_DIR:-$HOME/.claude-team2}")"
      dlog "claude-tmux submitted OK, session=$SESS, manifest registered"
      if [ "${_model_lower}" = "opus" ] && [ "${RULES32_FABLE_RETRY:-0}" != "1" ]; then
        RULES32_WATCH_MODE=1 \
        RULES32_WATCH_ONLY="${TAG}|${FLAG}|${PF}|${WD}|${MAX_SECONDS}|${LOG}" \
        RULES32_FABLE_RETRY=0 \
        FABLE_CLAUDE_CONFIG_DIR="$FABLE_CLAUDE_CONFIG_DIR" \
        QUOTA_WATCH_TIMEOUT="$QUOTA_WATCH_TIMEOUT" \
        QUOTA_WATCH_INTERVAL="$QUOTA_WATCH_INTERVAL" \
        AKARI_PORT="$AKARI_PORT" \
          setsid bash "$0" __rules32_watch__ >/dev/null 2>&1 &
        dlog "quota watch spawned (timeout=${QUOTA_WATCH_TIMEOUT}s) pid=$!"
      fi
      exit 0
    fi
    REASON="claude-tmux route: start_team2_observable.sh failed to start (session=$SESS)"
  fi
  {
    echo "=============================================================="
    echo "[AKARI_GATE_FAIL] worker $TAG cannot take claude-tmux: $REASON"
    echo "  fix: ensure akari server is up (127.0.0.1:$AKARI_PORT)"
    echo "=============================================================="
  } | tee -a "$LOG" >&2
  printf '[AKARI_GATE_FAIL] %s worker %s (claude-tmux): %s\n' "$(date '+%F %T')" "$TAG" "$REASON" > "$CW/FAILSIG_akari_gate_${TAG}"
  exit 1
fi

# ── akari path: generate workflow + tmux detached CLI run, FLAG on success ──
run_on_akari() {
  local mode="$1" proj="$2" base="$3"
  local ts="$WF_DIR/${TAG}.ts" inner="$WF_DIR/${TAG}.sh" sess="akari_wf_${TAG}" rc
  if [ "$mode" = "fleet" ]; then
    cat > "$ts" <<EOF
export const meta = { name: "dispatch-$TAG", description: "akari_dispatch task $TAG (project=$proj base=$base)", phases: [{ title: "run" }], project: "$proj", base: "$base" };
phase("run");
const prompt = await Bun.file("$PF").text();
const [result] = await parallel([() => agent(prompt, { label: "$TAG" })]);
return { ok: true, tag: "$TAG", project: "$proj", base: "$base", result };
EOF
  else
    cat > "$ts" <<EOF
export const meta = { name: "dispatch-$TAG", description: "akari_dispatch single task $TAG", phases: [{ title: "run" }] };
phase("run");
const prompt = await Bun.file("$PF").text();
const result = await agent(prompt, { label: "$TAG" });
return { ok: true, tag: "$TAG", result };
EOF
  fi
  cat > "$inner" <<EOF
#!/usr/bin/env bash
# generated by akari_dispatch.sh for $TAG (mode=$mode project=$proj base=$base)
export HOME="$HOME"
export AKARI_SERVER_URL="http://127.0.0.1:$AKARI_PORT"
echo "=== $TAG AKARI_RUN start mode=$mode project=$proj base=$base \$(date) ===" >> "$LOG"
_cli_out="$CW/akari_cli_out_${TAG}_\$\$.json"
_t0=\$(date +%s)
bun "$AKARI_CLI" run "$ts" > "\$_cli_out" 2>&1
rc=\$?
_dur=\$(( \$(date +%s) - _t0 ))
cat "\$_cli_out" >> "$LOG"
echo "=== $TAG AKARI_RUN end rc=\$rc dur=\${_dur}s \$(date) ===" >> "$LOG"
if [ \$rc -ne 0 ]; then
  _prefix="[BLOCKER]"
  if [ \$rc -eq 124 ] || [ \$rc -eq 137 ] || [ \$rc -eq 143 ]; then
    _prefix="KILLED(rc=\$rc)"
  elif [ \$_dur -lt 60 ]; then
    _prefix="FASTFAIL"
  fi
  printf '%s %s akari CLI run failed rc=%s dur=%ss — real failure (see %s)\n' "\$_prefix" "\$(date '+%F %T')" "\$rc" "\$_dur" "$LOG" > "$CW/FAILSIG_$TAG"
  stamp_fail_class "$CW/FAILSIG_$TAG" || true
elif grep -q 'WALL-CLOCK DEADLINE CHECKPOINT' "\$_cli_out"; then
  _cp_path=\$(grep -o 'DURABLE PROGRESS:.*' "\$_cli_out" | head -1)
  printf 'DEADLINE_KILLED\n%s akari worker killed by wall-clock deadline (rc=0 but WALL-CLOCK DEADLINE CHECKPOINT present)\ncheckpoint: %s\nsee %s\n' "\$(date '+%F %T')" "\$_cp_path" "$LOG" > "$CW/FAILSIG_$TAG"
  stamp_fail_class "$CW/FAILSIG_$TAG" || true
  echo "[akari_dispatch] DEADLINE_KILLED — CLI rc=0 but result contains WALL-CLOCK DEADLINE CHECKPOINT, never touch FLAG" >> "$LOG"
elif [ -f "$FLAG" ]; then
  rm -f "$CW/FAILSIG_$TAG"
  echo "[akari_dispatch] worker-written FLAG confirms completion" >> "$LOG"
else
  printf 'NO_FLAG_FROM_WORKER\n%s akari CLI rc=0 but worker did not write FLAG — dispatch layer never backfills the flag\nsee %s\n' "\$(date '+%F %T')" "$LOG" > "$CW/FAILSIG_$TAG"
  stamp_fail_class "$CW/FAILSIG_$TAG" || true
  echo "[akari_dispatch] NO_FLAG_FROM_WORKER — CLI rc=0 but FLAG absent, never touch FLAG" >> "$LOG"
fi
rm -f "\$_cli_out"
EOF
  chmod +x "$inner"
  "$TMUX_BIN" kill-session -t "$sess" 2>/dev/null
  "$TMUX_BIN" new-session -d -s "$sess" "bash '$inner'" || return 1
  dlog "submitted akari workflow ts=$ts session=$sess mode=$mode project=$proj base=$base (tmux detached); MODEL arg (if any) not forwarded, akari uses its own default_worker_model"
}

# ── routing (akari fleet/single — only reached when MODEL is empty/non-claude)
ROUTE_MODE=""; ROUTE_PROJ=""; ROUTE_BASE=""
if [ "$DRY_RUN" != "1" ]; then
  if ! akari_ok; then
    REASON="akari /api/health probe failed (127.0.0.1:$AKARI_PORT down or ok:false)"
  elif ! ROOT="$(repo_root_of "$WD")"; then
    REASON="WORKDIR $WD is not inside a git repo (codex_work-style non-repo surfaces go to run_loop by design)"
  elif ROUTE_OUT="$(resolve_route "$ROOT")"; then
    if [ "$(echo "$ROUTE_OUT" | awk '{print $1}')" = "fleet" ]; then
      ROUTE_MODE="fleet"
      ROUTE_PROJ="$(echo "$ROUTE_OUT" | awk '{print $2}')"
      ROUTE_BASE="$(git -C "$WD" branch --show-current 2>/dev/null)"
      if [ -z "$ROUTE_BASE" ]; then
        REASON="repo root $ROOT matched project $ROUTE_PROJ, but WORKDIR is on detached HEAD with no branch name — no base_ref for fleet clone (fail-loud)"
        ROUTE_MODE=""
      fi
    else
      ROUTE_MODE="single"
    fi
  else
    REASON="repo root $ROOT not in akari project registry (GET /api/projects has no exact root match; see /api/projects)"
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  if ! ROOT="$(repo_root_of "$WD" 2>/dev/null)"; then
    if [ -n "${AIGW_KEY_FILE:-}" ] || [ -f "$HOME/.config/meshy-aigw.key" ]; then
      : # key location resolved at fallback time
    fi
    dry_route_summary "run_loop-fallback" "WORKDIR $WD is not a git repo (non-repo surface goes to run_loop by design)"
    dry "fallback command (inside tmux loop-${TAG}): export MESHY_AIGW_KEY=\"\$(cat ${AIGW_KEY_FILE:-<AIGW_KEY_FILE>})\"; while [ ! -f '$FLAG' ]; do bash '$RUN_LOOP_SCRIPT' '$TAG' '$WD' '$FLAG' '$PF' '$LOG' '$FALLBACK_MODEL'; sleep 5; done"
    exit 0
  fi
  if ROUTE_OUT="$(resolve_route "$ROOT" 2>/dev/null)"; then
    if [ "$(echo "$ROUTE_OUT" | awk '{print $1}')" = "fleet" ]; then
      _base="$(git -C "$WD" branch --show-current 2>/dev/null)"
      if [ -n "$_base" ]; then
        dry_route_summary "akari-fleet project=$(echo "$ROUTE_OUT" | awk '{print $2}') base=$_base"
      else
        dry_route_summary "AKARI_GATE_FAIL" "fleet match but detached HEAD, no base_ref (fail-loud, no downgrade)"
      fi
    else
      dry_route_summary "akari-default (default pool, r1 semantics)"
    fi
  elif akari_ok; then
    dry_route_summary "run_loop-fallback" "repo root $ROOT not in akari project registry"
    dry "fallback command (inside tmux loop-${TAG}): export MESHY_AIGW_KEY=\"\$(cat ${AIGW_KEY_FILE:-<AIGW_KEY_FILE>})\"; while [ ! -f '$FLAG' ]; do bash '$RUN_LOOP_SCRIPT' '$TAG' '$WD' '$FLAG' '$PF' '$LOG' '$FALLBACK_MODEL'; sleep 5; done"
  else
    dry_route_summary "run_loop-fallback" "akari /api/health probe failed — real run would use fallback per owner 0907 ruling"
    dry "fallback command (inside tmux loop-${TAG}): export MESHY_AIGW_KEY=\"\$(cat ${AIGW_KEY_FILE:-<AIGW_KEY_FILE>})\"; while [ ! -f '$FLAG' ]; do bash '$RUN_LOOP_SCRIPT' '$TAG' '$WD' '$FLAG' '$PF' '$LOG' '$FALLBACK_MODEL'; sleep 5; done"
  fi
  exit 0
fi

if [ -n "$ROUTE_MODE" ]; then
  if [ "$ROUTE_MODE" = "fleet" ]; then
    echo "[$(date '+%F %T')] akari_dispatch[$TAG] ROUTE=akari-fleet project=$ROUTE_PROJ base=$ROUTE_BASE (registry root match + health ok)" | tee -a "$LOG" >&2
    dlog "provenance repo_root=$ROOT branch=$ROUTE_BASE head=$(git -C "$WD" rev-parse HEAD 2>/dev/null)"
  else
    echo "[$(date '+%F %T')] akari_dispatch[$TAG] ROUTE=akari-default (default pool, r1 semantics + health ok)" | tee -a "$LOG" >&2
    dlog "provenance repo_root=$ROOT head=$(git -C "$WD" rev-parse HEAD 2>/dev/null)"
  fi
  if run_on_akari "$ROUTE_MODE" "$ROUTE_PROJ" "$ROUTE_BASE"; then
    register_manifest "$TAG" "$WD" "$ROUTE_MODE"
    if [ "$ROUTE_MODE" = "fleet" ]; then
      board_mark_dispatched "akari@fleet:${ROUTE_PROJ}"
    else
      board_mark_dispatched "akari@default"
    fi
    exit 0
  fi
  REASON="akari workflow submission failed (tmux new-session failed)"
fi

# ── run_loop fallback (owner 0907: akari down/unable = incident; loud banner) ─
{
  echo "=============================================================="
  echo "[AKARI_FALLBACK] worker $TAG cannot take akari: $REASON"
  echo "  auto-fallback to run_loop per owner 0907 ruling (tmux, model=$FALLBACK_MODEL)"
  echo "=============================================================="
} | tee -a "$LOG" >&2
printf '[AKARI_FALLBACK] %s worker %s: %s\nfallback: run_loop model=%s (tmux loop-%s)\n' \
  "$(date '+%F %T')" "$TAG" "$REASON" "$FALLBACK_MODEL" "$TAG" > "$CW/FALLBACK_akari_${TAG}"
if [ ! -f "$RUN_LOOP_SCRIPT" ]; then
  echo "[AKARI_GATE_FAIL] fallback script $RUN_LOOP_SCRIPT does not exist — no route left" | tee -a "$LOG" >&2
  printf '[AKARI_GATE_FAIL] %s worker %s: akari unable and fallback script missing\n' "$(date '+%F %T')" "$TAG" > "$CW/FAILSIG_akari_gate_${TAG}"
  exit 1
fi
KEY_EXPR="cat \$HOME/.config/meshy-aigw.key"
if [ -n "${AIGW_KEY_FILE:-}" ]; then
  KEY_EXPR="cat '$AIGW_KEY_FILE'"
fi
SESS="loop-${TAG}"
"$TMUX_BIN" kill-session -t "$SESS" 2>/dev/null
# key read at runtime inside tmux; never inline on the command line (ps/tmux visible = credentials-in-logs red line)
if ! "$TMUX_BIN" new-session -d -s "$SESS" \
  "export MESHY_AIGW_KEY=\"\$( $KEY_EXPR )\"; while [ ! -f '$FLAG' ]; do bash '$RUN_LOOP_SCRIPT' '$TAG' '$WD' '$FLAG' '$PF' '$LOG' '$FALLBACK_MODEL'; sleep 5; done"; then
  echo "[AKARI_GATE_FAIL] fallback tmux new-session failed" | tee -a "$LOG" >&2
  printf '[AKARI_GATE_FAIL] %s worker %s: fallback tmux start failed\n' "$(date '+%F %T')" "$TAG" > "$CW/FAILSIG_akari_gate_${TAG}"
  exit 1
fi
register_manifest "$TAG" "$WD" "runloop-fallback"
board_mark_dispatched "${FALLBACK_MODEL}@runloop"
dlog "FALLBACK submitted: tmux $SESS run_loop model=$FALLBACK_MODEL (reason: $REASON)"
exit 0
