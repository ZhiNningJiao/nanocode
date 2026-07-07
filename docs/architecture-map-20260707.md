# nanocode 全景摸底（2026-07-07，Fable one-shot 深读 + 三路 subagent 交叉）

> 比 docs/architecture.md（只覆盖 PTY 终端层）完整；本文覆盖 AI 会话栈。行号基于
> zhining/mes13740-plugins-ui @ d6a9086，行号会漂移、以符号名为准。

## 1. 分层

```
浏览器 public/js（无构建 vanilla JS）
  ├─ tab-manager.js      tab 生命周期/resume picker/渲染器选择
  ├─ terminal-view.js    composer 壳：发送/排队托盘/打断按钮/手机端
  ├─ claude-block-renderer.js  stream-json → 聊天块、子agent可见性、历史回放
  └─ plugins-registry.js 插件清单（apiVersion 1.0 + permissions 仅声明不执行）
server/index.js           Express + WS 升级 + TTS 代理(GPT-SoVITS:9880, 熔断器) + 服务健康
terminal/routes.js        REST + WS attach 分发
terminal/claude-session-controller.js  会话心脏（cs 状态机/队列/打断/重置）
  ├─ claude-tmux-driver.js   生产默认：每 tab 一个 tmux 常驻 claude + .sock JSON 协议
  ├─ claude-sdk-driver.js    SDK 流式（tmux 失败时回退）；claude-persistent-spawn 保子进程跨重启
  ├─ opencode-block-driver.js  fable5/opencode tab：opencode run 子进程（AIGW）
  └─ codex-sdk-driver.js       codex tab（sdk 模式时）
server/store.js           JSON 文件持久层 data/nanocode.json（原子写+损坏备份）
```

## 2. 一条消息的生命周期（claude tab）

1. 前端 `sendInput()`：若 `isClaudeThinking` → 只进本地 `_pendingQueue` 并 `PUT /queue` 持久化（**不发 WS**）；空闲才发 `{type:'claude-input', text, _nonce}`。
2. controller `onMsg` → `dispatchClaudeTurn` → `getClaudeDriver()`（生产=tmux，测试=NODE_TEST_CONTEXT 强制 sdk，tmux 挂了运行时回退 sdk）。
3. driver 忙碌时消息进 `cs.queue`（内存）+ 广播 `queued` 事件；turn 结束的 finally 里 flush：`_forceFlushQueue || !wasInterrupted || auto_flush_queue_on_interrupt(默认开)` → 全部 join('\n\n') 当**一个**新 turn。`cs.queue` 没接住的，还有 `tab.pendingQueue`（store 持久化）兜底 drain——这就是"turn 一结束排队消息全发出去"的机制。
4. 历史真源 = claude CLI 自己写的 `~/.claude/projects/<cwd编码>/<sid>.jsonl`；store 只记指针（sid/cwd/configDir）。重启后 attach 直接从 jsonl tail 恢复 `cs.history`，首 turn 用 `--resume`（三层回退：resume → continue → 全新 session）。

## 3. 打断语义（本次修复的主战场）

- **软打断**（Stop 第一下）：`POST /interrupt` → SDK `q.interrupt()`（tmux 走 .sock `{type:'interrupt'}`）。
- **强打断**（2.5s 内第二下 Stop，force=1）：**不杀进程**——SDK 流式下 force 被重映射为 `q.interrupt()` + 4s watchdog（超时就地合成 error_during_execution 结算 turn，进程和 sub-agent 全保活，红线）。真 SIGKILL 只在 reset。
- **立即发送**（queuefix 274e573，2026-07-07 合入）：旧设计 WS `_sendNow` + HTTP interrupt 双通道竞速 → 空闲时消息被自己人打死/忙碌时 flush 扑空。新设计：**WS handler 一步原子**——先记 wasBusy，忙碌=入队后带 andFlush 强打断、空闲=直接跑，前端不再发 HTTP。
- **force-unwedge 兜底**（busy=true 但 currentProc=null 的假忙死锁）：强打断就地清 busy + 广播合成 result + drain 滞留队列。**d6a9086 前这里必炸 ReferenceError**（孤儿 `_emitAgentStop`，定义在被 66867e5 strategy=ours 归档的 p1p5-plugin-host 线上）——即"强打断没有任何反应"的一个真实来源。回归测试 `claude-force-unwedge.test.js`。

## 4. tmux bridge 的坑（都有注释/已修）

- tmux server 环境冻结：必须 `-e HOME` `-e CLAUDE_CONFIG_DIR` 钉死，否则 resume "No conversation found" 假成功（memory 有案）。
- argv 不能带字面 'exec'（tmux 直接 execvp）；bridge .sock 是 JSON-lines 协议别用 `tmux -S` 连。
- turn 空转 10min watchdog 防 busy 永久卡死。

## 5. 已知薄弱点（按危险度，来自三路深读，除①外均未修）

1. ✅（已修 d6a9086）force-unwedge ReferenceError。
2. opencode-block / codex 的 interrupt 是三份复制逻辑：裸 `kill('SIGINT')`，**force 被静默忽略、无 unwedge 兜底**——fable5/opencode tab 卡死时没有强打断可用。
3. 前端重连时无条件 `_thinking=false`：长 tool call 静默期重连会出现"假空闲窗口"，此时发消息绕过排队托盘。
4. `doInterrupt()` fetch 失败被吞（catch {}）：打断请求本身失败时 Stop 按钮永远等不到 result，busy 指示卡死。
5. FORCE_UNLOCK_MS=4000 固定：慢而健康的打断可能被 watchdog 抢跑合成 error，随后真 result 又到 → UI 双"done"。
6. 队列无跨设备实时同步：第二台设备要切 tab/刷新才能看到新排队项；`queue-drained` WS 事件丢失时托盘残留已发送项。
7. 活跃 session 探测靠 mtime<30s + lsof 启发式：偶发双进程 resume 同一 jsonl（有 conflict 重试兜底但非预防）。
8. 测试环境强制 sdk driver：tmux 专属竞态（bridge 断连/watchdog）没有自动化覆盖。
9. 死代码陷阱：`showQueueChoiceBanner`（老 WS-vs-HTTP 竞速模式）和 `clearAfterReset` 无调用者残留——谁要是重新接线就把老 race 带回来。

## 6. 部署事实（2026-07-07 晚）

- **9475**（生产）：`~/code/nanocode` 分支 zhining/mes13740-plugins-ui。**进程 18:57 起，跑的是 9b1e391(7/4) 的旧代码**；19:46 后的 commit（resume picker 修复、queuefix、unwedge 修复、GLM 需求3）都**等下次重启才生效**。主人 2026-07-07 晚明确"先不重启"。
- **9476**（稳定备胎）：`~/code/wt-nano-9476-release` = tag v1.6.0 = fork/main（66867e5），独立 data/。
- 版本习惯：tag 是真版本源（v1.6.0），package.json version 落后（1.2.4）勿信。
- fork = ZhiNningJiao/nanocode（可推），origin = victoriacity（只读）。
