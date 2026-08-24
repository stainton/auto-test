"""场景设计 —— nodes/docs/4_scenario_design.md。

把单点的行为模型组合成真实的用户行为序列。缺陷常藏在两个功能的接缝处,
所以这一步的产物是后面用例设计的遍历单位。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    SCENARIO_DESIGN_OUTPUT_SCHEMA,
    TEST_SCENARIOS_PATH,
)


def build_scenario_design_node(client: LLMClient) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.SCENARIO_DESIGN,
        output_schema=SCENARIO_DESIGN_OUTPUT_SCHEMA,
    )
    return Isolated(
        Stage(
            name="scenario_design",
            executor=agent.run,
            reads=[BEHAVIOR_MODELS_PATH],
            writes=[TEST_SCENARIOS_PATH],
            output_schema=SCENARIO_DESIGN_OUTPUT_SCHEMA,
        )
    )
