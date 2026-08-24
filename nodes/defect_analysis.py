"""缺陷分析 —— nodes/docs/6_defect_analysis.md。

对执行结果做归因:FAIL 聚类去重成缺陷;BLOCKED / INCONCLUSIVE 不记缺陷,
而是记成测试能力的缺口(环境、数据、可观测性),连同"因此没被验证到的风险"
一起归档——后者是测试报告里"结论置信度"的直接依据。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    DEFECTS_PATH,
    DEFECT_ANALYSIS_OUTPUT_SCHEMA,
    EXECUTION_RESULTS_PATH,
    TEST_CASES_PATH,
    TEST_GAPS_PATH,
)


def build_defect_analysis_node(client: LLMClient) -> Node:
    agent = make_agent(
        client=client,
        system_prompt=prompts.DEFECT_ANALYSIS,
        output_schema=DEFECT_ANALYSIS_OUTPUT_SCHEMA,
    )
    return Isolated(
        Stage(
            name="defect_analysis",
            executor=agent.run,
            # 三份都要:执行结果给现象,用例给"期望是什么、哪条断言被违反",
            # 行为模型给风险级别(severity 要按它上调)与影响面。
            reads=[EXECUTION_RESULTS_PATH, TEST_CASES_PATH, BEHAVIOR_MODELS_PATH],
            writes=[DEFECTS_PATH, TEST_GAPS_PATH],
            output_schema=DEFECT_ANALYSIS_OUTPUT_SCHEMA,
        )
    )
