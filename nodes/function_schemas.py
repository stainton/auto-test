"""nodes/function.py（功能分析节点）用到的状态字段定义。

字段设计依据 nodes/components.md 对"功能"的定义：
- 一个功能要有明确目标（goal），且产出可验证的结果（outputs），而不是中间产物。
- 功能的 inputs/outputs 只考虑功能本身，不下钻子功能；复杂功能由更简单的功能
  组合而成时，用 sub_functions 记录组成关系，而不是把子功能的输入输出摊平进来。
"""

from __future__ import annotations

from bumaren_agent_workflow.state.schema import StateSchema

_FUNCTION = {
    "id": str,
    "name": str,
    "goal": str,
    "inputs": [str],
    "outputs": [str],
    "sub_functions": [str],
}

_STATE_SCHEMA_NAME = "requirement_analysis_state"

REQUIREMENT_DOC_KEY = "requirement_doc"
FUNCTIONS_KEY = "functions"

REQUIREMENT_DOC_PATH = f"{_STATE_SCHEMA_NAME}.{REQUIREMENT_DOC_KEY}"
FUNCTIONS_PATH = f"{_STATE_SCHEMA_NAME}.{FUNCTIONS_KEY}"

FUNCTION_OUTPUT_SCHEMA = StateSchema(
    "function_output",
    {FUNCTIONS_PATH: [_FUNCTION]},
)

REQUIREMENT_ANALYSIS_STATE_SCHEMA = StateSchema(
    _STATE_SCHEMA_NAME,
    {
        _STATE_SCHEMA_NAME: {
            REQUIREMENT_DOC_KEY: str,
            FUNCTIONS_KEY: [_FUNCTION],
        }
    },
)


def empty_state() -> dict:
    """构造一份符合 schema 的空状态,作为一次新运行的起点。"""
    return REQUIREMENT_ANALYSIS_STATE_SCHEMA.empty()
