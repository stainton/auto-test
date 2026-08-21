"""nodes/testcase.py（用例设计节点）用到的状态字段定义。

字段设计依据：
- nodes/testcase.md：用例在已经划定的场景范围内设计，scenario_id 引用 scenario
  节点产出的 _SCENARIO.id，不重新臆造场景；steps 与 expected_result 按下标一一
  对应，步骤要有指导作用但不用细到每个操作点（后续考虑交给 AI 执行），预期结果
  要无歧义、可判定（后续考虑交给 AI 检查）。
- 与下游用例管理系统 casehub 对齐字段名（见 casehub/pkg/model.TestCase）：
  case_id/case_name/priority/description/pre_condition/steps/expected_result
  与该结构体的可写业务字段一一对应，便于本节点产出的用例后续直接落库，不需要
  再做一次字段映射；scenario_id 是本项目内部的场景溯源字段，casehub 那边没有
  对应字段，落库时会被当成未知字段安全忽略。
"""

from __future__ import annotations

from bumaren_agent_workflow.state.schema import OneOf, StateSchema

_TEST_CASE = {
    "case_id": str,
    "case_name": str,
    "scenario_id": str,
    "priority": OneOf(1, 2, 3),
    "description": str,
    "pre_condition": str,
    "steps": [str],
    "expected_result": [str],
}

_STATE_SCHEMA_NAME = "testcase_state"

TEST_CASES_KEY = "test_cases"
TEST_CASES_PATH = f"{_STATE_SCHEMA_NAME}.{TEST_CASES_KEY}"

TESTCASE_OUTPUT_SCHEMA = StateSchema(
    "testcase_output",
    {TEST_CASES_PATH: [_TEST_CASE]},
)

TESTCASE_STATE_SCHEMA = StateSchema(
    _STATE_SCHEMA_NAME,
    {
        _STATE_SCHEMA_NAME: {
            TEST_CASES_KEY: [_TEST_CASE],
        }
    },
)


def empty_state() -> dict:
    """构造一份符合 schema 的空状态,作为一次新运行的起点。"""
    return TESTCASE_STATE_SCHEMA.empty()
