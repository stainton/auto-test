# 自动化测试服务代码

```text
server/
  shared/       HTTP、任务生命周期、进度事件和任务持久化
  runtime/      Agent 执行适配器，目前使用 Claude Code 非交互模式
  planner/      输入/输出契约、planner 提示词、流程实现、服务入口、OpenAPI
  tests/        原生 Node.js 服务测试，不调用付费模型
```

planner 独立启动，不修改 `.claude/agents/`、`.mcp.json`、review、根目录 npm scripts 或原有文件式工作流。服务版提示词改编自现有 planner，输入来自 HTTP，输出经过字段校验后返回；计划与用例表由同一份结果生成，保持一致。

后续 generator、healer 分别增加 `server/generator/`、`server/healer/`，实现自己的契约、流程和入口，复用 shared/runtime；不要将它们塞入 planner 工具白名单。构建和部署也分别放在对应的 `build/<service>` 与 `deploy/kubernetes/<service>`。

TODO：generator 接入用例管理侧前，建立用例与需求 ID、设计时需求版本/内容快照的持久关联；仅用审核后的用例及其上下文生成脚本，并保存用例与脚本的对应关系。
