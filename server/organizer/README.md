# Organizer（用例重整，功能 AM，临时）

只做用例结构优化：探索产品、读每条已有用例测的是什么，把它们按 `产品 / 模块 / 子功能… / 测试类别` 归类。**不设计用例**——AI 设计是 [planner](../planner/README.md) 的事。用例结构问题修复后整体删除：本目录、`planner/main.mjs` 和 `automation/main.mjs` 里的挂载各几行，以及 CaseHub 那边的 organizer。

和 planner 跑在同一个进程（planner Pod / 合并的 automation 服务）里，共用浏览器运行时、Claude 配置（CaseHub 下发的 planner 配置）和登录态复用；但它是独立的任务类型，路由在 `/v1/organizer/*`，有自己的任务队列和并发数。探索是只读的：不提交表单、不增删改数据。服务不碰调用方的数据，归类结果由 CaseHub 应用。

## 接口

与 planner 相同的任务接口，前缀换成 `/v1/organizer`：`POST /jobs`、`GET /jobs/{id}`、`/events`、`/result`、`DELETE`、`/release`、`/checkpoint`（中断的任务可以 `continueFrom` 继续）、`/capacity`。

请求：

```json
{
  "products": [{ "code": "AIGC", "name": "AIGC 平台", "baseUrl": "https://aigc.example.com/", "notes": "左侧导航是模块入口" }],
  "cases": [{ "id": "TC-SYNC-ENTRY-FUNC-001", "title": "资产操作菜单中同步至JoyData", "folder": "V1 / 一键同步", "excerpt": "前置：… 步骤：… 预期：…" }],
  "functions": [{ "product": "AIGC", "code": "ASYNC", "path": ["资产区", "一键同步"] }],
  "scope": { "product": "AIGC", "path": ["资产区"], "maxChildren": 8, "maxDepth": 2 },
  "target": { "baseUrl": "https://aigc.example.com/" },
  "context": { "instructions": "", "testData": { "username": "…", "password": "…" }, "productExperience": "" },
  "timeoutMs": 3600000
}
```

- `products`：1–20 个；`target.baseUrl` 一般取第一个产品。`cases`：1–1000 条，一批，不必是全部基线。
- `functions`：前几批已经定下的叶子功能，本批沿用它们的路径和缩写。
- 模块按用例实际测的功能拆成子功能（如 资产区 / 文件夹操作、搜索、排序），子功能用例很多时再细分；路径 1–6 级，不含测试类别。
- 可选的 `scope` 用于对一个已有目录做更深的划分：用例都留在该产品、该路径之下，模型只返回 scope 以下的相对路径（可以为空，表示直接留在 scope 目录），结果里的 `path` 已拼回完整路径。
  - `maxChildren`（1–30，默认 8）：任何一个目录（含 scope 目录本身）下的子目录数上限；`maxDepth`（默认 2，不超过总深度 6）：scope 以下最多几层。测试类别目录不计。
  - 服务保证结果守住这两个上限：超出深度的层级截掉；某个目录的子目录超过上限时保留用例最多的那几个，其余子目录的用例上移到该目录（结果的 `capped` 列出被合并的子目录）；模型漏掉的用例留在 scope 目录本身（`leftInScope`）。

结果：`{mode: "organize", products, functions, assignments: [{caseId, product, functionCode, path, category}], unassigned, leftInScope?, capped?, explorationNotes, limitations}`。`functionCode` 是叶子功能的缩写，同一产品内一条路径只对应一个缩写，缩写被别的路径占用时自动加数字（`ASRCH` → `ASRCH2`）。测试类别目录、`TC-<产品>-<功能>-<类别>-NNN` 编号和目录重建都由 CaseHub 完成。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| ORGANIZER_CONCURRENCY | 1 | 同时运行的重整任务数（planner Pod 内另算，planner 的是 PLANNER_CONCURRENCY） |
| ORGANIZER_TIMEOUT_MS | 3600000 | 单个任务默认时限；请求的 `timeoutMs` 优先 |
| ORGANIZER_MAX_TIMEOUT_MS | 14400000 | 请求 `timeoutMs` 的上限 |
| ORGANIZER_MAX_JOBS / ORGANIZER_RETENTION_MS / ORGANIZER_MAX_RETAINED | 100 / 86400000 / 200 | 同 planner 的对应项 |

工作目录在 planner 的数据目录下的 `organizer-workspaces/`，启动时清空。

## 验证

`node --test server/tests/organizer.check.mjs`：契约、上限、worker、任务存储，以及与 planner 同进程时的路由（planner 的请求不再接受 organize 字段）。
