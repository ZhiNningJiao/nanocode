# Sanitization — 工具链归档脱敏说明

本归档为**脱敏版**：原样归档（`zhining/toolchain-archive` @ 0e8dd12）基础上，
对所有情报形状值替换为占位符。占位符实值见内网 `~/code/` 真件，本仓库不保存映射。

## 占位符一览

| 占位符 | 替换对象（形状） |
| --- | --- |
| `«INTERNAL_HOST»` | 内网 IP：10 段 / 192-168 段 / 172-16 至 172-31 段的点分四段地址 |
| `«FEISHU_CHAT_ID»` | 飞书 chat id：`oc_` 前缀 + 16 位以上小写字母数字串 |
| `«SLACK_ID»` | Slack user/channel id：U/D/C 前缀 + 9 位以上大写字母数字串 |
| `«EMAIL»` | 内部邮箱地址（公司域邮箱等） |
| `«INTERNAL_GATEWAY»` | 内部网关域名（非公开产品域，如内网 AI 网关域） |

## 保留项（按 owner 决策，非情报）

- key/token **文件路径引用**（如 `~/.config/xxx.key`）保留——路径非情报，内容才是（内容本就不入库）。
- 公开产品域 / staging 域（公司公开产品域本体）可留。
- 本地文件系统路径（绝对 home 路径、`~/code/...`）保留，脚本可读性优先。

## 自查（归档时双侧 grep 零命中，模式见任务书 TASK toolchain_sanitize 第 4 条）

- 密钥形状：Anthropic/OpenAI/OAuth/Slack 四大 token 前缀 + PEM 私钥头 + Bearer 长串——零命中。
- 情报形状：内网点分 IP（三个段族）+ 飞书 oc_ 长串 + 公司邮箱域 + 内网 AI 网关域 + Slack U 头 id——零命中。

可读性：全部 `.sh` 过 `bash -n`，全部 `.py` 过 `python3 -m py_compile`（占位符不破坏引号结构）。
