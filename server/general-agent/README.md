# general-agent

通用 AI 服务，仅调用 Claude CLI，不包含 Playwright、浏览器、MCP 或专业工作流。

`POST /v1/general-agent/generate` 接收 `prompt`，可选 `systemPrompt` 和 JSON Schema `schema`；返回 `{ "output": ... }`。未提供 schema 时输出 `{ "text": "..." }`。

可选的 `agentSettings` 与 planner/generator 相同，会在本次调用前写入 `GENERAL_AGENT_CLAUDE_SETTINGS`，无需重启。
