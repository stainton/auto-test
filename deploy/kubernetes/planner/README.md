# Planner Kubernetes 服务

仅部署 planner。构建文件位于 `build/planner/`，业务代码位于 `server/`；不部署 review、generator 或 healer。

1. 从仓库根目录构建：`sh build/planner/build.sh <registry>/auto-test-planner:<version>`，然后推送镜像。
2. 将本目录 `kustomization.yaml` 的 images 项配置为实际 `newName` 和 `newTag`。
3. 在部署 namespace 中创建名为 `planner-secrets` 的 Secret，必须包含 `api-token`；如果打包的 `setting.json` 已提供 Claude 鉴权，`anthropic-api-key` 可以省略。使用 Secret 管理系统或本地受限文件，例如：

   ```sh
   kubectl create secret generic planner-secrets \
     --from-file=anthropic-api-key=/secure/anthropic-api-key \
     --from-file=api-token=/secure/planner-api-token
   ```

   两个文件应只包含对应值，不带末尾换行。不要将真实密钥提交到仓库。
4. `kubectl apply -k deploy/kubernetes/planner`。
5. `kubectl rollout status deployment/planner`。

集群内地址：`http://planner:4501`；跨 namespace 使用 `http://planner.<namespace>.svc.cluster.local:4501`。外部调试可用 `kubectl port-forward service/planner 4501:4501`。正式集群外访问由调用方环境配置网关/TLS，不自动创建公网入口。

接口规范：`server/planner/openapi.json`，运行时也可使用 Bearer Token 请求 `/openapi.json`。由业务后端调用服务并转发 SSE，避免将服务级 Token 暴露给浏览器；SSE 网关需关闭响应缓冲，允许长连接和心跳。

需要默认 StorageClass 提供 5Gi RWO PVC；没有默认 StorageClass 时请在 PVC 配置已有的存储类。PVC 保存任务状态、有限进度记录及结果，不保存原始请求、认证状态或待执行队列输入。重启后未完成任务标记为失败，调用方重新提交；已完成结果在保留期内仍可读取。

当前固定单副本、Recreate 更新：内存队列和本地文件存储不能直接横向扩容，也不能由多个实例共享同一数据目录。后续扩容应替换 `server/shared/jobs.mjs` 的存储/队列实现。增加并发需同时增加浏览器资源预算。

Pod 需要访问模型 API 和被测系统，执行被授权的测试操作；请求可携带登录状态。服务启动检查 CLI、Playwright 和 Chromium 是否存在，真实模型凭据与目标站点可达性在任务运行时验证。数据默认保留 24 小时、最多 100 个任务（包括已完成任务），容量满时返回 503；按需调整环境变量，定期备份需要长期保留的结果。

镜像构建前将 Claude CLI 配置放入 `build/planner/setting.json`，构建会自动安装到 `/app/config/claude/settings.json`，Pod 启动时显式加载。Deployment 不设置默认 PLANNER_MODEL，避免覆盖文件中的模型；如需部署时覆盖，可自行增加该环境变量。若只使用文件中的模型鉴权，可仅创建 HTTP Token：

```sh
kubectl create secret generic planner-secrets --from-file=api-token=/secure/planner-api-token
```
