# Generator Kubernetes 服务

1. 在仓库中准备 `build/generator/setting.json`，填写 Claude CLI 使用的模型、API 地址和凭据。
2. 构建并推送镜像：`sh build/generator/build.sh <registry>/auto-test-generator:<version>`。
3. 将本目录 `kustomization.yaml` 的 images 项配置为实际 `newName` 和 `newTag`。
4. 执行：

   ```sh
   kubectl apply -k deploy/kubernetes/generator
   kubectl rollout status deployment/generator
   ```

无需创建 Secret 或配置服务 Token。setting.json 在构建时自动归位到 `/app/config/claude/settings.json`，启动时显式传给 Claude CLI。部署默认不覆盖文件中的模型；需要覆盖时可以增加 `GENERATOR_MODEL` 环境变量。

同一进程还提供脚本修复 `/v1/healer/*`（与生成共用浏览器运行时，见 `server/healer/README.md`），无需单独部署 healer。healer 首次启动时把 generator 的配置复制到 `/var/lib/generator/healer-settings.json`，之后由 CaseHub「脚本修复」的 agent 设置随请求下发。

集群内地址为 `http://generator:4502`（任意一个 Pod）和 headless Service `generator-nodes`（全部就绪 Pod）。CaseHub 的 Kubernetes 清单对 generator 和 healer 都使用 `dns+http://generator-nodes:4502`；跨 namespace 时改成 `dns+http://generator-nodes.<namespace>.svc.cluster.local:4502`。外部调试可以运行 `kubectl port-forward --address 0.0.0.0 service/generator 4502:4502`，随后直接访问，无需鉴权。服务开放 CORS，浏览器可直接调用接口和订阅 SSE。

OpenAPI 文档在 `server/generator/openapi.json`，运行时可直接请求 `GET /openapi.json`。

Pod 是无状态节点，不需要 PVC：任务记录、进度、结果和失败现场的诊断包都由 CaseHub 取走保存，Pod 内只有 `emptyDir`（`/var/lib/generator`：任务工作目录、资产缓存和 healer 的配置文件，重建即清空）。副本数可固定、可随时调整，也可按 generator + healer 的排队数自动扩缩（见 `deploy/kubernetes/README.md`）。停机时运行中的任务最多再跑 `GENERATOR_DRAIN_TIMEOUT_MS`（默认 60 分钟），仍未结束的由 CaseHub 重新排队到其他 Pod。

清单保留浏览器资源预算、共享内存和健康检查；容器文件系统可写，不设置额外的容器安全策略。Pod 需要能够访问模型 API 和被测系统。
