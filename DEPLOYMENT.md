# auto-test 部署指南

本文说明 auto-test 的 HTTP 服务（planner、generator/healer、executor、general-agent）怎样部署、扩容和升级。服务接口见 [server/README.md](server/README.md)，Kubernetes 清单细节见 [deploy/kubernetes/README.md](deploy/kubernetes/README.md)。任务的派发方 CaseHub 的部署见 CaseHub 仓库的 `DEPLOYMENT.md`。

## 1. 先了解：节点是无状态的

planner、generator（同一进程里还提供 healer）、executor 都是**无状态执行节点**：

- **不连数据库，也不回连 CaseHub。** 任务需要的需求、用例、探索经验、agent 配置和资产，都由 CaseHub 随任务推送过来。
- **任务记录归 CaseHub。** 进度、结果、planner 中断时的会话包、失败现场的诊断包，都由 CaseHub 取走保存。节点只在内存里保留正在运行和等待取走的任务。
- **节点本地只有临时目录和缓存。** 工作目录在启动时清空，资产缓存和登录态缓存丢了也无害。所以节点**不需要持久卷**，可以随时重启、增减。
- **由 CaseHub 挑节点。** CaseHub 查询每个节点的 `GET /v1/<kind>/capacity`，把任务交给空闲的那个；同一类节点运行几个都可以。

```text
            ┌────────────── CaseHub（单副本，持有任务记录） ──────────────┐
            │  排队 → 挑空闲节点 → 推资产/配置 → 跟随进度 → 取回结果 → 释放  │
            └──────┬─────────────────────┬───────────────────────┬─────────┘
                   ▼                     ▼                       ▼
         planner 节点 × N     generator/healer 节点 × N     executor 节点 × N
```

general-agent 只提供同步调用（阅读友好版等），不走任务队列，按普通无状态服务部署即可。

## 2. 准备

1. 为每个服务准备 Claude 配置 `build/<服务>/setting.json`（格式见同目录的 `setting.example.json`）。这只是兜底配置：CaseHub 在「agent 设置」里保存的配置会随每个任务下发，并以 CaseHub 的为准。
2. 节点要能访问模型 API 和被测系统。CaseHub 要能访问每个节点；节点不需要访问 CaseHub。
3. Kubernetes 部署需要构建镜像：`sh build/<服务>/build.sh <registry>/auto-test-<服务>:<tag>`。

## 3. 进程部署

适合单机或几台机器、不使用 Kubernetes 的场景。

**单节点**（每类一个进程，默认端口）：

```sh
node server/planner/main.mjs        # 4501
node server/generator/main.mjs      # 4502，同时提供 /v1/healer
node server/executor/main.mjs       # 4504
node server/general-agent/main.mjs  # 4503
```

CaseHub 用默认地址（`http://localhost:4501` 等）即可连接。也可以只启动一个 `node server/automation/main.mjs`（4501），它在一个进程里同时提供 planner、generator 和 healer，此时 CaseHub 设置 `CASEHUB_AUTOMATION_URL`。

**多节点**：同一类节点多启动几个进程，各用自己的端口和临时目录（可以分布在不同机器上），再把地址列表交给 CaseHub：

```sh
PLANNER_PORT=4501 PLANNER_DATA_DIR=/var/tmp/planner-a PLANNER_ASSET_DIR=/var/tmp/planner-a/assets node server/planner/main.mjs &
PLANNER_PORT=4511 PLANNER_DATA_DIR=/var/tmp/planner-b PLANNER_ASSET_DIR=/var/tmp/planner-b/assets node server/planner/main.mjs &
# CaseHub：CASEHUB_PLANNER_URL=http://10.0.0.5:4501,http://10.0.0.5:4511
```

进程部署没有自动扩缩，节点数就是启动的进程数。增减节点后修改 CaseHub 的地址列表并重启 CaseHub。重启时还在排队的任务需要重新提交，已经在节点上运行的任务不受影响。

**停止节点**：发一次 SIGTERM 或按一次 Ctrl-C，节点会先跑完手上的任务（见第 6 节），再按一次立即取消。不要用 `kill -9` 停止正在运行任务的节点，否则 CaseHub 只能把这些任务当作节点丢失来处理。

## 4. Kubernetes 部署

```sh
kubectl apply -k deploy/kubernetes
kubectl rollout status deployment/planner deployment/generator deployment/executor deployment/general-agent
```

每类节点对应一个 Deployment，外加两个 Service：

| Service | 用途 |
| --- | --- |
| `planner` / `generator` / `executor` | 普通 Service，指向任意一个 Pod，用于调试和 port-forward |
| `planner-nodes` / `generator-nodes` / `executor-nodes` | headless Service，解析出全部就绪 Pod；CaseHub 用 `dns+http://planner-nodes:4501` 等地址挑空闲 Pod |

CaseHub 自带的清单已经使用 `dns+` 地址。CaseHub 与 auto-test 不在同一 namespace 时，改用 `dns+http://planner-nodes.<namespace>.svc.cluster.local:4501` 这样的完整地址。

Pod 只挂载 `emptyDir`，不需要 StorageClass，也不需要 PVC。

## 5. 扩缩容

**固定副本数**（默认）：直接调整副本数，CaseHub 会自动发现新 Pod。

```sh
kubectl scale deployment/generator --replicas=3
```

**按排队数自动扩缩**（可选，需要 [KEDA](https://keda.sh) 2.12 或更高版本）：

1. 在 `deploy/kubernetes/kustomization.yaml` 中打开：

   ```yaml
   components:
     - components/autoscaling
   ```

2. 把 `deploy/kubernetes/components/autoscaling/scaledobjects.yaml` 里的 `casehub.default.svc.cluster.local` 改成 CaseHub 实际所在的 namespace。KEDA 在自己的 namespace 里运行，需要完整域名。
3. 按需调整每类节点的 `minReplicaCount` 和 `maxReplicaCount`，然后重新 `kubectl apply -k deploy/kubernetes`。

KEDA 读取 CaseHub 的 `GET /api/queue`，按"排队中 + 运行中"的任务数调整副本数，一个 Pod 对应一个任务。generator 按 generator 与 healer 两个队列之和扩缩。注意：

- **planner 的 `minReplicaCount` 不要设为 0。** CaseHub 的"评估用例数"和"阅读友好版改写"是同步调用，不会排队，没有 planner Pod 时会直接失败。
- **generator 和 executor 可以设为 0。** 空闲时缩到零；有任务时由 CaseHub 排队等待，直到 KEDA 拉起 Pod，等待上限为 CaseHub 的 `CASEHUB_TASK_QUEUE_TIMEOUT`，默认 30 分钟。
- **不启用这个组件就没有任何自动扩缩**，其余功能一切照常。

## 6. 停机、缩容与滚动更新

无论是进程部署还是 Kubernetes，节点收到 SIGTERM 后的行为都一样：

1. `/readyz` 立即返回 503，Pod 随之从 `*-nodes` 中消失，不再接收新任务；`/healthz` 保持 200，所以存活探针不会把它杀掉。
2. 排队中的任务以 `NODE_SHUTDOWN` 交还 CaseHub，由 CaseHub 派给其他节点。
3. 运行中的任务继续执行，最长 `*_DRAIN_TIMEOUT_MS`。超时仍未结束的以 `NODE_SHUTDOWN` 结束：planner 保留会话包，可以在任意节点继续；generator、healer、executor 的任务由 CaseHub 重新排队。
4. 最多再等 `*_DRAIN_HOLD_MS`，让 CaseHub 取走结果，然后退出。

清单里的 `terminationGracePeriodSeconds` 已按上面两段时间之和设置：planner 和 executor 为 990 秒，generator 和 automation 为 3690 秒。**调大任务时限时要一起调大它**，否则任务没跑完 Pod 就被强制结束。

相关环境变量（`<P>` 为 `PLANNER`、`GENERATOR`、`EXECUTOR` 或 `AUTOMATION`）：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `<P>_DRAIN_TIMEOUT_MS` | 该服务的任务时限 | 停机时等待运行中任务完成的上限 |
| `<P>_DRAIN_HOLD_MS` | 60000 | 任务全部结束后，等待 CaseHub 取走结果的上限 |
| `<P>_CONCURRENCY` | 1 | 每个节点同时运行的任务数；自动扩缩按一个 Pod 一个任务计算 |
| `<P>_MAX_JOBS` | 100 | 节点上未完成（排队 + 运行）任务数的上限 |
| `<P>_RETENTION_MS` / `<P>_MAX_RETAINED` | 24 小时 / 200 条 | 已结束但没被 CaseHub 释放的任务最多保留多久、多少条 |

## 7. 从旧版本升级

旧版本是单副本、任务存在 PVC 上，由 CaseHub 直接转发请求。升级步骤：

1. **在没有任务运行时升级。** 旧前端存在浏览器本地的任务 ID 是旧节点上的 ID，升级后无法再查到。
2. **先升级 CaseHub**，让它接管任务记录。生产环境的 CaseHub 应使用 PostgreSQL，见 CaseHub 的 `DEPLOYMENT.md`。
3. **再升级 auto-test**：Kubernetes 执行 `kubectl apply -k deploy/kubernetes`；进程部署直接用新代码重启即可，旧数据目录里的任务文件不再被读取，可以删除。
4. **清理旧 PVC。** `kubectl apply` 不会删除不再使用的 PVC，需要手动删除：

   ```sh
   kubectl delete pvc planner-data generator-data executor-data   # 用过 automation/ 的还有 automation-data
   ```

5. 按需修改 CaseHub 的节点地址：Kubernetes 用 `dns+http://<服务>-nodes:<端口>`；进程部署可以继续用单个地址。

新版节点与旧版 CaseHub 也能配合，接口向后兼容，只是没有多节点分发。新版 CaseHub 也能使用旧版节点，只是不支持查询空闲槽位和下载会话包：旧节点上中断的 planner 任务只能回到原节点继续。

## 8. 部署后检查

```sh
curl http://<节点>:4501/readyz                      # {"status":"ready"}
curl http://<节点>:4501/v1/planner/capacity         # {"concurrency":1,"running":0,...,"available":1,"accepting":true}
curl http://<CaseHub>/api/queue                     # 每类任务的 queued / running / demand / nodes
```

`/api/queue` 中某类任务的 `nodes` 为 0，说明 CaseHub 找不到这类节点，请检查 CaseHub 的 `CASEHUB_*_URL` 配置和 headless Service。

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 任务一直"排队等待空闲节点" | 所有节点都忙，或节点数为 0（KEDA 尚未扩容、`minReplicaCount` 为 0）。查看 `/api/queue` 和各节点的 `/capacity`；超过 `CASEHUB_TASK_QUEUE_TIMEOUT` 后任务以 `NO_NODE_AVAILABLE` 失败 |
| "暂时联系不上执行节点" | CaseHub 访问不到节点地址：检查网络、端口，以及 `dns+` 名称能否解析 |
| 任务以 `NODE_LOST` 结束 | 节点被强杀、崩溃或长时间失联（`CASEHUB_NODE_LOST_AFTER`，默认 2 分钟）。generator、healer、executor 任务会自动重跑，最多 3 次；planner 运行中丢失的任务没有会话可继续，需要重新开始 |
| 任务以 `CASEHUB_RESTARTED` 结束 | CaseHub 重启时任务还在排队。请求内容（含测试密码）只放在 CaseHub 内存里，需要重新提交 |
| planner 任务停机后显示"可继续" | 正常：排空超时后会话已由 CaseHub 保存，点"继续"即可在任意 planner 节点接着做 |
| Pod 一直处于 Terminating | 正在排空运行中的任务，属于正常现象；最长持续 `terminationGracePeriodSeconds` |
