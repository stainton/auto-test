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

集群内地址为 `http://generator:4502`。CaseHub 的 Kubernetes 清单已经使用此地址；跨 namespace 时改成 `http://generator.<namespace>.svc.cluster.local:4502`。外部调试可以运行 `kubectl port-forward --address 0.0.0.0 service/generator 4502:4502`，随后直接访问，无需鉴权。服务开放 CORS，浏览器可直接调用接口和订阅 SSE。

OpenAPI 文档在 `server/generator/openapi.json`，运行时可直接请求 `GET /openapi.json`。

保留单副本和 Recreate 更新策略，避免多个进程同时写任务文件。默认需要 StorageClass 提供 5Gi RWO PVC，用于保存任务状态、进度和结果；没有默认存储类时在 PVC 中填写 storageClassName。重启后未完成任务标记失败，调用方重新提交；已完成结果在保留期内仍可读取。任务默认保留 24 小时，最多保留 100 个，可调整环境变量。

清单保留浏览器资源预算、共享内存和健康检查；容器文件系统可写，不设置额外的容器安全策略。Pod 需要能够访问模型 API 和被测系统。
