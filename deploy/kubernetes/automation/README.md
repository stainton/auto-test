# automation Kubernetes 部署（单进程组合，可选）

默认部署方式是 planner、generator、executor 三个独立 Pod（见 `deploy/kubernetes/README.md`）。只有需要把 planner、generator、healer 合并到一个 Pod 时才使用本目录，此时 CaseHub 设置 `CASEHUB_AUTOMATION_URL=http://automation:4501`。

准备 `build/automation/setting.json`，构建镜像后执行：

```sh
kubectl apply -k deploy/kubernetes/automation
kubectl apply -k deploy/kubernetes/executor
kubectl rollout status deployment/automation
kubectl rollout status deployment/executor
```

服务在 `http://automation:4501` 提供 `/v1/planner/*`、`/v1/generator/*` 与 `/v1/healer/*`。探索经验由 CaseHub 保存并随请求下发，PVC 只保存任务与资产。脚本执行由独立的 `executor` Deployment 提供。
