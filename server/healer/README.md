# Healer 脚本修复

部署在 generator Pod 中（`server/generator/main.mjs`，端口 4502），使用 automation 合并服务时则在 4501，无需新增容器。只修复已有脚本：接收原用例、script 源码、failureDetails（可选）、目标环境和资产，先用 test_run 复现，再用 test_debug 定位并修复。最多五轮业务修复；服务端还会独立执行最终返回代码，全部通过且没有跳过测试后才接受结果。产品缺陷或无法构造的外部条件返回 blocked，不能降低业务断言以求通过。

CaseHub 只在「自动化管理」单条脚本的详情和右键菜单提供入口。支持进度、取消、刷新恢复、失败详情、补充说明后重试；成功保存回原脚本，失败保留原脚本。若修复期间脚本已修改，则不覆盖，仍可下载结果。

路由与 generator 相同：`POST /v1/healer/jobs`、`GET /v1/healer/jobs/{id}`、`GET /v1/healer/jobs/{id}/events`、`GET /v1/healer/jobs/{id}/result`、`DELETE /v1/healer/jobs/{id}`。输入沿用 generator 契约，每次仅允许一个 case，新增必填 `cases[0].script`（最多 120000 字符）及可选 `failureDetails`（最多 100000 字符）。结果沿用 generated/blocked 与 scripts 格式；generated 表示修复并验证成功。

与 generator 共用资产缓存和隔离执行机制；探索经验同样由 CaseHub 随请求下发并存回。失败现场保留在数据目录（generator Pod 为 `GENERATOR_DATA_DIR`，automation 为 `AUTOMATION_DATA_DIR`）的 `healer-workspaces`；任务状态的 `artifacts.workspace` 提供位置。默认保留 24 小时，随任务过期清理。

独立配置：`HEALER_CLAUDE_SETTINGS`、`HEALER_MODEL`、`HEALER_CASE_TIMEOUT_MS`（默认 3600000）、`HEALER_TIMEOUT_MS`（默认 3600000）、`HEALER_CONCURRENCY`（默认 1）、`HEALER_MAX_JOBS`（默认 100）、`HEALER_RETENTION_MS`（默认 86400000）。未指定配置文件时，首次从 generator 配置复制到数据目录下的 `healer-settings.json`；之后使用独立文件，CaseHub 在「设置 → agent设置 → 脚本修复」保存的配置随每次请求下发。

验证：`node --test server/tests/healer.check.mjs`；真实浏览器复跑检查：`node server/tests/healer-verification-smoke.mjs`（无需调用付费模型）。独立复跑验证由 `verifyRepair` 完成，不依赖模型声称已通过。
