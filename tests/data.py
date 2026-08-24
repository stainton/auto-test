"""端到端测试用的假数据:两个行为模型、两个场景、两条用例、一 PASS 一 FAIL。

刻意让高风险(test_depth=critical)的那个功能对应的用例 FAIL,好让发布闸门
真的被触发一次——闸门是这个场景里最不该出错的一段代码。
"""

from __future__ import annotations

_CORE_A = {
    "model_id": "BM-A-01",
    "function": "下单",
    "roles": ["买家"],
    "preconditions": ["已登录"],
    "inputs": ["商品 id", "数量"],
    "outputs": ["订单号"],
    "business_rules": ["库存充足才允许下单"],
    "states": ["待支付"],
    "state_transitions": ["无 -> 待支付"],
    "permissions": ["登录用户"],
    "external_dependencies": ["库存服务"],
    "data_changes": ["t_order 新增一行"],
    "side_effects": ["发下单消息"],
    "error_conditions": ["库存不足"],
}
_CORE_B = {**_CORE_A, "model_id": "BM-B-01", "function": "取消订单", "states": ["已取消"]}

_RISK = [{"dimension": "业务风险", "level": "critical", "reason": "超卖无法履约"}]
_DIM = [{"category": "并发", "points": ["重复提交"], "reason": "超卖"}]

BEHAVIOR_MODELS_CORE = [_CORE_A, _CORE_B]
BEHAVIOR_MODELS_RISKED = [
    {**_CORE_A, "risks": _RISK, "test_depth": "critical"},
    {**_CORE_B, "risks": _RISK, "test_depth": "low"},
]
BEHAVIOR_MODELS_FULL = [
    {**m, "test_dimensions": _DIM} for m in BEHAVIOR_MODELS_RISKED
]

TEST_SCENARIOS = [
    {
        "scenario_id": "SC-01",
        "scenario_name": "并发下单",
        "model_ids": ["BM-A-01"],
        "user_journey": ["登录", "连点两次下单"],
        "test_dimensions": ["并发"],
        "risk_focus": "超卖",
        "priority": "critical",
    },
    {
        "scenario_id": "SC-02",
        "scenario_name": "下单后取消",
        "model_ids": ["BM-B-01"],
        "user_journey": ["下单", "取消"],
        "test_dimensions": ["状态转换"],
        "risk_focus": "状态回退",
        "priority": "low",
    },
]


def _case(case_id: str, scenario_id: str, model_id: str, priority: str) -> dict:
    return {
        "case_id": case_id,
        "case_name": f"{case_id} 用例",
        "scenario_id": scenario_id,
        "model_id": model_id,
        "priority": priority,
        "test_dimensions": ["并发"],
        "precondition": "已登录且库存为 1",
        "steps": [{"step_id": "S1", "action": "连点两次下单", "observation_ids": ["OBS-1"]}],
        "observations": [
            {
                "observation_id": "OBS-1",
                "channel": "database",
                "target": "t_order 行数",
                "method": "SQL count",
                "timing": "immediate",
                "required": True,
            }
        ],
        "expected_result": ["只生成一笔订单"],
        "oracle": {
            "assertions": [
                {
                    "assertion_id": "A1",
                    "observation_id": "OBS-1",
                    "rule": "count_eq",
                    "expected": "1",
                    "severity": "blocker",
                    "rationale": "库存充足才允许下单",
                }
            ],
            "verdict_rules": {"PASS": "", "FAIL": "", "BLOCKED": "", "INCONCLUSIVE": ""},
        },
        "cleanup": ["删除测试订单"],
    }


CASES_SC01 = [_case("TC-01", "SC-01", "BM-A-01", "critical")]
CASES_SC02 = [_case("TC-02", "SC-02", "BM-B-01", "low")]


def _result(verdict: str, failed: list[str]) -> dict:
    return {
        "verdict": verdict,
        "verdict_reason": f"演示用的 {verdict}",
        "failed_assertion_ids": failed,
        "observed": [{"observation_id": "OBS-1", "obtained": True, "actual": "2"}],
        "evidence": ["trace-123"],
        "execution_notes": "假执行",
        "retry_count": 0,
    }


# 首轮:高风险的 TC-01 失败,低风险的 TC-02 通过;回归里 TC-01 修好。
EXECUTION_INITIAL_FAIL = _result("FAIL", ["A1"])
EXECUTION_INITIAL_PASS = _result("PASS", [])
EXECUTION_REGRESSION_PASS = _result("PASS", [])

DEFECTS = [
    {
        "defect_id": "DEF-01",
        "title": "并发下单超卖",
        "related_case_ids": ["TC-01"],
        "related_model_id": "BM-A-01",
        "scenario_id": "SC-01",
        "failed_assertion_ids": ["A1"],
        "symptom": "生成了两笔订单",
        "expected": "只生成一笔",
        "reproduce_steps": ["连点两次下单"],
        "reproducibility": "always",
        "root_cause_hypothesis": "缺少幂等校验",
        "defect_type": "并发",
        "severity": "blocker",
        "priority": "P0",
        "impact_scope": {
            "affected_functions": ["下单"],
            "affected_roles": ["买家"],
            "data_impact": "产生多余订单,需要清理",
            "risk_dimensions": ["业务风险"],
        },
        "regression_hint": ["下单", "库存扣减"],
        "status": "new",
    }
]

TEST_GAPS = [
    {
        "issue_id": "GAP-01",
        "source_verdict": "INCONCLUSIVE",
        "related_case_ids": ["TC-02"],
        "category": "观测点缺失",
        "description": "取不到 MQ 消息",
        "masked_risk": "取消订单是否发通知未被验证",
        "action": "补充 MQ 观测能力",
    }
]

REGRESSION_PLAN = [
    {
        "regression_id": "RG-01",
        "trigger": "defect_fix",
        "trigger_ref": "DEF-01",
        "scope_reason": "缺陷复现",
        # TC-99 不存在:用来验证 regression_cases 节点会把它挑出来而不是崩掉。
        "case_ids": ["TC-01", "TC-01", "TC-99"],
        "priority": "critical",
    }
]

REGRESSION_CONCLUSION = {
    "regression_run_id": "RR-01",
    "defect_verification": [{"defect_id": "DEF-01", "result": "verified", "evidence": ["trace-456"]}],
    "new_defect_ids": [],
    "reopened_defect_ids": [],
    "uncovered": [],
    "conclusion": "回归通过",
}

# 模型给出的过于乐观的结论:高风险功能首轮 FAIL,闸门不该放行。
OPTIMISTIC_CONCLUSION = {
    "conclusion": {
        "quality_assessment": "整体不错",
        "release_suggestion": "可发布",
        "residual_risk": [],
        "next_actions": ["修复 DEF-01"],
        "confidence_note": "",
    }
}
