# 自动化测试服务代码

```text
server/
  shared/       HTTP、任务生命周期、进度事件、任务持久化和跨服务共用的契约基元
  runtime/      Claude CLI 非交互执行与配置加载，直接连接 Playwright MCP
  planner/      测试设计：输入/输出契约、提示词、流程实现、service.mjs（任务与路由）、服务入口（planner Pod）、OpenAPI
  generator/    脚本生成：同样的结构，一条已评审用例产出一个 Playwright spec；入口同时挂载 healer（generator Pod）
  healer/       脚本修复：契约、提示词、流程与 service.mjs，由 generator 或 automation 进程挂载
  executor/     脚本执行：运行已审核 spec 并生成测试记录（executor Pod）
  automation/   单进程组合：用同样的 service.mjs 在一个进程内提供 planner、generator、healer，供单容器或本地开发
  general-agent/ 通用结构化生成：仅 Claude CLI，不包含 Playwright 或 MCP
  tests/        原生 Node.js 服务测试，不调用付费模型
```

生产部署为三个独立的 Pod，各有自己的镜像、浏览器、任务存储和 PVC，互不抢占资源：

| Pod | 入口 | 端口 | 路由 |
| --- | --- | --- | --- |
| planner | `planner/main.mjs` | 4501 | `/v1/planner/*`（设计、评估、阅读友好版改写） |
| generator | `generator/main.mjs` | 4502 | `/v1/generator/*` 与 `/v1/healer/*`（生成与修复共用浏览器运行时） |
| executor | `executor/main.mjs` | 4504 | `/v1/executor/*`（执行已审核脚本） |

每个工作流的任务存储与 HTTP 路由由各自的 `service.mjs` 构建，独立入口与 `automation/` 组合入口挂载的是同一份代码，路由和契约完全一致。探索经验（`shared/experience.mjs`）在每个 Pod 的数据目录里各自维护：产品级经验按目标系统 origin 隔离，先做有界在线校验，失效时只探索受影响页面并写回；需求级经验另由 CaseHub 保存并随请求带回，因此 planner 的发现仍会传给另一个 Pod 里的 generator。generator 额外按需求返回 `explorationRecords`，并在一个批次内跨用例共享新发现。

`automation/` 仍可在一个进程内同时提供三条路由（默认 4501），适合单容器环境或本地开发；CaseHub 设置 `CASEHUB_AUTOMATION_URL` 即可改为连接它。

general-agent 在 4503 上独立启动，接受调用方给出的提示词和 JSON Schema，只有 Claude CLI 运行时；它不安装浏览器，也不加载 MCP 工具。CaseHub 当前将阅读友好版生成流量转发到该服务。构建和 Kubernetes 清单分别在 `build/general-agent` 与 `deploy/kubernetes/general-agent`。

构建和 Kubernetes 清单分别在 `build/<服务>` 与 `deploy/kubernetes/<服务>`；`kubectl apply -k deploy/kubernetes` 一次部署 planner、generator、executor 与 general-agent。各服务共用 `shared/contract.mjs` 里含义必须一致的部分（被测系统 target、按风险排序的中文说明），各自的输入/输出契约仍在各自的 contract.mjs。

人工评审仍是硬门槛，只是位置不同：文件式工作流看 `specs/approved/`，HTTP 服务看调用方——generator 只生成调用方提交的用例，服务自身不做审批，也不代调用方决定哪些用例可以生成。
