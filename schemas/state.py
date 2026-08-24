"""auto-test 工作流的共享状态定义。

一次运行要跨节点追踪的事实,对应 nodes/docs/ 下的八份设计文档,外加一个抽象
的用例执行节点:需求建模 → 风险分析 → 测试策略 → 场景设计 → 测试用例 →
(用例执行)→ 缺陷分析 → 回归 → 测试报告。

三条贯穿全场景的建模约定:

1. **行为模型是被逐步补齐的同一份数据。** 需求建模产出骨架,风险分析补
   `risks`/`test_depth`,测试策略补 `test_dimensions`。因此
   `_BEHAVIOR_MODEL_*` 分成三档:状态里存的是最完整的一档,而每个节点的
   `output_schema` 只声明它那一档——`StateSchema.to_json_schema()` 会把所有
   字段塞进 JSON Schema 的 `required`(见 state/schema.py 的
   `_to_json_schema`),共用同一份描述符会逼着需求建模节点凭空编造风险字段。
   状态侧的 `validate` 不强制必填,所以少写几个字段写回状态是合法的。

2. **设计期与执行期的数据分开存。** 用例(`test_cases`)是设计产物,执行结论
   (`execution_results`)是运行产物,不把 verdict 回填进用例——同一条用例会被
   首轮和回归各执行一次,回填就意味着后一次覆盖前一次,报告里再也算不出
   "这条用例修复前后分别是什么结论"。

3. **观测值不用自由 dict。** 设计文档里 `observed` 写成
   `{"OBS-1": "实际值"}`,但 StateSchema 的对象描述符会拒绝未声明的键(它的
   设计目标是抓拼写错),这里改成 `[{observation_id, actual, obtained}]` 的
   列表——顺带把"这个观测点到底取到值了没有"显式化,而这正是
   INCONCLUSIVE 判定的依据。
"""

from bumaren_agent_workflow.state.schema import OneOf, StateSchema

_STATE_SCHEMA_NAME = "auto_test_state"


def _path(key: str) -> str:
    return f"{_STATE_SCHEMA_NAME}.{key}"


# --------------------------------------------------------------------------
# 公共枚举
# --------------------------------------------------------------------------

LEVEL = OneOf("critical", "high", "medium", "low")
SEVERITY = OneOf("blocker", "critical", "major", "minor")
VERDICT = OneOf("PASS", "FAIL", "BLOCKED", "INCONCLUSIVE")
DEFECT_PRIORITY = OneOf("P0", "P1", "P2", "P3")
RISK_DIMENSION = OneOf("业务风险", "数据风险", "安全风险", "技术风险", "变更风险")
OBSERVATION_CHANNEL = OneOf(
    "api_response", "database", "cache", "mq", "log", "third_party", "ui", "metrics", "file"
)
ASSERTION_RULE = OneOf(
    "equals", "not_equals", "contains", "matches", "in_range",
    "absent", "exists", "changed_from_to", "count_eq",
)
EXECUTION_ROUND = OneOf("initial", "regression")


# --------------------------------------------------------------------------
# 1/2/3 行为模型(三档:骨架 → +风险 → +测试维度)
# --------------------------------------------------------------------------

_RISK = {
    "dimension": RISK_DIMENSION,
    "level": LEVEL,
    "reason": str,
}

_TEST_DIMENSION = {
    "category": str,   # 输入 / 状态 / 业务规则 / 并发 / 数据 / 网络 / 依赖 / 状态转换 ...
    "points": [str],   # 该维度下具体要打的点
    "reason": str,     # 为什么这个功能需要这个维度(与风险对应)
}

# 需求建模(nodes/docs/1_requirement_model.md)产出的骨架。
_BEHAVIOR_MODEL_CORE = {
    "model_id": str,
    "function": str,
    "roles": [str],
    "preconditions": [str],
    "inputs": [str],
    "outputs": [str],
    "business_rules": [str],
    "states": [str],
    "state_transitions": [str],
    "permissions": [str],
    "external_dependencies": [str],
    "data_changes": [str],
    "side_effects": [str],
    "error_conditions": [str],
}

# 风险分析(nodes/docs/2_risk_analyze.md)补齐后的形状。
_BEHAVIOR_MODEL_RISKED = {
    **_BEHAVIOR_MODEL_CORE,
    "risks": [_RISK],
    "test_depth": LEVEL,   # 各维度风险汇总后决定的测试深度
}

# 测试策略(nodes/docs/3_test_strategy.md)补齐后的形状,也是状态里存的形状。
_BEHAVIOR_MODEL = {
    **_BEHAVIOR_MODEL_RISKED,
    "test_dimensions": [_TEST_DIMENSION],
}


# --------------------------------------------------------------------------
# 4 测试场景(nodes/docs/4_scenario_design.md)
# --------------------------------------------------------------------------

_TEST_SCENARIO = {
    "scenario_id": str,
    "scenario_name": str,
    "model_ids": [str],          # 这个场景串起了哪几个行为模型
    "user_journey": [str],       # 真实用户行为序列
    "test_dimensions": [str],    # 本场景要打的测试维度(来自策略)
    "risk_focus": str,           # 本场景对准的风险
    "priority": LEVEL,
}


# --------------------------------------------------------------------------
# 5 测试用例(nodes/docs/5_testcase.md:steps + observations + oracle)
# --------------------------------------------------------------------------

_OBSERVATION = {
    "observation_id": str,
    "channel": OBSERVATION_CHANNEL,
    "target": str,     # 具体观测对象,如 response.body.code / t_order.status
    "method": str,     # 怎么取到这个值
    "timing": str,     # immediate / after_step_S1 / eventually_within_5s
    "required": bool,  # 缺失即无法判定(影响 INCONCLUSIVE)
}

_ASSERTION = {
    "assertion_id": str,
    "observation_id": str,
    "rule": ASSERTION_RULE,
    "expected": str,
    "severity": SEVERITY,
    "rationale": str,   # 这条断言对应哪条业务规则/风险点
}

_STEP = {
    "step_id": str,
    "action": str,
    "observation_ids": [str],
}

# 四种结论的判定规则。通用判定顺序(BLOCKED → FAIL → INCONCLUSIVE → PASS)是
# 全流程约定、写在 prompts 里;这四个字段只写**本用例特有**的补充条件。
_VERDICT_RULES = {
    "PASS": str,
    "FAIL": str,
    "BLOCKED": str,
    "INCONCLUSIVE": str,
}

_ORACLE = {
    "assertions": [_ASSERTION],
    "verdict_rules": _VERDICT_RULES,
}

_TEST_CASE = {
    "case_id": str,
    "case_name": str,
    "scenario_id": str,
    "model_id": str,
    "priority": LEVEL,
    "test_dimensions": [str],
    "precondition": str,
    "steps": [_STEP],
    "observations": [_OBSERVATION],
    "expected_result": [str],
    "oracle": _ORACLE,
    "cleanup": [str],
}


# --------------------------------------------------------------------------
# 用例执行(抽象执行节点,无对应设计文档)
# --------------------------------------------------------------------------

_OBSERVED = {
    "observation_id": str,
    "obtained": bool,   # 这个观测点到底有没有取到值 —— INCONCLUSIVE 的判定依据
    "actual": str,      # 取到的实际值;obtained=false 时写取不到的原因
}

# 执行节点的 Agent 只负责产出这一档;case_id 与 round 由代码盖章(见
# nodes/test_execution.py),不交给模型抄。
_EXECUTION_RESULT_CORE = {
    "verdict": VERDICT,
    "verdict_reason": str,
    "failed_assertion_ids": [str],
    "observed": [_OBSERVED],
    "evidence": [str],
    "execution_notes": str,   # AI 自己摸索执行的过程记录:试了什么、用了什么手段
    "retry_count": int,
}

_EXECUTION_RESULT = {
    **_EXECUTION_RESULT_CORE,
    "case_id": str,
    "round": EXECUTION_ROUND,
}


# --------------------------------------------------------------------------
# 7 缺陷分析(nodes/docs/6_defect_analysis.md)
# --------------------------------------------------------------------------

_IMPACT_SCOPE = {
    "affected_functions": [str],
    "affected_roles": [str],
    "data_impact": str,
    "risk_dimensions": [RISK_DIMENSION],
}

_DEFECT = {
    "defect_id": str,
    "title": str,
    "related_case_ids": [str],
    "related_model_id": str,
    "scenario_id": str,
    "failed_assertion_ids": [str],
    "symptom": str,
    "expected": str,
    "reproduce_steps": [str],
    "reproducibility": OneOf("always", "intermittent", "once"),
    "root_cause_hypothesis": str,
    "defect_type": str,
    "severity": SEVERITY,
    "priority": DEFECT_PRIORITY,
    "impact_scope": _IMPACT_SCOPE,
    "regression_hint": [str],
    "status": OneOf("new", "confirmed", "rejected", "fixed", "verified", "closed"),
}

# BLOCKED / INCONCLUSIVE 不是缺陷,而是测试能力的缺口,单独一张表。
_TEST_GAP = {
    "issue_id": str,
    "source_verdict": OneOf("BLOCKED", "INCONCLUSIVE"),
    "related_case_ids": [str],
    "category": str,
    "description": str,
    "masked_risk": str,   # 因为它而没被验证的功能与风险
    "action": str,
}


# --------------------------------------------------------------------------
# 8 回归(nodes/docs/7_regression.md)
# --------------------------------------------------------------------------

_REGRESSION_ITEM = {
    "regression_id": str,
    "trigger": OneOf("defect_fix", "code_change", "env_fix", "scheduled"),
    "trigger_ref": str,
    "scope_reason": str,   # 缺陷复现 / 影响面 / 依赖联动 / 高风险冒烟 / 历史失败 / 未验证补跑
    "case_ids": [str],
    "priority": LEVEL,
}

_DEFECT_VERIFICATION = {
    "defect_id": str,
    "result": OneOf("verified", "not_fixed", "partially_fixed", "blocked"),
    "evidence": [str],
}

_REGRESSION_CONCLUSION = {
    "regression_run_id": str,
    "defect_verification": [_DEFECT_VERIFICATION],
    "new_defect_ids": [str],
    "reopened_defect_ids": [str],
    "uncovered": [str],
    "conclusion": OneOf("回归通过", "回归不通过", "有条件通过"),
}


# --------------------------------------------------------------------------
# 9 测试报告(nodes/docs/8_test_report.md)
# --------------------------------------------------------------------------

_REPORT_SUMMARY = {
    "total": int,
    "passed": int,
    "failed": int,
    "blocked": int,
    "inconclusive": int,
    # 分母刻意不含 BLOCKED / INCONCLUSIVE,避免用阻塞用例稀释失败率。
    "pass_rate": float,
    # (PASS + FAIL) / total:本次执行里有多少用例真的给出了结论。
    "valid_rate": float,
}

_COVERAGE_ROW = {
    "name": str,
    "total": int,
    "passed": int,
    "failed": int,
    "blocked": int,
    "inconclusive": int,
}

_REPORT_COVERAGE = {
    "by_function": [_COVERAGE_ROW],
    "by_risk_level": [_COVERAGE_ROW],
    "by_test_dimension": [_COVERAGE_ROW],
    "uncovered": [str],
}

_REPORT_CONCLUSION = {
    "quality_assessment": str,
    "release_suggestion": OneOf("可发布", "有条件发布", "不建议发布"),
    "residual_risk": [str],
    "next_actions": [str],
    "confidence_note": str,   # valid_rate 偏低时必须显式声明结论置信度低
}

_REPORT = {
    "report_id": str,
    "run_id": str,
    # L1 执行报告(执行结束即可输出)/ L2 缺陷报告 / L3 完整报告。
    "level": OneOf("L1", "L2", "L3"),
    "generated_at": str,
    "summary": _REPORT_SUMMARY,
    "coverage": _REPORT_COVERAGE,
    # 高风险功能仍有 FAIL/BLOCKED/INCONCLUSIVE 时为 false:代码算出来的硬约束,
    # 用来压住模型可能给出的过于乐观的 release_suggestion。
    "release_gate_passed": bool,
    "gate_violations": [str],
    "conclusion": _REPORT_CONCLUSION,
}

_RUN_META = {
    "run_id": str,
    "env": str,
    "build": str,
    "requirement_ref": str,
    "started_at": str,
}


# --------------------------------------------------------------------------
# 状态路径
# --------------------------------------------------------------------------

RUN_META_KEY = "run_meta"
REQUIREMENT_DOC_KEY = "requirement_doc"
BEHAVIOR_MODELS_KEY = "behavior_models"
TEST_SCENARIOS_KEY = "test_scenarios"
TEST_CASES_KEY = "test_cases"
EXECUTION_RESULTS_KEY = "execution_results"
DEFECTS_KEY = "defects"
TEST_GAPS_KEY = "test_gaps"
REGRESSION_PLAN_KEY = "regression_plan"
REGRESSION_CASES_KEY = "regression_cases"
REGRESSION_CONCLUSION_KEY = "regression_conclusion"
REPORT_KEY = "report"

RUN_META_PATH = _path(RUN_META_KEY)
REQUIREMENT_DOC_PATH = _path(REQUIREMENT_DOC_KEY)
BEHAVIOR_MODELS_PATH = _path(BEHAVIOR_MODELS_KEY)
TEST_SCENARIOS_PATH = _path(TEST_SCENARIOS_KEY)
TEST_CASES_PATH = _path(TEST_CASES_KEY)
EXECUTION_RESULTS_PATH = _path(EXECUTION_RESULTS_KEY)
DEFECTS_PATH = _path(DEFECTS_KEY)
TEST_GAPS_PATH = _path(TEST_GAPS_KEY)
REGRESSION_PLAN_PATH = _path(REGRESSION_PLAN_KEY)
REGRESSION_CASES_PATH = _path(REGRESSION_CASES_KEY)
REGRESSION_CONCLUSION_PATH = _path(REGRESSION_CONCLUSION_KEY)
REPORT_PATH = _path(REPORT_KEY)


AUTO_TEST_STATE_SCHEMA = StateSchema(
    _STATE_SCHEMA_NAME,
    {
        _STATE_SCHEMA_NAME: {
            RUN_META_KEY: _RUN_META,
            REQUIREMENT_DOC_KEY: str,
            BEHAVIOR_MODELS_KEY: [_BEHAVIOR_MODEL],
            TEST_SCENARIOS_KEY: [_TEST_SCENARIO],
            TEST_CASES_KEY: [_TEST_CASE],
            EXECUTION_RESULTS_KEY: [_EXECUTION_RESULT],
            DEFECTS_KEY: [_DEFECT],
            TEST_GAPS_KEY: [_TEST_GAP],
            REGRESSION_PLAN_KEY: [_REGRESSION_ITEM],
            # 回归要执行的用例快照(从 regression_plan 的 case_ids 解析出的完整
            # 用例对象),供回归那一段的 ForEach 直接遍历。
            REGRESSION_CASES_KEY: [_TEST_CASE],
            REGRESSION_CONCLUSION_KEY: _REGRESSION_CONCLUSION,
            REPORT_KEY: _REPORT,
        }
    },
)


# --------------------------------------------------------------------------
# 各节点的输出契约
# --------------------------------------------------------------------------

REQUIREMENT_INPUT_OUTPUT_SCHEMA = StateSchema(
    "requirement_input_output",
    {REQUIREMENT_DOC_PATH: str, RUN_META_PATH: _RUN_META},
)

REQUIREMENT_MODEL_OUTPUT_SCHEMA = StateSchema(
    "requirement_model_output",
    {BEHAVIOR_MODELS_PATH: [_BEHAVIOR_MODEL_CORE]},
)

RISK_ANALYZE_OUTPUT_SCHEMA = StateSchema(
    "risk_analyze_output",
    {BEHAVIOR_MODELS_PATH: [_BEHAVIOR_MODEL_RISKED]},
)

TEST_STRATEGY_OUTPUT_SCHEMA = StateSchema(
    "test_strategy_output",
    {BEHAVIOR_MODELS_PATH: [_BEHAVIOR_MODEL]},
)

SCENARIO_DESIGN_OUTPUT_SCHEMA = StateSchema(
    "scenario_design_output",
    {TEST_SCENARIOS_PATH: [_TEST_SCENARIO]},
)

# ForEach 逐场景设计用例:每轮只产出本场景的用例,由 AppendToState 累积
# (Stage.writes 走的是 patch/整表覆盖,会把前几轮冲掉)。
TESTCASE_DESIGN_OUTPUT_SCHEMA = StateSchema(
    "testcase_design_output",
    {"designed_cases": [_TEST_CASE]},
)

# Agent 只产出 core 这一档。
TEST_EXECUTION_AGENT_OUTPUT_SCHEMA = StateSchema(
    "test_execution_agent_output",
    {"execution_result": _EXECUTION_RESULT_CORE},
)

# Stage 在 Agent 产出上盖了 case_id 与 round 之后的形状(见
# nodes/test_execution.py):这两项从 ForEach 的当前用例与本次执行轮次直接得出,
# 属于"能算的不交给模型判断"。
TEST_EXECUTION_OUTPUT_SCHEMA = StateSchema(
    "test_execution_output",
    {"execution_result": _EXECUTION_RESULT},
)

DEFECT_ANALYSIS_OUTPUT_SCHEMA = StateSchema(
    "defect_analysis_output",
    {DEFECTS_PATH: [_DEFECT], TEST_GAPS_PATH: [_TEST_GAP]},
)

REGRESSION_SCOPE_OUTPUT_SCHEMA = StateSchema(
    "regression_scope_output",
    {REGRESSION_PLAN_PATH: [_REGRESSION_ITEM]},
)

REGRESSION_CASES_OUTPUT_SCHEMA = StateSchema(
    "regression_cases_output",
    {REGRESSION_CASES_PATH: [_TEST_CASE]},
)

REGRESSION_VERDICT_OUTPUT_SCHEMA = StateSchema(
    "regression_verdict_output",
    {REGRESSION_CONCLUSION_PATH: _REGRESSION_CONCLUSION},
)

REPORT_METRICS_OUTPUT_SCHEMA = StateSchema(
    "report_metrics_output",
    {
        REPORT_PATH: {
            "report_id": str,
            "run_id": str,
            "level": OneOf("L1", "L2", "L3"),
            "generated_at": str,
            "summary": _REPORT_SUMMARY,
            "coverage": _REPORT_COVERAGE,
            "release_gate_passed": bool,
            "gate_violations": [str],
        }
    },
)

# Agent 只产出结论本身;Stage 校验并写回状态的是"挂在 report 下的结论"这一档
# (patch 对 dict 是浅合并,所以只会替换 report.conclusion,不动统计与覆盖率)。
REPORT_CONCLUSION_AGENT_OUTPUT_SCHEMA = StateSchema(
    "report_conclusion_agent_output",
    {"conclusion": _REPORT_CONCLUSION},
)

REPORT_CONCLUSION_OUTPUT_SCHEMA = StateSchema(
    "report_conclusion_output",
    {REPORT_PATH: {"conclusion": _REPORT_CONCLUSION}},
)


def empty_state() -> dict:
    """构造一份符合 schema 的空状态,作为一次新运行的起点。"""
    return AUTO_TEST_STATE_SCHEMA.empty()
