# automation Kubernetes 部署

准备 `build/automation/setting.json`，构建镜像后执行：

```sh
kubectl apply -k deploy/kubernetes/automation
kubectl rollout status deployment/automation
```

服务地址为 `http://automation:4501`。CaseHub 使用同一地址访问 `/api/planner/*` 与 `/api/generator/*`；探索经验与任务数据位于同一个 PVC，因此 Pod 重建后仍会保留。
