# 通用红线（一页）

来源：`~/code/worker-core/WORKER_CORE.md §6–§8` + `DCC_DESIGN_CODEX.md 〇节`（2026-07-16 / 07-31 起）。

- 绝不直接提交/推 main；工作分支 `zhining/<简述>`；未授权不开 PR 不 merge。
- **8770/8700 永不碰**（syzs 的）；我们自起服务一律用 94xx 不常用端口；worker 自验端口 9481–9483。
- 主 viewer 9480 秘书统管保活；重起必须 `start_onestop_viewer.sh`（带 auth），绝不裸起 app.py。
- 密钥/cookie/token 绝不进 git、日志、报告。
- 过程产物（FLAG_/REPORT_/run.log/截图/GLB 中间件）绝不 git add；测试资产只进 baseline/ fixtures/ 等。
- 禁 task-id/case 特例分支；差异进数据配置。禁 env flag 控算法行为。禁 /tmp 旁路产物。
- 运行中服务的 checkout 禁当工区；他人仓库只读；共享容器只 kill 自己 `-mes<号>` 后缀的。
- docker 一律 `--user $(id -u):$(id -g)` 非 root，跑完 `docker rm -f` 清自己的。
- E2E 登录态：绝不拷 storageState（refresh token 一次性轮换）；走 cdp_attach 直连真实浏览器；先 check_login。
- 图像生成=付费默认不跑；worker 绝不 Read 图片，像素裁决归 Sonnet。
- pkill -f 模式必须锚定进程真实形状，或先 pgrep -af 人工核对再按 PID 杀（宽模式连坐=一天两起事故）。
