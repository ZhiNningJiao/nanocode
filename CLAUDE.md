# CLAUDE.md - nanocode

## 项目概述

nanocode 是一个基于 Web 的轻量终端工作区，用于管理项目和 AI 编程助手。
技术栈：Node.js + Express + xterm.js + WebSocket + node-pty

## 项目结构

- `server/index.js` — Express 服务端 + WebSocket
- `server/store.js` — 数据存储
- `public/index.html` — 前端页面
- `public/js/` — 前端 JS
- `public/style.css` — 样式
- `terminal/` — 终端相关

## 测试命令

```bash
cd /storage/home/zhiningjiao/code/nanocode
npm test
npm run dev  # 开发模式启动
```

## Git 远程仓库

- `origin` — 上游仓库 victoriacity/nanocode（只读参考）
- `fork` — 我们的 fork ZhiNningJiao/nanocode（push 到这里）
- **所有 push 操作用 `git push fork <branch>`**，不要 push 到 origin

## 无人值守模式（值守）

用 `/ralph-loop` 启动，按以下 SOP 循环执行。

### 身份声明

启动后立即在 `~/code/agent-status.md` 写入：
```
[nanocode] <当前时间> | 启动中，正在读取状态
```
每次切换任务时更新该行。停止时更新为 `| 已停止`。

### 工作循环

1. 读 CLAUDE.md + TODO.md，理解当前状态
2. 确认当前在 `zhining/*` 分支上（不在则创建并切换）
3. 选任务：取 `[待执行]` 优先级最高的任务
   - 没有可执行任务 → 扫描代码，自主发现问题并写入 TODO.md
   - 发现 bug / 技术债 → 自主添加高优先级 todo
4. 执行 + 测试验证
   - 通过 → commit → 更新 TODO.md → 追加 work-log.md → 继续
   - 达到里程碑（完成大任务或积累 3+ 个未推送 commit）→ 只 push，不创建 PR → work-log 记录
   - 失败 → 自救 → 失败则 `[blocked]` + 原因 → 跳下一任务
5. 每轮扫描代码，改进机会追加到 proposals.md

### 热更新部署流程

每次修改完代码需要部署时，按以下步骤操作：
1. `PORT=3002 node server/index.js &` 启动新代码在 3002
2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3002` 确认 200
3. `kill $(lsof -t -i:3001)` 停掉旧进程
4. `PORT=3001 node server/index.js &` 用新代码重启 3001
5. 确认 3001 正常后停掉 3002

**原则：主人始终有一个端口可访问，不能出现两个都挂的情况。**

### 限额降级

rate limit → 切 `claude-sonnet-4-6`；Sonnet 也限额 → 按下列顺序处理：

1. **仍可等待**：若策略允许，等待配额恢复、不无故退出。
2. **唤起 Cursor 汇报官**：若需换会话继续，更新交接文档：根目录 `HANDOFF_NEXT_SESSION.md` 或 `docs/HANDOFF_NEXT_SESSION.md`（若创建），或 `~/code/agent-status.md` 中 `[nanocode]` 行；写入时间、进度、待办、最近修改、下一步；**`next_agent: 汇报官`**；**`started_agents`**（本会话已启动的 sub-agent / 工具 agent；无则 `started_agents: []`）。
3. 提示用户：「请开新对话并选择 **汇报官**（Cursor 汇报官，人设边牧娘），汇报官将读取交接与 CLAUDE.md 并全线接管。」
4. 全局约定：`.cursor/rules/limit-handoff.mdc`；汇报官：`.cursor/agents/handoff-officer.md`。

**Claude 接管后**：若交接写有「交接完毕，请 Claude 关闭汇报官 sub-agent」，应关闭汇报官或提示用户关闭。

### 停止条件

满足以下任一条件时，输出 `<promise>DONE</promise>` 结束循环：
- 所有任务都 `[done]` 或 `[blocked]`
- 没有新的可执行任务
