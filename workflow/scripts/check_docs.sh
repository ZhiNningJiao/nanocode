#!/bin/sh
# 轻量文档体检：workflow/ 内 markdown 相对链接与禁泄漏扫描。零依赖，不改 CI。
# 用法: sh workflow/scripts/check_docs.sh   （在仓库根目录跑）
set -e
cd "$(dirname "$0")/../.."
fail=0

# 1) 相对链接存在性（跳过 http(s)/mailto/锚点）
for f in $(find workflow -name '*.md'); do
  dir=$(dirname "$f")
  grep -oE '\]\(([^)#]+)' "$f" | sed 's/](//' | while IFS= read -r link; do
    case "$link" in
      http*|mailto:*|\#*) continue ;;
    esac
    [ -e "$dir/$link" ] || echo "BROKEN LINK: $f -> $link"
  done
done | tee /tmp/opencode/check_docs_links.txt
grep -q BROKEN /tmp/opencode/check_docs_links.txt && fail=1

# 2) 泄漏扫描。
#    fail 级=凭据（key/token/sk-私钥/chat_id）；info 级=本机绝对路径/内网 IP
#    （私有 fork 内属故意保留的操作指引，如 ntfy 全链接、CodeKG 路径）。
leaks=$(grep -rnE '/\.config/[^ ]*\.key|sk-[A-Za-z0-9]{8}|chat_id[=:][0-9]+|Bearer [A-Za-z0-9]' workflow --include='*.md' | grep -vE '键|密|白名单|默认路径|\.example|\*\*' || true)
if [ -n "$leaks" ]; then echo "LEAK (credential):"; echo "$leaks"; fail=1; else echo "credential-scan: clean"; fi
grep -rnE '~?zhiningjiao|10\.18\.' workflow --include='*.md' || true | wc -l | xargs echo "info: machine-path/IP mentions:"

exit $fail
