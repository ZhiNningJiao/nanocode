# workflow/ — 一套人机协作秘书工作流的沉淀仓

> 10 分钟读完。Owner 2026-09-18 原话：「我觉得我们的工作流应该沉淀在我个人 fork 的
> nanocode 仓库了，包括这一整套习惯，工作流等。」本目录是那份沉淀的草案分支
> `zhining/workflow-corpus-0918`（不合 main，只本地 commit，由秘书搬运）。

## 这套工作流是什么

一句话：**一个人类 owner + 一个 AI 秘书（调度中枢）+ 一群并行 AI worker（免费模型为主）
的工厂式流水线**。owner 只出想法和拍板；秘书负责把想法变成任务书、派车、防假过验收、
给 owner 出证据和链接；worker 领任务书干活，用 FLAG/REPORT/日志自证；史官（waker）
每几分钟巡一遍在跑车并唤醒秘书；飞书是 owner 与秘书的双向通道。

核心信念（血泪换来）：
1. **worker 的完成声明只是待证命题**——一切以 run.log / diff / 可复现证据为准（防假过）。
2. **免费的 GLM 疯狂并行**，贵模型只做攻坚和关键决策（省额度）。
3. **有活即派、活不落地**；失败必须分类处置，禁止原样空转。
4. 所有规则「不当 review comment 商量，进门禁直接判 FAIL」。

## 角色

| 角色 | 是谁 | 职责 |
|---|---|---|
| owner | 人类 | 出想法、拍板、终验收（尤其视觉） |
| 秘书 | Team1 Claude/Codex 会话 | 唯一调度者：派单、验收、回写 Linear、通知 owner；不亲写业务代码 |
| worker | 免费 GLM 为主 / Opus 攻坚 | 领任务书干活，自跑自验自报 |
| 史官 waker | `waker.sh` tmux 常驻 | 只读只报不处置：巡查在跑车、注入简报唤醒秘书 |
| waker-keeper / failsafe | cron 脚本 | 守卫的守卫：waker 死了拉起；秘书猝死自动交接 |
| 桥 | feishu-secretary-bridge | 飞书 ↔ 秘书会话实时双向 |
| 视觉初审 | Team2 Sonnet headless | 一切像素裁决归它，秘书/worker 绝不 Read 图片 |

## 一天怎么转

1. owner 在飞书/会话丢想法 → 秘书当天入想法板（飞书 Base，唯一业务台账）。
2. 秘书写任务书（模板见 `dispatch/README.md`，内嵌任务书模板）→ 经 `akari_dispatch.sh` 派车
   （武器库段自动前置：CodeKG 速查 + ARSENAL_INDEX + memq 考古）。
3. worker 开工三查（memq 决策 / CodeKG 地形 / 武器库）→ 干活 → `cmd 2>&1 | tee run.log`
   → grep 干净 → REPORT（每条断言带 `证据: 文件:行号`）→ 落 FLAG（push 在前 FLAG 在后）
   → 报告末尾列「下一段可续派的活」≥1 条。
4. 旗哨 cron 扫到 FLAG → 双审 QA（机械门 `qa_gate_mechanical.py` + 语义门
   `qa_gate_semantic.py`）→ 秘书独立验收 → 想法板结案（已验收+已通知才算结案）→
   飞书回执通知 owner。
5. 史官每 4.5–30 分钟一拍简报注入秘书；P0/熔断/用量越线用 `‼️【异常禀报】` 强插。
6. 秘书交接时：在飞状态移入归档、新秘书按接班 10 步走（见 `handoff/`）。

## 接班 10 步（秘书新会话第一件事）

见 `dispatch/../README` 同级的规则引用，权威全文在
`~/code/workflow-docs-tidy-1335/candidates/CURRENT_WORKFLOW.v2.md §1`（v2 候选，未生效前
以 `~/.claude/.../memory/CURRENT_WORKFLOW.md` 为准）。速记版：

1. 确认自己是谁（duty-status + switch-secretary.sh）→ 2. 读决策台账 Linear MES-15907
（只读 head+5）→ 3. 读工作流 §1–§5 + MEMORY 索引 → 4. 读在飞状态（HANDOFF +
work-log 最近5条 + INBOX）→ 5. 扫信号 `ls -t ~/codex_work | grep -E '^(FLAG|NEEDSIG|FAILSIG|SPIN)_'`
→ 6. 扫在跑车（判活只看 log mtime，绝不 pgrep）→ 7. 池况 usage_snap + MODEL_ROSTER →
8. 设巡检 cron（全员空闲就关）→ 9. 飞书到岗回执（bot 署名）→ 10. 每条在跑线答三问
（在干什么 / FLAG 名与落没落 / 下一步等谁），答不全=接班失败。

## 四流程各一页

- **派单** → `dispatch/README.md`（任务书模板 + DISPATCH_HEADER 副本 + 模型路由）
- **验收** → `rules/verification.md`（防假过：机械门+语义门+视觉归 Sonnet）
- **汇报** → `rules/reporting.md`（时间戳、Linear 中性、飞书分级、方向简报）
- **归档** → `rules/archive.md`（ARCHIVE_RULES v1 十条：两证齐才结案，未结案永久保留）

## 规则索引

- `rules/redlines.md` — 通用红线（不碰 main/8770、密钥不进 git、过程产物不入库…）
- `rules/timestamp.md` — 时间自检与计数以日志为准
- `rules/scope-guard.md` — Scope 护栏（白名单、越界即停）
- `rules/dispatch-ironlaw.md` — 有活即派 + 续派条款 + 空转四分类
- `rules/linear.md` — Linear 只读 head+5、中性措辞、评论压缩
- `rules/verification.md` — 防假过验收门
- `rules/reporting.md` — 汇报与通知分级
- `rules/archive.md` — 归档规则 v1
- `rules/measurement.md` — 实验计时/测量口径（算法 vs HTTP、案例命名）
- `gantt-map.md` — 甘特派单板数据关系映射（已实现候选 vs 当前部署分离）
- `scripts/check_docs.sh` — 文档链接+泄漏轻量体检（零依赖）
- `MIGRATION.md` — 哪些实体应真迁进仓、哪些留本机
- `retro/2026-09-18-astra.md` — Astra 班次复盘摘要与脚本化清单
- `scripts/INDEX.md` — 脚本入口表（只登记路径，不复制本体）
