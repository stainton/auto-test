# Planner Kubernetes 服务

1. 在仓库中准备 `build/planner/setting.json`，填写 Claude CLI 使用的模型、API 地址和凭据。
2. 构建并推送镜像：`sh build/planner/build.sh <registry>/auto-test-planner:<version>`。
3. 将本目录 `kustomization.yaml` 的 images 项配置为实际 `newName` 和 `newTag`。
4. 执行：

   ```sh
   kubectl apply -k deploy/kubernetes/planner
   kubectl rollout status deployment/planner
   ```

无需创建 Secret 或配置服务 Token。setting.json 在构建时自动归位到 `/app/config/claude/settings.json`，启动时显式传给 Claude CLI。部署默认不覆盖文件中的模型；需要覆盖时可以增加 `PLANNER_MODEL` 环境变量。

集群内地址为 `http://planner:4501`（任意一个 Pod）和 headless Service `planner-nodes`（全部就绪 Pod）。CaseHub 的 Kubernetes 清单使用 `dns+http://planner-nodes:4501`，自己挑空闲 Pod 派发任务；跨 namespace 时改成 `dns+http://planner-nodes.<namespace>.svc.cluster.local:4501`。外部调试可以运行 `kubectl port-forward --address 0.0.0.0 service/planner 4501:4501`，随后直接访问，无需鉴权。服务开放 CORS，浏览器可直接调用接口和订阅 SSE。

OpenAPI 文档在 `server/planner/openapi.json`，运行时可直接请求 `GET /openapi.json`。

Pod 是无状态节点，不需要 PVC：任务记录、进度和结果由 CaseHub 保存，Pod 内只有 `emptyDir`（`/var/lib/planner`：任务工作目录与资产缓存，启动时清空）。副本数可固定、可随时调整，也可按排队数自动扩缩（见 `deploy/kubernetes/README.md`）；滚动更新时新 Pod 先就绪，旧 Pod 跑完手上的任务再退出。

被中断的任务（超时、停机排空到时限）会保留 Claude 会话；CaseHub 随即下载会话包（`GET /v1/planner/jobs/{id}/checkpoint`）保存，人点"继续"时推给任意一个 planner Pod 接着做，原 Pod 是否还在都不影响。

清单保留浏览器资源预算、共享内存和健康检查；容器文件系统可写，不设置额外的容器安全策略。Pod 需要能够访问模型 API 和被测系统。
