# auto-test Kubernetes 部署

planner、generator、executor 分别部署为独立的 Deployment + Service + PVC，各用各的镜像、浏览器和资源预算，一个服务的长任务不会抢占另一个的浏览器：

| 目录 | Service 地址 | 提供 | 镜像构建 |
| --- | --- | --- | --- |
| `planner/` | `http://planner:4501` | `/v1/planner/*` | `sh build/planner/build.sh <registry>/auto-test-planner:<tag>` |
| `generator/` | `http://generator:4502` | `/v1/generator/*`、`/v1/healer/*` | `sh build/generator/build.sh <registry>/auto-test-generator:<tag>` |
| `executor/` | `http://executor:4504` | `/v1/executor/*` | `sh build/executor/build.sh <registry>/auto-test-executor:<tag>` |
| `general-agent/` | `http://general-agent:4503` | `/v1/general-agent/*` | `sh build/general-agent/build.sh <registry>/auto-test-general-agent:<tag>` |

1. 准备 `build/planner/setting.json`、`build/generator/setting.json`、`build/general-agent/setting.json`（executor 构建时复用 planner 的配置），格式见各目录的 `setting.example.json`。
2. 构建并推送上表中的镜像，在各子目录 `kustomization.yaml` 的 images 项填写实际 `newName` / `newTag`。
3. 一次部署全部服务，或进入单个子目录分别部署：

   ```sh
   kubectl apply -k deploy/kubernetes
   kubectl rollout status deployment/planner deployment/generator deployment/executor deployment/general-agent
   ```

4. CaseHub 清单中设置 `CASEHUB_PLANNER_URL=http://planner:4501`、`CASEHUB_GENERATOR_URL=http://generator:4502`、`CASEHUB_EXECUTOR_URL=http://executor:4504`；healer 默认走 generator 地址（`CASEHUB_HEALER_URL` 可覆盖）。跨 namespace 时改为 `http://<service>.<namespace>.svc.cluster.local:<port>`。

每个 Pod 单副本、Recreate 更新，避免多个进程写同一份任务文件；PVC 只保存任务状态与结果。需求级与产品级探索经验都只保存在 CaseHub，随每次请求下发、任务完成后存回，所以 planner 和 generator 分开部署仍共用同一份经验。

只能运行一个 Pod 时可改用 `automation/`（planner + generator + healer 合并在 4501），CaseHub 设置 `CASEHUB_AUTOMATION_URL` 即可。
