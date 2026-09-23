# automation Kubernetes 部署

准备 `build/automation/setting.json`，构建镜像后执行：

```sh
kubectl apply -k deploy/kubernetes/automation
kubectl apply -k deploy/kubernetes/executor
kubectl rollout status deployment/automation
kubectl rollout status deployment/executor
```

服务在 `http://automation:4501` 提供 `/api/planner/*` 与 `/api/generator/*`。产品级与需求级探索经验位于 PVC，Pod 重建后仍会保留。脚本执行由独立的 `executor` Deployment 提供。
