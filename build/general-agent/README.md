# general-agent 镜像

构建：`sh build/general-agent/build.sh registry.example.com/auto-test-general-agent:1.0.0`

镜像仅安装 Claude Code CLI 和服务运行所需的 Node.js；不安装 Playwright 或浏览器。可将实际 `setting.json` 放入本目录（已忽略），构建后通过 `GENERAL_AGENT_CLAUDE_SETTINGS` 使用；也可运行时挂载该文件。
