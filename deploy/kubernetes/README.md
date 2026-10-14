# auto-test Kubernetes 部署

planner、generator、executor 分别部署为独立的 Deployment，各用各的镜像、浏览器和资源预算，一个服务的长任务不会抢占另一个的浏览器。每个 Pod 都是**无状态执行节点**：任务记录归 CaseHub，CaseHub 把任务交给空闲的 Pod，所以每类节点都可以运行任意多个副本、滚动更新，不需要 PVC：

| 目录 | Service 地址 | 提供 | 镜像构建 |
| --- | --- | --- | --- |
| `planner/` | `http://planner:4501`，全部节点 `planner-nodes` | `/v1/planner/*` | `sh build/planner/build.sh <registry>/auto-test-planner:<tag>` |
| `generator/` | `http://generator:4502`，全部节点 `generator-nodes` | `/v1/generator/*`、`/v1/healer/*` | `sh build/generator/build.sh <registry>/auto-test-generator:<tag>` |
| `executor/` | `http://executor:4504`，全部节点 `executor-nodes` | `/v1/executor/*` | `sh build/executor/build.sh <registry>/auto-test-executor:<tag>` |
| `general-agent/` | `http://general-agent:4503` | `/v1/general-agent/*` | `sh build/general-agent/build.sh <registry>/auto-test-general-agent:<tag>` |

1. 准备 `build/planner/setting.json`、`build/generator/setting.json`、`build/general-agent/setting.json`（executor 构建时复用 planner 的配置），格式见各目录的 `setting.example.json`。
2. 构建并推送上表中的镜像，在各子目录 `kustomization.yaml` 的 images 项填写实际 `newName` / `newTag`。
3. 一次部署全部服务，或进入单个子目录分别部署：

   ```sh
   kubectl apply -k deploy/kubernetes
   kubectl rollout status deployment/planner deployment/generator deployment/executor deployment/general-agent
   ```

4. CaseHub 清单中设置 `CASEHUB_PLANNER_URL=dns+http://planner-nodes:4501`、`CASEHUB_GENERATOR_URL` 与 `CASEHUB_HEALER_URL` 为 `dns+http://generator-nodes:4502`、`CASEHUB_EXECUTOR_URL=dns+http://executor-nodes:4504`（CaseHub 自带的清单已是如此）。`*-nodes` 是 headless Service，CaseHub 每次派发前解析出所有就绪 Pod，查各自的 `/capacity`，把任务交给空闲的那个。跨 namespace 时改为 `dns+http://<service>-nodes.<namespace>.svc.cluster.local:<port>`。

### 扩缩容

- **固定副本数**（默认）：改 Deployment 的 `replicas` 即可，例如 `kubectl scale deployment/generator --replicas=3`。CaseHub 自动发现新 Pod。
- **按排队数自动扩缩**（可选）：集群装有 [KEDA](https://keda.sh)（≥ 2.12，generator 用到 `scalingModifiers`）时，在本目录 `kustomization.yaml` 打开 `components: [components/autoscaling]`，并把 `components/autoscaling/scaledobjects.yaml` 里的 CaseHub 地址改成实际 namespace。KEDA 读 CaseHub 的 `GET /api/queue`，按"排队 + 运行中"的任务数把每类节点扩到相应副本数（一 Pod 一任务），空闲后缓慢缩回。不打开这个组件就没有任何自动扩缩，其余一切照常。

缩容和滚动更新都是安全的：被移除的 Pod 先变为未就绪（从 `*-nodes` 中消失、不再接新任务），把手上的任务跑完（`*_DRAIN_TIMEOUT_MS`），再等 CaseHub 取走结果（`*_DRAIN_HOLD_MS`）后退出；`terminationGracePeriodSeconds` 已按两者之和设置，调大任务时限时一起调大。超过时限仍未结束的任务：planner 保留会话包，可在任意节点继续；generator、healer、executor 由 CaseHub 重新排队到其他节点。

Pod 本地只有临时目录（`emptyDir`：任务工作目录、资产缓存），重建即清空，不影响任何任务记录。需求级与产品级探索经验都只保存在 CaseHub，随每次请求下发、任务完成后存回；已保存的登录态只缓存在各 Pod 内存里，CaseHub 会把同一被测系统、同一测试账号的任务优先交给已登录过的 Pod。

从旧版本（单副本 + PVC）升级：先升级 CaseHub（它接管任务记录），在没有任务运行时再 `kubectl apply -k deploy/kubernetes`。`kubectl apply` 不会删除已不再使用的 PVC，确认无误后手动删除：`kubectl delete pvc planner-data generator-data executor-data`（用过 `automation/` 的还有 `automation-data`）。

只能运行一个 Pod 时可改用 `automation/`（planner + generator + healer 合并在 4501），CaseHub 设置 `CASEHUB_AUTOMATION_URL` 即可。
