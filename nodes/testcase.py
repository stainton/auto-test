"""用例设计节点 —— 测试需求分析流程的第三步（见 wf.txt："... -> 测试用例 -> ..."）。

依据 nodes/testcase.md 的用例设计原则，基于 scenario 节点产出的场景列表
（scenario_state.scenarios），在每个已划定的场景范围内设计测试用例——不重新
识别场景，只在场景边界内把可测试的步骤/预期结果落到用例上。
"""

from __future__ import annotations

from bumaren_agent_workflow.agent import Agent, ConversationMemory
from bumaren_agent_workflow.engine import Node, Stage
from bumaren_agent_workflow.llm.client import LLMClient
from bumaren_agent_workflow.tools.registry import ToolRegistry

from nodes.function_schemas import REQUIREMENT_DOC_PATH
from nodes.scenario_schemas import SCENARIOS_PATH
from nodes.testcase_schemas import TEST_CASES_PATH, TESTCASE_OUTPUT_SCHEMA

TEST_CASE_FIELD_GUIDE = """
【用例字段说明】
- case_id: 唯一标识，建议 "TC-<关键词>-<两位序号>" 这类可读格式，同一次运行内
  不得重复。
- case_name: 一句话概括这条用例测的是什么。
- scenario_id: 该用例所属的场景 id，必须引用输入场景列表中已有的 id，不得臆造，
  也不得脱离场景边界去覆盖场景之外的内容。
- priority: 1/2/3 三档，1 最高、3 最低。按这条用例覆盖的场景对用户的重要程度、
  一旦出问题的影响面判断，不是按测试实现的难易度。
- description: 说明这条用例对应场景的哪个方面、为什么需要单独设一条用例覆盖它
  （而不是被同一场景下别的用例顺带覆盖）。
- pre_condition: 执行这条用例前必须具备的前置状态（环境、数据、已完成的操作）。
- steps 与 expected_result: 两个数组按下标一一对应，长度必须相等。
  steps 每一步要无歧义、有明确的指导作用（后续会交给 AI 按步骤执行），但不用
  细到每一个界面操作点；expected_result 对应下标写这一步应当观察到的具体
  现象，表述要清晰、可判定（后续会交给 AI 检查），不能写"结果符合预期"这类
  会导致判定含糊的空话。
"""

TESTCASE_DESIGN = (
    TEST_CASE_FIELD_GUIDE
    + """
你是"测试"角色，负责测试设计流程的第三步：在已经划定好的场景范围内设计测试
用例。

产品变化比较大，多数用例是一次性的，不用为长期维护/复用过度打磨用例结构，把
当前这一版场景覆盖到位、可执行、可判定即可。

【用例设计规则】
1. 只在输入给出的场景范围内设计用例，不重新识别或改动场景本身，也不要设计
   超出某个场景边界的用例（那属于另一个场景该覆盖的范围）。
2. 结合需求文档核实细节，保证用例描述的操作、数据、预期现象和需求文档一致，
   不要凭空编造需求文档没有提到的规则。
3. 每条用例要有可测试性：步骤能被清楚地执行（无论是人还是后续接入的 AI），
   预期结果能被清楚地判定对错，不能有歧义空间。

输入会包含 requirement_analysis_state.requirement_doc（需求文档原文，供你核实
细节）与 scenario_state.scenarios（scenario 节点划分出的场景列表，每个场景带
id、function_id、name、actors、description）。

你的任务：
1. 逐个场景设计一条或多条测试用例，覆盖该场景描述的条件/上下文下功能应有的
   表现；同一场景内不要设计重复等价的用例。
2. 为每条用例给出 case_id、case_name、scenario_id、priority、description、
   pre_condition、steps、expected_result。
3. 不要遗漏任何一个输入场景，也不要为输入之外的场景设计用例。
"""
)


def build_testcase_node(client: LLMClient) -> Node:
    agent = Agent(
        client=client,
        memory=ConversationMemory(system_prompt=TESTCASE_DESIGN),
        registry=ToolRegistry(),
        output_schema=TESTCASE_OUTPUT_SCHEMA,
    )

    return Stage(
        name="testcase",
        executor=agent.run,
        reads=[REQUIREMENT_DOC_PATH, SCENARIOS_PATH],
        writes=[TEST_CASES_PATH],
        output_schema=TESTCASE_OUTPUT_SCHEMA,
    )
