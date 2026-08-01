#!/usr/bin/env bash
#
# wake-secretary.sh — Wake an idle/stuck nanocode secretary session by injecting
# a user message over HTTP. Uses the POST /api/sessions/:id/inject endpoint
# (localhost-only), which reuses the exact WS 'claude-input' dispatch path — so
# the injected message is indistinguishable from the secretary typing it.
#
# Why: nanocode --watch restarts kill every internal listener, so a crontab
# watchdog can't poke the secretary over the old WS channel. This HTTP path is
# the only reliable external wake. sendNow=true (default) atomically interrupts
# a busy turn and flushes the injected message as the next turn (mirrors the
# "立刻发送" button; never kills the claude process or sub-agents).
#
# Usage:
#   wake-secretary.sh [wake-text]            # default text below, port 9475
#   NANO_PORT=9479 wake-secretary.sh "go"    # custom port
#   NANO_TOKEN=xxx wake-secretary.sh "go"    # when token auth is enabled
#   NANO_MATCH=f5bfda87 wake-secretary.sh    # filter by session/tab/label/cwd
#   SEND_NOW=0 wake-secretary.sh "hi"        # queue behind a running turn
#
# Env:
#   NANO_PORT  — server port (default 9475)
#   NANO_TOKEN — auth token (default '' = auth disabled). When non-empty it is
#                sent as X-Nanocode-Token header.
#   NANO_MATCH — substring to match against sessionKey, tabId, tabLabel, or cwd
#                (case-insensitive). Claude and Codex secretary sessions are
#                eligible. If unset, the first eligible session is used.
#   SEND_NOW   — 1 (default) = interrupt+flush; 0 = queue behind running turn.
#
# Exit codes:
#   0  inject dispatched
#   1  no matching session found / server unreachable
#   2  inject returned non-200
#
set -euo pipefail

PORT="${NANO_PORT:-9475}"
TOKEN="${NANO_TOKEN:-}"
MATCH="${NANO_MATCH:-}"
SEND_NOW="${SEND_NOW:-1}"
TEXT="${1:-读 TODO.md 执行待执行任务}"

BASE="http://127.0.0.1:${PORT}"
AUTH_HDR=()
if [[ -n "$TOKEN" ]]; then
  AUTH_HDR=(-H "X-Nanocode-Token: ${TOKEN}")
fi

echo "[wake-secretary] GET ${BASE}/api/sessions"
SESSIONS_JSON="$(curl -sS --max-time 5 "${AUTH_HDR[@]}" "${BASE}/api/sessions" 2>/dev/null)" || {
  echo "[wake-secretary] server unreachable on port ${PORT}" >&2
  exit 1
}

# Extract the first matching secretary sessionKey. jq if available, else node.
pick_session() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    if [[ -n "$MATCH" ]]; then
      echo "$json" | jq -r --arg m "$MATCH" '
        [.sessions[] | select(.type=="claude" or .type=="codex")]
        | map(select(
            ((.sessionKey // "") + " " + (.tabId // "") + " " +
             (.tabLabel // "") + " " + (.cwd // ""))
            | ascii_downcase | contains($m|ascii_downcase)
          ))
        | .[0].sessionKey // empty'
    else
      echo "$json" | jq -r '[.sessions[] | select(.type=="claude" or .type=="codex")] | .[0].sessionKey // empty'
    fi
  else
    node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const m = process.argv[1] || "";
      let cs = (j.sessions||[]).filter(s => s.type === "claude" || s.type === "codex");
      if (m) {
        const ml = m.toLowerCase();
        cs = cs.filter(s => (
          (s.sessionKey||"") + " " + (s.tabId||"") + " " +
          (s.tabLabel||"") + " " + (s.cwd||"")
        ).toLowerCase().includes(ml));
      }
      process.stdout.write(cs[0] ? cs[0].sessionKey : "");
    ' "$MATCH" <<<"$json"
  fi
}

SESSION_KEY="$(pick_session "$SESSIONS_JSON")"
if [[ -z "$SESSION_KEY" ]]; then
  echo "[wake-secretary] no matching secretary session found on port ${PORT}" >&2
  echo "[wake-secretary] active sessions: $(echo "$SESSIONS_JSON" | head -c 300)" >&2
  exit 1
fi
echo "[wake-secretary] target session: ${SESSION_KEY}"

# POST /api/sessions/:id/inject — URL-encode the key (colons are fine in curl
# paths, but encode to be safe).
ENCODED_KEY="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$SESSION_KEY")"
URL="${BASE}/api/sessions/${ENCODED_KEY}/inject"

echo "[wake-secretary] POST ${URL}  (sendNow=${SEND_NOW})"
RESP="$(curl -sS --max-time 10 -w '\n%{http_code}' \
  "${AUTH_HDR[@]}" \
  -H 'Content-Type: application/json' \
  -X POST "$URL" \
  -d "$(node -e "process.stdout.write(JSON.stringify({text:process.argv[1], sendNow:process.argv[2]==='1'}))" "$TEXT" "$SEND_NOW")" 2>/dev/null)" || {
  echo "[wake-secretary] inject request failed" >&2
  exit 2
}

HTTP_CODE="$(echo "$RESP" | tail -1)"
BODY="$(echo "$RESP" | sed '$d')"
echo "[wake-secretary] HTTP ${HTTP_CODE}: ${BODY}"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "[wake-secretary] OK — injected: ${TEXT}"
  exit 0
fi
echo "[wake-secretary] inject failed (HTTP ${HTTP_CODE})" >&2
exit 2
