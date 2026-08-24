## 回归

缺陷修复（或代码变更）之后，判定"修复是否生效"以及"修复是否破坏了别的地方"。

输入：缺陷清单（含修复记录）、行为模型（含风险与影响范围）、历史用例集与历史执行结果
输出：回归用例集、回归执行结论、缺陷闭环状态

### 回归范围选择

回归不是全量重跑，而是按下列优先级挑选：

1. **缺陷复现用例**（必选）：每个 `fixed` 缺陷关联的 `related_case_ids`，用于验证修复生效。
2. **影响面用例**（必选）：缺陷 `impact_scope.affected_functions` 与 `regression_hint` 覆盖的功能对应的用例。
3. **依赖联动用例**：行为模型中与被修改功能存在依赖、共享数据、共享状态机的功能。
4. **高风险冒烟用例**：风险级别为 critical/high 的功能的核心正向用例（防止修复引入主流程崩溃）。
5. **历史失败用例**：曾经 FAIL 后修复过的用例（防止缺陷复发）。
6. **上轮 BLOCKED/INCONCLUSIVE 用例**：环境或观测缺口修复后必须补跑，把未验证的风险补回来。

对**变更风险**（`2_risk_analyze.md` 中的变更维度）高的功能，回归范围向上扩展一层依赖。

### 回归用例模型

```json
{
    "regression_id": "regression id",
    "trigger": "defect_fix/code_change/env_fix/scheduled",
    "trigger_ref": "defect_id 或 commit/需求 id",
    "scope_reason": "缺陷复现/影响面/依赖联动/高风险冒烟/历史失败/未验证补跑",
    "case_ids": ["case_id"],
    "priority": "critical/high/medium/low",
    "verdict": "PASS/FAIL/BLOCKED/INCONCLUSIVE"
}
```

回归用例复用 `5_testcase.md` 的用例模型与 Oracle，判定规则完全一致，不另立标准。

### 回归结论

```json
{
    "regression_run_id": "run id",
    "defect_verification": [
        {
            "defect_id": "defect id",
            "result": "verified/not_fixed/partially_fixed/blocked",
            "evidence": ["回归用例执行留痕"]
        }
    ],
    "new_defects": ["修复引入的新缺陷 defect_id"],
    "reopened_defects": ["复发的缺陷 defect_id"],
    "uncovered": ["本轮仍未验证的功能与原因"],
    "conclusion": "回归通过 / 回归不通过 / 有条件通过"
}
```

- `not_fixed` / `partially_fixed`：缺陷状态回退为 `confirmed`，重新进入缺陷分析。
- `new_defects`：走完整的缺陷分析流程（`6_defect_analysis.md`），并触发下一轮回归。
- 回归的执行结果与首轮执行结果同构（同一份执行结果契约），可直接汇入测试报告。
