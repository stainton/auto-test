"""nodes/scenario.py（场景分析节点）用到的状态字段定义。

字段设计依据 nodes/scenario.md 的场景设计原则：
- 每个场景归属于某一个功能（function_id 引用 function 节点产出的 _FUNCTION.id）。
- 场景本身不是测试用例，只描述"在什么条件/上下文下使用这个功能"，用例留给后续
  节点在场景划定的范围内设计。
- 多用户、权限配置是反复强调的维度，用 actors 显式记录涉及的角色，而不是只靠
  description 里的自然语言带过。
"""

from __future__ import annotations

from bumaren_agent_workflow.state.schema import StateSchema

_SCENARIO = {
    "id": str,
    "function_id": str,
    "name": str,
    "actors": [str],
    "description": str,
}

_STATE_SCHEMA_NAME = "scenario_state"

SCENARIOS_KEY = "scenarios"
SCENARIOS_PATH = f"{_STATE_SCHEMA_NAME}.{SCENARIOS_KEY}"

SCENARIO_OUTPUT_SCHEMA = StateSchema(
    "scenario_output",
    {SCENARIOS_PATH: [_SCENARIO]},
)

SCENARIO_STATE_SCHEMA = StateSchema(
    _STATE_SCHEMA_NAME,
    {
        _STATE_SCHEMA_NAME: {
            SCENARIOS_KEY: [_SCENARIO],
        }
    },
)


def empty_state() -> dict:
    """构造一份符合 schema 的空状态,作为一次新运行的起点。"""
    return SCENARIO_STATE_SCHEMA.empty()
