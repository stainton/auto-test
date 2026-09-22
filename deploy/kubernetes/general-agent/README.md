# general-agent Kubernetes 部署

1. 在仓库中准备 `build/general-agent/setting.json`，填写 Claude CLI 所需模型和凭据。
2. 构建并推送镜像：`sh build/general-agent/build.sh <registry>/auto-test-general-agent:<version>`。
3. 在 [general-agent.yaml](general-agent.yaml) 中替换镜像地址，再执行：

```sh
kubectl apply -k deploy/kubernetes/general-agent
kubectl rollout status deployment/general-agent
```

集群内地址为 `http://general-agent:4503`。CaseHub 清单已将 `CASEHUB_GENERAL_AGENT_URL` 指向此地址；跨 namespace 时改为 `http://general-agent.<namespace>.svc.cluster.local:4503`。
