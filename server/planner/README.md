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
| POST | `/v1/planner/simplify` | 同步接口（非任务队列）：把已设计用例的前置条件/步骤/预期结果改写成非技术人员可读的精简版，不调用浏览器/工具，保留原有步骤数与含义，只去掉选择器、testid、属性值等自动化实现细节 |
| POST | `/v1/planner/estimate` | 同步接口（非任务队列）：只根据需求文本（不调用浏览器/工具）评估"建议覆盖用例数量"，考虑约 30% 需求因鉴权等原因无法自动化、手工测试至多单人 2 天。结果供人确认/修改后作为任务的 `caseCount` 提交 |
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
  "context": {
    "instructions": "覆盖正常登录和错误密码。使用提供的专用测试账号。",
    "testData": { "username": "test-user", "password": "caller-supplied-password" },
    "explorationNotes": "",
    "knownIssues": ""
  }
}
```

```sh
curl -X POST http://localhost:4501/v1/planner/jobs \
  -H 'Content-Type: application/json' --data-binary @request.json

curl -N http://localhost:4501/v1/planner/jobs/JOB_ID/events

curl http://localhost:4501/v1/planner/jobs/JOB_ID/result
```

`target.storageState` 可以直接传 Playwright 导出的 cookies/origins 对象（不接受本地文件路径），`target.extraHTTPHeaders` 可以携带目标系统的请求头。登录仍需交互时，将指引与专用测试账号放入 context。当前不接收自定义 seed 源码、本地附件路径或自定义 MCP 命令；需要上传附件的场景会注明缺少输入。

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

请求可带可选的 `caseCount`（1–500 的整数，通常先调用 `/v1/planner/estimate` 预填、人工确认后传入）：此时 planner 必须输出 `[max(1, caseCount-5), caseCount]` 条用例，超出范围的草稿校验失败。

`case_id` 由服务端生成，不由模型填写：`TC-<需求缩写>-<功能模块缩写>-<测试类别>-<NNN>`。需求缩写取请求里 requirement 的 `code`（大写字母/数字，2–12 位，不含 `-`；未提供时由 requirement id 去掉非字母数字得到），模块缩写与测试类别（FUNC 功能 / REL 可靠性 / PERF 性能 / SEC 安全 / COMPAT 兼容性 / UX 易用性）由 planner 给出，NNN 在同一结果内按前缀从 001 递增。`/v1/planner/estimate` 会同时返回每个需求的建议缩写 `requirementCodes`，供人确认后作为 `code` 传入。

结果还包含 `reviewStatus: draft`、`casesMarkdown`、`planMarkdown`、合并后的 `explorationNotes` 和 `limitations`。单次模型结构化结果限制 2 MiB。JSON 的步骤使用换行，Markdown 表格使用 `<br>`，列顺序保持不变。服务不自动批准草稿，不生成执行脚本。成功状态表示产出了合规草稿，查看 limitations 判断尚未验证的范围。

## 进度和任务生命周期

状态为 queued → running → succeeded / failed / cancelled。阶段和工具开始/完成事件来自运行过程，不使用虚构百分比。SSE 首先发送 snapshot，然后回放游标之后的 progress；使用 `Last-Event-ID` 或 `?after=N` 重连。最多保留最近 500 条，较旧记录丢失时先发送 reset。snapshot 表示当前任务状态，回放的旧 progress 用于过程记录，不应覆盖较新的状态。每 15 秒有心跳；终态关闭连接。抽屉关闭不影响任务，重新打开按 ID 查看即可。

取消后阶段先变为 cancelling，等待 Agent/MCP/浏览器进程终止再进入 cancelled。整任务默认 15 分钟超时。重启后未完成任务标记 SERVER_RESTARTED，由调用方重新提交。当前没有幂等提交或自动续跑；重复 POST 会创建新任务。

任务文件保存状态、进度和结果，不保存请求正文、storageState、headers 或队列输入。浏览器配置临时写入每任务独立目录，任务退出后清理，不从仓库 docs/specs 读取。调用方可按需归档结果。结果默认保留 24 小时；超期在下一次访问/提交/启动时清理，返回 404。最多保留 100 个任务，满时新请求返回 503。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| ANTHROPIC_API_KEY | 按鉴权方式配置 | 可由 Claude settings 提供，也可使用 Token/helper/其他 provider |
| PLANNER_CLAUDE_SETTINGS | 源码自动查找 build/planner/setting.json | Claude 配置路径；镜像为 /app/config/claude/settings.json |
| PLANNER_HOST | 0.0.0.0 | 监听地址 |
| PLANNER_PORT | 4501 | 监听端口 |
| PLANNER_MODEL | 不覆盖已有 Claude 模型配置 | 显式指定时优先；完全未配置模型时回退 haiku |
| PLANNER_CLAUDE_COMMAND | claude | 受信任的运行时可执行文件，不接受请求指定 |
| PLANNER_DATA_DIR | 系统临时目录/auto-test-planner-jobs | 任务状态与结果目录；镜像为 /var/lib/planner |
| PLANNER_CONCURRENCY | 1 | 同时运行的浏览器任务数 |
| PLANNER_TIMEOUT_MS | 900000 | 单个执行任务的最长时间，不含排队 |
| PLANNER_MAX_JOBS | 100 | 包括终态任务在内的保留数量上限 |
| PLANNER_RETENTION_MS | 86400000 | 终态任务保留时间 |
| PLANNER_SIMPLIFY_TIMEOUT_MS | 60000 | `/v1/planner/simplify` 单次改写的最长等待时间 |
| PLANNER_ESTIMATE_TIMEOUT_MS | 120000 | `/v1/planner/estimate` 单次评估的最长等待时间 |

## 验证

```sh
node --test server/tests/*.check.mjs
```

服务测试使用 `.check.mjs` 命名，避免被根目录 Playwright 默认 testMatch 扫描。测试使用受控 Agent 替身验证真实 HTTP、任务生命周期、进度重放、输出契约及运行时进程终止，不消耗模型额度。另外可运行 `node server/tests/runtime-smoke.mjs`，使用真实 Claude CLI、Playwright MCP 和 Chromium，加上本机模型替身和测试页面验证启动链路；不调用付费模型。可用 `PLANNER_SMOKE_RUNTIME_DIR` 指定另一个装有运行依赖的目录，`PLANNER_CLAUDE_COMMAND` 指定 CLI。真实模型生成质量验证仍需要有效的模型 API Key 和实际被测系统。

运行机制参考：[Claude 非交互模式](https://code.claude.com/docs/en/headless)、[Playwright Test Agents](https://playwright.dev/docs/test-agents)。
