# TASK {{tag}} — {{title}}（{{titleMeta}}）

## 为什么
{{why}}

## 先读（开工必读，读完再动手）
{{readFirst}}

## 要做
{{todo}}

## 交付
- `{{report}}`：首行 `VERDICT: DONE|PARTIAL`；开头{{plainAudience}}大白话 ≤ {{plainLines}} 行{{deliverExtra}}。写完 `touch {{flag}}`。开工先写 `{{step}}` 一行开工条，每个里程碑往上加一行（时间取 `date`）。{{boardLine}}
- 卡住要秘书给东西（信息 / 权限 / 资产）：写 `{{needsig}}`，第一行一句话说要什么；能做的部分照做，不空转。
- 收工报告末尾列「下一段可续派的活」≥ 1 条（或写明为何到此为止）。
{{siblings}}

## 红线
{{redlinesExtra}}- 绝不在 `{{sharedCheckouts}}` 共享检出里跑会写的 git 命令或改文件{{boardException}}；不碰别的车的工区和分支。
- **tmux**：你自己跑在 {{hostLabel}} 默认 tmux 里，不许运行任何 tmux 命令（测试要起 tmux 一律 `env -u TMUX tmux -S <本工区绝对套接字路径>`）。
- 不发飞书 / Slack / Linear。不许用 Agent 工具 / 子代理、MCP 连接器。不跑图像生成。{{keyRule}}不写宿主机 `/tmp`（临时文件放 `{{workdir}}/tmp/`）；每条 Bash 显式 timeout（≤ 600000 毫秒）；不用 run_in_background、Monitor、nohup；不按命令行模式 kill。
- {{hostLabel}} 上车多：重活放单元 `systemd-run --user --collect --unit={{unitPrefix}}-<名> -p CPUQuota=800% -p MemoryMax=20G -p MemorySwapMax=0`，**同时最多 {{heavyUnits}} 个重活**；收工停自己的单元。
- STEP / REPORT / FLAG / NEEDSIG 写在 `{{workRoot}}/` 顶层。硬顶前留 15 分钟写报告。
