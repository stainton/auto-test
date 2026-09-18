# Generator 镜像

仓库根目录执行：

```sh
sh build/generator/build.sh registry.example.com/auto-test-generator:1.0.0
```

Dockerfile 使用专属 package.json / package-lock.json 锁定 Claude Code 和 Playwright，独立安装 Chromium；不改动仓库根目录依赖和现有交互式工作流。构建上下文只包含服务代码与该专属依赖清单，包含服务代码、运行依赖和你提供的 setting.json。

本地试运行（模型配置放在 setting.json 中）：

```sh
docker run --rm -p 4502:4502 --shm-size=512m \
  -v generator-data:/var/lib/generator \
  registry.example.com/auto-test-generator:1.0.0
```

本地源码运行及接口示例见 `server/generator/README.md`。Kubernetes 资源见 `deploy/kubernetes/generator/`。

## Claude CLI 配置自动归位

将你提供的配置文件放在 `build/generator/setting.json`，然后运行上述构建命令即可。文件已在该目录的 `.gitignore` 中忽略；格式参考 `setting.example.json`。

构建时自动校验 JSON，将原文件内容安装到镜像中的 `/app/config/claude/settings.json`，启动时通过 `PLANNER_CLAUDE_SETTINGS` 将绝对路径显式传给 Claude 的 `--settings`，因此 bare 模式也会加载这份配置。不依赖当前任务的临时工作目录。

支持配置文件中的 `env`（API 地址、API Key/Token 等）、`model` 和其他 Claude 配置。未设置 `PLANNER_MODEL` 时保留 Claude 自身的模型配置优先级；两处都未配置模型时使用 haiku。没有提供 `setting.json` 时安装空配置，继续支持环境变量方式。格式错误会让构建失败，不会打印文件内容。

配置文件随镜像分发，容器启动无需服务 Token；模型平台需要的凭据由 setting.json 提供。也可在运行时挂载配置文件，并用 `PLANNER_CLAUDE_SETTINGS` 指定挂载路径。
