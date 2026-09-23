# automation Kubernetes 部署

准备 `build/automation/setting.json`，构建镜像后执行：

```sh
kubectl apply -k deploy/kubernetes/automation
kubectl rollout status deployment/automation
```

服务在 `http://automation:4501` 提供 `/api/planner/*` 与 `/api/generator/*`，在 `http://automation:4504` 提供 `/api/executor/*`。executor 在同一 Pod 中执行已评审的脚本，探索经验与任务数据位于同一个 PVC，因此 Pod 重建后仍会保留。
