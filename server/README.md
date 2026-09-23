# 自动化测试服务代码

```text
server/
  shared/       HTTP、任务生命周期、进度事件、任务持久化和跨服务共用的契约基元
  runtime/      Claude CLI 非交互执行与配置加载，直接连接 Playwright MCP
  planner/      测试设计：输入/输出契约、提示词、流程实现、服务入口、OpenAPI
  generator/    脚本生成：同样的四件套，一条已评审用例产出一个 Playwright spec
  automation/   合并服务：在一个进程内提供 /v1/planner 与 /v1/generator，并维护按需求隔离的探索经验
  general-agent/ 通用结构化生成：仅 Claude CLI，不包含 Playwright 或 MCP
  tests/        原生 Node.js 服务测试，不调用付费模型
```

planner 与 generator 的生产入口已合并为 automation 服务（默认 4501），但仍使用各自的 HTTP 路径和输入输出契约；它不修改 `.claude/agents/`、`.mcp.json`、review、根目录 npm scripts 或原有文件式工作流。服务版提示词改编自现有 planner，输入来自 HTTP，输出经过字段校验后返回；计划与用例表由同一份结果生成，保持一致。

生产部署使用 `automation/`（默认 4501）：planner 和 generator 仍保持原有 HTTP 路径，但共享一个进程、浏览器依赖和按需求 ID 存储的探索经验。探索经验是可选优化：有历史时会随请求复用，执行中发现可复用事实时会主动带回 `explorationNotes`；generator 额外按需求带回 `explorationRecords`。旧的 `planner/` 与 `generator/` 入口保留给兼容和单独开发调试。

general-agent 在 4503 上独立启动，接受调用方给出的提示词和 JSON Schema，只有 Claude CLI 运行时；它不安装浏览器，也不加载 MCP 工具。CaseHub 当前将阅读友好版生成流量转发到该服务。构建和 Kubernetes 清单分别在 `build/general-agent` 与 `deploy/kubernetes/general-agent`。

generator 已按同一模式落地：自己的契约、提示词、流程和入口，复用 shared/runtime，构建和部署分别在 `build/generator` 与 `deploy/kubernetes/generator`。两个服务共用 `shared/contract.mjs` 里含义必须一致的部分（被测系统 target、按风险排序的中文说明），各自的输入/输出契约仍在各自的 contract.mjs。healer 后续按同样方式增加 `server/healer/`。

人工评审仍是硬门槛，只是位置不同：文件式工作流看 `specs/approved/`，HTTP 服务看调用方——generator 只生成调用方提交的用例，服务自身不做审批，也不代调用方决定哪些用例可以生成。
