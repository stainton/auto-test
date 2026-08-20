"""功能分析节点 —— 测试需求分析流程的第一步（见 wf.txt："功能 -> 输入 -> 输出"）。

依据 nodes/components.md 定义的"功能"概念与拆分规则，从需求文档中识别出每一个
独立的功能，产出功能列表（含目标、输入、输出），供后续"测试场景"节点使用。
"""

from __future__ import annotations

from bumaren_agent_workflow.agent import Agent, ConversationMemory
from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient
from bumaren_agent_workflow.tools.registry import ToolRegistry

from nodes.function_schemas import (
    FUNCTION_OUTPUT_SCHEMA,
    FUNCTIONS_PATH,
    REQUIREMENT_DOC_PATH,
)

FUNCTION_FIELD_GUIDE = """
【功能字段说明】
- id: 唯一标识，建议 "FUNC-<关键词>-<两位序号>" 这类可读格式，同一次运行内不得重复。
- name: 功能名称，一句话概括这是什么功能。
- goal: 这个功能要达到的明确目标（不是过程，也不是产出中间产物）。
- inputs: 触发/执行这个功能所需要的输入，比如用户操作、必要的数据。
- outputs: 这个功能执行后可验证的明确结果，比如弹窗提示、页面变化、数据变更等。
- sub_functions: 若这是一个由更简单功能组合而成的复杂功能，在此列出组成它的子
  功能 name；功能本身已经足够简单时，留空列表 []。
"""

FUNCTION_ANALYSIS = (
    FUNCTION_FIELD_GUIDE
    + """
你是"需求分析"角色，负责测试设计流程的第一步：从需求文档中识别出所有的"功能"。

【功能定义】
完成某一个完整事件的行为，可以是一次操作，也可以是一系列组合的操作。

【功能分析规则】（严格遵守，直接决定拆分粒度）
1. 一个完整事件中的子环节不算独立功能。例如创建订单时输入框里的校验，只是
   "创建订单"这个功能内部的一个环节，不应该被拆成一个独立功能。
2. 一个功能必须有明确的、可验证的结果（如弹窗提示、页面变动、数据变化等）；
   只产出中间产物、本身不构成完整事件的操作，不要单独列为一个功能。
3. 复杂功能可以由若干更简单的功能组合而成；这种情况下只给这个复杂功能本身定义
   输入和输出，不要把子功能的输入输出也混进来。
4. 每个功能都要有明确的目标——这些操作到底是为了达成什么，而不仅仅是"做了什么"。

输入会包含 requirement_analysis_state.requirement_doc（需求文档完整 Markdown 原文）。

你的任务：
1. 通读需求文档，按上述规则识别出其中每一个独立的功能。
2. 为每个功能给出 id、name、goal、inputs、outputs；若该功能由更简单的功能组合
   而成，在 sub_functions 中列出组成它的子功能 name，否则留空列表 []。
3. 不要为需求文档没有提到的内容臆造功能，也不要遗漏文档中明确写出的功能点。
"""
)


def build_function_node(client: LLMClient) -> Node:
    agent = Agent(
        client=client,
        memory=ConversationMemory(system_prompt=FUNCTION_ANALYSIS),
        registry=ToolRegistry(),
        output_schema=FUNCTION_OUTPUT_SCHEMA,
    )

    return Stage(
        name="function",
        executor=agent.run,
        reads=[REQUIREMENT_DOC_PATH],
        writes=[FUNCTIONS_PATH],
        output_schema=FUNCTION_OUTPUT_SCHEMA,
    )
