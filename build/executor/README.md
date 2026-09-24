# executor 镜像

构建：`sh build/executor/build.sh registry.example.com/auto-test-executor:1.0.0`。

镜像只提供 `/v1/executor/*`：在隔离工作目录中运行已审核的 Playwright 脚本，收集步骤截图，并生成自包含 Markdown 测试记录。它与 automation 服务独立部署，避免脚本运行抢占 planner/generator 的浏览器和模型资源。

构建时复用 `build/planner/setting.json`，无需另行准备 executor 的配置文件；镜像会将其安装为 executor 自己使用的 Claude settings 路径。
