#!/usr/bin/env bash
# aigw-errors.sh — 拉 AIGW/LiteLLM 失败告警（Slack DM 摘要, owner 0831 指路）
# scripts_resume_2241 移植版：token 文件与频道显式可配，凭据绝不入仓。
# 用法: aigw-errors.sh [N条, 默认5]
# 依赖: curl, python3；SLACK_TOKEN_FILE（默认 ~/.config/slack-user-token.env，
#       行格式 SLACK_USER_TOKEN=...）必须存在，缺失即 fail-loud。
set -u
N="${1:-5}"
SLACK_TOKEN_FILE="${SLACK_TOKEN_FILE:-$HOME/.config/slack-user-token.env}"
AIGW_SLACK_CHANNEL="${AIGW_SLACK_CHANNEL:?aigw-errors: AIGW_SLACK_CHANNEL missing (live channel id stays on the machine)}"
[ -s "$SLACK_TOKEN_FILE" ] || { echo "aigw-errors: slack token missing at $SLACK_TOKEN_FILE (set SLACK_TOKEN_FILE)" >&2; exit 2; }
TOK=$(/usr/bin/grep '^SLACK_USER_TOKEN=' "$SLACK_TOKEN_FILE" | cut -d= -f2)
[ -n "$TOK" ] || { echo "aigw-errors: no SLACK_USER_TOKEN line in $SLACK_TOKEN_FILE" >&2; exit 2; }
curl -sm15 "https://slack.com/api/conversations.history?channel=$AIGW_SLACK_CHANNEL&limit=$N" \
  -H "Authorization: Bearer $TOK" | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin)
if not d.get('ok'): print('slack err:',d.get('error')); sys.exit(1)
for m in d.get('messages',[]):
    ts=datetime.datetime.fromtimestamp(float(m['ts'])).strftime('%m-%d %H:%M:%S')
    fields={}
    for b in m.get('blocks',[]):
        for f in b.get('fields',[]) if b.get('type')=='section' else []:
            t=f.get('text','')
            if '*Requested*' in t: fields['req']=t.split('\`')[1] if '\`' in t else t
            if '*Latency*' in t: fields['lat']=t.split('\`')[1] if '\`' in t else ''
    print(f\"{ts} | {fields.get('req','?')} | {fields.get('lat','')}\")"
