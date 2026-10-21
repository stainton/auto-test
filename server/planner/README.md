# Planner HTTP 服务

接收需求与运行上下文，执行 Playwright 探索和测试用例设计，返回待审核草稿。只实现 planner。

## 本地运行

需要 Node.js 24、项目的 Playwright 依赖及 Chromium、Claude Code 2.1.236（镜像已固定这些依赖）。从仓库根目录执行：

```sh
npm ci
npx playwright install chromium
# 如尚未安装 Claude Code：
npm install -g @anthropic-ai/claude-code@2.1.236
# 提供 build/planner/setting.json（或环境中的模型凭据）后启动：
node server/planner/main.mjs
```

默认监听 `0.0.0.0:4501`，本机访问 `http://localhost:4501`。Claude 使用 bare 模式，显式加载 `PLANNER_CLAUDE_SETTINGS` 指定的配置；源码运行时也会自动查找 `build/planner/setting.json`。模型鉴权可放在配置文件的 env、apiKeyHelper 或服务端环境中，不依赖个人订阅登录。未配置模型时默认 haiku；设置 `PLANNER_MODEL` 可显式覆盖 Claude 配置中的模型。配置路径不存在或 JSON 无效时启动失败，实际鉴权在任务运行时由 Claude 验证。服务端提供 API 凭据，调用方提供被测系统的 URL、登录状态/登录指引和测试数据。

## 外部接口

完整 OpenAPI 3.1 规范：[openapi.json](openapi.json)。服务启动后也提供 `GET /openapi.json`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/planner/jobs` | 提交任务，202 返回 ID 和状态，Location 指向状态接口 |
| GET | `/v1/planner/jobs/{jobId}` | 查询状态 |
| GET | `/v1/planner/jobs/{jobId}/events` | SSE 进度、重连回放 |
| GET | `/v1/planner/jobs/{jobId}/result` | 获取已成功完成的草稿 |
| DELETE | `/v1/planner/jobs/{jobId}` | 取消任务，不删除已有结果 |
| POST | `/v1/planner/jobs/{jobId}/release` | 下发方取走结果后释放已结束的任务（含保留的会话） |
| GET | `/v1/planner/jobs/{jobId}/checkpoint` | 中断任务的会话包（tar.gz），供在任意节点继续 |
| GET | `/v1/planner/capacity` | 本节点空闲槽位，供下发方挑选节点；提交时加 `?queue=false` 则无空闲槽位直接 429 |
| POST | `/v1/planner/simplify` | 同步接口（非任务队列）：把已设计用例的前置条件/步骤/预期结果改写成非技术人员可读的精简版，不调用浏览器/工具，保留原有步骤数与含义，只去掉选择器、testid、属性值等自动化实现细节 |
| POST | `/v1/planner/estimate` | 同步接口（非任务队列）：只根据需求文本（不调用浏览器/工具）评估"建议覆盖用例数量"，考虑约 30% 需求因鉴权等原因无法自动化、手工测试至多单人 2 天。结果供人确认/修改后作为任务的 `caseCount` 提交；`rationale` 是一句不超过 40 字的中文说明（覆盖了哪些业务范围），不是推理过程 |
| GET | `/healthz`、`/readyz` | 无鉴权健康检查 |

所有接口直接调用，无需 Token。已开放 CORS，浏览器可直接跨端口提交任务、查询结果，并使用原生 EventSource 订阅进度。CaseHub 也可通过自己的代理调用；只需要服务 URL。

请求示例（保存为调用方的 `request.json`，服务不会读取该文件）：

```json
{
  "requirements": [
    {
      "id": "REQ-LOGIN-001",
      "code": "LOGIN",
      "title": "用户登录",
      "content": "正确账号密码登录成功；错误密码显示错误提示并保留登录页面。"
    }
  ],
  "target": {
    "baseUrl": "https://test.example.com/login"
  },
  "timeoutMs": 1800000,
  "context": {
    "instructions": "覆盖正常登录和错误密码。使用提供的专用测试账号。",
    "testData": { "username": "test-user", "password": "caller-supplied-password" },
    "explorationNotes": "",
    "knownIssues": "",
    "assets": [
      { "id": "a1b2c3", "name": "上传测试图.png", "type": "image", "mimeType": "image/png",
        "sha256": "<文件的 SHA-256 小写十六进制>", "size": 68 }
    ]
  }
}
```

```sh
curl -X POST http://localhost:4501/v1/planner/jobs \
  -H 'Content-Type: application/json' --data-binary @request.json

curl -N http://localhost:4501/v1/planner/jobs/JOB_ID/events

curl http://localhost:4501/v1/planner/jobs/JOB_ID/result
```

`target.storageState` 可以直接传 Playwright 导出的 cookies/origins 对象（不接受本地文件路径），`target.extraHTTPHeaders` 可以携带目标系统的请求头。登录仍需交互时，将指引与专用测试账号放入 context。当前不接收自定义 seed 源码或自定义 MCP 命令。

`context.assets`（最多 20 条）是场景需要真实文件时用的：每条 `{id, name, type, mimeType, sha256, size}`，只引用文件，不含字节。文件由调用方（CaseHub）先推送：`HEAD /v1/planner/assets/{sha256}` 询问是否已缓存，`PUT` 同一路径上传原始字节（需要 Content-Length，上限 200 MiB，服务校验大小与 SHA-256 后才保留，重复上传无副作用）。任务引用了未上传的文件返回 409 `ASSET_NOT_CACHED`。任务开始时服务把文件复制进任务工作目录，并把本地路径 `path` 交给模型，模型直接用（如 `browser_file_upload`），不下载任何东西；服务也从不主动访问调用方，因此不需要调用方的地址、凭据或数据库权限。缓存目录 `PLANNER_ASSET_DIR`（默认系统临时目录下），总量超过 `PLANNER_ASSET_CACHE_MB`（默认 2048）时先淘汰最久未使用的文件。

返回结果中的 cases 每条严格包含 `test-model.md` 的八个字段，其中 `description` 是留给评审人工填写的总结，AI 不填写，恒为空字符串：

```json
{
  "request": "REQ-LOGIN-001",
  "name": "错误密码登录失败",
  "case_id": "TC-LOGIN-AUTH-FUNC-001",
  "priority": "P1",
  "precondition": "已存在专用测试账号，当前未登录",
  "description": "",
  "steps": "1. 打开登录页面\n2. 输入账号和错误密码并提交",
  "expects": "1. 显示登录表单\n2. 显示错误提示且仍在登录页面"
}
```

请求可带可选的 `timeoutMs`：整个设计任务的时限（毫秒，1 分钟–4 小时），由发起任务的人在界面上选择——探索耗时取决于被测系统和用例预算，固定的服务端默认值对大需求经常不够。不传时使用 `PLANNER_TIMEOUT_MS`；服务端再按 `PLANNER_MAX_TIMEOUT_MS` 封顶，单个调用方不会长期占住唯一的浏览器槽位。超时任务以 `JOB_TIMEOUT` 失败，实际生效的时限会写在任务状态的 `timeoutMs` 上。

请求可带可选的 `continueFrom`，指向一次中断的设计（状态里带 `continuable: true`，通常是 `JOB_TIMEOUT` 或停机时的 `NODE_SHUTDOWN`）。此时新任务不会从零开始探索，而是用 `claude --resume` 接着那次会话继续——浏览器是新的（继续的第一件事仍是 `planner_setup_page`），但模型此前探索到的内容还在。两种写法：

- `{ "checkpoint": "<sha256>" }`：下发方先从原节点下载 `GET /v1/planner/jobs/{jobId}/checkpoint`（只含 Claude 会话，不含配置、凭证或登录态），再推到要继续的节点 `PUT /v1/planner/assets/<sha256>`。任意节点、原节点重启后都能继续；会话包未推到本节点时返回 409 `CHECKPOINT_NOT_CACHED`。
- 原任务 ID：会话仍在本节点时直接继续。

请求其余字段仍须完整提供并按提交值生效，因此继续时可以调大 `timeoutMs` 或更正测试账号。一次中断只能被继续一次（继续本身若再失败，新任务同样可继续）；该任务未失败、已被继续或会话已清理时返回 409 `NOT_CONTINUABLE`。

`context.instructions` 是发起人填写的约束，planner 按硬性限制执行：可以限定覆盖范围、禁止某些操作（例如"不要等待后台任务运行完成"）、规定等待上限、说明登录方式。被约束挡住的验证不会绕道进行，而是作为 limitations 返回。`/v1/planner/estimate` 读取同一段文字，被排除的范围不计入建议用例数。

请求可带可选的 `caseCount`（1–500 的整数，通常先调用 `/v1/planner/estimate` 预填、人工确认后传入）：此时 planner 必须输出 `[max(1, caseCount-5), caseCount]` 条用例，超出范围的草稿校验失败。

结果另有 `modules`（`[{requirement, code, name}]`，每个功能模块的中文名称，可用于给模块文件夹命名）。`case_id` 由服务端生成，不由模型填写：`TC-<需求缩写>-<功能模块缩写>-<测试类别>-<NNN>`。需求缩写取请求里 requirement 的 `code`（大写字母/数字，2–12 位，不含 `-`；未提供时由 requirement id 去掉非字母数字得到），模块缩写与测试类别（FUNC 功能 / REL 可靠性 / PERF 性能 / SEC 安全 / COMPAT 兼容性 / UX 易用性）由 planner 给出，NNN 在同一结果内按前缀从 001 递增。`/v1/planner/estimate` 会同时返回每个需求的建议缩写 `requirementCodes`，供人确认后作为 `code` 传入。

结果还包含 `reviewStatus: draft`、`casesMarkdown`、`planMarkdown`、合并后的 `explorationNotes`、`limitations` 和 `issues`。`limitations` 是未验证/受限范围，每条为 `{risk: high|medium|low, summary}`；模型对每条还要标注 `covered`（所返回的用例里是否有用例断言了该功能），已被用例覆盖的条目由服务端丢弃，不出现在结果里，评审人只看到用例没有检查的部分；`issues` 是探索时实际观察到的问题（没有则为空数组），每条为 `{risk: high|medium|low, scenario, symptom}`，scenario 是出问题的业务场景、symptom 是当时应用的实际表现。两者的文本都是给非技术评审人看的中文、每项不超过 40 字，均按风险从高到低排序。用例仍按需求要求的正确行为编写，发现的缺陷只登记在 `issues`，不会写进 expects。单次模型结构化结果限制 2 MiB。JSON 的步骤使用换行，Markdown 表格使用 `<br>`，列顺序保持不变。服务不自动批准草稿，不生成执行脚本。成功状态表示产出了合规草稿，查看 limitations 判断尚未验证的范围、查看 issues 判断已发现的问题。

### 用例重整模式（功能 AM，临时）

请求带 `organize`（且不带 `requirements` / `caseCount`）时，任务不设计用例，而是探索产品、把给定的基线用例按 `产品 / 模块 / 按需的子级` 归类，代码在 [organize.mjs](organize.mjs)。用例结构问题修复后整体 revert。

- 输入：`organize.products`（1–20 个 `{code, name, baseUrl, notes?}`，`target.baseUrl` 一般取第一个产品）、`organize.cases`（1–1000 条 `{id, title, folder?, excerpt?}`，一批，不必是全部基线）、可选的 `organize.modules`（前几批已经定下的 `{product, code, name}`，本批沿用）。
- 探索是只读的：不提交表单、不增删改数据。
- 结果：`{mode: "organize", products, modules, assignments: [{caseId, product, moduleCode, folders, category}], unassigned, explorationNotes, limitations}`。同一产品内一个模块名只对应一个缩写，缩写被别的模块占用时自动加数字（`AUTH` → `AUTH2`）。新编号 `TC-<产品>-<模块>-<类别>-NNN` 和目录重建都由 CaseHub 完成，本服务不碰数据。

## 进度和任务生命周期

状态为 queued → running → succeeded / failed / cancelled。阶段和工具开始/完成事件来自运行过程，不使用虚构百分比。SSE 首先发送 snapshot，然后回放游标之后的 progress；使用 `Last-Event-ID` 或 `?after=N` 重连。最多保留最近 500 条，较旧记录丢失时先发送 reset。snapshot 表示当前任务状态，回放的旧 progress 用于过程记录，不应覆盖较新的状态。每 15 秒有心跳；终态关闭连接。抽屉关闭不影响任务，重新打开按 ID 查看即可。

取消后阶段先变为 cancelling，等待 Agent/MCP/浏览器进程终止再进入 cancelled。整任务默认 15 分钟超时，可由请求的 `timeoutMs` 覆盖。当前没有幂等提交或自动续跑；重复 POST 会创建新任务。

任务只存在内存里（见 [server/README.md](../README.md) 的"无状态执行节点"）：状态、进度和结果保留到下发方释放（`POST .../release`）为止，未释放的终态任务 24 小时后或超过 200 条时淘汰最旧的，之后返回 404；进程重启后所有任务都查不到，中断的会话只能靠下发方事先取走的 checkpoint 继续。未完成（排队 + 运行）的任务最多 100 个，满时新请求返回 503；已结束的任务不占这个名额。正常停机时运行中的任务先跑完（`PLANNER_DRAIN_TIMEOUT_MS`），超时的以 `NODE_SHUTDOWN` 失败并保留会话，下发方仍可取走 checkpoint。

浏览器配置临时写入每任务独立目录（`PLANNER_DATA_DIR/workspaces`，启动时清空），任务退出后清理，不从仓库 docs/specs 读取。中断的任务是例外：它的工作目录会保留，里面除了浏览器配置只有 Claude 会话（`CLAUDE_CONFIG_DIR` 指向该目录），供 `continueFrom` 继续或导出 checkpoint；成功、被取消、被释放或过期时一并删除，`continuable` 只对外表示"能否继续"，不暴露会话位置。请求正文、storageState、headers 不进入任务记录。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| ANTHROPIC_API_KEY | 按鉴权方式配置 | 可由 Claude settings 提供，也可使用 Token/helper/其他 provider |
| PLANNER_CLAUDE_SETTINGS | 源码自动查找 build/planner/setting.json | Claude 配置路径；镜像为 /app/config/claude/settings.json |
| PLANNER_HOST | 0.0.0.0 | 监听地址 |
| PLANNER_PORT | 4501 | 监听端口 |
| PLANNER_MODEL | 不覆盖已有 Claude 模型配置 | 显式指定时优先；完全未配置模型时回退 haiku |
| PLANNER_CLAUDE_COMMAND | claude | 受信任的运行时可执行文件，不接受请求指定 |
| PLANNER_DATA_DIR | 系统临时目录/auto-test-planner-jobs | 任务工作目录的临时空间（`workspaces/`，启动时清空）；镜像为 /var/lib/planner |
| PLANNER_CONCURRENCY | 1 | 同时运行的浏览器任务数 |
| PLANNER_TIMEOUT_MS | 900000 | 单个执行任务的默认最长时间，不含排队；请求里的 `timeoutMs` 优先 |
| PLANNER_MAX_TIMEOUT_MS | 14400000 | 请求 `timeoutMs` 的上限，超出按此封顶 |
| PLANNER_MAX_JOBS | 100 | 未完成（排队 + 运行）任务数上限，满时 503 |
| PLANNER_RETENTION_MS | 86400000 | 未被释放的终态任务最长保留时间 |
| PLANNER_MAX_RETAINED | 200 | 未被释放的终态任务最多保留条数，超出淘汰最旧的 |
| PLANNER_DRAIN_TIMEOUT_MS | 同 PLANNER_TIMEOUT_MS | 停机时等待运行中任务完成的上限 |
| PLANNER_DRAIN_HOLD_MS | 60000 | 任务全部结束后，等待下发方取走并释放结果的上限 |
| PLANNER_ASSET_DIR | 系统临时目录/auto-test-planner-assets | CaseHub 推送的资产缓存目录（按 SHA-256 命名） |
| PLANNER_ASSET_CACHE_MB | 2048 | 资产缓存总量上限，超出先淘汰最久未使用的文件 |
| PLANNER_SIMPLIFY_TIMEOUT_MS | 60000 | `/v1/planner/simplify` 单次改写的最长等待时间 |
| PLANNER_ESTIMATE_TIMEOUT_MS | 120000 | `/v1/planner/estimate` 单次评估的最长等待时间 |
| AUTH_SESSION_REUSE | 1 | 设为 `0` 关闭登录态复用 |
| AUTH_SESSION_TTL_MS | 1800000 | 已保存登录态的复用时长（仅内存），应小于被测系统自身的会话有效期 |

探索经验不保存在服务里：需求级经验通过 `context.explorationNotes`、产品级经验通过 `context.productExperience` 随请求传入，结果的 `explorationNotes` 与 `productExperience`（`{origin, notes}`，仅本次新验证的段落）由 CaseHub 存回。

## 验证

```sh
node --test server/tests/*.check.mjs
```

服务测试使用 `.check.mjs` 命名，避免被根目录 Playwright 默认 testMatch 扫描。测试使用受控 Agent 替身验证真实 HTTP、任务生命周期、进度重放、输出契约及运行时进程终止，不消耗模型额度。另外可运行 `node server/tests/runtime-smoke.mjs`，使用真实 Claude CLI、Playwright MCP 和 Chromium，加上本机模型替身和测试页面验证启动链路；不调用付费模型。`node server/tests/continue-smoke.mjs` 用同样的替身验证"继续"：先让第一次运行在探索中途被杀掉，再用保留下来的会话继续，断言第二次运行确实带着上一次的对话历史并在成功后清理工作目录。可用 `PLANNER_SMOKE_RUNTIME_DIR` 指定另一个装有运行依赖的目录，`PLANNER_CLAUDE_COMMAND` 指定 CLI。真实模型生成质量验证仍需要有效的模型 API Key 和实际被测系统。

运行机制参考：[Claude 非交互模式](https://code.claude.com/docs/en/headless)、[Playwright Test Agents](https://playwright.dev/docs/test-agents)。

### CaseHub 下发配置与免重启生效

agent 的配置由 CaseHub 存在数据库里，planner 自己不再保存副本：每次评估、设计、继续任务或阅读友好版生成的请求都带上 CaseHub 当前的配置（`agentSettings.content` 是 setting.json 正文，`agentSettings.revision` 是版本号）。任务开始前 planner 把 `PLANNER_CLAUDE_SETTINGS` 指向的文件对齐成这份正文（不一致才原子改写，一致则不写）。随后每次 Claude CLI 调用都会重新读取该文件和其中的模型配置，无需重启服务。

因此本地文件只是 CaseHub 配置的落地结果，被覆盖是预期行为：容器重建、回滚到旧镜像或有人手工改过文件，下一次请求都会把 CaseHub 里的配置重新写回来（不需要先在 CaseHub 那边改一次配置），不需要共享卷，也不需要持久卷。无效 JSON 会以 400 拒绝该请求且不落盘（`INVALID_AGENT_SETTINGS`），写文件失败返回 500（`AGENT_SETTINGS_FAILED`），都不会静默退回旧配置。显式设置的 `PLANNER_MODEL` 仍优先于文件中的模型设置。

镜像里的 `setting.json` 仍是首次启动、以及 CaseHub 不下发配置时的兜底；该路径需可写（默认镜像可写，若把根文件系统设为只读需单独挂载可写卷）。配置只影响后续 CLI 调用，已经在跑的 Claude 进程不变。
