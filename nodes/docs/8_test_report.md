## 测试报告输出

把执行结果（以及可选的缺陷分析、回归结论）汇总成可交付的测试报告。

输入：测试执行结果（**必需**）、缺陷清单与非缺陷问题清单（可选）、回归结论（可选）、行为模型与场景（用于覆盖率与风险对齐）
输出：测试报告（markdown / json）

### 节点依赖：报告可以在执行结束后立即产出

本节点**只强依赖执行结果**，缺陷分析与回归是可选的增量输入。执行一结束就能出报告，不必等待归因与回归完成。

```
1 需求建模 → 2 风险分析 → 3 测试策略 → 4 场景设计 → 5 测试用例 → [执行]
                                                                   │
                                        ┌──────────────────────────┼──────────────────────┐
                                        ↓                          ↓                      │
                                  6 缺陷分析 ──────────→ 7 回归 ───┤                      │
                                        │                          │                      │
                                        └──────────────┬───────────┘                      │
                                                       ↓                                  ↓
                                                8 测试报告输出 ←────────────────────────────
                                             （执行后即可输出，缺陷/回归数据到位后增量刷新）
```

### 报告级别

同一节点按输入完整度产出不同级别的报告，级别只影响章节是否存在，不影响已有章节的口径：

| 级别 | 触发时机 | 必需输入 | 包含内容 |
|------|----------|----------|----------|
| L1 执行报告 | 执行结束即可输出 | 执行结果 | 执行概况、四类 verdict 统计、失败用例明细、覆盖率、阻塞清单、初步结论 |
| L2 缺陷报告 | 缺陷分析完成后 | + 缺陷清单、非缺陷问题清单 | L1 + 缺陷分布与根因、测试能力缺口、风险闭环、发布建议 |
| L3 完整报告 | 回归完成后 | + 回归结论 | L2 + 回归范围与结果、缺陷闭环状态、新增/复发缺陷、最终发布结论 |

报告 id 与 `run_id` 绑定；L2/L3 是对同一份报告的**增量刷新**而非新建，保证同一次测试对外只有一份可追溯的报告。
缺陷分析或回归缺席时，对应章节标记为"未执行"，而不是省略——避免读者误以为无缺陷。

### 报告结构

```json
{
    "report_id": "report id",
    "run_id": "run id",
    "level": "L1/L2/L3",
    "generated_at": "生成时间",
    "meta": {"env": "", "build": "", "requirement_ref": "", "duration": ""},
    "summary": {
        "total": 0,
        "pass": 0,
        "fail": 0,
        "blocked": 0,
        "inconclusive": 0,
        "pass_rate": "PASS / (PASS + FAIL)",
        "valid_rate": "(PASS + FAIL) / total，衡量本次执行的有效性"
    },
    "coverage": {
        "by_function": "各功能的用例数与通过情况",
        "by_risk_level": "critical/high/medium/low 各风险级别的覆盖与通过情况",
        "by_test_dimension": "各测试维度的覆盖情况",
        "uncovered": ["行为模型中未被任何用例覆盖的点"]
    },
    "failures": ["失败用例明细：case_id、被违反的断言、期望值、实际观测值、evidence"],
    "blocked_and_inconclusive": ["用例、原因分类、被遮蔽的风险"],
    "defects": "来自 6_defect_analysis.md，缺席时为 not_executed",
    "test_gaps": "非缺陷问题清单，缺席时为 not_executed",
    "regression": "来自 7_regression.md，缺席时为 not_executed",
    "conclusion": {
        "quality_assessment": "质量评价",
        "release_suggestion": "可发布 / 有条件发布 / 不建议发布",
        "residual_risk": ["遗留风险与规避方案"],
        "next_actions": ["后续动作"]
    }
}
```

### 口径约定

- `pass_rate` 的分母不含 BLOCKED / INCONCLUSIVE，避免用阻塞用例稀释失败率。
- `valid_rate` 单独衡量本次执行有多少用例真正给出了结论；该值偏低时，报告结论必须显式声明"结论置信度低"。
- 高风险（critical/high）功能存在 FAIL、BLOCKED 或 INCONCLUSIVE 时，`release_suggestion` 不得给出"可发布"。
- 每条结论都要能回溯到 case_id → observation → assertion → evidence。
