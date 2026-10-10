# automation 镜像（单进程组合，可选）

生产默认把 planner、generator（含 healer）、executor 分别部署为独立 Pod，见 `deploy/kubernetes/README.md`。本镜像在一个进程内提供 planner、generator 与 healer，适合只能运行单个容器的环境。

构建：`sh build/automation/build.sh registry.example.com/auto-test-automation:1.0.0`。

镜像同时提供 `/v1/planner/*`、`/v1/generator/*` 与 `/v1/healer/*`（端口 4501）。服务共用 Playwright 与 Claude CLI；探索经验由 CaseHub 保存并随请求下发，镜像不保存经验文件。将实际 `setting.json` 放到此目录（已忽略）后再构建；格式参考 `setting.example.json`。
