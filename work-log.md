# Work Log

## 2026-06-24 [NCBUG 紧急通信修复部署验证]
- 任务：修复/部署 nanocode 9475 文本框消息发给 agent 后 agent 收不到的问题，保持 9475/9476 至少一个可用。
- 接手状态：已有修复提交在分支 `zhining/fix-tmux-busy-wedge-dropped-messages`。关键提交：`c2d7eef fix(tmux): clear cs.busy on mid-turn bridge disconnect so messages stop silently queuing`、`a71faf4 fix(routing): honor client tabType hint when stored tab is missing`、`3776934 docs: update work-log with tmux filter/kill/drawer/manage-tabtypes iteration`。
- 根因确认：消息链路是前端 `claude-input` → `/ws/terminal` → `terminal/claude-session-controller.js` → `terminal/claude-tmux-driver.js` → tmux bridge/Claude SDK。主要断点是 tmux bridge socket 中途断开时 `runTmuxTurn` 的 Promise 不 settle，`cs.busy` 永久为 true，后续用户消息只进 `cs.queue` 不投递给 agent。另一个已修复风险是存储 tab 丢失时 WS attach 默认回 bash，导致 `claude-input` 被 bash PTY 忽略。
- 测试证据：`npm test` 全量通过，`tests 139`, `pass 139`, `fail 0`。其中 `claude tmux driver` 回归覆盖 bridge 收到 user 后发 init 再断 socket、不发 `turn-done` 的场景，断言 `cs.busy` 复位且第二条消息能继续 dispatch。
- 部署步骤：先重启 9476：`PORT=9476 node server/index.js`，验证 `curl http://127.0.0.1:9476/` → `200`，页面 asset version `v=3776934`；再重启 9475，期间 9476 保持在线；最终 `curl` 验证 9475/9476 均 `200`，9475 asset version `v=3776934`。
- 真链路验证：通过 9475 创建临时 Claude tab，WebSocket attach 后发送 `claude-input`：`Reply with exactly this marker and nothing else: NCBUG_OK_1782271869036`。收到结果：`{"user":true,"init":true,"result":true,"assistantIncludesMarker":true,"assistant":"NCBUG_OK_1782271869036"}`，证明前端消息已真实到达目标 agent 并返回。
- 远端：推送到 `fork` 的当前分支 `zhining/fix-tmux-busy-wedge-dropped-messages`。

## 2026-06-24 [dogfood UX: tmux filter/kill, Escape-close drawer, manage tab types shortcut]
- 任务：作为真实用户 dogfood nanocode，发现并修复 4 个操作痛点
- 痛点 & 修复：
  1. **tmux session 列表无类型筛选**（91 sessions 全混在一起）→ 新增 filter chips (All/AI/Claude/Codex/Node/Bash)，AI 分组聚合 claude+codex+node，`_currentTypeFilter` 状态过滤
  2. **无 kill session 按钮**（死 session 无法清理）→ 每行加 × 按钮 + 确认弹窗；后端新增 `DELETE /api/tmux/kill`，session name 用 `^[a-zA-Z0-9._-]+$` regex 防注入
  3. **Escape 不关 agent drawer**（backdrop 阻止点击）→ agents.js 加 keydown listener，Escape 关抽屉
  4. **新 tab 菜单无 "Manage tab types" 快捷入口** → tab-manager.js 新增菜单项，点击打开 settings 并滚到 tab type checkboxes
- i18n: 新增 5 key (tmux_filter_all, tmux_filter_ai, tmux_kill_title, tmux_kill_confirm, tmux_kill_failed) en+zh
- CSS: `.tmux-filter-chips`, `.tmux-filter-chip`, `.tmux-session-btns`, `.tmux-session-kill`, `.tab-new-menu-manage` + light theme
- 验证：`npm test` 138/138 pass 0 fail；dogfood_drive.mjs: filter chips=6, kill buttons=30, manage link=true, console errors=0
- 热部署：9475 重启成功，`DELETE /api/tmux/kill` API 验证通过（nonexistent session 返回 404 错误，不崩溃）
- commit: e87abb1, push fork zhining/fix-tmux-busy-wedge-dropped-messages

## 2026-06-24 [9475 实时通信丢消息 — tmux bridge busy 永久卡死修复]
- 现象：主人在 9475 文本框给 agent 发消息，消息不实时送达，同一条长消息被迫重发 5 次（像被打断/丢失）。
- 根因（具体到函数）：`terminal/claude-tmux-driver.js` 的 `runTmuxTurn`。本轮 turn 的 Promise **只**在 bridge Unix socket 收到 `turn-done`/`turn-error` 时 resolve/reject。一旦 socket 中途断开（bridge 崩溃 / tmux 被 kill / turn 进行中 server 重启），这两条消息永远不会到，Promise 永久挂起 → `finally` 永不执行 → **`cs.busy` 永久停留 true**。busy 卡死后，后续每一条 `claude-input` 都被 `if (cs.busy)` 分支塞进 `cs.queue`（弹 "Message queued"），永远不投递给 agent。这就是"发的东西收不到 / 被迫重发"。`TmuxBridgeClient` 的 `socket.on('close')` 当时只翻 `this.connected=false`，不通知在途 turn，所以断连完全静默。
- 修复（3 层）：①`TmuxBridgeClient` 新增 `onDisconnect()`，socket close/error 时通知在途 turn；②`runTmuxTurn` 注册 disconnect guard，断连即 reject → finally 清 `cs.busy` + 释放 `currentProc`；③加 idle 看门狗兜底（每个 live event 重置，默认 10min，`NANOCODE_TMUX_TURN_IDLE_MS` 可调），保证即使无 socket close 的静默 hang 也不会永久卡 busy；④dispatch 时 `send()` 失败立即 fail-fast。
- 验证：新增回归测试（fake bridge 收到 user turn 后发 init 再 destroy socket，不发 turn-done）→ 断言 `cs.busy` 复位、`currentProc` 释放、后续消息正常 dispatch 而非入队。`node --test claude-tmux-driver.test.js` 4/4 pass（含新测试，日志可见 `turn error: tmux bridge socket closed` 即 guard 触发）；`npm test` 全量 139/139 pass，0 fail。
- 红线遵守：**未重启 9475**（主人可能正在用）。修复在源码，下次重启生效。
- 产出：分支 `zhining/fix-tmux-busy-wedge-dropped-messages` 已 push 到 fork，commit c2d7eef。run log: `run-tmux-msgfix.log`。

## 2026-06-07 [subagent 事件隔离 — 输入框闪烁修复]
- 任务：修复 claude tab 派出 subagent 时，输入框闪烁 + 消息被误锁进队列
- 根因：`_isLiveTurnEvent` 未检查 `parent_tool_use_id`，subagent 流式事件被误当主 turn 进行中 → thinking 抖动 → 输入框闪；`_handleResult` 未检查 `parent_tool_use_id`，subagent result 误触发主 turn 的 `_setThinking(false)` + `turn-complete` + flush
- 修复 1：`_isLiveTurnEvent`(line 696)开头加 `if (event.parent_tool_use_id) return false`
- 修复 2：`_handleResult`(line 1739)开头加 `if (event.parent_tool_use_id) { /* 清 subagent live block */ return }` 守卫
- 回归测试：`server/tests/claude-busy-thinking.test.js` 新增 5 个 subagent 隔离测试用例(describe: "subagent event isolation")；新增 `global.localStorage` stub；86 tests pass 0 fail
- 热部署：kill 3001 → 新 3001 起 → `curl /api/health` 200
- browse 实测：workspace 截图存 /tmp/nanocode-*.png，输入框空闲无闪，无 JS 错误
- commit: (本次)，push fork zhining/nanocode-selfresume-bugs

## 2026-06-07 [turn-complete 自动通知]
- 任务：nanocode 自监控 claude turn 完成，自动触发通知(音效+favicon红点+ntfy)
- 前端 claude-block-renderer.js: _setThinking(true) 记录 _turnStartTime，_handleResult 计算 elapsed，dispatch nanocode:turn-complete 事件
- 前端 app.js: 监听 nanocode:turn-complete，elapsed >= 阈值 → playNotifySound + _addUnread + POST /api/notify/turn-complete
- 后端 server/index.js: 新增 POST /api/notify/turn-complete 路由
- 后端 server/qa-watcher.js: 新增 pushNtfyTurnComplete 导出
- Settings: 通知音效区域新增阈值输入(默认10s)和 ntfy 开关(默认开)，两控件均走 i18n
- 测试: server/tests/turn-notify.test.js 10 回归，全 pass (81 tests pass 0 fail)
- 3001 热部署: 3002 起 → kill 3001 → 新 3001 起 → 确认 /api/health 200
- commit: 2cc96f6，push fork zhining/nanocode-selfresume-bugs

## 2026-06-07 [light mode 完整配色]
- 任务：实现 light mode 完整配色，修复切换机制 bug，覆盖所有面板
- 机制修复：theme.js applyTheme() 改用 setAttribute('data-theme','light') 替代 removeAttribute，[data-theme="light"] CSS 规则正确生效
- CSS 变量：style.css 新增 [data-theme="light"] 显式块，镜像 :root 浅色值，确保属性选择器优先级对称
- 覆盖组件：settings-panel、agent-drawer、TTS 按钮、service 健康状态、diff colors、subagent badge — 全部从硬编码暗色 fallback（rgba(255,255,255,0.x)）改为 var(--token) 覆盖
- 测试：新增 server/tests/theme-regression.test.js，验证 setAttribute 机制/默认 dark/CSS 选择器；全 69 tests pass，0 fail
- 截图验收：landing/project-picker/workspace/settings/agent-drawer/mobile 均呈浅色；dark mode 零回归（settings-panel 暗色确认）
- commit: d744205，push fork zhining/nanocode-selfresume-bugs

## 2026-06-07 13:40 [修复桌面端 busy 发消息不入队/滚走]
- 任务：桌面端 Claude busy 时发消息，队列框不显示、消息直接滚走（期望对齐手机端/CLI：忙时入队列框留着）。分支 zhining/nanocode-selfresume-bugs。
- 复现（桌面视口 1280x860，Playwright 真模拟键盘/事件链）：
  - 同会话本地 echo 路径正常（msg1 sendInputWithEcho→thinking=true→msg2 入队，排队中(1) 出现）。
  - **失败路径 = 刷新/重连后正在 busy 的 turn**：reload 后 chat-input 没有 claude-thinking class（thinkingClass:false），composer 以为 Claude 空闲 → 下一条走"立即发送"分支滚走。
- 确认默认 driver：claude-session-controller.js:140 getClaudeDriver() 默认 'sdk'。WS probe 抓 SDK 事件流：turn 内 system/init→system/status→stream_event×N→assistant→result/success，result 只在 turn 末尾一次（后端 busy/queue 正常）。
- 根因（file:line）：public/js/claude-block-renderer.js — _setThinking(true) 只在 sendInputWithEcho()（line 702，本地 echo）触发；**没有任何服务器事件把 thinking 置 true**（grep 全文仅 702 处 true）。凡是本客户端没本地发起的 turn（reload/重连/快 turn/多端）→ isClaudeThinking 恒 false → terminal-view.js:1028 sendInput 走立即发送分支 → 滚走、tray 不显示。
- 修法（最小对症）：_handleEvent 去重后、switch 前，对 LIVE（非 fromReplay、非 _exited）的 turn-progress 事件调 _setThinking(true)。新增 _isLiveTurnEvent()：assistant/partial_message/stream_event/rate_limit_event + system{init|status} 算 turn 进行中；result/user/其他 system 子类型(queued/info/...) 不算。result 仍→false 触发 flush。fromReplay（jsonl 历史回放）不置 true，避免恢复已完成会话误显示 busy。_setThinking 值不变即 no-op，幂等不刷事件。不碰 586db7d skipFlush。
- 验证：npm test 2>&1 | tee run-traybug.log → 62 pass 0 fail。新增回归 server/tests/claude-busy-thinking.test.js（7 例，真过 _handleEvent，用 SDK 实抓的事件形状，断言 nanocode:claude-thinking{thinking:true} 派发 + result→false + fromReplay 不置忙 + 幂等）。
- 3001 实测：安全重启（3002 standby 200→kill 3001 pid→relaunch 3001 200→停 3002，全程至少一端口活）。Playwright reload-mid-turn：修后 thinkingClass:true，msg2 入队（排队中(1)）；修前 thinkingClass:false。
- 截图：before /tmp/repro-reload-before-clean.log（thinkingClass:false 证据）；after /tmp/repro-after-final.png（排队中(2) tray 可见，composer 清空不滚走）/tmp/repro-reload-after.png。
- 产出：见下方 commit SHA。
- 下一步：push 到 fork zhining/nanocode-selfresume-bugs，等主人审核推 main。

## 2026-06-07 [SDK driver 取代 CLI 成为 block 模式默认驱动]
- 任务：调查 Claude SDK driver 能否在 block 模式完全取代 CLI driver，有 gap 就修，最终改默认。
- 逐项对比结论：除权限 gap 外全部对齐（model/effort/resume+continue-fallback/工具事件/interrupt/queue-flush/init-snapshot/slash/subagent/MCP/skills 经 inherited settingSources 全支持/529 fallback）。
- 修复的 gap：SDK driver 之前读 claude_permission_mode（UI 从不写入的幽灵设置）→ 永远 bypassPermissions，忽略 auto-edits/ask。改为读 global_permission（与 CLI 同源）三档 1:1 映射：full-auto→bypassPermissions / auto-edits→acceptEdits / ask→default。保留 claude_permission_mode 旧值兜底。
- 默认 driver：getClaudeDriver() 改为默认 'sdk'，仅 claude_driver==='cli' 显式 opt-out 才走 CLI。529/出错仍 fallback CLI。
- 测试：npm test → 55 pass 0 fail（新增 5 个权限映射用例）。
- 3001 实测：health 200；WS 真发 claude turn，SDK resume-miss→CLI --continue fallback 链路通；纯 SDK turn（turn2 resume 命中）工具渲染（Bash tool_use+result）/thinking/stream_event partial/assistant text/result success 全正常。
- 产出：见下方 commit SHA。
- 下一步：等主人统一验收后推 main。

## 2026-06-07 [手机端 UI 对齐 — 三键统一圆角+touch-toolbar等宽]
- 操作: public/style.css @media(max-width:480px) — 三键(.tts-btn/.tts-replay-btn/.send-btn)统一 44x44px + border-radius:var(--radius-md)(8px)
- 操作: touch-toolbar 6键改 flex:1 等宽 + height:36px + font-size:12px + white-space:nowrap
- 操作: .chat-textarea 移动端 placeholder 防换行
- 结果: 44 pass 0 fail; 3001 curl 200; 三键 borderRadius 全8px 实测；touch-btns 等宽 59px 实测
- 截图: /storage/home/zhiningjiao/code/nanocode/before-workspace.png(before) → after-workspace-390.png(after 390) after-mobile-360.png(after 360) after-desktop-1280.png(桌面无回归)
- commit: acd53e5 pushed fork/zhining/nanocode-selfresume-bugs

## 2026-06-07 [selfresume-bugs 收尾 — 喇叭合并+ntfy通用+interrupt测试+手机UI]
- 任务2: 删 public/index.html:514 旧 #tts-btn 元素(15行)，清 tts.js ttsBtn引用3处
- 任务3: index.html:340 placeholder zhiningwork→yourname; app.js 不写死 ntfy_topic 默认值
- 任务4: 3个interrupt过时测试全修 — 判定依据a33d294+9840310:
  - claude-interrupt-route: 等"Resuming with"事件(不是"Queue cleared") + 期望≥2 result events + first.subtype='error_during_execution'
  - claude-sdk-driver: subtype 'error_during_execution' + setImmediate wait + reruns.length=1
  - interrupt.test: sendRaw('\x03') 不插client-side block，期望 interrupted.length=0
- 任务5: style.css @media(max-width:480px) .tts-btn/.tts-replay-btn/send-btn/claude-stop-btn → 44px
- 结果: 44 pass, 0 fail; /api/codex/config={"model":"gpt-5.5"}; grep zhiningwork=0; 按钮44x44px ✓
- 截图: /tmp/mobile_before.png / /tmp/mobile_after.png

## 2026-06-07 [Settings模型下拉修复 — 删过时硬编码，Claude动态填充，Codex读config.toml]
- 操作: public/index.html 删除 claude-model-select 所有过时硬编码 option（opus-4-5/sonnet-4-5/haiku-4-5/opus-4/sonnet-4），只保 Default
- 操作: public/index.html 删除 codex-model-select 所有错误硬编码（o3/o4-mini/gpt-4.1/gpt-4o），只保 Default
- 操作: public/js/app.js _applyDynamicModelOptions 删除 knownModels 硬编码列表，只保 Default + snapshot.model (current)
- 操作: terminal/routes.js 新增 GET /api/codex/config，读 ~/.codex/config.toml model字段，返回 {model: "gpt-5.5"}
- 操作: public/js/app.js 新增 fetchCodexConfig + _applyCodexModelOptions，openSettingsPanel 时动态填充 Codex 下拉
- 结果: npm test 3 fail（全为既有interrupt相关，无新增）；3001重启后curl验证端点正常

## 2026-06-07 [Settings面板打磨 A-E — i18n/精简/全局Permission/通知红点/静音]
- 操作A: 新建 public/js/i18n.js，translations={en,zh}，t(key)+setLang()+applyI18n()，data-i18n属性遍历替换；Settings顶部Language下拉，默认en，即时切换
- 操作B: index.html删CLI Provider块(131-144)、删队列开关块(191-203)、删Claude驱动块(264-276)；app.js对应handler清除；队列逻辑保持默认启用
- 操作C: 新建全局Permission三档(full-auto/auto-edits/ask)，store key=global_permission；claude-session-controller.js两处permMode改读global_permission，codex TAB_LAUNCHER按档映射flags；恢复codex-model-select UI+JS handler
- 操作D: app.js新增红点系统(_addUnread/_clearUnread/favicon canvas)，window focus/visibilitychange清除；喇叭改为mute-btn全局静音，tts.js+playNotifySound均检查nanocodeMuted；ntfy loadNtfySettings默认localhost/zhiningwork
- 操作E: terminal-view.js删"⏵"字符，改为纯文字"Send now"
- 产出: commit 7850397，npm test fail=3（均既有flaky），3001 health 200 ✓

## 2026-06-04 [打断交互收口 — CLI风格强提示block + 悬空引用清除]
- 操作1：删除 terminal-view.js:377 悬空 `_interruptingAt = null`（变量已在上一个commit删除，ReferenceError隐患）
- 操作2：claude-block-renderer.js 新增公共方法 `showInterruptBlock()`，文案 "[Request interrupted by user]"（从Claude CLI binary strings命令提取的原文）
- 操作3：`sendRaw('\x03')` 路径改用 `showInterruptBlock()`（废弃旧文案"[interrupting…]"）
- 操作4：`doInterrupt()` (Esc键/Stop按钮) 调用 `activePane.showInterruptBlock()`，打断后立即在对话流插入强提示
- 操作5：style.css 新增 `.cbr-block-interrupted` 左侧色条样式（reuses cbr-block-system）
- 操作6：新增 server/tests/interrupt.test.js，8条测试覆盖：showInterruptBlock()插入块、CLI文案正确、sendRaw('\x03')文案对齐、grep验证无悬空引用
- 测试：npm test 24/24 pass, # fail 0；grep FAIL/Error/NOT FOUND → 仅 "# fail 0"
- 重启3001：kill 52877 → PORT=3001 nohup node server/index.js（PID 113275）→ health 200 ✓
- curl验证：/js/claude-block-renderer.js grep "Request interrupted by user" ✓；terminal-view.js grep _interruptingAt → 无 ✓
- 产出：commit effc79f

## 2026-06-04 [暂时禁用 --continue 自续接 — 避免 3001 测试实例抢占用户本机Claude会话]
- 操作：修改 terminal/routes.js 第 717 行，claude launcher 强制 return plain `claude --dangerously-skip-permissions; exec bash -l`
- 原 autoResume 判断 + shell loop + `claude --continue` 代码保留为 dead code，加注释说明恢复方法
- 测试结果：npm test 16/16 pass, # fail 0；grep FAIL/Error/NOT FOUND→仅"REMOTE error"测试名，无真实错误
- 重启 3001：kill 224110 → PORT=3001 nohup node server/index.js（PID 52877）→ health 200 ✓
- 验证：curl /js/terminal-view.js grep doInterrupt=5匹配（eb07a8a修复存在）✓；/js/app.js grep --continue=0 ✓
- 产出：commit 见下

## 2026-06-04 [打断/按键bug修复 P0-1~P0-4 — Esc/Ctrl+C/Stop/touch toolbar/force升级]
- 操作：修改4个文件（terminal-view.js, claude-block-renderer.js, style.css, terminal/routes.js）
- P0-1 Esc: 加优先级逻辑 slash>suggestions>interrupt>clearInput>PTY Esc; touch toolbar escape 同一函数
- P0-2 Ctrl+C: 有字时清空输入框(CLI对齐); 空+busy调interrupt API; touch ctrl-c同逻辑; ClaudeBlockRenderer.sendRaw改为POST /api/interrupt + _addSystemBlock('[interrupting…]')
- P0-3 强打断: Stop按钮click→doInterrupt()共享函数; 3s内再按escalate force=1; 显示"中断中…(再按强杀)"; 后端interrupt路由支持?force=1→SIGKILL; updateThinkingState收result事件时重置状态
- P0-4 touch toolbar: @media(pointer:coarse){.touch-toolbar{display:flex}} 补充
- 测试结果：npm test 16/16 pass, # fail 0；grep FAIL/Error/NOT FOUND→仅"# fail 0"
- 热更新: PORT=3001 health 200 ✓; /js/terminal-view.js grep doInterrupt=19匹配 ✓
- 产出: commit eb07a8a

## 2026-06-03 [Tool Blocks fold 3-level switching — 真实 3001 页面深度验证]
- 操作：用真实 Playwright browser 驱动真实 3001 页面，验证 full/header/line 三档折叠在各场景下的计算样式
- 发现：代码已正确（commit 88ce0f8 live-apply fix 已生效），前几轮 agent 只断言 localStorage，未验证 computed style / 真实 DOM 视觉变化
- 验证场景：初始加载 / 硬刷新 + WS 历史回放 / Settings 打开后切换 / Save 按钮路径 / radio click 路径
- 测试结果：npm test 6/6 PASS；孤立 harness PASS=36 FAIL=0；真实 3001 页 3 项 PASS
- 产出：evidence.md（计算样式证据 + 截图 evidence-fold-*-final.png）

## 2026-06-03 [Stop 不要杀 subagent — 传播路径实测 + 进程组隔离]
- 操作：trace Stop 传播路径（terminal-view.js → /interrupt → routes.js `cs.currentProc.kill('SIGINT')`，单正 pid，非进程组/非 SIGKILL）；写 4 个 probe 复刻 spawn 实测进程树
- 实测结论：
  - nanocode 侧已最干净，单 pid SIGINT 不会从 OS 层扫 subagent
  - subagent 是否存活取决于它在 claude 内部是否分离启动：setsid/nohup&/run_in_background → 存活（probe1/3/4）；前台未分离的 Bash 工具子进程被 claude 自身 abort 杀掉（probe2，非 nanocode 信号）；in-process Task subagent 推理随父 turn 中断结束 = harness 固有行为，nanocode 改不了
- 改动：routes.js runClaudeTurn spawn 加 `detached: true`（进程组隔离，防御性，不加 unref），interrupt 注释改写为实测结论 + 不变量
- 结果：✓ node --check 双文件 OK；npm test 6/6；terminal 测试 30 pass/6 skip/0 fail；probe4 验证 detached 下中断仍正常、分离子进程存活
- 产出：evidence.md + .interrupt-probe/probe-run-{1..4}.log；待提交
- 下一步：push fork

## 2026-06-03 [即时预览: tool-fold radio + subagent 开关 change 即时生效]
- 操作：public/js/app.js 给 input[name="tool-fold"] 三个 radio 加 change 监听 → setToolFoldLevel(value) 立刻调用；给 subagent-prompt-visible / subagent-activity-visible checkbox 加 change 监听 → setSubagentPromptVisible/setSubagentActivityVisible 立刻调用；Save 按钮保留为可选确认
- 结果：✓ npm test 6/6，playwright 验证 4 项切换均不点 Save 即写 localStorage；刷新后保持
- 产出：commit 88ce0f8，push fork zhining/nanocode-selfresume-bugs
- 下一步：等验收官确认

## 2026-06-03 [Bug修复: busy队列 + thinking解锁 + subagent fold]

**背景：主人实际使用发现3个问题，上一轮单测全过但实地用挂了。这次先复现再修再实跑验证。**

### 问题3（最重要）: busy时丢消息 → 改FIFO队列
- **根因**：`runClaudeTurn` busy时直接广播stderr "Previous turn still running, please wait." 并return，消息彻底丢弃
- **修法**：busy时push到`cs.queue`，广播`{type:'system',subtype:'queued'}`给客户端；exit handler里`setImmediate`跑下一条；interrupt时清空queue
- **验证**：`node qa-test/test-queue-and-thinking.mjs` → PASS（2个result事件、1个queued事件、0个drop消息）

### 问题2: thinking时发不了消息、要刷新才能发
- **根因**：`terminal-view.js:490` `if (isClaudeTab && isClaudeThinking) return` 硬挡。server busy拒绝→不回result→thinking卡死true→只能刷新
- **修法**：删除这个guard。有了server队列，发消息直接入队；result到了_setThinking(false)自愈。renderer加queued/info system subtype显示
- **验证**：集成测试同上，客户端不再被block

### 问题1: 开了subagent prompt开关仍看不到内容
- **抓包验证**：`claude --print --output-format=stream-json -- "用Agent工具..."` 抓包确认：
  - ✓ 顶层流确实有 `type:'assistant'` + `content[{type:'tool_use',name:'Agent',input:{prompt,description}}]`
  - ✓ `parent_tool_use_id: null`，所以`_handleAssistant`的guard不会拦
  - ✓ `_renderToolUsePart`的`isSubagentTool`匹配`name==='Agent'`正确
- **真因**：`applyToolFold(article)` 被调用在subagent-prompt blocks上。如果用户把cbr_tool_fold设为`header`或`line`，block的body就被CSS fold掉了（`display:none`）。block文章存在但内容不可见 → 用户以为开关没用
- **修法**：subagent-prompt blocks跳过`applyToolFold`，直接`setAttribute('data-fold','full')`；`setSubagentPromptVisible`里也补set

### 产出
- 3个原子提交：e1a7fda（队列）、6d561bd（thinking）、f067851（subagent fold）
- 集成测试：`qa-test/test-queue-and-thinking.mjs` ALL PASS
- run.log: grep -i "FAIL|Error|MISMATCH" → 干净

## 2026-06-03 [Task B 补丁: subagent assistant/partial_message gate 漏洞]
实地抓取验证（claude --print --output-format=stream-json --verbose --include-partial-messages）：
  - 当前 claude CLI 版本（Opus 4.8）中，assistant 和 partial_message 事件的 parent_tool_use_id 永远是 None
  - subagent 活动只通过 user 事件（pid 非空）暴露在顶层流
  - 但防御性编码必要：若未来版本产生带 pid 的 assistant/partial 事件，或通过 mock 构造测试，原代码漏洞会导致开关关闭时 subagent 活动仍渲染并污染 _liveAssistantBlock 状态
修法（/public/js/claude-block-renderer.js）：
  - `_handleAssistant`：顶部加 `if (event.parent_tool_use_id && !getSubagentActivityVisible()) return`（在 live-block 清零之前 return，避免状态污染）
  - `_handlePartialMessage`：同上，在 msg 解析之前 return
  - 主 agent 事件（pid=null/undefined）完全不受影响
验证：
  - 7 个 mock 行为验证 case 全 pass（含：主 agent toggle off → RENDERED；subagent toggle off → SKIPPED；subagent toggle on → RENDERED）
  - node --check 语法 OK
  - npm test 6/6 pass，grep FAIL/Error run.log → "# fail 0"
commit 7e9c0d6

## 2026-06-03 [Task A + B: tool折叠修复 + subagent可见性开关]

### Task A - Tool Blocks 折叠设置无效（根因确认）
根因1：CSS `.cbr-block-tool[data-fold="full"]` 规则要求属性**显式设为"full"**才显示内容。无属性时无 display:block 兜底规则。但 `applyToolFold(article)` 在渲染时读 localStorage，正常情况下会设置属性，所以这不是主因。
根因2（主因）：`_handleUserEvent` 只提取 `content.find(c => c.type === 'text')` 的文本内容，完全忽略了 `tool_result` 类型的 item。工具输出（Bash stdout、文件内容等）以 `tool_result` 形式出现在 user-turn 事件里，之前从未被渲染——这才是「看不到具体内容」「全是一条线」的根本原因。
修法：
  - CSS 加 `:not([data-fold])` 兜底规则
  - `_handleUserEvent` 改为遍历所有 content 项，遇到 tool_result 调用 `_renderToolResultPart`
证据：
  - 实地抓取 stream-json 确认：`user` event 中 `content[].type === "tool_result"`, `content[].content` = 输出字符串
  - npm test 6/6 pass，grep -i "FAIL|Error" run.log → "# fail 0"
  - commit 9ca1b73

### Task B - Subagent 可见性开关
实地抓取确认真实事件字段：
  - Subagent 调用：`assistant` event，`tool_use.name === "Agent"`，`input = {description, prompt, subagent_type}`
  - Subagent 活动：`user` event，`parent_tool_use_id` 设为 Agent tool 的 id（非 null）
两个开关（Settings > Subagent Visibility，localStorage 持久化，即时生效）：
  - 「Show message sent to subagent」默认开：控制 Agent/Task tool_use 块中 input.prompt 的显隐
  - 「Show subagent activity」默认关：控制 parent_tool_use_id 非空的 user 事件显隐
codex 处理：Bash tool_use 命令含 "codex" 正则匹配为启发式 codex dispatch，加 cbr-block-subagent-prompt 类，受开关1控制。注释已说明判定方式。
commit 03beb00

## 2026-06-03 10:30 [Bug2补丁：原地重连重复渲染]
- 根因：ClaudeBlockRenderer 原地重连（onclose → setTimeout → _connect()）时，同一 renderer 实例的 _scroll DOM 没被清空，server 重放 cs.history 后 = 旧渲染 + 重放 = 双份内容。Bug2 把 user 事件也加进了 history，让这个重复更明显。
- 修法：在 _ws.onopen 里，先判断 isReconnect（reconnectAttempts > 0，因为首次连接时该值为 0），若是重连则清空 _scroll.innerHTML + 重置 _liveAssistantBlock / _liveAssistantId / _pendingNonces / _thinking，并插一条 "[Reconnected. Restoring session history…]" 系统块作为视觉分隔。首次连接不受影响（_scroll 本来为空）。
- 验证：5 个内联 Node.js 单元测试（模拟 onopen 逻辑 + _handleUserEvent 逻辑）全部 pass；npm test 6/6；node --check 语法 OK；grep FAIL/Error run.log → "# fail 0"
- 产出：commit 60a731a

## 2026-06-03 09:55 [Bug1-5 + 自续接功能]
- 操作：实现 5 项 bug fix + 自续接功能
  - Bug1 (IME回车): terminal-view.js 加 compositionstart/compositionend 标志位 + e.isComposing + keyCode 229 守卫，阻止输入法合成期间 Enter 触发发送
  - Bug2 (消息不可见): routes.js 在收到 claude-input 时存 synthetic user event 到 cs.history；client 端 sendInputWithEcho 带 nonce，_handleUserEvent 通过 nonce dedup 避免双渲染，reconnect 回放时无 nonce 则正常渲染
  - Bug3 (滚到底按钮): claude-block-renderer.js 在 container 内创建 .cbr-scroll-to-bottom 浮动按钮，scroll 事件更新可见性；style.css 加 transition + absolute positioning
  - Bug4 (tool折叠): claude-block-renderer.js 新增 getToolFoldLevel/setToolFoldLevel/applyToolFold 模块函数，_renderToolUsePart 加折叠按钮+点击 header 切换单块；style.css data-fold="full|header|line" CSS 属性控制；index.html + app.js 加 Settings UI
  - 自续接: routes.js TAB_LAUNCHERS.claude 改为 shell 循环（读 store.getSetting('claude_autoresume')），支持 3 秒倒计时 + 任意键退出到 bash；Settings UI 切换开关存 localStorage + server
- 产出：commits 06c41e7, 000687f, 1cf2bd1, 78d7d4b
- 测试：npm test 6/6 pass, grep -i FAIL/Error run.log → "# fail 0"，PORT=3099 server 启动 200 ✓
- 下一步：等主人 QA 验收

## 2026-03-19 23:55 [Agent 命名功能]
- 操作：实现 session 自定义命名功能
  - store.js: 新增 sessionNames 数据层 (get/set/getAll)
  - routes.js: 新增 GET /session-names 和 PUT /sessions/:id/name API
  - api.js: 新增 fetchSessionNames / updateSessionName 前端 API
  - terminal-view.js: session tab 显示自定义名称，双击重命名
  - style.css: 新增 .session-rename-input 样式
  - store.test.js: 新增 2 个测试用例
- 结果：✓ 全部 10 个测试通过
- 产出：commit d84bf8a on zhining/agent-naming-and-ux
- 下一步：继续下一个 TODO 任务

## 2026-03-20 00:05 [Claude 界面自动滚动到最新]
- 操作：terminal-pane.js 新增滚动跟踪 + 浮动「滚到底部」按钮
- 结果：✓ 通过
- 产出：commit dfda767

## 2026-03-20 00:20 [文本复制功能]
- 操作：Ctrl+C 选中时复制、无选中时发送 ^C；移动端添加 Copy 按钮
- 结果：✓ 通过
- 产出：commit be31415
- push 到 zhining/agent-naming-and-ux

## 2026-03-20 00:30 [手机端滑动体验优化]
- 操作：重写 touch scroll 为带惯性的平滑滚动（velocity tracking + friction decay）
- 结果：✓ 通过
- 产出：commit 8f714ae

## 2026-03-20 00:40 [全面探索并完善产品体验]
- 操作：通读全部代码，修复 XSS 漏洞（landing.js innerHTML 注入），清理废弃代码
- 结果：✓ 通过，4 条改进建议写入 proposals.md
- 产出：commit 8856d89
- push 到 zhining/agent-naming-and-ux，可酌情 PR

## 2026-03-20 01:30 [验收官反馈修复]
- 操作：修复验收官提出的 4 个问题
  - CSS 变量修复：landing-new-form 的 --bg-2/--border/--fg-1 等替换为 glass design system 变量
  - --fg-3 对比度提升：0.4 → 0.55 (WCAG AA 合规)
  - WebSocket 连接状态三态：disconnected → connecting(黄色脉冲) → connected(绿色)
  - Claude 模式图标：锁🔒改为星★，语义更匹配 AI 助手
  - 新增 3 条改进建议写入 proposals.md（session 内存泄漏、原子写入、history.jsonl 优化）
- 结果：✓ 全部 10 个测试通过
- 产出：commit c999db5
- push 到 zhining/agent-naming-and-ux
- 旧 3001 进程已停止，新代码在 PORT=3001 重启完毕

## 2026-03-20 10:15 [自动滚动 bug 修复]
- 操作：修复用户反馈的"agent 说话时页面跳到最上边"的 bug
  - 根因：term.onScroll 在 term.write() 期间同步触发，在 scrollToBottom() 执行前就将 _userScrolledUp 设为 true，导致自动滚动被跳过
  - 修复：移除 term.onScroll handler，仅保留 DOM viewport scroll listener（在 scroll position 实际变化后触发）
  - 额外：用 requestAnimationFrame 包裹 viewport listener 挂载，确保 xterm 渲染完成
- 结果：✓ 全部 10 个测试通过
- 产出：commit ca65f96
- push 到 zhining/agent-naming-and-ux，3001 已重启新代码

## 2026-03-20 10:45 [7 项功能批次实现]
- 操作：一次性实现 proposals.md 中 7 项功能
  1. Favicon + PWA manifest：SVG favicon (>_) + manifest.json
  2. WebSocket 心跳超时：per-client ping 追踪，30s 无 ping 断开
  3. Project 搜索：sidebar 4+ 项目时显示搜索框，按名称/SSH host 过滤
  4. 终端字体大小：Settings 页 range slider (10-22px)，实时应用到终端
  5. Session GC：PTY 退出 + 无 client 30 分钟后自动清理
  6. 原子写入：store.js save() 先写 .tmp 再 rename
  7. 空 sidebar 引导："No projects yet. Click + to add one."
- 结果：✓ 全部 10 个测试通过
- 产出：commit 6310ab4
- push 到 zhining/agent-naming-and-ux，3001 已重启新代码


## 2026-03-21 [TTS 按钮不可见修复]
- 操作：修复 TTS 按钮在 mac 和安卓都看不到的问题
  - 根因：CSS 变量 --surface-2/--surface-3 未在 :root 定义，tts-btn 和 mic-btn 背景透明
  - 根因：SVG fill="none" + 非激活时 wave 隐藏，只剩极细描边 polygon 几乎不可见
  - 修复：:root 添加 --surface-2: rgba(255,255,255,0.08) 和 --surface-3: rgba(255,255,255,0.12)
  - 修复：speaker polygon 添加 fill="currentColor"
- 结果：✓ 10/10 测试通过，热更新部署 3001 正常
- 产出：commit 62c248c
- 下一步：用户确认移动端和桌面端可见

## 2026-03-21 [TTS 听不到声音修复]
- 操作：修复 TTS 音频无法播放问题
  - AudioContext unlock：首次用户交互时创建静音 buffer 解锁浏览器 autoplay 策略
  - Settings 新增 "Test TTS" 按钮：用户手动触发测试语音播放
  - play() 错误日志：不再静默吞掉，console.warn('[TTS]') 方便调试
- 结果：✓ 10/10 测试通过，热更新部署 3001 正常
- 产出：commit 待提交

## 2026-03-21 [TTS 偶尔蹦日语修复]
- 操作：server/index.js getTtsConfig() text_lang 默认从 'auto' 改为 'en'；顺带修复 handleTts 末尾多余 `})` 语法错误
- 结果：✓ TTS 200 OK，热更新部署 3001 成功
- 产出：commit d45681b
- 下一步：等验收官确认

## 2026-03-22 [重播按钮修复]
- 操作：删除 Test TTS 中 setLastTtsText(testText)；replay 按钮 tooltip 改为 "Replay last message"
- 结果：✓ 热更新 3001 成功，两项 curl 验证通过
- 产出：commit 9137eca
- 下一步：等验收官确认

## 2026-03-22 [TTS 音色优化 NanamiNeural]
- 操作：edge-tts ja-JP-NanamiNeural 生成参考音频 → ffmpeg 转 WAV → 替换 GPT-SoVITS ref_audio → /api/tts/voice 持久化
- 结果：✓ POST /api/tts → 200, 29KB OGG Vorbis，新甜美猫娘声工作正常
- 产出：/storage/home/zhiningjiao/code/GPT-SoVITS/ref_audio.wav（已替换），旧版备份为 ref_audio_backup_xiaoy.wav
- 下一步：等主人和验收官试听确认音色效果

## 2026-03-22 [重播按钮读所有历史修复]
- 操作：replay handler 加 stopTts() 先清空队列，再 push ttsLastText
- 结果：✓ stopTts() 出现 3 次，3001 已服务最新静态文件
- 产出：commit 524447c
- 下一步：等验收官确认

## 2026-03-22 [TTS 重复播报修复]
- 操作：sessions.js 始终发 history 消息 + stripAnsi 补全 + enqueueTts 队列内去重
- 结果：✓ 3001 热更新成功，served JS 验证 2 项通过
- 产出：commit 784e8fd
- 下一步：等验收官确认

## 2026-03-22 [QA 信号监听服务]
- 操作：server/qa-watcher.js（fs.watch）+ /ws/notify WS endpoint + 前端 toast
- 结果：✓ 测试写入 qa-signal.json → 服务端检测到 → tmux notified reviewer: nanocode QA watcher test
- 产出：commit 63632f7
- 下一步：等验收官确认

## 2026-03-22 [done 信号 + activity-feed]
- 操作：qa-watcher.js 扩展 done-signal 监听 + evidence.md 聚合；app.js 扩展 done_notify/activity WS 处理
- 结果：✓ done-signal 检测、agent-status 追加、evidence 聚合均验证通过
- 产出：commit afa2d6b
- 下一步：等验收官确认

## 2026-03-22 [fs.watchFile CephFS 修复]
- 操作：qa-watcher.js fs.watch → fs.watchFile 2s 轮询，覆盖 qa/done/evidence 6个文件
- 结果：✓ QA signal 轮询触发验证通过
- 产出：commit b613ff7
- 下一步：等验收官确认

## 2026-03-23 [watchFile persistent:true 修复]
- 操作：persistent: false → true，防止 Node 事件循环退出导致 callback 不触发
- 结果：✓ echo qa-signal → sleep 5s → [watcher] QA signal: nanocode persistent:true test
- 产出：commit aefcd8d

## 2026-06-07 [手机端 UI 对齐修复]
- 任务：修复 5 个手机端 UI 问题（按钮高度/黑条/标签间距/工具块对齐/整体正负形）
- 操作：只改 public/style.css，不碰后端/block-renderer.js
- 结果：
  - 问题1: tts/replay/send 按钮 height 44→38px，与 textarea 一致，垂直居中
  - 问题2: .claude-queue-tray:empty {display:none} 消除无意义黑条
  - 问题3: mobile-pane-switch gap 4→8px, padding 8px 12px→6px 8px，左右边缘均衡
  - 问题4: cbr-tool-header 加 gap:8px；icon-wrap 固定 16px；name line-height:1；subagent-badge 移除 margin-left
  - 问题5: 整体间距遵循 8px 网格，desktop 无回归
- 测试：npm test 55/55 pass，3001 200 OK
- 产出：commit bc197e3, 8431296；push fork zhining/nanocode-selfresume-bugs
- 截图：/tmp/before_workspace_390.png, /tmp/after_workspace_390.png, /tmp/final_mobile_390.png, /tmp/final_desktop.png

## 2026-06-07 [Favicon 红点角标修复]
- 任务：修复 _drawFaviconDot() 把 favicon 换成纯绿方块的 bug，改为原 logo + 右上角小红点角标
- 根因：原实现用 fillRect(#8cc63f) 画了绿方块当底，没有 drawImage 原 SVG
- 操作：public/js/app.js - 新增 _preloadFaviconImage()，在 init() 里调用；_drawFaviconDot() 改为 drawImage(原SVG) + 右上角 r=6 红圆点+数字
- 原 favicon：SVG（黑底圆角矩形 + 绿色 >_ 文字），`/favicon.svg`
- 验证：browse 渲染测试截图 /tmp/favicon-badge-test.png，左=logo+badge(3) 右=原始logo，SVG drawImage 成功
- 测试：npm test 71/71 pass，run-favicon.log 干净，curl 3001/api/health 200
- 截图：/tmp/favicon-badge-test.png

## 2026-06-24 [Agent tmux 会话浏览器 + 标签页类型启用/禁用]
- 任务：提升 nanocode 易用性：① Agent 抽屉栏中 tmux 会话浏览+点击连接，② 插件标签页类型加载/卸载 UI，③ 整体操作便捷度
- 功能 1 — tmux 会话浏览器（Agent 抽屉栏）：
  - `public/js/agents.js`：`_loadTmuxSessions()` 拉取 `/api/tmux/list`，渲染会话列表（名称、命令徽章、创建时间、预览、连接按钮）；搜索过滤器按名称实时过滤
  - `public/js/agents.js`：`_connectTmuxSession(target)` 派发 `nanocode:connect-tmux` 事件
  - `public/js/terminal-view.js`：监听 `nanocode:connect-tmux`，调用 `api.createTab()` 创建 `tmux` 类型标签页
  - `public/js/api.js`：`createTab()` 新增 `tmuxTarget` 和 `claudeSessionId` 选项支持
  - `server/index.js`：`/api/tmux/list` 增强 `paneCommand` 字段（从 `#{pane_current_command}` 提取）
  - `server/store.js`：`TAB_TYPES` 新增 `tmux`；`createTab` 支持 `tmuxTarget`；`updateTab` allowed 列表加入 `tmuxTarget`
  - `terminal/routes.js`：`POST /api/projects/:id/tabs` 读取 `tmuxTarget` 传给 store
  - `terminal/claude-session-controller.js`：tmux 类型标签页使用 `tmux attach-session -t <target>` 启动 PTY
  - `public/style.css`：tmux 浏览器 CSS（搜索框、会话卡片、命令徽章 claude/codex/bash/node、预览文本、连接按钮 hover）
  - `public/js/i18n.js`：tmux 浏览器相关文案 en/zh 翻译
- 功能 2 — 标签页类型启用/禁用（设置面板）：
  - `public/js/tab-manager.js`：导出 `getEnabledTabTypes()` / `setEnabledTabTypes()`；`_showNewTabMenu()` 按 enabledTypes 过滤；`NEW_TAB_OPTIONS` 和 `TYPE_ICON_SVG` 新增 tmux 类型
  - `public/index.html`：设置面板新增标签页类型复选框区域（每种类型一个 checkbox）
  - `public/js/app.js`：`loadTabTypesSettings()` 加载 + 保存处理器，使用 `localStorage` 键 `nanocodeEnabledTabTypes`
  - `public/js/i18n.js`：标签页类型标签 en/zh 翻译
- 测试：`npm test` 138/138 pass，0 fail
- 热部署：9476 起 → kill 9475 → 9475 重启 → kill 9476，`/api/health` 200
- API 验证：`/api/tmux/list` 返回 `paneCommand` 字段（bash/node 等），确认生效

## 2026-06-24 [易用性迭代 — tmux预览净化/即时开关/徽章/自动刷新]
- 任务：以 driver 视角使用 nanocode，发现并修复 4 个易用性痛点
- 改进 1 — tmux 预览 ANSI 净化（`server/index.js`）：
  - 问题：`/api/tmux/list` 的 `capture-pane` 用 `-e` 标志保留了 ANSI 转义码，预览文本满是 `\x1b[1m` 等乱码
  - 修法：去掉 `-e` 标志，输出纯文本；验证预览可读（如 `cc-builtin: cmd=node, preview='注意：最终 git status…'`）
- 改进 2 — 标签页类型即时生效（`public/js/app.js`）：
  - 问题：标签页类型复选框需点 Save 才生效，不像 tool-fold/subagent 开关那样即时
  - 修法：checkbox change 事件即时调 `setEnabledTabTypes()`，Save 按钮保留但变为可选确认；最后一个类型不可取消（防全空）
- 改进 3 — Agent 抽屉按钮徽章（`public/js/agents.js` + `public/style.css`）：
  - 问题：header 的 Agent 按钮（👥图标）不显示有多少 AI agent 正在运行
  - 修法：`_updateToggleBadge()` 拉取 `/api/tmux/list`，统计 claude/codex/node 会话数，在按钮右上角显示绿色数字徽章；每 30s 自动刷新
- 改进 4 — 抽屉打开时自动刷新（`public/js/agents.js`）：
  - 问题：tmux 会话列表只在打开抽屉时加载一次，不自动更新
  - 修法：`_startAutoRefresh()` 每 15s 刷新 tmux 会话 + subagent 列表；关闭抽屉时停止定时器
- 测试：`npm test` 138/138 pass，0 fail
- 热部署：9476 起 → kill 9475 → 9475 重启 → kill 9476，`/api/health` 200
- 前端验证：agents.js badge 代码 2 处、app.js instantBound 2 处、style.css badge CSS 1 处，均已部署
- commit: 343e76b，push fork zhining/nanocode-history-replay-fix

## 2026-06-24 [Driver dogfooding — agent drawer i18n + recent sessions dedup + UX polish]
- 任务：以 driver 视角使用 nanocode（9475），发现并修复易用性痛点
- 发现痛点（Playwright 驱动真实 9475 页面，dump DOM + 截图）：
  1. Agent 抽屉栏所有文本硬编码中文：tmux 会话标题、"连接"按钮、"搜索 tmux 会话..." placeholder、"还有 N 个会话未显示"、"刷新"、"运行中 Sub-agents"、"当前没有运行中的 sub-agent"、"停止"、"最近会话"、"(无摘要)" —— 切换语言为 EN 后仍显示中文
  2. 最近会话列表被 40+ 条重复 "work" 条目淹没（同一 project、同一 prompt 前缀，只是不同 session ID）
  3. summary 截取 120 字符太长，在抽屉栏占位过大
  4. relTimeFromMtime 返回 "刚刚"（硬编码中文）
  5. tmux session preview max-height 4.5em 略高，抽屉栏空间利用率低
  6. recent-agent-summary 只显示 1 行（white-space: nowrap），长 prompt 被截断到看不见内容
- 改进 1 — i18n 全量覆盖（`public/js/i18n.js` + `public/js/agents.js`）：
  - 新增 13 个 `agents.*` 翻译键（en/zh 双语）
  - `t()` 函数支持函数值（参数化翻译如 `agents.tmux_more`、`agents.subagents_title`）
  - `agents.js` 导入 `t()`，所有硬编码中文替换为 `t('agents.xxx')` 调用
  - 涵盖：tmux 标题、连接按钮、搜索 placeholder、刷新 tooltip、更多提示、subagent 标题/空态/停止、最近会话标题、无摘要、无 agent
- 改进 2 — 最近会话去重（`terminal/recent-agents.js`）：
  - `scanRecentAgents` 按 (projectName + summary 前40字符) 去重，保留最新条目
  - 结果从 40+ 条 → 3 条（实测验证），大幅减少噪音
  - 截取长度 120→80 字符，返回 `null` 替代硬编码中文 "(无摘要)"（由前端 i18n 兜底）
- 改进 3 — relTime i18n（`terminal/recent-agents.js`）：
  - `relTimeFromMtime` "刚刚"→"just now"
  - 移除 `cwdFromDirName` 里的 `console.warn` 噪音（每次打开抽屉刷屏）
- 改进 4 — CSS 紧凑化（`public/style.css`）：
  - `.tmux-session-preview` max-height 4.5em→3em（3 行→2 行，更多会话可见）
  - `.recent-agent-summary` 1 行 nowrap→2 行 -webkit-line-clamp（长 prompt 可读性提升）
- 修复 bug：i18n.js 重复 `zh: {` 块导致 SyntaxError（Unexpected strict mode reserved word），前端全挂
- 测试：`npm test` 138/138 pass，0 fail
- 热部署：kill 9475 → PORT=9475 重启 → `/api/health` 200
- 前端验证：Playwright 实测 EN 模式所有 agent drawer 文本正确翻译，ZH 模式中文正常，0 console error
- commit: 599d6f0，push fork zhining/nanocode-history-replay-fix

## 2026-07-16 17:32 [nano_maint R1 — 接 Opus officer 班，9476/9475 巡检]
- 任务：接手 nanocode GLM 维护线（HANDOFF_opus_officer.md），巡检 9475/9476 健康与前端报错，npm test 保持 0 fail
- 接班：读 HANDOFF_opus_officer.md（178 FLAG 验收收线，9476 跑 zhining/nano-9476-integ-0716 HEAD 3ffec41，0 pending REVIEW_REQ/CHORE）；HANDOFF_opus_burn.md 尚未落地，按任务书跳过
- 分支：zhining/nano-9476-integ-0716 @ 3ffec41，工作树干净（仅未跟踪 .git.bak-migrate）
- 健康巡检：
  - 9475 = 200（pid 304142，未触碰）
  - 9476 = 200（pid 243001，本 worktree 起 `node server/index.js`）；/api/health + /api/services + /api/sessions 均 200
  - 9476 服务态：nanocode up / akari up；mblend·dccpipeline·regression·TTS down（非 nanocode 维护面，预期）
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s）：
  - console error/warning = 0，pageerror = 0，failed request = 0，title="Nanocode"
- npm test：`node --test server/tests/*.test.js` → 653 pass / 0 fail（tee run_nano_maint.log）
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0（FLAG_* 均为 6 月遗留空旗，非维护面，按 handoff 跳过）
- 观察（非本轮动作，留主人定夺）：fork/main 领先本分支 3 commit（opus_burn R8/R9：e68ed60/d3da9db/570c744，连接恢复/命令计时/图片渲染/块导航/键盘可访问性/MCP markdown）——属大改，未并入 9476，按任务书「大改先等批」不动
- 本轮无可修复 bug / 无 REVIEW_REQ/CHORE → 巡检即当轮所做，无 push 无部署
- run.log：run_nano_maint.log（gitignored，run-*.log）；grep 无真实失败（仅测试名含 "Error" 子串）

## 2026-07-16 17:33 [nano_maint R2 — 复巡 + 读 opus_burn 交接]
- 复巡（R1 后约 1 分钟，状态未变）：9475=200 / 9476=200（/api/health+/api/services+/api/sessions 均 200，本轮自带 curl）
- npm test 复跑（本轮自带，`tee -a run_nano_maint.log`）：653 pass / 0 fail
- REVIEW_REQ_* / CHORE_* = 0（无新待办）
- 新观察（相对 R1）：fork/main 由 3 ahead → 4 ahead，新增 5945c5a `docs(opus_burn): handoff + FLAG`——opus_burn 交接文档落在仓内 `HANDOFF_opus_burn.md`（非 ~/codex_work/，任务书所指路径尚未出现），已 `git show` 只读读完：R4-R9 codex 块渲染全套（图片渲染/块导航/键盘可访问性/MCP markdown/连接恢复/命令计时），653/0，smoke 用 9477，不碰 9475/9476
- 4 commit 均未并入 9476（本分支仍 3ffec41），属大改，按任务书「大改先等批」继续不动，留主人定夺是否并入 9476
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 17:36 [nano_maint R3 — 三巡，状态不变，NOTHING-TO-DO]
- 接班状态：HEAD 1ff1931（R1+R2 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（本轮自带 curl，`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不查进程细节）
  - 9476 = 200（/api/health + /api/services + /api/sessions 均 200）
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本置于仓内以解析本地 node_modules）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（本轮自带，`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：rg 失败关键字仅命中测试名子串（"returns error..."等合法用例）与首次 /tmp 脚本 ERR_MODULE_NOT_FOUND（已改仓内脚本复跑通过）+ 前端扫描 errors:0 输出；无真实失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 仍为 6 月遗留空旗（按 handoff 跳过）
- fork/main：仍 4 ahead（5945c5a/e68ed60/d3da9db/570c744，与 R2 一致，无新增）——opus_burn codex 块渲染大改未并入 9476，按任务书「大改先等批」继续不动，留主人定夺
- 过程产物：run_nano_maint.log 已确认 gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 [nano_maint R4 — 四巡，状态不变，NOTHING-TO-DO]
- 接班状态：HEAD 5bbb869（R3 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（本轮自带 curl，`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R3 一致）
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（本轮自带，`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；rg 失败关键字仅命中测试名子串，无真实失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 仍为 6 月遗留空旗（按 handoff 跳过）
- fork/main：仍 4 ahead（5945c5a/e68ed60/d3da9db/570c744，与 R3 一致，无新增）——opus_burn codex 块渲染大改未并入 9476，按任务书「大改先等批」继续不动，留主人定夺
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 17:38 [nano_maint R5 — 五巡，状态不变，NOTHING-TO-DO]
- 接班状态：HEAD eece396（R4 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（本轮自带 curl，`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R4 一致）；/api/sessions = 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（本轮自带，`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；grep 失败关键字仅命中测试名子串（"returns ... error ..." 等合法用例，全 ok），无 `not ok`、无 `# fail [1-9]`，无真实失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 仍为 6 月遗留空旗（按 handoff 跳过）
- fork/main：仍 4 ahead（5945c5a/e68ed60/d3da9db/570c744，与 R4 一致，无新增）——opus_burn codex 块渲染大改未并入 9476，按任务书「大改先等批」继续不动，留主人定夺
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 17:45 [nano_maint R6 — 六巡，状态不变，NOTHING-TO-DO]
- 接班状态：HEAD 94141c0（R5 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（本轮自带 curl，`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R5 一致）；/api/sessions = 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（本轮自带，`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`grep -c "^not ok"` = 0，无 `# fail [1-9]`，无真实失败（测试日志里的 resume-miss / ntfy ECONNREFUSED 均为合法测试 fixture 产生的预期噪音，非真实失败）
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 仍为 6 月遗留空旗（按 handoff 跳过）
- opus_burn 交接：HANDOFF_opus_burn.md 已落在 fork/main（5945c5a），任务书「落地后也读」→ `git show fork/main:HANDOFF_opus_burn.md` 只读读完：R4-R9 codex 块渲染全套（命令/文件/思考/markdown/MCP/图片渲染/块导航/键盘可访问性/连接恢复/计时），~2200 行，全在 fork/main 未并入 9476
- fork/main：仍 4 ahead（5945c5a/e68ed60/d3da9db/570c744，与 R5 一致，无新增）——opus_burn codex 块渲染大改未并入 9476，按任务书「大改先在任务书下等批」继续不动，留主人定夺
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 [nano_maint R7 — 七巡，状态不变，NOTHING-TO-DO]
- 接班状态：HEAD 27c2823（R6 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（本轮自带 curl，`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R6 一致）；/api/sessions = 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（本轮自带，`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`grep -c "^not ok"` = 0，无 `# fail [1-9]`，无 RESULT:FAIL/Traceback/NaN，无真实失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 仍为 6 月遗留空旗（按 handoff 跳过）
- fork/main：仍 4 ahead（5945c5a/e68ed60/d3da9db/570c744，与 R6 一致，无新增）——opus_burn codex 块渲染大改未并入 9476，按任务书「大改先在任务书下等批」继续不动，留主人定夺
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 [nano_maint R8 — 八巡，状态不变，NOTHING-TO-DO]
- 接班状态：HEAD 4ba3359（R7 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（本轮自带 curl，`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R7 一致）；/api/sessions = 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（本轮自带，`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`rg --no-ignore -c "^not ok"` = 0 匹配（无 TAP 失败行），npm test 汇总 `# fail 0` 确认零失败；首轮 self-check 因 echo 关键字回写文件造成自身污染，改用行首 `^not ok` TAP 标记复验干净
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 396 个仍为 6 月遗留空旗（按 handoff 跳过）
- fork/main：仍 4 ahead（5945c5a/e68ed60/d3da9db/570c744，与 R7 一致，无新增）——opus_burn codex 块渲染大改未并入 9476，按任务书「大改先在任务书下等批」继续不动，留主人定夺
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 [nano_maint R9 — 九巡，9475/9476 健康，fork/main 已并 opus_burn 4 提交，push fork 同步 8 work-log 提交，NOTHING-TO-DO]
- 接班状态：HEAD 1b1c7c9（R8 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R8 一致）；/api/sessions = 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`rg --no-ignore -c "^not ok"` = 0 匹配；npm test 汇总 `# fail 0` 确认零失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 仍 6 月遗留空旗（按 handoff 跳过）
- fork/main 状态变更（本轮新发现）：fork/main 已前进到 5945c5a——主人已将 opus_burn 的 4 个实质提交（5945c5a/e68ed60/d3da9db/570c744）并入 fork/main。`git merge-base --is-ancestor` 逐条确认 4 提交均 IN fork/main。R1-R8 报的「fork/main 4 ahead（未并入）」已清零
- 本分支相对 fork/main：8 ahead（R1+R2~R9 共 8 个 work-log doc 提交，均为 NOTHING-TO-DO 巡检记账，无源码改动）——达 WORKER_CORE §6「3+ 未推 commit → push」里程碑
- 动作：push fork 同步分支（仅 docs work-log，不开 PR，不动 9475，无功能改动故不部署 9476）
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO

## 2026-07-16 [nano_maint R10 — 十巡，状态不变，NOTHING-TO-DO]
- 接班状态：HEAD a4989c2（R9 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R9 一致）；/api/sessions = 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`rg --no-ignore -c "^not ok"` = 0 匹配；npm test 汇总 `# fail 0` 确认零失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 397 个仍为 6 月遗留空旗（按 handoff 跳过）
- fork 状态（本轮 `git fetch fork` 后）：本分支 vs fork/zhining/nano-9476-integ-0716 = 0 ahead / 0 behind（R9 push 已同步，本轮无新功能改动）；vs fork/main = 8 ahead / 4 behind——fork/main 的 opus_burn 4 提交（5945c5a/e68ed60/d3da9db/570c744）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 [nano_maint R11 — 十一巡，读 opus_burn handoff，9475/9476 健康，fork 同步 2 doc 提交，NOTHING-TO-DO]
- 接班状态：HEAD 88d427e（R10 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（`tee -a run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R10 一致）；/api/sessions 经 localhost = 200 `{"sessions":[]}`
  - 注：外部 IP 10.18.8.55:9476/api/sessions 返回 403——服务器按设计将 /api/sessions 限定 localhost 访问（CSRF/origin 守卫），非回归；历轮均 curl localhost 故记 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（`tee run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`rg --no-ignore -c "^not ok"` = 0 匹配；npm test 汇总 `# fail 0` 确认零失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* ~397 个仍为 6 月遗留空旗（按 handoff 跳过）
- opus_burn handoff（本轮新读）：~/codex_work/HANDOFF_opus_burn.md 已落地。内容：opus_burn R4-R9 收尾——codex-block-renderer（command/file/thinking/markdown/usage/MCP/image 等块渲染，parity Claude tab）、akari-panel、USER_MANUAL 更新；653/0 测过；明确 "wrap up for GLM maintenance"。关键交付实为 `public/js/codex-block-renderer.js`（handoff 误记为 `public/`，本轮 `git ls-tree fork/main` 勘正）
- fork 状态（本轮 `git fetch fork`）：本分支 HEAD 88d427e vs fork/zhining/nano-9476-integ-0716(a4989c2) = 1 ahead（R10 work-log 未推）；vs fork/main(5945c5a) = 9 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺（handoff 已读、工作就绪且测过，待主人一声令下即 merge→冒烟→部署）
- 动作：提交 R11 work-log 记账 + push fork 同步分支（R10+R11 两 doc 提交，不开 PR，不动 9475，无功能改动故不部署 9476）
- 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
- 本轮无可修复 bug / 无待办 → NOTHING-TO-DO

## 2026-07-16 [nano_maint R12 — 十二巡，状态不变，opus_burn handoff 已读，NOTHING-TO-DO]
- 接班状态：HEAD 66fbdea（R11 work-log 提交），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
- 健康巡检（`tee run_nano_maint.log`）：
  - 9475 = 200（未触碰，按红线不动 9475）
  - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R11 一致）；/api/sessions(localhost) = 200
- 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
  - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
- npm test（`tee run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
- run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`rg "^not ok"` = 0 匹配；无 `# fail [1-9]`、无 RESULT:FAIL/Traceback/NaN，无真实失败
- 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* ~399 个仍为 6 月遗留空旗（按 handoff 跳过）
- opus_burn handoff：~/codex_work/HANDOFF_opus_burn.md 已落地（R11 首读，本轮复核无变更）——codex-block-renderer 全套 + akari-panel + USER_MANUAL，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD 66fbdea vs fork/zhining/nano-9476-integ-0716 = 0 ahead / 0 behind（R11 push 已同步）；vs fork/main(5945c5a) = 10 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 [nano_maint R13 — 十三巡，两 handoff 均已读，9475/9476 健康，npm test 653/0，fe 0 errors，NOTHING-TO-DO]
 - 接班状态：HEAD 862c4a9（R12 work-log 提交，未 push），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：~/codex_work/HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套 + akari-panel + USER_MANUAL，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册
 - 健康巡检（`tee run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R12 一致）；/api/sessions(localhost) = 200 `{"sessions":[]}`
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`rg "^not ok"` = 0 匹配；npm test 汇总 `# fail 0` 确认零失败（fail-marker sweep 仅命中 "nanocode" 子串误触 NaN 正则，无 RESULT:FAIL/Traceback/ENOENT/`# fail [1-9]` 真实失败）
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* ~399 个仍为 6 月遗留空旗（按 handoff 跳过）
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD 862c4a9 vs fork/zhining/nano-9476-integ-0716(a4989c2) = 1 ahead（R12 work-log 未推）；vs fork/main(5945c5a) = 11 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：R12(862c4a9) 1 个未推 → 本轮提交 R13 后 = 2 个未推，未达 WORKER_CORE §6「3+ 未推 commit → push」阈值，故本轮不 push
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；仅提交 work-log 记账，无 push 无部署

## 2026-07-16 [nano_maint R14 — 十四巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork push（3 未推达阈值），NOTHING-TO-DO]
 - 接班状态：HEAD 7578147（R13 work-log 提交，未 push），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：~/codex_work/HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套 + akari-panel + USER_MANUAL，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R13 一致）；/api/sessions(localhost) = 200 `{"sessions":[]}`
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`rg "^not ok"` = 0 匹配；npm test 汇总 `# fail 0` 确认零失败（hard-fail sweep 命中 1 处 = line 2350 `# [opencode:block] spawn error: ENOENT opencode`，系 opencode-block driver 测试**预期捕获** ENOENT 的用例内容，其下 subtest `ok 1`/`ok 2` 通过，非真实失败；无 RESULT:FAIL/Traceback/`# fail [1-9]` 真实失败；0 NaN）
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* ~398 个仍为 6 月遗留空旗（按 handoff 跳过）
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD 7578147 vs fork/zhining/nano-9476-integ-0716(a4989c2) = 2 ahead（R12+R13 work-log 未推）；vs fork/main(5945c5a) = 12 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R14 后 = 3 个未推（R12+R13+R14），达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮 push fork 同步分支（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账 + push fork 同步

## 2026-07-16 [nano_maint R15 — 十五巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork 已同步（1 未推未达阈值），NOTHING-TO-DO]
 - 接班状态：HEAD 22115f8（R14 work-log 提交，已 push fork 同步），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：~/codex_work/HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套 + akari-panel + USER_MANUAL，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R14 一致）；/api/sessions(localhost) = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（commit db43176 feat(codex): search overlay, file change grouping, error jump）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先，`db43176..HEAD` 16 提交全为 `docs(work-log):` + merge，**零功能改动**；所有版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` / `/vendor/*` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；fail sweep 命中 2 处 = line 311-312 `renders object-form error.message (claude SDK Error-like)`、line 2330-2331 `output starts with Error: → true`，均系测试**预期** error-rendering 用例内容（其下 `ok 2`/`ok 3` 通过），非真实失败；无 RESULT:FAIL/Traceback/`# fail [1-9]`/`^not ok` 真实失败；0 NaN
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 遗留空旗仍按 handoff 跳过
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD 22115f8 vs fork/zhining/nano-9476-integ-0716 = **0 ahead / 0 behind（已同步，R14 推过）**；vs fork/main(5945c5a) = 13 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R15 后 = 1 个未推（仅 R15），未达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮不 push（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账

## 2026-07-16 [nano_maint R16 — 十六巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork 1 未推未达阈值，NOTHING-TO-DO]
 - 接班状态：HEAD 74b1f69（R15 work-log 提交，未 push），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：~/codex_work/HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套 + akari-panel + USER_MANUAL，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R15 一致）；/api/sessions = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（与 R15 一致）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先，`db43176..HEAD` 17 提交全为 `docs(work-log):` + merge，**零功能改动**；版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`^not ok` = 0、`# fail [1-9]` = 0 真实失败；hard-fail sweep 命中 1 处 = line 2511 `# [opencode:block] spawn error: ENOENT opencode`，系 createOpencodeBlockDriver「error paths」测试**预期**用例内容（其下 ok 1/ok 2/ok 3 + 父 ok 72 全通过），非真实失败；0 NaN（仅本轮 sweep 命令 echo 误触，无测试 NaN）
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* ~398 个遗留空旗仍按 handoff 跳过
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD 74b1f69 vs fork/zhining/nano-9476-integ-0716 = **1 ahead / 0 behind（R15 未推）**；vs fork/main(5945c5a) = 14 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
  - 未推 commit 计数：本轮提交 R16 后 = 2 个未推（R15+R16），未达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮不 push（不开 PR，不动 9475，无功能改动故不部署 9476）
  - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账

## 2026-07-16 18:07 [nano_maint R19 — 十九巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork 1 未推未达阈值，NOTHING-TO-DO]
 - 接班状态：HEAD d1de39a（R18 work-log 提交，未 push——1 个未推），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee -a run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R18 一致）；/api/sessions = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（与 R15-R18 一致）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先，`db43176..HEAD` 20 提交全为 `docs(work-log):` + merge，**零功能改动**；版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`^not ok` = 0、`# fail [1-9]` = 0 真实失败；RESULT:FAIL/Traceback/NaN sweep 命中均为**前置轮次 sweep 命令回显文本**（sweep header 行含模式字面 + "grep config error: unknown encoding" 报错行），非真实失败；npm test 汇总 `# fail 0`（行 15678）确认
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 遗留空旗仍按 handoff 跳过
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD vs fork/zhining/nano-9476-integ-0716 = **1 ahead / 0 behind（R18 未推）**；vs fork/main(5945c5a) = 17 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R19 后 = 2 个未推（R18+R19），未达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮不 push（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账

## 2026-07-16 [nano_maint R17 — 十七巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork push（3 未推达阈值），NOTHING-TO-DO]
 - 接班状态：HEAD 5c333af（R16 work-log 提交，未 push），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R16 一致）；/api/sessions = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（与 R16 一致）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先，`db43176..HEAD` 17 提交全为 `docs(work-log):` + merge，**零功能改动**；版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`^not ok` = 0、`# fail [1-9]` = 0 真实失败
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 398 个遗留空旗仍按 handoff 跳过
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD vs fork/zhining/nano-9476-integ-0716 = **2 ahead / 0 behind（R15+R16 未推）**；vs fork/main(5945c5a) = 15 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R17 后 = 3 个未推（R15+R16+R17），达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮 push fork（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账并 push fork

## 2026-07-16 [nano_maint R18 — 十八巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork 1 未推未达阈值，NOTHING-TO-DO]
 - 接班状态：HEAD 83a1096（R17 work-log 提交，已 push fork 同步），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R17 一致）；/api/sessions = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（与 R15-R17 一致）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先，`db43176..HEAD` 18 提交全为 `docs(work-log):` + merge，**零功能改动**；版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`^not ok` = 0、`# fail [1-9]` = 0 真实失败；RESULT:FAIL/Traceback/NaN sweep 命中均为**前置轮次 sweep 命令回显文本**（sweep header 行含模式字面），非真实失败；npm test 汇总 `# fail 0` 确认
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 遗留空旗仍按 handoff 跳过
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD vs fork/zhining/nano-9476-integ-0716 = **0 ahead / 0 behind（已同步，R17 推过）**；vs fork/main(5945c5a) = 16 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R18 后 = 1 个未推（仅 R18），未达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮不 push（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账

## 2026-07-16 18:09 [nano_maint R20 — 二十巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork push（3 未推达阈值），NOTHING-TO-DO]
 - 接班状态：HEAD 6af186b（R19 work-log 提交，未 push——2 个未推 R18+R19），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee -a run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R19 一致）；/api/sessions = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（与 R15-R19 一致）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先，`db43176..HEAD` 21 提交全为 `docs(work-log):` + merge，**零功能改动**；版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`^not ok` = 0、`# fail [1-9]` = 0 真实失败；RESULT:FAIL/Traceback/NaN sweep 命中均为**测试 subtest 名含 "Error" 字面（如 "renders object-form error.message"、"output starts with Error:"，均 ok 通过）+ sweep header 回显**，非真实失败；npm test 汇总 `# fail 0` 确认
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 遗留空旗仍按 handoff 跳过
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD vs fork/zhining/nano-9476-integ-0716 = **2 ahead / 0 behind（R18+R19 未推）**；vs fork/main(5945c5a) = 18 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R20 后 = 3 个未推（R18+R19+R20），达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮 push fork（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账并 push fork

## 2026-07-16 [nano_maint R21 — 廿一巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork 1 未推未达阈值，NOTHING-TO-DO]
 - 接班状态：HEAD c1e307c（R20 work-log 提交，已 push fork 同步），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee -a run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R20 一致）；/api/sessions = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（与 R15-R20 一致）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先，`db43176..HEAD` 24 提交全为 `docs(work-log):` + 2 merge + 1 docs(session-singleton)，**零功能改动**；版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`^not ok` = 0、`# fail [1-9]` = 0 真实失败；npm test 汇总 `# fail 0` 确认
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 398 个遗留空旗仍按 handoff 跳过（无 REPORT 证据）
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD vs fork/zhining/nano-9476-integ-0716 = **0 ahead / 0 behind（已同步，R20 推过）**；vs fork/main(5945c5a) = 4 behind / 19 ahead——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R21 后 = 1 个未推（仅 R21），未达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮不 push（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账

## 2026-07-16 [nano_maint R22 — 廿二巡，两 handoff 在册，9475/9476 健康，npm test 653/0，fe 0 errors，fork 2 未推未达阈值，NOTHING-TO-DO]
 - 接班状态：HEAD e916016（R21 work-log 提交，未 push——1 个未推 R21），工作树干净（仅未跟踪 .git.bak-migrate，前置遗留不动）
 - 入口 handoff 复读：HANDOFF_opus_officer.md（officer 178 FLAG 验过 / 0 待办 / 9476 union 分支已 push fork）+ HANDOFF_opus_burn.md（opus_burn R4-R9 codex-block-renderer 全套，653/0 测过，明确 "wrap up for GLM maintenance"，待主人定夺并入 9476）均已在册，无变更
 - 健康巡检（`tee -a run_nano_maint.log`）：
   - 9475 = 200（未触碰，按红线不动 9475）
   - 9476 = 200；/api/health = ok；/api/services：nanocode up / akari up（mblend·dccpipeline·regression·TTS down，非 nanocode 维护面，预期，与 R1-R21 一致）；/api/sessions = 200
 - 资产/版本核对：运行 9476 asset 版本 = `db43176`（与 R15-R21 一致）；`git merge-base --is-ancestor db43176 HEAD` = YES → 运行版本是本分支祖先；`db43176..HEAD` 非 docs(work-log)/Merge 提交仅 1 个 = `9ab72a9 docs(session-singleton)`（docs-only，零功能改动，R21 已记）；版本化资产 `/js/app.js?v=db43176` / `/js/i18n.js` / `/js/tts.js` / `/style.css?v=db43176` 逐条 curl = 200。无功能漂移 → 不重部署 9476
 - 前端报错巡检（Playwright headless 加载 http://localhost:9476/，networkidle+2.5s，脚本 _fe_check.mjs 仓内起、用后即删）：
   - title="Nanocode"，console error/warning = 0，pageerror = 0，failed request = 0
 - npm test（`tee -a run_nano_maint.log`）：`node --test server/tests/*.test.js` → 653 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo
 - run.log 自查：`git check-ignore run_nano_maint.log` 命中（gitignored）；`^not ok` = 0、`# fail [1-9]` = 0 真实失败；npm test 汇总 `# fail 0` 确认
 - 待办扫描：~/codex_work/REVIEW_REQ_* / CHORE_* = 0；FLAG_* 399 个遗留空旗仍按 handoff 跳过（无 REPORT 证据）
 - fork 状态（本轮 `git fetch fork`）：本分支 HEAD vs fork/zhining/nano-9476-integ-0716 = **1 ahead / 0 behind（R21 未推）**；vs fork/main(5945c5a) = 20 ahead / 4 behind——opus_burn 4 提交（570c744/d3da9db/e68ed60/5945c5a）仍**未并入** 9476 运行分支，按任务书「大改先在任务书下等批」继续不动，留主人定夺
 - 未推 commit 计数：本轮提交 R22 后 = 2 个未推（R21+R22），未达 WORKER_CORE §6「3+ 未推 commit → push」阈值 → 本轮不 push（不开 PR，不动 9475，无功能改动故不部署 9476）
 - 过程产物：run_nano_maint.log gitignored（run-*.log），_fe_check.mjs 用后即删，不入库
 - 本轮无可修复 bug / 无待办 → NOTHING-TO-DO；提交 work-log 记账
