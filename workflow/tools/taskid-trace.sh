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

# Deployment knobs (explicit; no implicit home reads). Defaults point at the
# upstream tool checkout on this machine; override via environment.
MSCTL_BIN="${MSCTL_BIN:-/jfs/home/zhiningjiao/code/task-asset-fetch-0918/bin/msctl}"
MSCTL_AUTH_DIR="${MSCTL_AUTH_DIR:-/jfs/home/zhiningjiao/code/task-asset-fetch-0918/auth-prod}"
OUT_BASE="${TASKID_TRACE_OUT:-/tmp/taskid-trace}"
STAMP="$(date +%Y%m%dT%H%M%S)"
OUT="$OUT_BASE/${TASK_ID}-$STAMP"
mkdir -p "$OUT"
LOG="$OUT/trace.log"
exec > >(tee -a "$LOG") 2>&1
echo "== taskid-trace $TASK_ID env=$ENVIRONMENT since=$SINCE assets=$ASSETS start=$(date '+%F %T')"

INFO_MANIFEST="$OUT/info/manifest.json"
if [ "$ENVIRONMENT" = "prod" ]; then
  # ① prod: official msctl companion, info-only (explicit CLI-owned auth).
  [ -x "$MSCTL_BIN" ] || { echo "MSCTL_BIN not executable: $MSCTL_BIN" >&2; exit 2; }
  [ -d "$MSCTL_AUTH_DIR" ] || { echo "MSCTL_AUTH_DIR missing: $MSCTL_AUTH_DIR" >&2; exit 2; }
  python3 "$LIB/task_asset_msctl.py" "$TASK_ID" \
    --config-dir "$MSCTL_AUTH_DIR" --profile prod --msctl "$MSCTL_BIN" \
    --out "$OUT/info" || { echo "msctl info failed" >&2; exit 2; }
else
  # ① staging: bounded web/v2 management API client; token from env only.
  python3 "$LIB/task_asset_fetch.py" "$TASK_ID" --env staging \
    --token-env "${TASKID_TRACE_TOKEN_ENV:-MESHY_TASK_TOKEN}" \
    --out "$OUT/info" || { echo "staging info failed" >&2; exit 2; }
fi

# ② Loki three-stage log pull (loki.py reads LOKI_URL/LOKI_TOKEN itself).
if LOCI_OUT=$(python3 "$LIB/loki.py" "$TASK_ID" --since "$SINCE" --out "$OUT/logs"); then
  echo "loki: $LOCI_OUT"
else
  RC=$?
  echo "WARN: loki pull failed rc=$RC (see $OUT/logs state above)" >&2
fi

# ③ optional --assets: download output/ keys into a fresh directory.
if [ "$ASSETS" = "1" ]; then
  python3 - "$TASK_ID" "$ENVIRONMENT" "$OUT" "$LIB" "$MSCTL_BIN" "$MSCTL_AUTH_DIR" <<'PY'
import json, subprocess, sys, os
task, environment, out, lib, msctl, auth = sys.argv[1:7]
keys = []
if environment == "prod":
    # List output/ via the official CLI (explicit auth dir; stderr suppressed).
    listing = subprocess.run([msctl, "--config-dir", auth, "--profile", "prod",
                              "tasks", "ls", task + "/output/"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=120)
    for line in listing.stdout.decode(errors="replace").splitlines():
        line = line.strip()
        if line.startswith("output/"):
            keys.append(line)
else:
    manifest_path = os.path.join(out, "info", "manifest.json")
    with open(manifest_path, encoding="utf-8") as stream:
        for entry in json.load(stream).get("listing", {}).get("entries", []):
            key = entry.get("key", "")
            if key.startswith("output/") and not key.endswith("/"):
                keys.append(key)
cmd = [sys.executable, os.path.join(lib, "task_asset_msctl.py"), task,
       "--config-dir", auth, "--profile", "prod", "--msctl", msctl,
       "--out", os.path.join(out, "assets")]
if environment == "staging":
    cmd = [sys.executable, os.path.join(lib, "task_asset_fetch.py"), task,
           "--env", "staging", "--token-env",
           os.environ.get("TASKID_TRACE_TOKEN_ENV", "MESHY_TASK_TOKEN"),
           "--out", os.path.join(out, "assets")]
for key in keys[:20]:
    cmd += ["--key", key]
if not keys:
    print("assets: no output/ keys found; nothing downloaded")
    raise SystemExit(0)
proc = subprocess.run(cmd, stdin=subprocess.DEVNULL,
                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1800)
print("assets:", proc.stdout.decode(errors="replace").strip())
raise SystemExit(proc.returncode)
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
logs = sorted(f for f in os.listdir(os.path.join(out, "logs")) if f.endswith(".log")) \
       if os.path.isdir(os.path.join(out, "logs")) else []
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
