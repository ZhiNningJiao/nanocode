#!/bin/bash
# One-shot detached restarter for nanocode 9475 (queuefix deploy, 2026-07-07).
# Waits for the in-flight claude turns (the fixer agent + secretary) to finish
# before killing the old server, so no message pipe is cut mid-turn.
# Must run under setsid, fully detached from the agent that spawned it.
OLD_PID=${1:?old server pid}
LOG=~/code/nanocode/restart-9475.log
exec >> "$LOG" 2>&1
echo "=== $(date '+%F %T') restarter armed, old server pid=$OLD_PID"

# Wait until the old server has no busy claude --print children (max 15 min).
for i in $(seq 1 180); do
  busy=$(ps --ppid "$OLD_PID" -o comm= 2>/dev/null | grep -c '^claude$')
  [ "$busy" -eq 0 ] && break
  sleep 5
done
echo "$(date '+%F %T') busy-claude children remaining: ${busy:-?} (proceeding)"

kill "$OLD_PID" 2>/dev/null
for i in $(seq 1 20); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
kill -0 "$OLD_PID" 2>/dev/null && { kill -9 "$OLD_PID"; sleep 2; }
echo "$(date '+%F %T') old server stopped"

cd ~/code/nanocode || exit 1
PORT=9475 HOST=0.0.0.0 nohup node server/index.js >> nanocode-9475.log 2>&1 &
NEW_PID=$!
sleep 4
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9475/)
health=$(curl -s http://127.0.0.1:9475/api/health)
echo "$(date '+%F %T') new server pid=$NEW_PID http=$code health=$health"

curl -s -d "nanocode 9475 已重启部署 queuefix(原子强打断) http=$code | 9476 稳定版v1.6.0在跑 | 详报 ~/code/reports/NANOFIX_20260707.md" \
  http://10.18.8.55/zhiningwork >/dev/null 2>&1
echo "=== done"
