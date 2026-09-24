# Generator HTTP 服务

接收已经人工评审通过的测试用例，驱动 Playwright 探索被测系统，为每条用例生成一个可运行的 spec 文件。只实现 generator：不设计用例（那是 planner），不修复失败脚本（healer 不在范围内），也不保存审批状态——人工评审在调用方（CaseHub 的「自动化管理」）完成，服务只接收调用方认为可以生成的用例。

## 本地运行

需要 Node.js 24、项目的 Playwright 依赖及 Chromium、Claude Code 2.1.236（镜像已固定这些依赖）。从仓库根目录执行：

```sh
npm ci
npx playwright install chromium
# 如尚未安装 Claude Code：
npm install -g @anthropic-ai/claude-code@2.1.236
# 提供 build/generator/setting.json（或环境中的模型凭据）后启动：
node server/generator/main.mjs
```

默认监听 `0.0.0.0:4502`，本机访问 `http://localhost:4502`。与 planner 一样使用 bare 模式，显式加载 `GENERATOR_CLAUDE_SETTINGS` 指定的配置；源码运行时自动查找 `build/generator/setting.json`。服务端提供模型凭据，调用方提供被测系统的 URL、登录状态/登录指引和测试数据。planner 与 generator 是两个独立进程，可以分别部署、分别限流，也可以只启动其中一个。

## 外部接口

完整 OpenAPI 3.1 规范：[openapi.json](openapi.json)。服务启动后也提供 `GET /openapi.json`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/generator/jobs` | 提交生成任务（1–50 条用例），202 返回 ID 和状态，Location 指向状态接口 |
| GET | `/v1/generator/jobs/{jobId}` | 查询状态 |
| GET | `/v1/generator/jobs/{jobId}/events` | SSE 进度、重连回放 |
| GET | `/v1/generator/jobs/{jobId}/result` | 获取已成功完成的脚本 |
| DELETE | `/v1/generator/jobs/{jobId}` | 取消任务，不删除已有结果 |
| GET | `/healthz`、`/readyz` | 无鉴权健康检查 |

所有接口直接调用，无需 Token，已开放 CORS，浏览器可直接提交任务并用原生 EventSource 订阅进度。任务生命周期、SSE 重连（`Last-Event-ID` / `?after=N`）、重启后标记 `SERVER_RESTARTED`、保留期与容量上限的语义与 planner 完全一致，见 [planner/README.md](../planner/README.md#进度和任务生命周期)；任务失败码为 `GENERATOR_FAILED`。

请求示例：

```json
{
  "cases": [
    {
      "id": "TC-LOGIN-AUTH-FUNC-001",
      "title": "错误密码登录失败",
      "priority": "P1",
      "requirement": "REQ-LOGIN-001",
      "precondition": "已存在专用测试账号，当前未登录",
      "steps": "1. 打开登录页面\n2. 输入账号和错误密码并提交",
      "expects": "1. 显示登录表单\n2. 显示错误提示且仍在登录页面"
    }
  ],
  "requirements": [
    { "id": "REQ-LOGIN-001", "title": "用户登录", "content": "错误密码显示错误提示并保留登录页面。" }
  ],
  "target": { "baseUrl": "https://test.example.com/login" },
  "context": {
    "instructions": "使用提供的专用测试账号，不要注册新账号。",
    "testData": { "username": "test-user", "password": "caller-supplied-password" },
    "explorationNotes": "",
    "knownIssues": ""
  }
}
```

`cases` 是调用方存储的用例原文：`steps` / `expects` 保持按行编号的多行文本，`expects` 决定脚本断言什么。`requirements` 是可选背景，generator 只用它理解用例背后的业务规则，绝不据此新增用例；带 `requirement` 的用例只会收到对应的那一份需求。`target` 与 planner 相同：`storageState` 传 Playwright 导出的 cookies/origins 对象（不接受本地文件路径），`extraHTTPHeaders` 可携带目标系统请求头，登录仍需交互时把指引和专用测试账号放进 `context`。

## 结果

一条用例产出一个脚本，顺序与提交顺序一致：

```json
{
  "scripts": [
    {
      "caseId": "TC-LOGIN-AUTH-FUNC-001",
      "title": "错误密码登录失败",
      "fileName": "TC-LOGIN-AUTH-FUNC-001.spec.ts",
      "language": "typescript",
      "status": "generated",
      "code": "import { test, expect } from '@playwright/test';\n…",
      "summary": "验证错误密码被拒绝并停留在登录页",
      "deviations": []
    }
  ],
  "generated": 1,
  "blocked": 0,
  "explorationNotes": "合并后的探索记录",
  "limitations": []
}
```

- `code` 是完整的 spec 源码，由调用方保存；服务不向仓库写文件，任务结束即删除临时工作目录。
- `status` 为 `blocked` 表示无法诚实地生成可运行脚本（缺少账号/令牌/素材等必需输入，或流程三次尝试仍不可达）：此时 `code` 为空，`summary` 说明缺什么。**不会**返回 skip、fixme、占位或未经验证的断言。所有 blocked 用例同时汇总在 `limitations` 里（`{risk, summary}`，与 planner 的字段一致，便于同一套界面展示）。
- `deviations` 是实测行为与用例预期不一致的地方：脚本按实测行为断言并在该行标注 `// deviation:`，同时在这里登记一条中文说明（每条不超过 40 字，按风险排序）。
- `summary` 与 `deviations[].summary` 都写给非技术评审人看：中文、不含选择器/URL/工具名。
- `explorationNotes` 是合并后的探索记录，建议调用方保存并在下次请求中回传，可显著减少重复探索。
- 任务只要跑完就是 `succeeded`，blocked 属于结果而非失败，调用方据此保存能用的脚本、并逐条看到其余用例为什么没生成。

每条用例单独一次模型调用（见 worker.mjs）：批量任务里第五条失败不会丢掉前四条已经写好的脚本，每次调用有独立超时，前一条用例观察到的页面信息会传给下一条。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| ANTHROPIC_API_KEY | 按鉴权方式配置 | 可由 Claude settings 提供，也可使用 Token/helper/其他 provider |
| GENERATOR_CLAUDE_SETTINGS | 源码自动查找 build/generator/setting.json | Claude 配置路径；镜像为 /app/config/claude/settings.json |
| GENERATOR_HOST | 0.0.0.0 | 监听地址 |
| GENERATOR_PORT | 4502 | 监听端口 |
| GENERATOR_MODEL | 不覆盖已有 Claude 模型配置 | 显式指定时优先；完全未配置模型时回退 haiku |
| GENERATOR_CLAUDE_COMMAND | claude | 受信任的运行时可执行文件，不接受请求指定 |
| GENERATOR_DATA_DIR | 系统临时目录/auto-test-generator-jobs | 任务状态与结果目录；镜像为 /var/lib/generator |
| GENERATOR_CONCURRENCY | 1 | 同时运行的浏览器任务数 |
| GENERATOR_TIMEOUT_MS | 3600000 | 单个任务（含批量全部用例）的最长时间，不含排队 |
| GENERATOR_CASE_TIMEOUT_MS | 1800000 | 单条用例的最长生成时间；超时该条记为 blocked，任务继续 |
| GENERATOR_MAX_JOBS | 100 | 包括终态任务在内的保留数量上限 |
| GENERATOR_RETENTION_MS | 86400000 | 终态任务保留时间 |

## 验证

```sh
node --test server/tests/generator.check.mjs
```

用受控 Agent 替身验证输入校验、每条用例一次调用、批量中单条失败的降级、取消传播、脚本合法性（必须是导入 `@playwright/test` 且不含 skip/fixme 的真实 spec）以及 OpenAPI 文档，不消耗模型额度。真实生成质量仍需要有效的模型 API Key 和实际被测系统。

### CaseHub 下发配置与免重启生效

agent 的配置由 CaseHub 存在数据库里，generator 自己不再保存副本：每次脚本生成请求都带上 CaseHub 当前的配置（`agentSettings.content` 是 setting.json 正文，`agentSettings.revision` 是版本号）。任务开始前 generator 把 `GENERATOR_CLAUDE_SETTINGS` 指向的文件对齐成这份正文（不一致才原子改写，一致则不写）。随后每次 Claude CLI 调用都会重新读取该文件和其中的模型配置，无需重启服务。

因此本地文件只是 CaseHub 配置的落地结果，被覆盖是预期行为：容器重建、回滚到旧镜像或有人手工改过文件，下一次请求都会把 CaseHub 里的配置重新写回来（不需要先在 CaseHub 那边改一次配置），不需要共享卷，也不需要持久卷。无效 JSON 会以 400 拒绝该请求且不落盘（`INVALID_AGENT_SETTINGS`），写文件失败返回 500（`AGENT_SETTINGS_FAILED`），都不会静默退回旧配置。显式设置的 `GENERATOR_MODEL` 仍优先于文件中的模型设置。

镜像里的 `setting.json` 仍是首次启动、以及 CaseHub 不下发配置时的兜底；该路径需可写（默认镜像可写，若把根文件系统设为只读需单独挂载可写卷）。配置只影响后续 CLI 调用，已经在跑的 Claude 进程不变。
