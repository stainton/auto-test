"""风险分析 —— nodes/docs/2_risk_analyze.md。

在行为模型上补 risks(业务/数据/安全/技术/变更五个维度)与 test_depth,
决定每个功能的测试深度。

写回的是整张 behavior_models 表(Stage.writes 走 patch,对列表是整表覆盖),
所以这个节点必须产出**全部**行为模型,而不是只产出补充的风险字段。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    REQUIREMENT_DOC_PATH,
    RISK_ANALYZE_OUTPUT_SCHEMA,
)


def build_risk_analyze_node(client: LLMClient) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.RISK_ANALYZE,
        output_schema=RISK_ANALYZE_OUTPUT_SCHEMA,
    )
    return Isolated(
        Stage(
            name="risk_analyze",
            executor=agent.run,
            # 变更风险要从需求文档里的改动痕迹判断,光看行为模型看不出来。
            reads=[BEHAVIOR_MODELS_PATH, REQUIREMENT_DOC_PATH],
            writes=[BEHAVIOR_MODELS_PATH],
            output_schema=RISK_ANALYZE_OUTPUT_SCHEMA,
        )
    )
