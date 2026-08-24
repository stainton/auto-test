"""测试用例设计 —— nodes/docs/5_testcase.md。

按场景逐个设计用例:这个 Stage 是外层 ForEach 的 body,每轮只看**一个**测试
场景,通过 `reads=[scenario_item_path]` 读到当前场景(见 ForEach 的游标约定)。

逐场景而不是一次性把全部场景丢给模型,有两个理由:
  · 上下文可控——用例带 observations 与 oracle,是整个流程里最长的产物,
    一次性生成所有场景的用例很容易在中途被截断;
  · 深度可控——每轮只对着一个场景的 risk_focus 想,不会被别的场景稀释。

累积用 AppendToState 而不是 Stage.writes:writes 走 patch,对列表是整表覆盖,
后一轮会把前几轮设计的用例全部冲掉。
"""

from __future__ import annotations

from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient

import prompts
from nodes.common import AppendToState, Isolated, make_agent
from schemas.state import (
    BEHAVIOR_MODELS_PATH,
    TESTCASE_DESIGN_OUTPUT_SCHEMA,
    TEST_CASES_PATH,
)

DESIGNED_CASES_KEY = "designed_cases"


def build_testcase_design_node(client: LLMClient, scenario_item_path: str) -> Node:
    """构建"为当前场景设计用例"的节点。

    Args:
        client: LLMClient。
        scenario_item_path: 外层 ForEach 发布"当前场景"的游标路径,由
            workflow.py 用 `foreach_item_path(<foreach 名>)` 算出后传进来
            ——不要在这里手写这个字符串,否则改名时两处会对不上。
    """
    agent = make_agent(
        client=client,
        system_prompt=prompts.TESTCASE_DESIGN,
        output_schema=TESTCASE_DESIGN_OUTPUT_SCHEMA,
    )
    stage = Stage(
        name="testcase_design",
        executor=agent.run,
        # 只给当前场景 + 全部行为模型:用例的 precondition / observations /
        # oracle 都要落到行为模型的状态、数据变化、副作用上,少了它写不具体。
        reads=[scenario_item_path, BEHAVIOR_MODELS_PATH],
        output_schema=TESTCASE_DESIGN_OUTPUT_SCHEMA,
    )
    return AppendToState(Isolated(stage), DESIGNED_CASES_KEY, TEST_CASES_PATH)
