## 缺陷分析

对测试执行结果进行归因：哪些是真缺陷、根因假设是什么、影响面有多大、要不要拦版本；
哪些不是缺陷，而是环境/数据/观测能力的缺口。

输入：测试执行结果（带 verdict 与 evidence 的用例结果）、行为模型（含风险与测试维度）、测试场景
输出：缺陷清单、非缺陷问题清单（测试能力缺口）、缺陷分布与质量结论、回归范围建议

### 输入契约：测试执行结果

执行节点（人工或自动化执行器）产出的结果，是本节点及测试报告节点的唯一事实来源：

```json
{
    "run_id": "本次执行的唯一 id",
    "env": "测试环境标识",
    "build": "被测版本/commit",
    "started_at": "开始时间",
    "finished_at": "结束时间",
    "results": [
        {
            "case_id": "case id",
            "verdict": "PASS/FAIL/BLOCKED/INCONCLUSIVE",
            "failed_assertions": ["A1"],
            "observed": {"OBS-1": "实际观测值"},
            "evidence": ["日志、trace_id、截图、SQL 结果"],
            "duration_ms": 0,
            "retry_count": 0
        }
    ]
}
```

### 处理规则

按 verdict 分流：

- **FAIL** → 进入缺陷候选，逐条归因。
- **INCONCLUSIVE** → 不记缺陷，记为**可观测性/稳定性缺口**（观测点取不到、数据被污染、结果 flaky）。
  若重试后转为稳定的 FAIL/PASS，则按转化后的结论处理。
- **BLOCKED** → 不记缺陷，记为**环境/数据/依赖缺口**，并标注它遮蔽了哪些用例（未被验证的风险）。
- **PASS** → 只用于覆盖率与风险闭环统计。

缺陷候选还需做**聚类去重**：多个用例因同一根因失败时，合并为一个缺陷，保留全部关联 case_id。

### 缺陷模型

```json
{
    "defect_id": "defect id",
    "title": "缺陷标题",
    "related_case_ids": ["case_id"],
    "related_model_id": "对应的行为模型 id",
    "scenario_id": "scenario id",
    "failed_assertions": ["A1"],
    "symptom": "实际观测到的现象（来自 observation 的实际值）",
    "expected": "期望行为（来自 oracle 的断言）",
    "reproduce_steps": ["step1", "step2"],
    "reproducibility": "always/intermittent/once",
    "root_cause_hypothesis": "根因假设，如：并发下缺少幂等校验",
    "defect_type": "功能/业务规则/状态机/并发/数据一致性/权限安全/依赖容错/性能/兼容性/易用性",
    "severity": "blocker/critical/major/minor",
    "priority": "P0/P1/P2/P3",
    "impact_scope": {
        "affected_functions": ["受影响的功能"],
        "affected_roles": ["受影响的角色"],
        "data_impact": "是否产生脏数据、是否需要数据修复",
        "risk_dimension": ["业务风险", "数据风险"]
    },
    "regression_hint": ["修复后必须回归的功能/用例范围"],
    "status": "new/confirmed/rejected/fixed/verified/closed"
}
```

`severity` 取自被违反断言的最高 severity，并结合行为模型中的风险级别上调；
`priority` 由 severity + 风险维度 + 影响范围共同决定。

### 非缺陷问题模型（测试能力缺口）

```json
{
    "issue_id": "issue id",
    "source_verdict": "BLOCKED/INCONCLUSIVE",
    "related_case_ids": ["case_id"],
    "category": "环境不可用/测试数据缺失/依赖服务不可用/权限缺失/观测点缺失/结果不稳定",
    "description": "问题描述",
    "masked_risk": "因该问题未被验证的功能与风险",
    "action": "改进动作，如：补充 MQ 观测点、准备过期 Token 的测试数据"
}
```

### 输出的质量结论

- 缺陷按 severity / defect_type / 功能模块 / 风险维度的分布
- 高风险功能（critical/high）是否仍有未闭环缺陷
- BLOCKED/INCONCLUSIVE 遮蔽的风险面积
- 发布建议：可发布 / 有条件发布（列出遗留缺陷与规避方案）/ 不建议发布
