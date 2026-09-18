#!/usr/bin/env bash
# taskid-trace.sh — one command per task id: ①info summary ②Loki three-stage
# log pull ③optional --assets download ④TIMELINE.md.
#
# Usage:
#   taskid-trace.sh <TASK_ID> [--env prod|staging] [--since 24h] [--assets]
#
# Credentials never enter this repository: they are read at call time from
# explicit locations/env vars (see workflow/tools/README.md).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/lib"

TASK_ID="" ENVIRONMENT="prod" SINCE="1h" ASSETS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --assets) ASSETS=1; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) if [ -z "$TASK_ID" ]; then TASK_ID="$1"; shift; else echo "extra arg: $1" >&2; exit 2; fi ;;
  esac
done
[ -n "$TASK_ID" ] || { echo "usage: taskid-trace.sh <TASK_ID> [--env prod|staging] [--since 24h] [--assets]" >&2; exit 2; }
case "$TASK_ID" in
  *[!0-9a-fA-F-]*|"") echo "task id must be a UUID-like token" >&2; exit 2 ;;
esac
case "$ENVIRONMENT" in prod|staging) ;; *) echo "--env must be prod or staging" >&2; exit 2 ;; esac
case "$SINCE" in *[!0-9smhd]*) echo "bad --since" >&2; exit 2 ;; esac

# Deployment knobs (explicit; no machine-specific defaults, fail-loud).
# Point MSCTL_BIN/MSCTL_AUTH_DIR at your task-asset-fetch checkout in the env
# (or an env file sourced by the caller); nothing about this machine is baked in.
MSCTL_BIN="${MSCTL_BIN:?taskid-trace: MSCTL_BIN missing (path to msctl binary)}"
MSCTL_AUTH_DIR="${MSCTL_AUTH_DIR:?taskid-trace: MSCTL_AUTH_DIR missing (dir holding config.toml with profiles)}"
# Unified entry (scripts_resume_2241): BOTH environments go through the official
# msctl adapter. The shipped config.toml carries [profiles.prod] and [profiles.stg]
# in the SAME auth dir, so staging reuses the existing msctl session with
# --profile stg — no MESHY_TASK_TOKEN, no browser tokens, no fresh auth.
PROFILE="prod"
case "$ENVIRONMENT" in
  staging) PROFILE="${MSCTL_STG_PROFILE:-stg}" ;;
esac
OUT_BASE="${TASKID_TRACE_OUT:-/tmp/taskid-trace}"
STAMP="$(date +%Y%m%dT%H%M%S)"
OUT="$OUT_BASE/${TASK_ID}-$STAMP"
mkdir -p "$OUT"
LOG="$OUT/trace.log"
exec > >(tee -a "$LOG") 2>&1
echo "== taskid-trace $TASK_ID env=$ENVIRONMENT since=$SINCE assets=$ASSETS start=$(date '+%F %T')"

INFO_MANIFEST="$OUT/info/manifest.json"
# ① unified: official msctl companion, info-only (explicit CLI-owned auth).
[ -x "$MSCTL_BIN" ] || { echo "MSCTL_BIN not executable: $MSCTL_BIN" >&2; exit 2; }
[ -d "$MSCTL_AUTH_DIR" ] || { echo "MSCTL_AUTH_DIR missing: $MSCTL_AUTH_DIR" >&2; exit 2; }
python3 "$LIB/task_asset_msctl.py" "$TASK_ID" \
  --config-dir "$MSCTL_AUTH_DIR" --profile "$PROFILE" --msctl "$MSCTL_BIN" \
  --out "$OUT/info" || { echo "msctl info failed (profile=$PROFILE)" >&2; exit 2; }

# ② Loki three-stage log pull (lib/loki_pull.py staging shell over verbatim lib/loki.py:
#    direct-Loki fallback when LOKI_URL is set; key read per README contract).
LOKI_MSG=""
if LOKI_MSG=$(python3 "$LIB/loki_pull.py" "$TASK_ID" --since "$SINCE" --out "$OUT/logs"); then
  echo "loki: $LOKI_MSG"
else
  RC=$?
  # Fail-loud, machine-readable: this JSON must land in trace.log and stdout.
  echo "{\"state\": \"loki_failed\", \"rc\": $RC, \"detail\": ${LOKI_MSG:-\"(no output)\"}}"
  echo "FAIL: loki pull failed rc=$RC (state JSON above)" >&2
fi

# ③ optional --assets: download output/ keys into a fresh directory.
if [ "$ASSETS" = "1" ]; then
python3 - "$TASK_ID" "$PROFILE" "$OUT" "$LIB" "$MSCTL_BIN" "$MSCTL_AUTH_DIR" <<'PY'
import json, os, re, subprocess, sys
task, profile, out, lib, msctl, auth = sys.argv[1:7]
keys = []
# List output/ via the official CLI (explicit auth dir + profile). Real line
# format: "2026-09-17 08:55:31    4454524 Character_output.fbx" i.e.
# "<date> <time> <size> <name>" — leading timestamp, NOT an output/ prefix.
# Parse the trailing name column and re-prefix output/.
listing = subprocess.run(
    [msctl, "--config-dir", auth, "--profile", profile,
     "tasks", "ls", task + "/output/"],
    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, timeout=300)
err = listing.stderr.decode(errors="replace").strip()
if err:
    open(os.path.join(out, "assets-listing.stderr"), "w",
         encoding="utf-8").write(err + "\n")
if listing.returncode != 0:
    # Listing failure must be distinguishable from "no keys" and loud.
    print(json.dumps({"state": "listing_failed",
                      "rc": listing.returncode,
                      "stderr": err[-400:] if err else "(suppressed)"}))
    raise SystemExit(2)
pat = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\s+\d+\s+(.+)$")
for line in listing.stdout.decode(errors="replace").splitlines():
    m = pat.match(line.strip())
    if m:
        name = m.group(1).strip()
        if name and not name.endswith("/"):
            keys.append("output/" + name)
cmd = [sys.executable, os.path.join(lib, "task_asset_msctl.py"), task,
       "--config-dir", auth, "--profile", profile, "--msctl", msctl,
       "--out", os.path.join(out, "assets")]
if not keys:
    # Listing succeeded but nothing to fetch — a distinct, non-failure state.
    print(json.dumps({"state": "no_keys",
                      "note": "listing ok, zero output/ file keys"}))
    raise SystemExit(0)
for key in keys[:20]:
    cmd += ["--key", key]
proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, timeout=1800)
if proc.returncode != 0:
    print(json.dumps({"state": "download_failed", "rc": proc.returncode}))
    raise SystemExit(proc.returncode)
print(json.dumps({"state": "downloaded", "count": len(keys[:20])}))
PY
fi

# ④ TIMELINE.md
python3 - "$TASK_ID" "$ENVIRONMENT" "$OUT" <<'PY'
import json, os, sys
task, environment, out = sys.argv[1:4]
info = {}
manifest_path = os.path.join(out, "info", "manifest.json")
if os.path.exists(manifest_path):
    with open(manifest_path, encoding="utf-8") as stream:
        info = json.load(stream).get("task_info", {})
logdir = os.path.join(out, "logs")
logs = sorted(f for f in os.listdir(logdir) if f.endswith(".log")) \
       if os.path.isdir(logdir) else []
assets = sorted(os.listdir(os.path.join(out, "assets"))) \
         if os.path.isdir(os.path.join(out, "assets")) else []
NOW = os.popen('date "+%F %T"').read().strip()
lines = [f"# TIMELINE {task}", "", f"- environment: {environment}",
         f"- generated: {NOW}",
         f"- trace log: {os.path.join(out, 'trace.log')}", "", "## task info", ""]
for key in ("Mode", "Phase", "Status", "CreatedAt", "StartedAt", "FinishedAt"):
    if key in info:
        lines.append(f"- {key}: {info[key]}")
lines += ["", "## log stages", ""] + [f"- logs/{name}" for name in logs] or []
lines += ["", "## assets", ""] + [f"- assets/{name}" for name in assets] or []
with open(os.path.join(out, "TIMELINE.md"), "w", encoding="utf-8") as stream:
    stream.write("\n".join(lines) + "\n")
print("timeline:", os.path.join(out, "TIMELINE.md"))
PY
echo "== done $(date '+%F %T') out=$OUT"
