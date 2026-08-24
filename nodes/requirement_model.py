"""需求建模 —— nodes/docs/1_requirement_model.md。

输入 markdown 需求文档,输出 System Under Test 的行为模型:功能、角色、
前置条件、输入输出、业务规则、状态与状态变化、权限、外部依赖、数据变化、
副作用、错误条件。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    REQUIREMENT_DOC_PATH,
    REQUIREMENT_MODEL_OUTPUT_SCHEMA,
)


def build_requirement_model_node(client: LLMClient) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.REQUIREMENT_MODEL,
        output_schema=REQUIREMENT_MODEL_OUTPUT_SCHEMA,
    )
    return Isolated(
        Stage(
            name="requirement_model",
            executor=agent.run,
            reads=[REQUIREMENT_DOC_PATH],
            writes=[BEHAVIOR_MODELS_PATH],
            output_schema=REQUIREMENT_MODEL_OUTPUT_SCHEMA,
        )
    )
