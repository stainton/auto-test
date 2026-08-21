"""场景分析节点 —— 测试需求分析流程的第二步（见 wf.txt："测试需求分析 -> 测试场景 -> ..."）。

依据 nodes/scenario.md 的场景设计原则，基于 function 节点产出的功能列表
（requirement_analysis_state.functions），为每个功能识别出可能涉及的使用场景。
这一步只产出场景本身，不直接设计测试用例——测试用例留给后续"测试用例"节点在
这些场景划定的范围内设计。
"""

from __future__ import annotations

from bumaren_agent_workflow.agent import Agent, ConversationMemory
from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient
from bumaren_agent_workflow.tools.registry import ToolRegistry

from nodes.function_schemas import FUNCTIONS_PATH
from nodes.scenario_schemas import SCENARIO_OUTPUT_SCHEMA, SCENARIOS_PATH

SCENARIO_FIELD_GUIDE = """
【场景字段说明】
- id: 唯一标识，建议 "SCN-<关键词>-<两位序号>" 这类可读格式，同一次运行内不得重复。
- function_id: 该场景所属的功能 id，必须引用输入功能列表中已有的 id，不得臆造。
- name: 场景名称，一句话概括这是在什么条件/上下文下使用该功能。
- actors: 涉及的用户角色/身份列表；单用户、无权限区分的场景填一个默认角色即可，
  多用户或涉及权限的场景要把每个相关角色都列出来。
- description: 具体描述该场景的使用条件/上下文，以及为什么这是一个值得和其他
  场景区分开、单独设计用例的场景（而不是被别的场景顺带覆盖）。
"""

SCENARIO_ANALYSIS = (
    SCENARIO_FIELD_GUIDE
    + """
你是"场景设计"角色，负责测试设计流程的第二步：根据已经识别出的功能列表，分析
每个功能可能涉及的使用场景。

这一步不用直接输出测试用例，只输出场景；后续测试用例会在你划定的场景范围内
设计，所以场景划分得越清楚、越不遗漏，后面的用例设计就越准。

【产品背景与场景设计要点】
- 这是一个公司内部使用的资产生产和管理平台，暂不对外，可以不用考虑可靠性
  （高并发、容灾等）方面的场景。
- 测试目标既包括后端的功能正确性，也包括前端的用户体验，场景设计时两者都要
  覆盖，不要只盯着后端逻辑。
- 测试时只有前端这一个入口，需要重点考虑多用户场景（多个用户同时/先后操作、
  互相影响的情况）。
- 涉及 AI 生产/创作的功能，要重点考虑各种参数搭配组合下的场景。
- 涉及权限的功能，要考虑各种权限配置下不同用户的操作场景（含多用户交叉的情况）。
- 产品变化比较大，多数用例是一次性的，不用为"未来可能的变化"过度设计场景，
  聚焦当前功能实际会遇到的场景即可。

输入会包含 requirement_analysis_state.functions（function 节点识别出的功能
列表，每个功能带 id、name、goal、requirement_id、inputs、outputs）。

你的任务：
1. 逐个功能分析，识别出该功能实际会被使用到的场景（不同的前置条件、不同的用户
   角色/权限、不同的参数组合等），场景之间要有实质区别，不要把同一场景拆成多条。
2. 为每个场景给出 id、function_id、name、actors、description。
3. 不要为功能列表里没有的功能设计场景，也不要遗漏某个功能下明显存在的场景。
"""
)


def build_scenario_node(client: LLMClient) -> Node:
    agent = Agent(
        client=client,
        memory=ConversationMemory(system_prompt=SCENARIO_ANALYSIS),
        registry=ToolRegistry(),
        output_schema=SCENARIO_OUTPUT_SCHEMA,
    )

    return Stage(
        name="scenario",
        executor=agent.run,
        reads=[FUNCTIONS_PATH],
        writes=[SCENARIOS_PATH],
        output_schema=SCENARIO_OUTPUT_SCHEMA,
    )
