# 自动化测试服务代码

```text
server/
  shared/       HTTP、任务生命周期（内存）、进度事件、归档打包和跨服务共用的契约基元
  runtime/      Claude CLI 非交互执行与配置加载，直接连接 Playwright MCP
  planner/      测试设计：输入/输出契约、提示词、流程实现、service.mjs（任务与路由）、服务入口（planner Pod）、OpenAPI
  organizer/    用例重整（临时，功能 AM）：只做已有用例的结构优化，不设计用例；挂在 planner Pod 和 automation 服务里，见 organizer/README.md
  generator/    脚本生成：同样的结构，一条已评审用例产出一个 Playwright spec；入口同时挂载 healer（generator Pod）
  healer/       脚本修复：契约、提示词、流程与 service.mjs，由 generator 或 automation 进程挂载
  executor/     脚本执行：运行已审核 spec 并生成测试记录（executor Pod）
  automation/   单进程组合：用同样的 service.mjs 在一个进程内提供 planner、generator、healer，供单容器或本地开发
  general-agent/ 通用结构化生成：仅 Claude CLI，不包含 Playwright 或 MCP
  tests/        原生 Node.js 服务测试，不调用付费模型
```

生产部署为三个独立的 Pod，各有自己的镜像和浏览器，互不抢占资源：

| Pod | 入口 | 端口 | 路由 |
| --- | --- | --- | --- |
| planner | `planner/main.mjs` | 4501 | `/v1/planner/*`（设计、评估、阅读友好版改写）；同一进程还提供 `/v1/organizer/*`（用例重整，临时） |
| generator | `generator/main.mjs` | 4502 | `/v1/generator/*` 与 `/v1/healer/*`（生成与修复共用浏览器运行时） |
| executor | `executor/main.mjs` | 4504 | `/v1/executor/*`（执行已审核脚本） |

每个工作流的任务存储与 HTTP 路由由各自的 `service.mjs` 构建，独立入口与 `automation/` 组合入口挂载的是同一份代码，路由和契约完全一致。探索经验全部由 CaseHub 保存，服务自身不落盘：需求级经验随 `requirements[].explorationNotes` / `context.explorationNotes` 下发，结果中的 `explorationNotes` / `explorationRecords` 由 CaseHub 存回；产品级经验按目标系统 origin 保存在 CaseHub，随 `context.productExperience` 下发，服务先做有界在线校验、失效时只探索受影响页面，结果的 `productExperience` 只返回本次新验证的段落，由 CaseHub 去重合并（`shared/experience.mjs`）。因此 planner 与 generator 分在不同 Pod 也看到同一份经验。generator 额外按需求返回 `explorationRecords`，并在一个批次内跨用例共享新发现。

**探索提速**（planner、generator、healer 共用）：
- **复用登录态**：任务本身不是针对登录（用例标题、需求标题里没有登录/密码/验证码/会话等词）时，第一个登录成功的任务让模型把会话（cookie + localStorage）保存下来，之后同一被测系统、同一测试账号的任务直接带着它开始探索，不再走登录页。登录态只保存在进程内存里并有时效，不写盘、不进任务数据；只作用于探索用的种子页面，**不进入 Playwright 项目配置**，所以生成脚本的 `test_run` 仍从干净浏览器开始，脚本必须自己登录。针对登录本身的任务始终从未登录开始；调用方自带 `target.storageState` 时沿用原有行为。`AUTH_SESSION_REUSE=0` 可关闭，`AUTH_SESSION_TTL_MS` 调整时效。
- **信任已有经验**：当前页面与记录的路由吻合、记录的 locator 正是所需控件时直接使用，操作本身及其结果就是校验；只有导航失败（含被重定向到登录页）、元素在超时内找不到、或操作后的状态与记录不符时，才只对受影响的页面/控件重新探索，并返回修正后的经验（路由变化时以 `REPLAY_RESET` 重写）。

## 无状态执行节点

planner、generator（含 healer）、executor 都是**无状态执行节点**：不连数据库，也不回连 CaseHub。任务所需的一切（需求、用例、经验、配置、资产、要继续的会话）由下发方随任务带来；需要持久化的产出（结果、新经验、可继续的会话、失败诊断）由下发方取走保存。节点本地只有两类东西：

- **运行中的任务**：任务记录、进度和结果只在内存里。任务结束后保留到下发方 `POST .../jobs/{id}/release` 为止（或 `*_RETENTION_MS` 到期、超过 `*_MAX_RETAINED` 条时淘汰最旧的），进程重启即全部遗忘，下发方查不到的任务按"已中断"处理。`*_DATA_DIR` 只是任务工作目录的临时空间，启动时清空。
- **丢了也无害的缓存**：按 SHA-256 寻址的资产缓存、进程内的登录态（只在本节点复用，不交给下发方）。

供下发方（CaseHub）在多个节点间分发任务的接口，三个服务一致（`<kind>` 为 planner / generator / healer / executor）：

| 接口 | 用途 |
| --- | --- |
| `GET /v1/<kind>/capacity` | `{concurrency, running, queued, reserved, available, accepting}`，挑空闲节点用 |
| `POST /v1/<kind>/jobs?queue=false` | 只在有空闲槽位时接收，否则 429 `BUSY`，下发方换下一个节点；槽位在校验期间即被预留，并发提交不会超卖。不带参数时照旧排队 |
| `POST /v1/<kind>/jobs/{id}/release` | 下发方已取走结果后释放任务及其保留的文件 |
| `GET /v1/planner/jobs/{id}/checkpoint` | 中断任务（`continuable: true`）的会话包（tar.gz，响应头 `X-Content-SHA256`）。推到任意 planner 节点的 `PUT /v1/planner/assets/<sha256>` 后，以 `continueFrom: { checkpoint: <sha256> }` 继续 |
| `GET /v1/{generator,healer}/jobs/{id}/diagnostics` | 失败现场（`diagnostics: true`）的 tar.gz：各次尝试的脚本、完整错误、运行日志、Playwright 产物，上限 50 MiB |

导出的会话包和诊断包都不含 agent 配置、凭证、Claude 配置目录或保存的登录态。每个任务的 agent 配置写在它自己的工作目录里，之后的请求下发新配置不会影响已在运行的任务。

**进程部署多开节点**：同一类节点启动多个进程即可，各用自己的端口和临时目录，然后把地址列表交给 CaseHub：

```sh
PLANNER_PORT=4501 PLANNER_DATA_DIR=/tmp/planner-a PLANNER_ASSET_DIR=/tmp/planner-a/assets node server/planner/main.mjs &
PLANNER_PORT=4511 PLANNER_DATA_DIR=/tmp/planner-b PLANNER_ASSET_DIR=/tmp/planner-b/assets node server/planner/main.mjs &
# CaseHub：CASEHUB_PLANNER_URL=http://127.0.0.1:4501,http://127.0.0.1:4511
```

节点可以分布在不同机器上（地址写成各机器的 IP），CaseHub 把任务交给其中空闲的那个；进程部署没有自动扩缩，节点数就是启动的进程数，随时增减后改 CaseHub 的地址列表并重启 CaseHub 即可（重启时还在排队的任务需重新提交，已在节点上运行的不受影响）。Kubernetes 部署见 `deploy/kubernetes/README.md`（headless Service + 可选的 KEDA 自动扩缩）。

**停机与缩容**（进程部署与 Kubernetes 相同）：收到 SIGTERM/SIGINT 后 `/readyz` 立即变 503（`/healthz` 保持 200），不再接新任务，排队中的任务以 `NODE_SHUTDOWN` 失败交还下发方；运行中的任务最多再跑 `*_DRAIN_TIMEOUT_MS`（默认等于该服务的任务时限），超时的同样以 `NODE_SHUTDOWN` 失败——planner 会话因此仍可继续；之后最多再等 `*_DRAIN_HOLD_MS`（默认 60 秒）让下发方取走并释放结果，然后退出。再发一次信号立即取消全部任务。Kubernetes 的 `terminationGracePeriodSeconds` 应不小于两者之和。

`automation/` 仍可在一个进程内同时提供三条路由（默认 4501），适合单容器环境或本地开发；CaseHub 设置 `CASEHUB_AUTOMATION_URL` 即可改为连接它。

general-agent 在 4503 上独立启动，接受调用方给出的提示词和 JSON Schema，只有 Claude CLI 运行时；它不安装浏览器，也不加载 MCP 工具。CaseHub 当前将阅读友好版生成流量转发到该服务。构建和 Kubernetes 清单分别在 `build/general-agent` 与 `deploy/kubernetes/general-agent`。

构建和 Kubernetes 清单分别在 `build/<服务>` 与 `deploy/kubernetes/<服务>`；`kubectl apply -k deploy/kubernetes` 一次部署 planner、generator、executor 与 general-agent。各服务共用 `shared/contract.mjs` 里含义必须一致的部分（被测系统 target、按风险排序的中文说明），各自的输入/输出契约仍在各自的 contract.mjs。

人工评审仍是硬门槛，只是位置不同：文件式工作流看 `specs/approved/`，HTTP 服务看调用方——generator 只生成调用方提交的用例，服务自身不做审批，也不代调用方决定哪些用例可以生成。
