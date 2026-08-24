"""测试策略 —— nodes/docs/3_test_strategy.md。

回答"从哪些角度攻击这个功能":在行为模型上补 test_dimensions,深度按上一步
算出的 test_depth 分配。同样是整表覆盖式写回。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    TEST_STRATEGY_OUTPUT_SCHEMA,
)


def build_test_strategy_node(client: LLMClient) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.TEST_STRATEGY,
        output_schema=TEST_STRATEGY_OUTPUT_SCHEMA,
    )
    return Isolated(
        Stage(
            name="test_strategy",
            executor=agent.run,
            reads=[BEHAVIOR_MODELS_PATH],
            writes=[BEHAVIOR_MODELS_PATH],
            output_schema=TEST_STRATEGY_OUTPUT_SCHEMA,
        )
    )
